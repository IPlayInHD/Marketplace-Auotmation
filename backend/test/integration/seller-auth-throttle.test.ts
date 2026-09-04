import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as auth from '../../src/modules/identity-auth/index.ts';
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

// AUTH-204 (D-19 condition 6) after migration 0008: only completed authentication failures
// count, per hashed account and per hashed client. Capacity is reserved under a row lock before
// any credential work and finalized by the outcome, so a burst cannot bypass the limit while a
// success counts nowhere and clears only its own account's failures. Database-authoritative,
// restart-safe, capped, never a permanent lock-out. Waits are made deterministic by backdating
// locks and reservations as the superuser.

const DOMAIN = 'synthetic.invalid';
const address = (local: string) => [local, DOMAIN].join('@');
const PASSWORD = 'synthetic passphrase for throttling';
const WRONG = 'wrong password attempt';

/** Small numbers so the shape is testable; the production policy is THROTTLE_POLICY. */
const POLICY: auth.ThrottlePolicy = {
  account: { freeFailures: 3, baseSeconds: 2, capSeconds: 4, decaySeconds: 3600, reservationSeconds: 60 },
  client: { freeFailures: 6, baseSeconds: 2, capSeconds: 8, decaySeconds: 3600, reservationSeconds: 60 },
};

interface ThrottleRow {
  scope: string;
  subject_hash: string;
  failures: number;
  pending: number;
  locked: boolean;
  locked_until: string | null;
  lock_seconds: number | null;
}

describe('Progressive sign-in throttling counts failures only (AUTH-204, migration 0008)', () => {
  let env: TestDatabase;
  let harness: AuthApp;
  let owner: SyntheticAccount;
  let second: SyntheticAccount;
  let third: SyntheticAccount;
  let attacker: SyntheticAccount;
  const statuses: number[] = [];
  const clientOf = (ip: string) => ({ headers: { origin: TEST_ORIGIN }, remoteAddress: ip });
  const key = (): auth.IdentifierKey => ({
    key: harness.config.clientHashKey,
    version: harness.config.clientHashKeyVersion,
  });

  /** One sign-in attempt through the route, its status remembered for the audit reconciliation. */
  const attempt = async (email: string, password: string, ip: string) => {
    const res = await signInRequest(harness, email, password, clientOf(ip));
    statuses.push(res.statusCode);
    return res;
  };
  const rows = () =>
    query<ThrottleRow>(
      env.superuserUrl,
      `SELECT scope::text, subject_hash, failures, pending, COALESCE(locked_until > now(), false) AS locked, locked_until::text,
              ceil(extract(epoch FROM (locked_until - now())))::int AS lock_seconds
         FROM auth.sign_in_throttle ORDER BY scope, subject_hash`,
    );
  const clientRow = async (ip: string) =>
    (await rows()).find(
      (r) => r.scope === 'client' && r.subject_hash === auth.hashClientIdentifier(ip, key()).hash,
    );
  const accountRow = async (email: string) =>
    (await rows()).find(
      (r) =>
        r.scope === 'account' &&
        r.subject_hash === auth.hashAccountIdentifier(auth.normalizeEmail(email), key()),
    );
  const expireLocks = () =>
    query(
      env.superuserUrl,
      `UPDATE auth.sign_in_throttle SET locked_until = now() - interval '1 second' WHERE locked_until IS NOT NULL`,
    );
  /** Keeps every running lock running, so an assertion about a refusal cannot race the clock. */
  const holdLocks = () =>
    query(
      env.superuserUrl,
      `UPDATE auth.sign_in_throttle SET locked_until = now() + interval '30 seconds' WHERE locked_until > now()`,
    );
  const eventCounts = async () => {
    const events = await signInEvents(env.superuserUrl);
    const succeeded = await query<{ n: string }>(
      env.superuserUrl,
      `SELECT count(*)::text AS n FROM app.audit_event WHERE event_type = 'SELLER_SIGN_IN_SUCCEEDED'`,
    );
    return {
      failed: events.filter((e) => e.event_type === 'SELLER_SIGN_IN_FAILED').length,
      throttled: events.filter((e) => e.event_type === 'SELLER_SIGN_IN_THROTTLED').length,
      succeeded: Number(succeeded[0]?.n ?? 0),
    };
  };

  beforeAll(async () => {
    env = await startDatabase();
    const provision = (local: string) =>
      provisionAccount(env, {
        displayName: `Synthetic Seller ${local}`,
        email: address(`seller-${local}`),
        password: PASSWORD,
      });
    owner = await provision('owner');
    second = await provision('second');
    third = await provision('third');
    attacker = await provision('attacker');
    harness = await startAuthApp(env, { throttle: POLICY, poolMax: 8 });
  });
  afterAll(async () => {
    await harness?.close();
    await env?.stop();
  });

  it('admits twenty consecutive successful sign-ins from one client without a failure, a delay or a failed-sign-in event', async () => {
    const ip = '203.0.113.10';
    const before = await eventCounts();
    for (let i = 1; i <= 20; i += 1) {
      const res = await attempt(owner.email, PASSWORD, ip);
      expect(res.statusCode, `sign-in ${i}`).toBe(200);
      expect(cookieOf(res, harness.cookieName)?.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }
    expect(await clientRow(ip)).toMatchObject({ failures: 0, pending: 0, locked: false, locked_until: null });
    expect(await accountRow(owner.email)).toMatchObject({ failures: 0, pending: 0, locked: false });
    const after = await eventCounts();
    expect(after).toEqual({ ...before, succeeded: before.succeeded + 20 });
  });

  it('adds no client failure for successful sign-ins across several accounts on one client', async () => {
    const ip = '203.0.113.10';
    for (let round = 0; round < 3; round += 1) {
      for (const account of [owner, second, third]) {
        expect((await attempt(account.email, PASSWORD, ip)).statusCode).toBe(200);
      }
    }
    expect(await clientRow(ip)).toMatchObject({ failures: 0, pending: 0, locked: false });
    for (const account of [owner, second, third])
      expect(await accountRow(account.email)).toMatchObject({ failures: 0, pending: 0 });
  });

  it('counts a wrong password and an unknown account identically, against the account and the client', async () => {
    const unknown = address('nobody-t');
    const known = { email: owner.email, ip: '203.0.113.20' };
    const nobody = { email: unknown, ip: '203.0.113.21' };
    const before = { ...harness.verifyCalls, ...(await eventCounts()) };
    const responses = [];
    for (const target of [known, nobody]) {
      for (let i = 0; i < 2; i += 1) {
        const res = await attempt(target.email, WRONG, target.ip);
        expect(res.statusCode).toBe(401);
        responses.push(res);
      }
      expect(await accountRow(target.email)).toMatchObject({ failures: 2, pending: 0, locked: false });
      expect(await clientRow(target.ip)).toMatchObject({ failures: 2, pending: 0, locked: false });
    }
    // Byte-identical bodies and headers for both failure paths (AUTH-203), one derivation each.
    const [k1, k2, n1, n2] = responses;
    for (const res of [k2, n1, n2]) {
      expect(res?.body).toBe(k1?.body);
      expect(res?.headers['content-length']).toBe(k1?.headers['content-length']);
      expect(res?.headers['content-type']).toBe(k1?.headers['content-type']);
    }
    expect(k1?.json()).toEqual({ error: 'invalid_credentials' });
    expect(harness.verifyCalls).toEqual({ real: before.real + 2, decoy: before.decoy + 2 });
    const after = await eventCounts();
    expect(after).toEqual({
      failed: before.failed + 4,
      throttled: before.throttled,
      succeeded: before.succeeded,
    });
    const failed = (await signInEvents(env.superuserUrl)).filter(
      (e) => e.event_type === 'SELLER_SIGN_IN_FAILED',
    );
    for (const e of failed.slice(-4)) expect(e.summary).toEqual({});
  });

  it('resets the account failure state on a later success without erasing the client failures other attempts caused', async () => {
    const ip = '203.0.113.30';
    expect((await attempt(second.email, WRONG, ip)).statusCode).toBe(401);
    expect((await attempt(second.email, WRONG, ip)).statusCode).toBe(401);
    expect((await attempt(address('nobody-30'), WRONG, ip)).statusCode).toBe(401);
    expect(await accountRow(second.email)).toMatchObject({ failures: 2, pending: 0 });
    expect(await clientRow(ip)).toMatchObject({ failures: 3, pending: 0 });
    const before = await eventCounts();
    expect((await attempt(second.email, PASSWORD, ip)).statusCode).toBe(200);
    expect(await accountRow(second.email)).toMatchObject({
      failures: 0,
      pending: 0,
      locked: false,
      locked_until: null,
    });
    // AUTH-204: the owner is back in, but the client keeps every failure it earned.
    expect(await clientRow(ip)).toMatchObject({ failures: 3, pending: 0 });
    expect(await accountRow(address('nobody-30'))).toMatchObject({ failures: 1, pending: 0 });
    expect(await eventCounts()).toEqual({ ...before, succeeded: before.succeeded + 1 });
  });

  it('lets one valid account neither launder nor accelerate the client limiter', async () => {
    const ip = '203.0.113.40';
    // The attacker burns the client's allowance against other accounts.
    for (let i = 1; i <= POLICY.client.freeFailures + 1; i += 1) {
      expect((await attempt(address(`victim-${i}`), WRONG, ip)).statusCode, `failure ${i}`).toBe(401);
    }
    const spent = POLICY.client.freeFailures + 1;
    expect(await clientRow(ip)).toMatchObject({ failures: spent, pending: 0, locked: true });
    await holdLocks();
    const refused = await attempt(address('victim-x'), WRONG, ip);
    expect(refused.statusCode).toBe(429);
    expect(refused.json()).toEqual({ error: 'try_later' });
    expect((await signInEvents(env.superuserUrl)).at(-1)).toMatchObject({
      event_type: 'SELLER_SIGN_IN_THROTTLED',
      summary: { scope: 'client', retry_after_seconds: expect.any(Number) as number },
    });
    // A valid account of their own does not get past the client's lock either.
    expect((await attempt(attacker.email, PASSWORD, ip)).statusCode).toBe(429);
    await expireLocks();
    // Once the lock has run out, successes are admitted one at a time and change nothing.
    for (let i = 0; i < 3; i += 1) {
      expect((await attempt(attacker.email, PASSWORD, ip)).statusCode).toBe(200);
      expect(await clientRow(ip)).toMatchObject({ failures: spent, pending: 0 });
    }
    // The next failure continues the progression from where it was, not from zero.
    expect((await attempt(address('victim-y'), WRONG, ip)).statusCode).toBe(401);
    const row = await clientRow(ip);
    expect(row).toMatchObject({ failures: spent + 1, pending: 0, locked: true });
    const delay = auth.delayAfterFailures(POLICY.client, spent + 1);
    expect(row?.lock_seconds).toBeGreaterThanOrEqual(delay - 1);
    expect(row?.lock_seconds).toBeLessThanOrEqual(delay);
    await holdLocks();
    expect((await attempt(address('victim-z'), WRONG, ip)).statusCode).toBe(429);
    expect((await attempt(attacker.email, PASSWORD, ip)).statusCode).toBe(429);
    // The attacker's own account is untouched: from elsewhere it signs in at once.
    expect((await attempt(attacker.email, PASSWORD, '203.0.113.41')).statusCode).toBe(200);
    await expireLocks();
  });

  it('serialises parallel failures so a burst cannot exceed the account or the client allowance', async () => {
    const accountIp = '203.0.113.50';
    const target = address('burst-target');
    const burst = await Promise.all(Array.from({ length: 12 }, () => attempt(target, WRONG, accountIp)));
    const codes = burst.map((r) => r.statusCode);
    expect(codes.filter((c) => c === 401)).toHaveLength(POLICY.account.freeFailures + 1);
    expect(codes.filter((c) => c === 429)).toHaveLength(12 - POLICY.account.freeFailures - 1);
    expect(await accountRow(target)).toMatchObject({
      failures: POLICY.account.freeFailures + 1,
      pending: 0,
      locked: true,
    });
    expect(await clientRow(accountIp)).toMatchObject({
      failures: POLICY.account.freeFailures + 1,
      pending: 0,
    });

    const clientIp = '203.0.113.51';
    const spray = await Promise.all(
      Array.from({ length: 12 }, (_, i) => attempt(address(`spray-${i}`), WRONG, clientIp)),
    );
    const sprayCodes = spray.map((r) => r.statusCode);
    expect(sprayCodes.filter((c) => c === 401)).toHaveLength(POLICY.client.freeFailures + 1);
    expect(sprayCodes.filter((c) => c === 429)).toHaveLength(12 - POLICY.client.freeFailures - 1);
    expect(await clientRow(clientIp)).toMatchObject({
      failures: POLICY.client.freeFailures + 1,
      pending: 0,
      locked: true,
    });
    for (let i = 0; i < 12; i += 1) {
      const row = await accountRow(address(`spray-${i}`));
      expect(row?.failures ?? 0, `spray-${i}`).toBeLessThanOrEqual(1);
      expect(row?.pending ?? 0, `spray-${i}`).toBe(0);
    }
    await expireLocks();
  });

  it('loses no failure when successes and failures finalize concurrently on one client', async () => {
    const ip = '203.0.113.60';
    // Each round stays within what the client's allowance still admits in parallel (failures
    // plus attempts in flight), so every request is admitted and finalizes concurrently.
    let expectedFailures = 0;
    for (const [round, size] of [3, 2, 1].entries()) {
      const mixed = await Promise.all([
        ...Array.from({ length: size }, () => attempt(third.email, PASSWORD, ip)),
        ...Array.from({ length: size }, (_, i) => attempt(address(`mixed-${round}-${i}`), WRONG, ip)),
      ]);
      expectedFailures += size;
      expect(mixed.map((r) => r.statusCode).sort()).toEqual([
        ...Array.from({ length: size }, () => 200),
        ...Array.from({ length: size }, () => 401),
      ]);
      expect(await clientRow(ip), `round ${round}`).toMatchObject({ failures: expectedFailures, pending: 0 });
      expect(await accountRow(third.email)).toMatchObject({ failures: 0, pending: 0 });
    }
    // Exactly the free allowance was spent: the next failure is the first delayed one.
    expect(expectedFailures).toBe(POLICY.client.freeFailures);
    expect((await attempt(address('mixed-last'), WRONG, ip)).statusCode).toBe(401);
    expect(await clientRow(ip)).toMatchObject({ failures: POLICY.client.freeFailures + 1, locked: true });
    await holdLocks();
    expect((await attempt(third.email, PASSWORD, ip)).statusCode).toBe(429);
    await expireLocks();
  });

  it('does not extend a lock by checking it and answers the database clock’s remaining lock as Retry-After', async () => {
    const ip = '203.0.113.70';
    const target = address('locked-target');
    for (let i = 1; i <= POLICY.account.freeFailures + 1; i += 1) {
      expect((await attempt(target, WRONG, ip)).statusCode).toBe(401);
    }
    const subject = auth.hashAccountIdentifier(target, key());
    await query(
      env.superuserUrl,
      `UPDATE auth.sign_in_throttle SET locked_until = now() + interval '30 seconds' WHERE scope = 'account' AND subject_hash = $1`,
      [subject],
    );
    const initial = await accountRow(target);
    const verifyBefore = { ...harness.verifyCalls };
    for (let i = 0; i < 5; i += 1) {
      const [expected] = await query<{ s: number }>(
        env.superuserUrl,
        `SELECT ceil(extract(epoch FROM (locked_until - now())))::int AS s FROM auth.sign_in_throttle WHERE scope = 'account' AND subject_hash = $1`,
        [subject],
      );
      const res = await attempt(target, WRONG, ip);
      expect(res.statusCode).toBe(429);
      expect(res.headers['retry-after']).toMatch(/^[1-9]\d*$/);
      expect(Math.abs(Number(res.headers['retry-after']) - (expected?.s ?? 0))).toBeLessThanOrEqual(1);
      expect(cookieOf(res, harness.cookieName)?.value).toBe('');
      const now = await accountRow(target);
      expect(now?.locked_until).toBe(initial?.locked_until);
      expect(now).toMatchObject({ failures: initial?.failures, pending: 0 });
    }
    expect(harness.verifyCalls).toEqual(verifyBefore);
    // The client's reservation was released, not counted: the account refusal checked nothing.
    expect(await clientRow(ip)).toMatchObject({ failures: POLICY.account.freeFailures + 1, pending: 0 });
    await expireLocks();
  });

  it('never lets a counter go negative', async () => {
    const fresh = auth.hashAccountIdentifier(address('never-reserved'), key());
    const settle = (failed: boolean) =>
      query<{ failures: number; pending: number; locked_until: string | null }>(
        env.runtimeUrl,
        `SELECT failures, pending, locked_until FROM auth.finalize_sign_in_attempt('account', $1, $2, 3, 1, 4, 3600)`,
        [fresh, failed],
      );
    // Settling what was never reserved changes nothing and creates nothing.
    expect(await settle(false)).toEqual([{ failures: 0, pending: 0, locked_until: null }]);
    expect((await rows()).find((r) => r.subject_hash === fresh)).toBeUndefined();
    // A reservation settled twice clamps at zero rather than going negative.
    await query(
      env.runtimeUrl,
      `SELECT * FROM auth.reserve_sign_in_attempt('account', $1, 3, 1, 4, 3600, 60)`,
      [fresh],
    );
    expect(await settle(false)).toEqual([{ failures: 0, pending: 0, locked_until: null }]);
    expect(await settle(false)).toEqual([{ failures: 0, pending: 0, locked_until: null }]);
    expect(await settle(true)).toMatchObject({ 0: { failures: 1, pending: 0, locked_until: null } });
    for (const column of ['failures', 'pending']) {
      await expect(
        query(env.superuserUrl, `UPDATE auth.sign_in_throttle SET ${column} = -1 WHERE subject_hash = $1`, [
          fresh,
        ]),
      ).rejects.toMatchObject({ code: '23514' });
    }
  });

  it('bounds an interrupted attempt: its reservation blocks only within the reservation window and never becomes a failure', async () => {
    const ip = '203.0.113.80';
    const real = await auth.createPasswordVerifier();
    const interrupted = auth.createAuthService({
      db: harness.runtime.db,
      config: harness.config,
      passwords: {
        hash: (p) => real.hash(p),
        verify: () => Promise.reject(new Error('derivation interrupted')),
        verifyAgainstDecoy: () => Promise.reject(new Error('derivation interrupted')),
      },
      throttle: POLICY,
    });
    // A clean slate for the owner's account: a success clears its earlier failures.
    expect((await attempt(owner.email, PASSWORD, ip)).statusCode).toBe(200);
    const before = await eventCounts();
    for (let i = 1; i <= POLICY.account.freeFailures + 1; i += 1) {
      await expect(
        interrupted.signIn({
          email: owner.email,
          password: WRONG,
          client: auth.hashClientIdentifier(ip, key()),
          requestId: `req-interrupted-${randomUUID()}`,
        }),
      ).rejects.toThrow(/interrupted/);
      expect(await accountRow(owner.email), `interrupted ${i}`).toMatchObject({
        failures: 0,
        pending: i,
        locked: false,
      });
      expect(await clientRow(ip), `interrupted ${i}`).toMatchObject({ failures: 0, pending: i });
    }
    expect(await eventCounts()).toEqual(before);
    // Within the window the abandoned reservations fill the allowance: a further attempt waits.
    const refused = await attempt(owner.email, WRONG, ip);
    expect(refused.statusCode).toBe(429);
    expect(refused.headers['retry-after']).toBe('1');
    expect(await accountRow(owner.email)).toMatchObject({
      failures: 0,
      pending: POLICY.account.freeFailures + 1,
    });
    // After the window they are discarded: the next attempt is admitted and only it is counted.
    await query(
      env.superuserUrl,
      `UPDATE auth.sign_in_throttle SET last_reserved_at = now() - make_interval(secs => $1) WHERE pending > 0`,
      [POLICY.account.reservationSeconds + 1],
    );
    expect((await attempt(owner.email, WRONG, ip)).statusCode).toBe(401);
    expect(await accountRow(owner.email)).toMatchObject({ failures: 1, pending: 0, locked: false });
    expect(await clientRow(ip)).toMatchObject({ failures: 1, pending: 0 });
    expect(await eventCounts()).toEqual({
      ...before,
      failed: before.failed + 1,
      throttled: before.throttled + 1,
    });
    expect((await attempt(owner.email, PASSWORD, ip)).statusCode).toBe(200);
    expect(await accountRow(owner.email)).toMatchObject({ failures: 0, pending: 0 });
  });

  it('keeps its state in the database, so a restarted process still refuses a locked subject', async () => {
    const ip = '203.0.113.90';
    const email = address('restart-target');
    for (let i = 1; i <= POLICY.account.freeFailures + 1; i += 1) {
      expect((await attempt(email, WRONG, ip)).statusCode).toBe(401);
    }
    expect(await accountRow(email)).toMatchObject({
      failures: POLICY.account.freeFailures + 1,
      locked: true,
    });
    await holdLocks();
    const restarted = await startAuthApp(env, {
      throttle: POLICY,
      config: { clientHashKey: harness.config.clientHashKey },
    });
    try {
      const res = await signInRequest(restarted, email, WRONG, clientOf(ip));
      statuses.push(res.statusCode);
      expect(res.statusCode).toBe(429);
      expect(restarted.verifyCalls).toEqual({ real: 0, decoy: 0 });
    } finally {
      await restarted.close();
    }
  });

  it('forgets failures after the decay window and refuses an invalid policy at either keyhole', async () => {
    const ip = '203.0.113.91';
    const email = address('decay-target');
    for (let i = 1; i <= POLICY.account.freeFailures + 1; i += 1) {
      expect((await attempt(email, WRONG, ip)).statusCode).toBe(401);
    }
    expect(await accountRow(email)).toMatchObject({
      failures: POLICY.account.freeFailures + 1,
      locked: true,
    });
    await query(
      env.superuserUrl,
      `UPDATE auth.sign_in_throttle SET last_failure_at = now() - make_interval(secs => $1) WHERE subject_hash = $2 OR subject_hash = $3`,
      [
        POLICY.account.decaySeconds + 1,
        auth.hashAccountIdentifier(email, key()),
        auth.hashClientIdentifier(ip, key()).hash,
      ],
    );
    // The history is forgotten with its lock: admitted at once, and only the new failure counts.
    expect((await attempt(email, WRONG, ip)).statusCode).toBe(401);
    expect(await accountRow(email)).toMatchObject({ failures: 1, pending: 0, locked: false });
    expect(await clientRow(ip)).toMatchObject({ failures: 1, pending: 0, locked: false });
    for (const statement of [
      `SELECT * FROM auth.reserve_sign_in_attempt('account', repeat('a', 64), 3, 0, 0, 0, 60)`,
      `SELECT * FROM auth.reserve_sign_in_attempt('account', repeat('a', 64), 3, 1, 4, 3600, 0)`,
      `SELECT * FROM auth.finalize_sign_in_attempt('account', repeat('a', 64), true, 3, 0, 0, 0)`,
    ]) {
      await expect(query(env.runtimeUrl, statement), statement).rejects.toMatchObject({ code: 'ST001' });
    }
  });

  it('reconciles every response with exactly one event of the right type and stores no raw identifier', async () => {
    const counts = await eventCounts();
    expect(counts.succeeded).toBe(statuses.filter((s) => s === 200).length);
    expect(counts.failed).toBe(statuses.filter((s) => s === 401).length);
    expect(counts.throttled).toBe(statuses.filter((s) => s === 429).length);
    expect(statuses.filter((s) => ![200, 401, 429].includes(s))).toEqual([]);
    const stored = await query<{ t: string }>(
      env.superuserUrl,
      `SELECT row_to_json(r)::text AS t FROM auth.sign_in_throttle r UNION ALL SELECT row_to_json(r)::text FROM auth.sign_in_event r`,
    );
    const text = stored.map((r) => r.t).join('\n');
    expect(text).not.toMatch(/@|synthetic|203\.0\.113|password/i);
    for (const r of await rows()) {
      expect(r.failures).toBeGreaterThanOrEqual(0);
      expect(r.pending).toBe(0);
    }
  });
});
