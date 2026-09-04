import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type * as auth from '../../src/modules/identity-auth/index.ts';
import {
  cookieOf,
  provisionAccount,
  signInEvents,
  signInRequest,
  startAuthApp,
  TEST_ORIGIN,
  type AuthApp,
  type SyntheticAccount,
} from '../helpers/auth.ts';
import { startDatabase, type TestDatabase } from '../helpers/database.ts';
import { query } from '../helpers/inspect.ts';

// AUTH-204 (D-19 condition 6): progressive delay per hashed account and per hashed client,
// database-authoritative, restart-safe, refusing parallel bypass, capped, and never a permanent
// lock-out of the owner. The waits are made deterministic by backdating locks as the superuser.

const DOMAIN = 'synthetic.invalid';
const address = (local: string) => [local, DOMAIN].join('@');
const PASSWORD = 'synthetic passphrase for throttling';

/** Small numbers so the shape is testable; the production policy is THROTTLE_POLICY. */
const POLICY: auth.ThrottlePolicy = {
  account: { freeAttempts: 3, baseSeconds: 1, capSeconds: 4, decaySeconds: 3600 },
  client: { freeAttempts: 6, baseSeconds: 1, capSeconds: 8, decaySeconds: 3600 },
};

describe('Progressive sign-in throttling (AUTH-204)', () => {
  let env: TestDatabase;
  let harness: AuthApp;
  let account: SyntheticAccount;
  const clientOf = (ip: string) => ({ headers: { origin: TEST_ORIGIN }, remoteAddress: ip });

  const throttleRows = () =>
    query<{ scope: string; attempts: number; locked: boolean; lock_seconds: number | null }>(
      env.superuserUrl,
      `SELECT scope::text, attempts, locked_until > now() AS locked, ceil(extract(epoch FROM (locked_until - now())))::int AS lock_seconds
         FROM auth.sign_in_throttle ORDER BY scope, subject_hash`,
    );
  const expireLocks = () =>
    query(
      env.superuserUrl,
      `UPDATE auth.sign_in_throttle SET locked_until = now() - interval '1 second' WHERE locked_until IS NOT NULL`,
    );

  beforeAll(async () => {
    env = await startDatabase();
    account = await provisionAccount(env, {
      displayName: 'Synthetic Seller T',
      email: address('seller-t'),
      password: PASSWORD,
    });
    harness = await startAuthApp(env, { throttle: POLICY, poolMax: 8 });
  });
  afterAll(async () => {
    await harness?.close();
    await env?.stop();
  });

  it('counts attempts per account, delays progressively, answers a neutral 429 with Retry-After, and treats unknown accounts identically', async () => {
    const known = address('seller-t');
    const unknown = address('nobody-t');
    for (const email of [known, unknown]) {
      const ip = email === known ? '203.0.113.11' : '203.0.113.12';
      for (let i = 1; i <= 4; i += 1) {
        const res = await signInRequest(harness, email, 'wrong password attempt', clientOf(ip));
        expect(res.statusCode, `${email} attempt ${i}`).toBe(401);
      }
      const before = { ...harness.verifyCalls };
      const throttled = await signInRequest(harness, email, 'wrong password attempt', clientOf(ip));
      expect(throttled.statusCode).toBe(429);
      expect(throttled.json()).toEqual({ error: 'try_later' });
      expect(throttled.headers['retry-after']).toMatch(/^[1-9]\d*$/);
      expect(Number(throttled.headers['retry-after'])).toBeLessThanOrEqual(POLICY.account.capSeconds);
      expect(cookieOf(throttled, harness.cookieName)?.value).toBe('');
      expect(harness.verifyCalls).toEqual(before);
    }
    const events = await signInEvents(env.superuserUrl);
    const throttledEvents = events.filter((e) => e.event_type === 'SELLER_SIGN_IN_THROTTLED');
    expect(throttledEvents).toHaveLength(2);
    for (const e of throttledEvents) {
      expect(e.summary).toEqual({ scope: 'account', retry_after_seconds: expect.any(Number) as number });
      expect(JSON.stringify(e)).not.toMatch(/@|203\.0\.113/);
    }
    const rows = await throttleRows();
    expect(rows.filter((r) => r.scope === 'account' && r.attempts === 4 && r.locked)).toHaveLength(2);
  });

  it('never lets the owner be locked out for good: locks are capped, refusals do not extend them, and a correct sign-in resets the account counter', async () => {
    const ip = '203.0.113.11';
    await expireLocks();
    // Keep failing past the cap; every refusal while locked leaves the lock untouched.
    for (let i = 0; i < 6; i += 1) {
      const res = await signInRequest(harness, account.email, 'wrong password attempt', clientOf(ip));
      expect(res.statusCode).toBe(401);
      const locked = (await throttleRows()).find((r) => r.scope === 'account' && r.locked);
      expect(locked?.lock_seconds ?? 0).toBeLessThanOrEqual(POLICY.account.capSeconds);
      const lockBefore = locked?.lock_seconds;
      const refused = await signInRequest(harness, account.email, 'wrong password attempt', clientOf(ip));
      expect(refused.statusCode).toBe(429);
      const after = (await throttleRows()).find((r) => r.scope === 'account' && r.locked);
      expect(after?.lock_seconds ?? 0).toBeLessThanOrEqual(lockBefore ?? 0);
      await expireLocks();
    }
    const ok = await signInRequest(harness, account.email, PASSWORD, clientOf(ip));
    expect(ok.statusCode).toBe(200);
    const accountRow = (await throttleRows()).find((r) => r.scope === 'account' && r.attempts === 0);
    expect(accountRow).toBeDefined();
    // The client counter is not reset by a success (one valid account cannot launder a client).
    expect(
      (await throttleRows()).filter((r) => r.scope === 'client' && r.attempts > 0).length,
    ).toBeGreaterThan(0);
  });

  it('counts attempts per client across accounts and refuses the client, not the accounts, when its allowance is spent', async () => {
    const ip = '203.0.113.30';
    await expireLocks();
    for (let i = 1; i <= POLICY.client.freeAttempts + 1; i += 1) {
      const res = await signInRequest(
        harness,
        address(`victim-${i}`),
        'wrong password attempt',
        clientOf(ip),
      );
      expect(res.statusCode, `attempt ${i}`).toBe(401);
    }
    const refused = await signInRequest(harness, address('victim-x'), 'wrong password attempt', clientOf(ip));
    expect(refused.statusCode).toBe(429);
    const last = (await signInEvents(env.superuserUrl)).at(-1);
    expect(last?.event_type).toBe('SELLER_SIGN_IN_THROTTLED');
    expect(last?.summary).toMatchObject({ scope: 'client' });
    // Another client may still try the same account: the account counter was not touched by the refusal.
    const other = await signInRequest(
      harness,
      address('victim-x'),
      'wrong password attempt',
      clientOf('203.0.113.31'),
    );
    expect(other.statusCode).toBe(401);
  });

  it('serialises parallel attempts so a burst cannot exceed the allowance', async () => {
    const ip = '203.0.113.40';
    const email = address('burst-target');
    const burst = await Promise.all(
      Array.from({ length: 12 }, () => signInRequest(harness, email, 'wrong password attempt', clientOf(ip))),
    );
    const codes = burst.map((r) => r.statusCode);
    expect(codes.filter((c) => c === 401)).toHaveLength(POLICY.account.freeAttempts + 1);
    expect(codes.filter((c) => c === 429)).toHaveLength(12 - POLICY.account.freeAttempts - 1);
    const rows = await throttleRows();
    const accountRow = rows.find(
      (r) => r.scope === 'account' && r.attempts === POLICY.account.freeAttempts + 1 && r.locked,
    );
    expect(accountRow).toBeDefined();
  });

  it('keeps its state in the database, so a restarted process still refuses a locked subject', async () => {
    const ip = '203.0.113.50';
    const email = address('restart-target');
    for (let i = 1; i <= POLICY.account.freeAttempts + 1; i += 1) {
      expect((await signInRequest(harness, email, 'wrong password attempt', clientOf(ip))).statusCode).toBe(
        401,
      );
    }
    const restarted = await startAuthApp(env, {
      throttle: POLICY,
      config: { clientHashKey: harness.config.clientHashKey },
    });
    try {
      const res = await signInRequest(restarted, email, 'wrong password attempt', clientOf(ip));
      expect(res.statusCode).toBe(429);
      expect(restarted.verifyCalls).toEqual({ real: 0, decoy: 0 });
    } finally {
      await restarted.close();
    }
  });

  it('decays a counter after the policy window and refuses an invalid policy at the keyhole', async () => {
    await query(
      env.superuserUrl,
      `UPDATE auth.sign_in_throttle SET last_attempt_at = now() - interval '2 hours'`,
    );
    const res = await signInRequest(
      harness,
      address('restart-target'),
      'wrong password attempt',
      clientOf('203.0.113.50'),
    );
    expect(res.statusCode).toBe(401);
    const row = (await throttleRows()).find((r) => r.scope === 'account' && r.attempts === 1);
    expect(row).toBeDefined();
    await expect(
      query(
        env.runtimeUrl,
        `SELECT * FROM auth.reserve_sign_in_attempt('account', repeat('a', 64), 3, 0, 0, 0)`,
      ),
    ).rejects.toMatchObject({ code: 'ST001' });
  });
});
