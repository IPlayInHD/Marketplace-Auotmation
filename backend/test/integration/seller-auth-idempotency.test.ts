import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TENANT_SETTING } from '../../src/db/constants.ts';
import { establishTenantContext } from '../../src/db/kysely.ts';
import type * as KyselyModule from '../../src/db/kysely.ts';
import * as audit from '../../src/modules/audit/index.ts';
import * as auth from '../../src/modules/identity-auth/index.ts';
import { IDEMPOTENCY_KEY_HEADER } from '../../src/shared/command.ts';
import { IdempotencyConflictError } from '../../src/shared/errors.ts';
import {
  AUTH_PREFIX,
  cookieOf,
  get,
  post,
  provisionAccount,
  sellerAuditEvents,
  sessionRows,
  signIn,
  signInRequest,
  startAuthApp,
  TEST_ORIGIN,
  type AuthApp,
  type Session,
  type SyntheticAccount,
} from '../helpers/auth.ts';
import { startDatabase, type TestDatabase } from '../helpers/database.ts';
import { query } from '../helpers/inspect.ts';

// The one statement that creates tenant context is wrapped, unchanged in behaviour, so the tests
// can prove which paths call it: the exact-replay path of migration 0010 never may.
vi.mock('../../src/db/kysely.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof KyselyModule>();
  return { ...actual, establishTenantContext: vi.fn(actual.establishTenantContext) };
});
const tenantContextCalls = vi.mocked(establishTenantContext);

// D-20 (Accepted 2026-09-04): authentication-route idempotency semantics. The GET routes and
// sign-in take no key; sign-in and rotation are one-time-secret exceptions with no exact-response
// receipt, bounded by the active-session cap (AUTH-230); sign-out converges to one fixed 204
// (AUTH-231); sign-out-all is consequential and runs under a client-supplied key with a stored,
// non-secret outcome (AUTH-232, OPS-730 to OPS-732). Every account and value is synthetic, and
// every test owns its accounts, so the suite passes in any order.

const DOMAIN = 'synthetic.invalid';
const address = (local: string) => [local, DOMAIN].join('@');
const PASSWORD = 'synthetic passphrase for idempotency';
/** Small so the eviction shape is testable; the recorded private-alpha default is 10 (config test). */
const CAP = 3;
const ME = `${AUTH_PREFIX}/me`;
const SESSIONS = `${AUTH_PREFIX}/sessions`;
const ROTATE = `${AUTH_PREFIX}/sessions/rotate`;
const SIGN_OUT = `${AUTH_PREFIX}/sign-out`;
const SIGN_OUT_ALL = `${AUTH_PREFIX}/sign-out-all`;

interface ReceiptRow {
  idempotency_key: string;
  command: string;
  fingerprint: string;
  subject_type: string;
  subject_id: string;
  outcome: Record<string, unknown>;
  audit_event_id: string | null;
}

describe('Authentication-route idempotency semantics (D-20)', () => {
  let env: TestDatabase;
  let harness: AuthApp;
  const accounts: Record<string, SyntheticAccount> = {};
  /** Values that may never reach a receipt, an audit event or a log. */
  const secrets: string[] = [PASSWORD];
  const remember = (s: Session): Session => {
    secrets.push(s.token, s.antiForgery);
    return s;
  };
  const withKey = (key: string) => ({ headers: { origin: TEST_ORIGIN, [IDEMPOTENCY_KEY_HEADER]: key } });
  const hex = (token: string) => auth.hashSessionToken(token).toString('hex');
  const account = (name: string): SyntheticAccount => {
    const found = accounts[name];
    if (!found) throw new Error(`no synthetic account ${name}`);
    return found;
  };
  const liveIds = async (accountId: string) =>
    (
      await query<{ id: string }>(
        env.superuserUrl,
        `SELECT id FROM auth.seller_session
          WHERE account_id = $1 AND revoked_at IS NULL AND absolute_expires_at > now()
            AND last_seen_at > now() - make_interval(secs => $2)
          ORDER BY created_at, id`,
        [accountId, harness.config.sessionIdleSeconds],
      )
    ).map((r) => r.id);
  const liveCount = async (accountId: string) => (await liveIds(accountId)).length;
  const receipts = (sellerId: string) =>
    query<ReceiptRow>(
      env.superuserUrl,
      `SELECT idempotency_key, command, fingerprint, subject_type, subject_id, outcome, audit_event_id
         FROM app.idempotency_receipt WHERE seller_id = $1 ORDER BY created_at`,
      [sellerId],
    );
  const revokedAllEvents = (sellerId: string) =>
    query<{ id: string; idempotency_key: string | null; summary: Record<string, unknown> }>(
      env.superuserUrl,
      `SELECT id, idempotency_key, summary FROM app.audit_event
        WHERE seller_id = $1 AND event_type = 'SELLER_SESSIONS_REVOKED' ORDER BY seq`,
      [sellerId],
    );
  const countEvents = async (sellerId: string, type: string) =>
    (await sellerAuditEvents(env.superuserUrl, sellerId)).filter((e) => e.event_type === type).length;
  const meWith = (token: string, headers: Record<string, string> = {}) => get(harness, ME, token, headers);
  const idleExpire = (token: string) =>
    query(
      env.superuserUrl,
      `UPDATE auth.seller_session SET last_seen_at = now() - make_interval(secs => $2) WHERE token_hash = $1`,
      [auth.hashSessionToken(token), harness.config.sessionIdleSeconds + 1],
    );

  beforeAll(async () => {
    env = await startDatabase();
    for (const name of [
      'reader',
      'capped',
      'burst',
      'ordered',
      'rotator',
      'outer',
      'revoker',
      'faulty',
      'tenant',
      'other',
      'isolated',
      'pool',
      'probe',
      'arbitrary',
      'arbitrary2',
    ]) {
      accounts[name] = await provisionAccount(env, {
        displayName: `Synthetic Seller ${name}`,
        email: address(`seller-${name}`),
        password: PASSWORD,
      });
    }
    harness = await startAuthApp(env, { poolMax: 8, config: { maxActiveSessions: CAP } });
  });
  afterAll(async () => {
    await harness?.close();
    await env?.stop();
  });

  it('serves both GET routes and sign-in without an idempotency key, and treats a key on sign-in as no promise at all', async () => {
    const reader = account('reader');
    const s = remember(await signIn(harness, reader));
    for (const url of [ME, SESSIONS]) {
      expect((await get(harness, url, s.token)).statusCode, url).toBe(200);
      expect((await get(harness, url, s.token, { [IDEMPOTENCY_KEY_HEADER]: randomUUID() })).statusCode).toBe(
        200,
      );
    }
    const key = randomUUID();
    const first = await signInRequest(harness, reader.email, PASSWORD, withKey(key));
    const second = await signInRequest(harness, reader.email, PASSWORD, withKey(key));
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    const t1 = cookieOf(first, harness.cookieName)?.value ?? '';
    const t2 = cookieOf(second, harness.cookieName)?.value ?? '';
    remember({ token: t1, antiForgery: first.json<{ antiForgery: string }>().antiForgery });
    remember({ token: t2, antiForgery: second.json<{ antiForgery: string }>().antiForgery });
    expect(t1).not.toBe(t2);
    expect((await meWith(t1)).statusCode).toBe(200);
    expect((await meWith(t2)).statusCode).toBe(200);
    expect(await liveCount(reader.accountId)).toBe(3);
    expect(await receipts(reader.sellerId)).toEqual([]);
  });

  it('lets a repeated fresh sign-in create another session and keeps live sessions at the cap by evicting the oldest, audited without secrets', async () => {
    const capped = account('capped');
    const sessions: Session[] = [];
    for (let i = 0; i < CAP + 2; i += 1) sessions.push(remember(await signIn(harness, capped)));
    expect(await liveCount(capped.accountId)).toBe(CAP);
    const rows = await sessionRows(env.superuserUrl, capped.accountId);
    expect(rows).toHaveLength(CAP + 2);
    // The two oldest were evicted, each by the sign-in that pushed the count past the cap.
    expect(rows.slice(0, 2).map((r) => r.revocation_reason)).toEqual(['evicted', 'evicted']);
    expect(rows.slice(2).map((r) => r.revocation_reason)).toEqual([null, null, null]);
    expect(rows[0]?.replaced_by_session_id).toBe(rows[CAP]?.id);
    expect(rows[1]?.replaced_by_session_id).toBe(rows[CAP + 1]?.id);
    for (const [i, s] of sessions.entries()) {
      expect((await meWith(s.token)).statusCode, `session ${i}`).toBe(i < 2 ? 401 : 200);
    }
    const events = await sellerAuditEvents(env.superuserUrl, capped.sellerId);
    const evicted = events.filter((e) => e.event_type === 'SELLER_SESSION_EVICTED');
    expect(evicted.map((e) => e.subject_id)).toEqual([rows[0]?.id, rows[1]?.id]);
    for (const [i, e] of evicted.entries()) {
      expect(e.summary).toEqual({
        account_id: capped.accountId,
        replaced_by_session_id: rows[CAP + i]?.id,
        active_session_cap: CAP,
      });
    }
    const signedIn = events.filter((e) => e.event_type === 'SELLER_SIGN_IN_SUCCEEDED');
    expect(signedIn.map((e) => e.summary['evicted_count'])).toEqual([0, 0, 0, 1, 1]);
    const text = JSON.stringify(events);
    for (const s of secrets) expect(text).not.toContain(s);
    for (const r of rows) expect(text).not.toContain(r.token_hash_hex);
  });

  it('keeps the cap under concurrent successful sign-ins and retains the newest sessions', async () => {
    const burst = account('burst');
    const responses = await Promise.all(
      Array.from({ length: 8 }, () => signInRequest(harness, burst.email, PASSWORD)),
    );
    for (const res of responses) {
      expect(res.statusCode).toBe(200);
      remember({
        token: cookieOf(res, harness.cookieName)?.value ?? '',
        antiForgery: res.json<{ antiForgery: string }>().antiForgery,
      });
    }
    expect(await liveCount(burst.accountId)).toBe(CAP);
    const rows = await sessionRows(env.superuserUrl, burst.accountId);
    expect(rows).toHaveLength(8);
    expect(await liveIds(burst.accountId)).toEqual(rows.slice(-CAP).map((r) => r.id));
    expect(rows.filter((r) => r.revocation_reason === 'evicted')).toHaveLength(8 - CAP);
    expect(await countEvents(burst.sellerId, 'SELLER_SESSION_EVICTED')).toBe(8 - CAP);
  });

  it('evicts by creation time, not by recent use, and never counts an expired session', async () => {
    const ordered = account('ordered');
    const [oldest, middle, newest] = [
      remember(await signIn(harness, ordered)),
      remember(await signIn(harness, ordered)),
      remember(await signIn(harness, ordered)),
    ];
    expect(await liveCount(ordered.accountId)).toBe(CAP);
    // The oldest is the most recently used, and is still the one evicted.
    expect((await meWith(oldest?.token ?? '')).statusCode).toBe(200);
    const n1 = remember(await signIn(harness, ordered));
    expect((await meWith(oldest?.token ?? '')).statusCode).toBe(401);
    for (const t of [middle?.token, newest?.token, n1.token])
      expect((await meWith(t ?? '')).statusCode).toBe(200);
    expect(await countEvents(ordered.sellerId, 'SELLER_SESSION_EVICTED')).toBe(1);
    // An idle-expired session is not live, so the next sign-in evicts nothing.
    await idleExpire(middle?.token ?? '');
    const n2 = remember(await signIn(harness, ordered));
    for (const t of [newest?.token, n1.token, n2.token]) expect((await meWith(t ?? '')).statusCode).toBe(200);
    expect(await countEvents(ordered.sellerId, 'SELLER_SESSION_EVICTED')).toBe(1);
    expect(await liveCount(ordered.accountId)).toBe(CAP);
  });

  it('rotates without a key and creates at most one successor; a retry with the revoked predecessor creates nothing and only password sign-in recovers the client, after which the orphan can be revoked', async () => {
    const rotator = account('rotator');
    const first = remember(await signIn(harness, rotator));
    const rotated = await post(harness, ROTATE, first);
    expect(rotated.statusCode).toBe(200);
    remember({
      token: cookieOf(rotated, harness.cookieName)?.value ?? '',
      antiForgery: rotated.json<{ antiForgery: string }>().antiForgery,
    });
    const rowsBefore = await sessionRows(env.superuserUrl, rotator.accountId);
    expect(rowsBefore).toHaveLength(2);
    const [predecessor, orphan] = rowsBefore;
    expect(predecessor).toMatchObject({ revocation_reason: 'rotated', replaced_by_session_id: orphan?.id });
    expect(String(orphan?.absolute_expires_at)).toBe(String(predecessor?.absolute_expires_at));
    const rotatedBefore = await countEvents(rotator.sellerId, 'SELLER_SESSION_ROTATED');
    // The response is lost: the client holds only the predecessor. Retrying creates nothing.
    for (const extra of [{}, withKey(randomUUID())]) {
      const retry = await post(harness, ROTATE, first, extra);
      expect(retry.statusCode).toBe(401);
      expect(retry.json()).toEqual({ error: 'unauthenticated' });
      expect(cookieOf(retry, harness.cookieName)?.value).toBe('');
    }
    expect(await sessionRows(env.superuserUrl, rotator.accountId)).toEqual(rowsBefore);
    expect(await countEvents(rotator.sellerId, 'SELLER_SESSION_ROTATED')).toBe(rotatedBefore);
    expect(await liveCount(rotator.accountId)).toBe(1);
    expect((await meWith(first.token)).statusCode).toBe(401);
    // Only the password gets the client back in; the orphan is listed and can be revoked.
    const restored = remember(await signIn(harness, rotator));
    const listed = await get(harness, SESSIONS, restored.token);
    expect(listed.statusCode).toBe(200);
    const listedSessions = listed.json<{ sessions: { id: string; current: boolean }[] }>().sessions;
    expect(listedSessions).toHaveLength(2);
    expect(listedSessions.map((x) => x.id)).toContain(orphan?.id);
    expect(listedSessions.filter((x) => x.current).map((x) => x.id)).not.toContain(orphan?.id);
    expect(await liveCount(rotator.accountId)).toBeLessThanOrEqual(CAP);
    const all = await post(harness, SIGN_OUT_ALL, restored, withKey(randomUUID()));
    expect(all.statusCode).toBe(200);
    expect(all.json()).toEqual({ revoked: 2 });
    expect(await liveCount(rotator.accountId)).toBe(0);
    expect(
      (await sessionRows(env.superuserUrl, rotator.accountId)).find((r) => r.id === orphan?.id)
        ?.revocation_reason,
    ).toBe('signed_out_all');
  });

  it('answers sign-out with one fixed 204 first and on every repeat, revoking and auditing once, and the revoked token authorizes nothing', async () => {
    const outer = account('outer');
    const s = remember(await signIn(harness, outer));
    const signedOutBefore = await countEvents(outer.sellerId, 'SELLER_SIGNED_OUT');
    const first = await post(harness, SIGN_OUT, s);
    expect(first.statusCode).toBe(204);
    expect(first.body).toBe('');
    expect(cookieOf(first, harness.cookieName)?.value).toBe('');
    const rowsAfterFirst = await sessionRows(env.superuserUrl, outer.accountId);
    expect(rowsAfterFirst.find((r) => r.token_hash_hex === hex(s.token))?.revocation_reason).toBe(
      'signed_out',
    );
    expect(await countEvents(outer.sellerId, 'SELLER_SIGNED_OUT')).toBe(signedOutBefore + 1);
    for (let i = 0; i < 3; i += 1) {
      const again = await post(harness, SIGN_OUT, s);
      expect(again.statusCode).toBe(204);
      expect(again.body).toBe('');
      expect(cookieOf(again, harness.cookieName)?.value).toBe('');
      expect(again.headers['content-length']).toBe(first.headers['content-length']);
    }
    expect(await sessionRows(env.superuserUrl, outer.accountId)).toEqual(rowsAfterFirst);
    expect(await countEvents(outer.sellerId, 'SELLER_SIGNED_OUT')).toBe(signedOutBefore + 1);
    expect((await meWith(s.token)).statusCode).toBe(401);
    expect((await get(harness, SESSIONS, s.token)).statusCode).toBe(401);
    expect((await post(harness, ROTATE, s)).statusCode).toBe(401);
    expect((await post(harness, SIGN_OUT_ALL, s, withKey(randomUUID()))).statusCode).toBe(401);
  });

  it('makes a missing, malformed, unknown, revoked or expired sign-out externally indistinguishable and mutation-free', async () => {
    const outer = account('outer');
    const gone = remember(await signIn(harness, outer));
    expect((await post(harness, SIGN_OUT, gone)).statusCode).toBe(204);
    const idle = remember(await signIn(harness, outer));
    await idleExpire(idle.token);
    const unknown = auth.generateSessionToken();
    const rowsBefore = await sessionRows(env.superuserUrl, outer.accountId);
    const eventsBefore = (await sellerAuditEvents(env.superuserUrl, outer.sellerId)).length;
    const cases: [string, Session | undefined][] = [
      ['missing', undefined],
      ['malformed', { token: 'not-a-token', antiForgery: 'irrelevant' }],
      ['unknown', { token: unknown, antiForgery: auth.antiForgeryTokenFor(unknown) }],
      ['revoked', gone],
      ['idle-expired', idle],
    ];
    const shapes = new Set<string>();
    for (const [label, session] of cases) {
      const res = await post(harness, SIGN_OUT, session);
      expect(res.statusCode, label).toBe(204);
      expect(res.body, label).toBe('');
      expect(cookieOf(res, harness.cookieName)?.value, label).toBe('');
      shapes.add(`${String(res.headers['content-type'])}|${String(res.headers['content-length'])}`);
    }
    expect(shapes.size).toBe(1);
    expect(await sessionRows(env.superuserUrl, outer.accountId)).toEqual(rowsBefore);
    expect((await sellerAuditEvents(env.superuserUrl, outer.sellerId)).length).toBe(eventsBefore);
    // A live session still needs its anti-forgery value and the origin: decided on the request alone.
    const live = remember(await signIn(harness, outer));
    expect((await post(harness, SIGN_OUT, { token: live.token, antiForgery: '' })).statusCode).toBe(403);
    expect(
      (await post(harness, SIGN_OUT, live, { headers: { origin: 'https://evil.example' } })).statusCode,
    ).toBe(403);
    expect((await meWith(live.token)).statusCode).toBe(200);
  });

  it('refuses sign-out-all without a well-formed client-generated UUID key before any lookup or mutation', async () => {
    const outer = account('outer');
    const s = remember(await signIn(harness, outer));
    // Revocation state only: a later /me check legitimately touches last_seen_at.
    const revocations = async () =>
      (await sessionRows(env.superuserUrl, outer.accountId)).map((r) => [
        r.id,
        r.revoked_at,
        r.revocation_reason,
      ]);
    const before = {
      rows: await revocations(),
      receipts: await receipts(outer.sellerId),
      events: await countEvents(outer.sellerId, 'SELLER_SESSIONS_REVOKED'),
    };
    const malformed: (string | undefined)[] = [
      undefined,
      '',
      'not-a-uuid',
      'a'.repeat(200),
      s.token,
      `${randomUUID()} `,
    ];
    for (const key of malformed) {
      const res = await post(harness, SIGN_OUT_ALL, s, key === undefined ? {} : withKey(key));
      expect(res.statusCode, String(key)).toBe(400);
      expect(res.json(), String(key)).toEqual({ error: 'idempotency_key_required' });
    }
    expect((await meWith(s.token)).statusCode).toBe(200);
    expect(await revocations()).toEqual(before.rows);
    expect(await receipts(outer.sellerId)).toEqual(before.receipts);
    expect(await countEvents(outer.sellerId, 'SELLER_SESSIONS_REVOKED')).toBe(before.events);
  });

  it('revokes every live session once, audits under the key, stores a non-secret receipt, and replays it after the session is gone', async () => {
    const revoker = account('revoker');
    const r1 = remember(await signIn(harness, revoker));
    const r2 = remember(await signIn(harness, revoker));
    const r3 = remember(await signIn(harness, revoker));
    expect(await liveCount(revoker.accountId)).toBe(3);
    const key = randomUUID();
    const first = await post(harness, SIGN_OUT_ALL, r2, withKey(key));
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ revoked: 3 });
    expect(cookieOf(first, harness.cookieName)?.value).toBe('');
    for (const s of [r1, r2, r3]) expect((await meWith(s.token)).statusCode).toBe(401);
    const rows = await sessionRows(env.superuserUrl, revoker.accountId);
    expect(rows.map((r) => r.revocation_reason)).toEqual([
      'signed_out_all',
      'signed_out_all',
      'signed_out_all',
    ]);
    expect(new Set(rows.map((r) => r.xmin)).size).toBe(1);
    const initiating = rows.find((r) => r.token_hash_hex === hex(r2.token));
    const events = await revokedAllEvents(revoker.sellerId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      idempotency_key: key,
      summary: { revoked_count: 3, initiated_by_session_id: initiating?.id },
    });
    const stored = await receipts(revoker.sellerId);
    expect(stored).toEqual([
      {
        idempotency_key: key,
        command: auth.SIGN_OUT_ALL_COMMAND,
        fingerprint: audit.fingerprintCommand(auth.SIGN_OUT_ALL_COMMAND, { sessionId: initiating?.id }),
        subject_type: 'seller_account',
        subject_id: revoker.accountId,
        outcome: { revoked: 3 },
        audit_event_id: events[0]?.id,
      },
    ]);

    // OPS-731: the same token and key replay the stored outcome with the session long revoked.
    for (let i = 0; i < 2; i += 1) {
      const replay = await post(harness, SIGN_OUT_ALL, r2, withKey(key));
      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toEqual({ revoked: 3 });
      expect(cookieOf(replay, harness.cookieName)?.value).toBe('');
    }
    expect(await receipts(revoker.sellerId)).toEqual(stored);
    expect(await revokedAllEvents(revoker.sellerId)).toEqual(events);
    expect(await sessionRows(env.superuserUrl, revoker.accountId)).toEqual(rows);

    // A revoked token under any other key performs nothing and leaves nothing behind.
    const fresh = await post(harness, SIGN_OUT_ALL, r2, withKey(randomUUID()));
    expect(fresh.statusCode).toBe(401);
    expect(fresh.json()).toEqual({ error: 'unauthenticated' });
    expect(await receipts(revoker.sellerId)).toEqual(stored);
    expect(await revokedAllEvents(revoker.sellerId)).toEqual(events);

    // OPS-732: the key bound to another initiating session, or to another command, conflicts.
    const otherToken = await post(harness, SIGN_OUT_ALL, r1, withKey(key));
    expect(otherToken.statusCode).toBe(409);
    expect(otherToken.json()).toEqual({ error: 'idempotency_conflict' });
    const r4 = remember(await signIn(harness, revoker));
    const liveConflict = await post(harness, SIGN_OUT_ALL, r4, withKey(key));
    expect(liveConflict.statusCode).toBe(409);
    expect((await meWith(r4.token)).statusCode).toBe(200);
    await expect(
      harness.runtime.db.transaction().execute(async (trx) => {
        await establishTenantContext(trx, revoker.sellerId);
        return audit.runIdempotent(
          trx,
          { sellerId: revoker.sellerId, requestId: `req-${randomUUID()}`, idempotencyKey: key },
          {
            command: 'listing.set_asking_price',
            payload: { sessionId: initiating?.id },
            eventType: 'LISTING_ASKING_PRICE_CHANGED',
            subjectType: 'listing',
            run: () => Promise.reject(new Error('must not run')),
            serialize: () => ({}),
            revive: () => ({}),
          },
        );
      }),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect(await receipts(revoker.sellerId)).toEqual(stored);
  });

  it('keeps receipts inside their tenant: another seller can neither read nor replay them', async () => {
    const tenant = account('tenant');
    const other = account('other');
    const key = randomUUID();
    const t = remember(await signIn(harness, tenant));
    expect((await post(harness, SIGN_OUT_ALL, t, withKey(key))).json()).toEqual({ revoked: 1 });
    const [mine] = await receipts(tenant.sellerId);
    expect(mine?.outcome).toEqual({ revoked: 1 });
    // The same key string in another tenant is that tenant's own fresh command, not a replay.
    const o1 = remember(await signIn(harness, other));
    remember(await signIn(harness, other));
    const res = await post(harness, SIGN_OUT_ALL, o1, withKey(key));
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ revoked: 2 });
    expect((await receipts(other.sellerId)).map((r) => r.outcome)).toEqual([{ revoked: 2 }]);
    expect((await receipts(tenant.sellerId))[0]).toEqual(mine);
    // Under the other tenant's row-level security the receipt does not exist.
    const seenAs = (sellerId: string) =>
      harness.runtime.db.transaction().execute(async (trx) => {
        await establishTenantContext(trx, sellerId);
        return audit.findIdempotencyReceipt(trx, tenant.sellerId, key);
      });
    expect(await seenAs(other.sellerId)).toBeUndefined();
    expect((await seenAs(tenant.sellerId))?.outcome).toEqual({ revoked: 1 });
  });

  it('rolls back the revocation, the event and the receipt together when the receipt cannot be written', async () => {
    const faulty = account('faulty');
    const s = remember(await signIn(harness, faulty));
    remember(await signIn(harness, faulty));
    const key = randomUUID();
    const before = {
      events: await revokedAllEvents(faulty.sellerId),
      receipts: await receipts(faulty.sellerId),
      live: await liveCount(faulty.accountId),
    };
    expect(before.live).toBe(2);
    await query(
      env.superuserUrl,
      `CREATE FUNCTION public.fail_receipt_for_test() RETURNS trigger LANGUAGE plpgsql AS $$
         BEGIN RAISE EXCEPTION 'injected receipt failure'; END $$;
       CREATE TRIGGER fail_receipt_for_test BEFORE INSERT ON app.idempotency_receipt
         FOR EACH ROW WHEN (NEW.idempotency_key = '${key}') EXECUTE FUNCTION public.fail_receipt_for_test();`,
    );
    try {
      const res = await post(harness, SIGN_OUT_ALL, s, withKey(key));
      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({ error: 'internal' });
    } finally {
      await query(
        env.superuserUrl,
        `DROP TRIGGER fail_receipt_for_test ON app.idempotency_receipt; DROP FUNCTION public.fail_receipt_for_test();`,
      );
    }
    expect((await meWith(s.token)).statusCode).toBe(200);
    expect(await liveCount(faulty.accountId)).toBe(2);
    expect(await revokedAllEvents(faulty.sellerId)).toEqual(before.events);
    expect(await receipts(faulty.sellerId)).toEqual(before.receipts);
    // With the fault gone the same key works once and then replays.
    const ok = await post(harness, SIGN_OUT_ALL, s, withKey(key));
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ revoked: 2 });
    expect(await liveCount(faulty.accountId)).toBe(0);
    expect((await post(harness, SIGN_OUT_ALL, s, withKey(key))).json()).toEqual({ revoked: 2 });
  });

  it('replays through a keyhole that establishes no tenant context and resolves no identifier, while a different key or fingerprint gets 401 or 409 without context', async () => {
    const iso = account('isolated');
    const s1 = remember(await signIn(harness, iso));
    const s2 = remember(await signIn(harness, iso));
    const key = randomUUID();
    const otherCommandKey = randomUUID();
    // A receipt of another command under a second key, written through the ordinary tenant path.
    await harness.runtime.db.transaction().execute(async (trx) => {
      await establishTenantContext(trx, iso.sellerId);
      await audit.runIdempotent(
        trx,
        { sellerId: iso.sellerId, requestId: `req-${randomUUID()}`, idempotencyKey: otherCommandKey },
        {
          command: 'listing.set_asking_price',
          payload: { probe: true },
          eventType: 'LISTING_ASKING_PRICE_CHANGED',
          subjectType: 'listing',
          run: () => Promise.resolve({ value: { ok: true }, subjectId: randomUUID(), changed: false }),
          serialize: () => ({ ok: true }),
          revive: () => ({ ok: true }),
        },
      );
    });
    const first = await post(harness, SIGN_OUT_ALL, s2, withKey(key));
    expect(first.statusCode).toBe(200);
    expect(first.json()).toEqual({ revoked: 2 });
    expect(await revokedAllEvents(iso.sellerId)).toHaveLength(1);
    expect(
      (await receipts(iso.sellerId)).filter((r) => r.command === auth.SIGN_OUT_ALL_COMMAND),
    ).toHaveLength(1);

    // Exact replay: the stored outcome, and the tenant-context construction site is never called.
    tenantContextCalls.mockClear();
    const replay = await post(harness, SIGN_OUT_ALL, s2, withKey(key));
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toEqual({ revoked: 2 });
    expect(cookieOf(replay, harness.cookieName)?.value).toBe('');
    expect(tenantContextCalls).not.toHaveBeenCalled();

    // The same revoked token under a different key: generic 401, no context.
    tenantContextCalls.mockClear();
    const otherKey = await post(harness, SIGN_OUT_ALL, s2, withKey(randomUUID()));
    expect(otherKey.statusCode).toBe(401);
    expect(otherKey.json()).toEqual({ error: 'unauthenticated' });
    expect(tenantContextCalls).not.toHaveBeenCalled();

    // The same key from the other revoked session (another fingerprint): conflict, no context.
    tenantContextCalls.mockClear();
    const otherSession = await post(harness, SIGN_OUT_ALL, s1, withKey(key));
    expect(otherSession.statusCode).toBe(409);
    expect(otherSession.json()).toEqual({ error: 'idempotency_conflict' });
    expect(tenantContextCalls).not.toHaveBeenCalled();

    // The initiating token with a key consumed by another command: conflict, no context.
    tenantContextCalls.mockClear();
    const otherCommand = await post(harness, SIGN_OUT_ALL, s2, withKey(otherCommandKey));
    expect(otherCommand.statusCode).toBe(409);
    expect(tenantContextCalls).not.toHaveBeenCalled();

    // The keyhole itself answers a verdict and an outcome, and nothing else.
    const rows = await query<Record<string, unknown>>(
      env.runtimeUrl,
      `SELECT * FROM auth.replay_sign_out_all($1, $2)`,
      [auth.hashSessionToken(s2.token), key],
    );
    expect(rows).toEqual([{ verdict: 'replay', outcome: { revoked: 2 } }]);
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual(['outcome', 'verdict']);
    const [signature] = await query<{ args: string; result: string }>(
      env.superuserUrl,
      `SELECT pg_get_function_arguments(p.oid) AS args, pg_get_function_result(p.oid) AS result
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'auth' AND p.proname = 'replay_sign_out_all'`,
    );
    expect(signature).toEqual({
      args: 'p_token_hash bytea, p_idempotency_key text',
      result: 'TABLE(verdict text, outcome jsonb)',
    });

    // No other authenticated route accepts the revoked token; sign-out converges without mutation.
    for (const [label, res] of [
      ['me', await meWith(s2.token)],
      ['sessions', await get(harness, SESSIONS, s2.token)],
      ['rotate', await post(harness, ROTATE, s2)],
    ] as const) {
      expect(res.statusCode, label).toBe(401);
    }
    const before = await sessionRows(env.superuserUrl, iso.accountId);
    expect((await post(harness, SIGN_OUT, s2)).statusCode).toBe(204);
    expect(await sessionRows(env.superuserUrl, iso.accountId)).toEqual(before);
    expect(await revokedAllEvents(iso.sellerId)).toHaveLength(1);
  });

  it('leaves no tenant setting on the connection after a replay or a fresh execution, even on a one-connection pool', async () => {
    const pool = account('pool');
    const one = await startAuthApp(env, { poolMax: 1, config: { maxActiveSessions: CAP } });
    try {
      /** What the single pooled connection sees next: the setting, the derived seller, and RLS-visible rows. */
      const connectionState = () =>
        one.runtime.db.transaction().execute(async (trx) => {
          const value = await sql<{ setting: string | null; seller: string | null }>`
            select current_setting(${TENANT_SETTING}, true) as setting, app.current_seller_id()::text as seller`.execute(
            trx,
          );
          const visible = await sql<{ n: string }>`select count(*)::text as n from app.audit_event`.execute(
            trx,
          );
          return {
            setting: value.rows[0]?.setting ?? '',
            seller: value.rows[0]?.seller ?? null,
            visible: Number(visible.rows[0]?.n),
          };
        });
      const s = remember(await signIn(one, pool));
      remember(await signIn(one, pool));
      const key = randomUUID();
      const first = await post(one, SIGN_OUT_ALL, s, withKey(key));
      expect(first.statusCode).toBe(200);
      expect(first.json()).toEqual({ revoked: 2 });
      expect(await connectionState()).toEqual({ setting: '', seller: null, visible: 0 });
      tenantContextCalls.mockClear();
      const replay = await post(one, SIGN_OUT_ALL, s, withKey(key));
      expect(replay.statusCode).toBe(200);
      expect(replay.json()).toEqual({ revoked: 2 });
      expect(tenantContextCalls).not.toHaveBeenCalled();
      expect(await connectionState()).toEqual({ setting: '', seller: null, visible: 0 });
      // The keyhole's own transient context is gone before its statement even returns.
      const [after] = await query<{ setting: string | null; verdict: string }>(
        env.runtimeUrl,
        `SELECT (SELECT verdict FROM auth.replay_sign_out_all($1, $2)) AS verdict, current_setting($3, true) AS setting`,
        [auth.hashSessionToken(s.token), key, TENANT_SETTING],
      );
      expect(after?.verdict).toBe('replay');
      expect(after?.setting ?? '').toBe('');
    } finally {
      await one.close();
    }
  });

  it('answers unknown, expired, revoked and malformed tokens identically on sign-out-all, with no context and comparable timing', async () => {
    const probe = account('probe');
    const expired = remember(await signIn(harness, probe));
    await idleExpire(expired.token);
    const gone = remember(await signIn(harness, probe));
    expect((await post(harness, SIGN_OUT, gone)).statusCode).toBe(204);
    const unknownToken = auth.generateSessionToken();
    const unknown: Session = { token: unknownToken, antiForgery: auth.antiForgeryTokenFor(unknownToken) };
    const malformed: Session = { token: 'not-a-token', antiForgery: 'irrelevant' };
    tenantContextCalls.mockClear();
    const shapes = new Set<string>();
    for (const [label, session] of [
      ['unknown', unknown],
      ['expired', expired],
      ['revoked', gone],
      ['malformed', malformed],
    ] as const) {
      const res = await post(harness, SIGN_OUT_ALL, session, withKey(randomUUID()));
      expect(res.statusCode, label).toBe(401);
      expect(res.json(), label).toEqual({ error: 'unauthenticated' });
      expect(cookieOf(res, harness.cookieName)?.value, label).toBe('');
      shapes.add(`${String(res.headers['content-type'])}|${String(res.headers['content-length'])}`);
    }
    expect(shapes.size).toBe(1);
    expect(tenantContextCalls).not.toHaveBeenCalled();
    // Bounded timing check: every path that reaches the database runs the same two keyhole calls.
    const timed = async (session: Session) => {
      const started = process.hrtime.bigint();
      await post(harness, SIGN_OUT_ALL, session, withKey(randomUUID()));
      return Number(process.hrtime.bigint() - started) / 1e6;
    };
    const samples = { unknown: [] as number[], expired: [] as number[], revoked: [] as number[] };
    for (let i = 0; i < 25; i += 1) {
      samples.unknown.push(await timed(unknown));
      samples.expired.push(await timed(expired));
      samples.revoked.push(await timed(gone));
    }
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
    const medians = Object.values(samples).map(median);
    expect(Math.max(...medians) - Math.min(...medians)).toBeLessThanOrEqual(10);
  });

  it('keeps sessions and receipts out of the runtime role’s direct reach and lets the replay keyhole retrieve no arbitrary receipt', async () => {
    const a = account('arbitrary');
    const b = account('arbitrary2');
    const bSession = remember(await signIn(harness, b));
    const bKey = randomUUID();
    expect((await post(harness, SIGN_OUT_ALL, bSession, withKey(bKey))).statusCode).toBe(200);
    const aSession = remember(await signIn(harness, a));
    const aKey = randomUUID();
    expect((await post(harness, SIGN_OUT_ALL, aSession, withKey(aKey))).statusCode).toBe(200);
    // Direct table access: sessions are unreachable; receipts and events fail closed without context.
    await expect(query(env.runtimeUrl, `SELECT * FROM auth.seller_session`)).rejects.toMatchObject({
      code: '42501',
    });
    expect(await query(env.runtimeUrl, `SELECT * FROM app.idempotency_receipt`)).toEqual([]);
    expect(await query(env.runtimeUrl, `SELECT * FROM app.audit_event`)).toEqual([]);
    const replay = (hash: Buffer, key: string) =>
      query<{ verdict: string; outcome: Record<string, unknown> | null }>(
        env.runtimeUrl,
        `SELECT verdict, outcome FROM auth.replay_sign_out_all($1, $2)`,
        [hash, key],
      );
    // An unknown digest, a digest with another seller's key, and the other way round: nothing.
    expect(await replay(auth.hashSessionToken(auth.generateSessionToken()), aKey)).toEqual([]);
    expect(await replay(auth.hashSessionToken(aSession.token), bKey)).toEqual([]);
    expect(await replay(auth.hashSessionToken(bSession.token), aKey)).toEqual([]);
    // Each seller's own initiating digest and key: exactly its own outcome.
    expect(await replay(auth.hashSessionToken(aSession.token), aKey)).toEqual([
      { verdict: 'replay', outcome: { revoked: 1 } },
    ]);
    expect(await replay(auth.hashSessionToken(bSession.token), bKey)).toEqual([
      { verdict: 'replay', outcome: { revoked: 1 } },
    ]);
    // Arguments are validated; nothing is dynamic.
    await expect(replay(Buffer.alloc(16), aKey)).rejects.toMatchObject({ code: 'SO002' });
    await expect(replay(auth.hashSessionToken(aSession.token), 'not-a-uuid')).rejects.toMatchObject({
      code: 'SO002',
    });
    await expect(
      query(env.runtimeUrl, `SELECT * FROM auth.sign_out_session($1, 0)`, [
        auth.hashSessionToken(aSession.token),
      ]),
    ).rejects.toMatchObject({ code: 'SO001' });
    // sign_out_session answers nothing for a revoked digest and discloses nothing.
    expect(
      await query(env.runtimeUrl, `SELECT * FROM auth.sign_out_session($1, 3600)`, [
        auth.hashSessionToken(aSession.token),
      ]),
    ).toEqual([]);
  });

  it('stores no protected authentication material in any receipt, in the events they reference, or in the logs', async () => {
    const stored = await query<{ t: string }>(
      env.superuserUrl,
      `SELECT row_to_json(r)::text AS t FROM app.idempotency_receipt r
       UNION ALL SELECT row_to_json(e)::text FROM app.audit_event e WHERE e.idempotency_key IS NOT NULL`,
    );
    const hashes = await query<{ h: string }>(
      env.superuserUrl,
      `SELECT encode(token_hash, 'hex') AS h FROM auth.seller_session`,
    );
    const clientHash = auth.hashClientIdentifier('127.0.0.1', {
      key: harness.config.clientHashKey,
      version: harness.config.clientHashKeyVersion,
    }).hash;
    const corpus = { receipts_and_keyed_events: stored.map((r) => r.t).join('\n'), logs: harness.logText() };
    for (const [name, text] of Object.entries(corpus)) {
      for (const secret of secrets) expect(text, `${name} carries a secret`).not.toContain(secret);
      for (const h of hashes) expect(text, `${name} carries a token hash`).not.toContain(h.h);
      expect(text, `${name} carries a client hash`).not.toContain(clientHash);
      expect(text, name).not.toMatch(/@|synthetic\.invalid|127\.0\.0\.1|password/i);
    }
    for (const r of await query<ReceiptRow>(env.superuserUrl, `SELECT * FROM app.idempotency_receipt`)) {
      expect(() => audit.assertAuditSummaryIsSafe(r.outcome)).not.toThrow();
    }
  });
});
