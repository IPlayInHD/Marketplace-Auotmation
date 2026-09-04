import { createHash, randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TENANT_SETTING } from '../../src/db/constants.ts';
import * as auth from '../../src/modules/identity-auth/index.ts';
import { UnauthenticatedError } from '../../src/shared/errors.ts';
import {
  AUTH_PREFIX,
  authStoredText,
  cookieOf,
  get,
  post,
  provisionAccount,
  RELAXED_THROTTLE,
  sellerAuditEvents,
  sessionRows,
  signIn,
  signInEvents,
  signInRequest,
  startAuthApp,
  TEST_ORIGIN,
  testAuthConfig,
  type AuthApp,
  type Session,
  type SyntheticAccount,
} from '../helpers/auth.ts';
import { startDatabase, type TestDatabase } from '../helpers/database.ts';
import { query } from '../helpers/inspect.ts';

// D-19 production proofs over the real routes: sign-in, cookie, hash-only storage, generic
// failures, expiry, rotation, revocation, listing, origin and anti-forgery refusal, trusted
// proxies, tenant context from the session only, pooled-connection reset, rollback, the six
// events, and the secret scans (D-19 conditions 2 to 6). Synthetic accounts only (D-18).

const DOMAIN = 'synthetic.invalid';
const address = (local: string) => [local, DOMAIN].join('@');
const PASSWORD_A = 'synthetic passphrase for seller A';
const PASSWORD_B = 'synthetic passphrase for seller B';

describe('Seller authentication foundation (D-19)', () => {
  let env: TestDatabase;
  let harness: AuthApp;
  let accountA: SyntheticAccount;
  let accountB: SyntheticAccount;
  /** Every value that must never be persisted outside its one legitimate column, audited, logged or returned. */
  const secrets: string[] = [PASSWORD_A, PASSWORD_B];
  /** Anti-forgery values, tracked apart from tokens so their hashes can be scanned for too. */
  const antiForgeryValues: string[] = [];
  const remember = (session: { token: string; antiForgery: string }) => {
    secrets.push(session.token, session.antiForgery);
    antiForgeryValues.push(session.antiForgery);
  };
  const bodies: string[] = [];

  const meRequest = async (token: string | undefined, headers: Record<string, string> = {}) => {
    const res = await get(harness, `${AUTH_PREFIX}/me`, token, headers);
    bodies.push(res.body);
    return res;
  };

  beforeAll(async () => {
    env = await startDatabase();
    accountA = await provisionAccount(env, {
      displayName: 'Synthetic Seller A',
      email: address('seller-a'),
      password: PASSWORD_A,
    });
    accountB = await provisionAccount(env, {
      displayName: 'Synthetic Seller B',
      email: address('Seller-B'),
      password: PASSWORD_B,
    });
    harness = await startAuthApp(env, { poolMax: 4 });
  });

  afterAll(async () => {
    try {
      // Proof 30: no protected authentication material anywhere it does not belong.
      const stored = await authStoredText(env.superuserUrl);
      const hashes = await query<{ h: string }>(
        env.superuserUrl,
        `SELECT encode(token_hash, 'hex') AS h FROM auth.seller_session`,
      );
      const antiForgeryHashes = antiForgeryValues.map((s) => createHash('sha256').update(s).digest('hex'));
      const ledger = await query<{ t: string }>(
        env.superuserUrl,
        `SELECT row_to_json(r)::text AS t FROM auth.sign_in_event r UNION ALL SELECT row_to_json(r)::text FROM auth.sign_in_throttle r
         UNION ALL SELECT row_to_json(r)::text FROM app.audit_event r UNION ALL SELECT row_to_json(r)::text FROM app.idempotency_receipt r`,
      );
      const corpus: Record<string, string> = {
        stored_rows_without_verifier_column: stored.replace(/\$argon2id\$[^"]+/g, '<verifier>'),
        ledger_and_audit: ledger.map((r) => r.t).join('\n'),
        logs: harness.logText(),
        responses: bodies.join('\n'),
      };
      for (const [name, text] of Object.entries(corpus)) {
        // The anti-forgery value is returned to the same-origin client by design; everywhere else it is a secret.
        const forbidden =
          name === 'responses' ? secrets.filter((v) => !antiForgeryValues.includes(v)) : secrets;
        for (const secret of forbidden) expect(text, `${name} carries a secret`).not.toContain(secret);
        for (const h of antiForgeryHashes)
          expect(text, `${name} carries an anti-forgery hash`).not.toContain(h);
        expect(text, `${name} carries a raw address`).not.toMatch(
          /127\.0\.0\.1|203\.0\.113\.|198\.51\.100\./,
        );
        if (name !== 'stored_rows_without_verifier_column') {
          expect(text, `${name} carries a verifier`).not.toContain('$argon2id$');
          expect(text, `${name} carries an account address`).not.toContain(DOMAIN);
          for (const { h } of hashes) expect(text, `${name} carries a token hash`).not.toContain(h);
        }
      }
      expect(corpus['logs']).not.toMatch(
        /"(password|token|tokenHash|antiForgery|email|ip|remoteAddress)":"(?!\[REDACTED\])/,
      );
    } finally {
      await harness?.close();
      await env?.stop();
    }
  });

  it('signs in with an exact __Host- cookie and stores only the token digest and the keyed client hash', async () => {
    const res = await signInRequest(harness, accountA.email, accountA.password);
    bodies.push(res.body);
    expect(res.statusCode).toBe(200);
    const token = cookieOf(res, harness.cookieName)?.value ?? '';
    remember({ token, antiForgery: res.json<{ antiForgery: string }>().antiForgery });
    const raw = res.headers['set-cookie'];
    const header = Array.isArray(raw) ? raw.join('\n') : String(raw);
    expect(header).toBe(
      `__Host-seller_session=${token}; Max-Age=${harness.config.sessionIdleSeconds}; Path=/; HttpOnly; Secure; SameSite=Lax`,
    );
    expect(res.json()).toEqual({ sellerId: accountA.sellerId, antiForgery: expect.any(String) as string });
    expect(res.body).not.toContain(token);

    const rows = await sessionRows(env.superuserUrl, accountA.accountId);
    const row = rows.find((r) => r.token_hash_hex === auth.hashSessionToken(token).toString('hex'));
    expect(row).toBeDefined();
    const expected = auth.hashClientIdentifier('127.0.0.1', {
      key: harness.config.clientHashKey,
      version: harness.config.clientHashKeyVersion,
    });
    expect(row?.client_hash).toBe(expected.hash);
    expect(row?.client_key_version).toBe(1);
    expect(row?.revoked_at).toBeNull();
    const stored = await authStoredText(env.superuserUrl);
    expect(stored).not.toContain(token);
    expect(stored).not.toContain(PASSWORD_A);
    const events = await sellerAuditEvents(env.superuserUrl, accountA.sellerId);
    const signedIn = events.filter((e) => e.event_type === 'SELLER_SIGN_IN_SUCCEEDED').at(-1);
    expect(signedIn).toMatchObject({ subject_type: 'seller_session', subject_id: row?.id });
    expect(signedIn?.summary).toEqual({
      account_id: accountA.accountId,
      client_hash: expected.hash,
      client_key_version: 1,
    });
  });

  it('answers byte-identical generic failures for an unknown account and a wrong password, deriving the key exactly once each', async () => {
    const before = { ...harness.verifyCalls, events: (await signInEvents(env.superuserUrl)).length };
    const unknown = await signInRequest(harness, address('nobody'), 'not the password anyway');
    const wrong = await signInRequest(harness, accountA.email, 'not the password anyway');
    bodies.push(unknown.body, wrong.body);
    for (const res of [unknown, wrong]) {
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'invalid_credentials' });
      expect(cookieOf(res, harness.cookieName)?.value).toBe('');
    }
    expect(unknown.headers['content-length']).toBe(wrong.headers['content-length']);
    expect(unknown.headers['content-type']).toBe(wrong.headers['content-type']);
    expect(harness.verifyCalls.decoy).toBe(before.decoy + 1);
    expect(harness.verifyCalls.real).toBe(before.real + 1);
    const failures = (await signInEvents(env.superuserUrl)).slice(before.events);
    expect(failures.map((e) => e.event_type)).toEqual(['SELLER_SIGN_IN_FAILED', 'SELLER_SIGN_IN_FAILED']);
    expect(failures[0]?.summary).toEqual({});
    expect(failures[1]?.summary).toEqual({});
    expect(failures[0]?.client_hash).toBe(failures[1]?.client_hash);
    expect(failures[0]?.account_subject_hash).not.toBe(failures[1]?.account_subject_hash);
    expect(JSON.stringify(failures)).not.toMatch(/@|synthetic|127\.0\.0\.1|password/);
    // A malformed address or an oversized password answers the same way, without touching accounts.
    const malformed = await signInRequest(harness, 'not an address', 'whatever the attacker typed');
    expect(malformed.statusCode).toBe(401);
    expect(malformed.json()).toEqual({ error: 'invalid_credentials' });
  });

  it('denies missing, malformed, unknown, revoked and expired sessions with one response and clears the cookie', async () => {
    const live = await signIn(harness, accountA);
    remember(live);
    const revoked = await signIn(harness, accountA);
    remember(revoked);
    expect((await post(harness, `${AUTH_PREFIX}/sign-out`, revoked)).statusCode).toBe(204);
    const idle = await signIn(harness, accountA);
    remember(idle);
    await query(
      env.superuserUrl,
      `UPDATE auth.seller_session SET last_seen_at = now() - make_interval(secs => $2) WHERE token_hash = $1`,
      [auth.hashSessionToken(idle.token), harness.config.sessionIdleSeconds + 1],
    );
    const absolute = await signIn(harness, accountA);
    remember(absolute);
    // absolute_expires_at is immutable by trigger (tested below); the clock is moved by the superuser
    // for this proof only, keeping the lifetime constraint satisfied, and the guard is restored.
    await query(env.superuserUrl, `ALTER TABLE auth.seller_session DISABLE TRIGGER seller_session_guard`);
    try {
      await query(
        env.superuserUrl,
        `UPDATE auth.seller_session SET created_at = now() - interval '2 seconds', absolute_expires_at = now() - interval '1 second' WHERE token_hash = $1`,
        [auth.hashSessionToken(absolute.token)],
      );
    } finally {
      await query(env.superuserUrl, `ALTER TABLE auth.seller_session ENABLE TRIGGER seller_session_guard`);
    }

    expect((await meRequest(live.token)).statusCode).toBe(200);
    const cases: [string, string | undefined][] = [
      ['missing', undefined],
      ['malformed', 'not-a-token'],
      ['padded', `${'A'.repeat(43)}=`],
      ['unknown', auth.generateSessionToken()],
      ['revoked', revoked.token],
      ['idle-expired', idle.token],
      ['absolute-expired', absolute.token],
    ];
    const shapes = new Set<string>();
    for (const [label, token] of cases) {
      const res = await meRequest(token, { 'x-seller-id': accountB.sellerId });
      expect(res.statusCode, label).toBe(401);
      expect(res.json(), label).toEqual({ error: 'unauthenticated' });
      expect(cookieOf(res, harness.cookieName)?.value, label).toBe('');
      shapes.add(`${res.headers['content-type']}|${res.headers['content-length']}`);
    }
    expect(shapes.size).toBe(1);
    const noSession = await post(harness, `${AUTH_PREFIX}/sessions/rotate`, undefined);
    expect(noSession.statusCode).toBe(401);
  });

  it('rotates in one transaction, inherits the absolute lifetime, kills the old token, and never carries a presented cookie forward', async () => {
    const first = await signIn(harness, accountA);
    remember(first);
    const rotated = await post(harness, `${AUTH_PREFIX}/sessions/rotate`, first);
    bodies.push(rotated.body);
    expect(rotated.statusCode).toBe(200);
    const next: Session = {
      token: cookieOf(rotated, harness.cookieName)?.value ?? '',
      antiForgery: rotated.json<{ antiForgery: string }>().antiForgery,
    };
    remember(next);
    expect(next.token).not.toBe(first.token);
    expect(rotated.body).not.toContain(next.token);
    const rows = await query<{
      id: string;
      revocation_reason: string | null;
      replaced_by_session_id: string | null;
      absolute_expires_at: Date;
      xmin: string;
    }>(
      env.superuserUrl,
      `SELECT id, revocation_reason, replaced_by_session_id, absolute_expires_at, xmin::text AS xmin FROM auth.seller_session
        WHERE token_hash = ANY($1::bytea[]) ORDER BY created_at`,
      [[auth.hashSessionToken(first.token), auth.hashSessionToken(next.token)]],
    );
    const [old, fresh] = rows;
    expect(old?.revocation_reason).toBe('rotated');
    expect(old?.replaced_by_session_id).toBe(fresh?.id);
    expect(fresh?.revocation_reason).toBeNull();
    expect(String(fresh?.absolute_expires_at)).toBe(String(old?.absolute_expires_at));
    expect(fresh?.xmin).toBe(old?.xmin);
    expect((await meRequest(first.token)).statusCode).toBe(401);
    expect((await meRequest(next.token)).statusCode).toBe(200);
    const events = await sellerAuditEvents(env.superuserUrl, accountA.sellerId);
    expect(events.filter((e) => e.event_type === 'SELLER_SESSION_ROTATED').at(-1)).toMatchObject({
      subject_id: fresh?.id,
      summary: { previous_session_id: old?.id, account_id: accountA.accountId },
    });

    // AUTH-206: a cookie presented at sign-in is neither honoured nor reused.
    const presented = await signInRequest(harness, accountA.email, accountA.password, { cookie: next.token });
    expect(presented.statusCode).toBe(200);
    const issued = cookieOf(presented, harness.cookieName)?.value ?? '';
    remember({ token: issued, antiForgery: presented.json<{ antiForgery: string }>().antiForgery });
    expect(issued).not.toBe(next.token);
    expect((await meRequest(next.token)).statusCode).toBe(200);
  });

  it('serialises concurrent rotation and revocation on one session: exactly one rotation wins and no live duplicate remains', async () => {
    const s = await signIn(harness, accountA);
    remember(s);
    const results = await Promise.all([
      post(harness, `${AUTH_PREFIX}/sessions/rotate`, s),
      post(harness, `${AUTH_PREFIX}/sessions/rotate`, s),
      post(harness, `${AUTH_PREFIX}/sign-out`, s),
      post(harness, `${AUTH_PREFIX}/sessions/rotate`, s),
    ]);
    const codes = results.map((r) => r.statusCode).sort();
    for (const r of results) {
      bodies.push(r.body);
      const c = cookieOf(r, harness.cookieName)?.value;
      if (c) secrets.push(c);
    }
    expect(codes.filter((c) => c === 200 || c === 204)).toHaveLength(1);
    expect(codes.filter((c) => c === 401)).toHaveLength(3);
    const rows = await query<{ n: string }>(
      env.superuserUrl,
      `SELECT count(*)::text AS n FROM auth.seller_session s
        WHERE s.revoked_at IS NULL AND (s.token_hash = $1 OR s.replaced_by_session_id IS NOT NULL AND s.id IN
          (SELECT replaced_by_session_id FROM auth.seller_session WHERE token_hash = $1))`,
      [auth.hashSessionToken(s.token)],
    );
    expect(Number(rows[0]?.n)).toBeLessThanOrEqual(1);
    expect((await meRequest(s.token)).statusCode).toBe(401);
  });

  it('signs out server-side and everywhere, one transaction each, without touching another seller', async () => {
    const a1 = await signIn(harness, accountA);
    const a2 = await signIn(harness, accountA);
    const a3 = await signIn(harness, accountA);
    const b1 = await signIn(harness, accountB);
    for (const s of [a1, a2, a3, b1]) remember(s);
    const out = await post(harness, `${AUTH_PREFIX}/sign-out`, a1);
    expect(out.statusCode).toBe(204);
    expect(cookieOf(out, harness.cookieName)?.value).toBe('');
    expect((await meRequest(a1.token)).statusCode).toBe(401);
    expect((await meRequest(a2.token)).statusCode).toBe(200);
    expect((await post(harness, `${AUTH_PREFIX}/sign-out`, a1)).statusCode).toBe(401);

    const listed = await get(harness, `${AUTH_PREFIX}/sessions`, a2.token);
    bodies.push(listed.body);
    expect(listed.statusCode).toBe(200);
    const sessions = listed.json<{ sessions: Record<string, unknown>[] }>().sessions;
    expect(sessions.length).toBeGreaterThanOrEqual(2);
    for (const s of sessions)
      expect(Object.keys(s).sort()).toEqual([
        'absoluteExpiresAt',
        'createdAt',
        'current',
        'id',
        'lastSeenAt',
      ]);
    expect(sessions.filter((s) => s['current'] === true)).toHaveLength(1);
    expect(listed.body).not.toMatch(/[0-9a-f]{64}/);

    const all = await post(harness, `${AUTH_PREFIX}/sign-out-all`, a2);
    bodies.push(all.body);
    expect(all.statusCode).toBe(200);
    const revoked = all.json<{ revoked: number }>().revoked;
    expect(revoked).toBeGreaterThanOrEqual(2);
    for (const s of [a2, a3]) expect((await meRequest(s.token)).statusCode).toBe(401);
    expect((await meRequest(b1.token)).statusCode).toBe(200);
    const rowsA = (await sessionRows(env.superuserUrl, accountA.accountId)).filter(
      (r) => r.revocation_reason === 'signed_out_all',
    );
    expect(rowsA.length).toBe(revoked);
    expect(new Set(rowsA.map((r) => r.xmin)).size).toBe(1);
    const events = await sellerAuditEvents(env.superuserUrl, accountA.sellerId);
    expect(events.filter((e) => e.event_type === 'SELLER_SIGNED_OUT').at(-1)?.summary).toEqual({
      account_id: accountA.accountId,
    });
    expect(events.filter((e) => e.event_type === 'SELLER_SESSIONS_REVOKED').at(-1)?.summary).toEqual({
      revoked_count: revoked,
      initiated_by_session_id: expect.any(String) as string,
    });
    expect(
      (await sellerAuditEvents(env.superuserUrl, accountB.sellerId)).filter(
        (e) => e.event_type === 'SELLER_SESSIONS_REVOKED',
      ),
    ).toHaveLength(0);
  });

  it('refuses cross-site and anti-forgery-less state changes before any mutation, sign-in included', async () => {
    const before = {
      sessions: (await sessionRows(env.superuserUrl)).length,
      events: (await signInEvents(env.superuserUrl)).length,
      throttle: (
        await query<{ n: string }>(env.superuserUrl, `SELECT count(*)::text AS n FROM auth.sign_in_throttle`)
      )[0]?.n,
      verify: harness.verifyCalls.real + harness.verifyCalls.decoy,
    };
    for (const headers of [
      {},
      { origin: 'https://evil.example' },
      { origin: TEST_ORIGIN, 'sec-fetch-site': 'cross-site' },
      { referer: 'https://evil.example/' },
    ]) {
      const res = await signInRequest(harness, accountA.email, accountA.password, { headers });
      bodies.push(res.body);
      expect(res.statusCode, JSON.stringify(headers)).toBe(403);
      expect(res.json()).toEqual({ error: 'forbidden_origin' });
      expect(cookieOf(res, harness.cookieName)).toBeUndefined();
    }
    expect((await sessionRows(env.superuserUrl)).length).toBe(before.sessions);
    expect((await signInEvents(env.superuserUrl)).length).toBe(before.events);
    expect(
      (
        await query<{ n: string }>(env.superuserUrl, `SELECT count(*)::text AS n FROM auth.sign_in_throttle`)
      )[0]?.n,
    ).toBe(before.throttle);
    expect(harness.verifyCalls.real + harness.verifyCalls.decoy).toBe(before.verify);

    const s = await signIn(harness, accountA);
    remember(s);
    const rowsBefore = await sessionRows(env.superuserUrl, accountA.accountId);
    const auditBefore = (await sellerAuditEvents(env.superuserUrl, accountA.sellerId)).length;
    const crossSite = await post(harness, `${AUTH_PREFIX}/sessions/rotate`, s, {
      headers: { origin: 'https://evil.example' },
    });
    expect(crossSite.statusCode).toBe(403);
    const noValue = await post(harness, `${AUTH_PREFIX}/sign-out-all`, { token: s.token, antiForgery: '' });
    expect(noValue.statusCode).toBe(403);
    expect(noValue.json()).toEqual({ error: 'forbidden_anti_forgery' });
    const otherValue = await post(harness, `${AUTH_PREFIX}/sign-out`, {
      token: s.token,
      antiForgery: auth.antiForgeryTokenFor(auth.generateSessionToken()),
    });
    expect(otherValue.statusCode).toBe(403);
    expect(await sessionRows(env.superuserUrl, accountA.accountId)).toEqual(rowsBefore);
    expect((await sellerAuditEvents(env.superuserUrl, accountA.sellerId)).length).toBe(auditBefore);
    expect((await meRequest(s.token)).statusCode).toBe(200);
  });

  it('derives the tenant from the session only and ignores seller identifiers in headers, query or body', async () => {
    const a = await signIn(harness, accountA);
    remember(a);
    const spoofed = await get(
      harness,
      `${AUTH_PREFIX}/me?sellerId=${accountB.sellerId}&seller_id=${accountB.sellerId}`,
      a.token,
      {
        'x-seller-id': accountB.sellerId,
        'x-forwarded-for': '203.0.113.9',
      },
    );
    bodies.push(spoofed.body);
    expect(spoofed.statusCode).toBe(200);
    expect(spoofed.json()).toMatchObject({ sellerId: accountA.sellerId, displayName: 'Synthetic Seller A' });
    const extraKey = await harness.app.inject({
      method: 'POST',
      url: `${AUTH_PREFIX}/sign-in`,
      headers: { origin: TEST_ORIGIN },
      payload: { email: accountA.email, password: accountA.password, sellerId: accountB.sellerId },
    });
    expect(extraKey.statusCode).toBe(400);
    expect(extraKey.json()).toEqual({ error: 'bad_request' });
    // The construction site itself refuses anything but a well-formed token.
    const service = auth.createAuthService({
      db: harness.runtime.db,
      config: harness.config,
      passwords: await auth.createPasswordVerifier(),
      throttle: RELAXED_THROTTLE,
    });
    for (const bad of [undefined, null, accountA.sellerId, { sellerId: accountA.sellerId }, 'x'.repeat(43)]) {
      await expect(service.withSellerSession(bad, () => Promise.resolve('reached'))).rejects.toBeInstanceOf(
        UnauthenticatedError,
      );
    }
  });

  it('leaves no tenant context on a pooled connection after an authenticated request', async () => {
    const single = await startAuthApp(env, {
      poolMax: 1,
      config: { clientHashKey: harness.config.clientHashKey },
    });
    try {
      const s = await signIn(single, accountA);
      remember(s);
      const me = await get(single, `${AUTH_PREFIX}/me`, s.token);
      bodies.push(me.body);
      expect(me.statusCode).toBe(200);
      const bare = await sql<{ ctx: string | null; sellers: string }>`
        select current_setting(${TENANT_SETTING}, true) as ctx, (select count(*) from app.seller)::text as sellers`.execute(
        single.runtime.db,
      );
      expect(bare.rows[0]?.ctx ?? '').toBe('');
      expect(bare.rows[0]?.sellers).toBe('0');
      // Inside the transaction the context was the session's seller and nothing else.
      const service = auth.createAuthService({
        db: single.runtime.db,
        config: single.config,
        passwords: await auth.createPasswordVerifier(),
        throttle: RELAXED_THROTTLE,
      });
      const seen = await service.withSellerSession(s.token, async (trx, principal) => {
        const row = await sql<{
          ctx: string;
        }>`select current_setting(${TENANT_SETTING}, true) as ctx`.execute(trx);
        return { ctx: row.rows[0]?.ctx, principal };
      });
      expect(seen.ctx).toBe(accountA.sellerId);
      expect(seen.principal.sellerId).toBe(accountA.sellerId);
      const after = await sql<{
        ctx: string | null;
      }>`select current_setting(${TENANT_SETTING}, true) as ctx`.execute(single.runtime.db);
      expect(after.rows[0]?.ctx ?? '').toBe('');
    } finally {
      await single.close();
    }
  });

  it('rolls back the session and its audit event together when the transaction fails after the write', async () => {
    const s = await signIn(harness, accountA);
    remember(s);
    const service = auth.createAuthService({
      db: harness.runtime.db,
      config: harness.config,
      passwords: await auth.createPasswordVerifier(),
      throttle: RELAXED_THROTTLE,
    });
    const rowsBefore = await sessionRows(env.superuserUrl, accountA.accountId);
    const auditBefore = (await sellerAuditEvents(env.superuserUrl, accountA.sellerId)).length;
    // A client hash the schema refuses makes the keyhole fail after the transaction began.
    await expect(
      service.rotateSession(s.token, { hash: 'not-hex', keyVersion: 1 }, `req-${randomUUID()}`),
    ).rejects.toThrow();
    expect(await sessionRows(env.superuserUrl, accountA.accountId)).toEqual(rowsBefore);
    expect((await sellerAuditEvents(env.superuserUrl, accountA.sellerId)).length).toBe(auditBefore);
    expect((await meRequest(s.token)).statusCode).toBe(200);
    const signInBefore = (await sessionRows(env.superuserUrl, accountA.accountId)).length;
    const failed = await service
      .signIn({
        email: accountA.email,
        password: accountA.password,
        client: { hash: 'zz', keyVersion: 1 },
        requestId: `req-${randomUUID()}`,
      })
      .catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(Error);
    expect((await sessionRows(env.superuserUrl, accountA.accountId)).length).toBe(signInBefore);
    expect((await sellerAuditEvents(env.superuserUrl, accountA.sellerId)).length).toBe(auditBefore);
  });

  it('trusts forwarding headers only from configured proxies and fails closed on ambiguity', async () => {
    const proxied = await startAuthApp(env, {
      config: { clientHashKey: harness.config.clientHashKey, trustedProxies: ['10.0.0.0/8'] },
    });
    try {
      const key = { key: proxied.config.clientHashKey, version: proxied.config.clientHashKeyVersion };
      const hashOf = async (res: Awaited<ReturnType<typeof signInRequest>>) => {
        const token = cookieOf(res, proxied.cookieName)?.value ?? '';
        remember({ token, antiForgery: res.json<{ antiForgery: string }>().antiForgery });
        return (await sessionRows(env.superuserUrl)).find(
          (r) => r.token_hash_hex === auth.hashSessionToken(token).toString('hex'),
        )?.client_hash;
      };
      const untrusted = await signInRequest(proxied, accountA.email, accountA.password, {
        headers: { origin: TEST_ORIGIN, 'x-forwarded-for': '198.51.100.7', forwarded: 'for=198.51.100.7' },
        remoteAddress: '203.0.113.5',
      });
      expect(untrusted.statusCode).toBe(200);
      expect(await hashOf(untrusted)).toBe(auth.hashClientIdentifier('203.0.113.5', key).hash);
      const trusted = await signInRequest(proxied, accountA.email, accountA.password, {
        headers: { origin: TEST_ORIGIN, 'x-forwarded-for': 'spoofed, 198.51.100.7, 10.0.0.9' },
        remoteAddress: '10.0.0.2',
      });
      expect(trusted.statusCode).toBe(200);
      expect(await hashOf(trusted)).toBe(auth.hashClientIdentifier('198.51.100.7', key).hash);
      for (const [label, extra] of [
        ['no header from a trusted proxy', { headers: { origin: TEST_ORIGIN }, remoteAddress: '10.0.0.2' }],
        [
          'malformed chain',
          { headers: { origin: TEST_ORIGIN, 'x-forwarded-for': 'garbage' }, remoteAddress: '10.0.0.2' },
        ],
        [
          'conflicting headers',
          {
            headers: { origin: TEST_ORIGIN, 'x-forwarded-for': '198.51.100.7', forwarded: 'for=203.0.113.9' },
            remoteAddress: '10.0.0.2',
          },
        ],
      ] as const) {
        const sessionsBefore = (await sessionRows(env.superuserUrl)).length;
        const res = await signInRequest(proxied, accountA.email, accountA.password, extra);
        bodies.push(res.body);
        expect(res.statusCode, label).toBe(400);
        expect(res.json(), label).toEqual({ error: 'bad_request' });
        expect((await sessionRows(env.superuserUrl)).length, label).toBe(sessionsBefore);
      }
    } finally {
      await proxied.close();
    }
  });

  it('keeps account and session identity immutable, revocation final, and the runtime role away from the tables', async () => {
    expect((await signInRequest(harness, accountA.email, 'wrong password for the ledger')).statusCode).toBe(
      401,
    );
    const s = await signIn(harness, accountA);
    remember(s);
    const h = auth.hashSessionToken(s.token);
    for (const [statement, code] of [
      [
        `UPDATE auth.seller_session SET token_hash = decode(repeat('00', 32), 'hex') WHERE token_hash = $1`,
        'SS001',
      ],
      [
        `UPDATE auth.seller_session SET absolute_expires_at = now() + interval '1 year' WHERE token_hash = $1`,
        'SS001',
      ],
      [`UPDATE auth.seller_session SET client_hash = repeat('a', 64) WHERE token_hash = $1`, 'SS001'],
      [`DELETE FROM auth.seller_session WHERE token_hash = $1`, 'SS001'],
      [
        `UPDATE auth.seller_account SET seller_id = gen_random_uuid() WHERE id = (SELECT account_id FROM auth.seller_session WHERE token_hash = $1)`,
        'SA001',
      ],
      [
        `DELETE FROM auth.seller_account WHERE id = (SELECT account_id FROM auth.seller_session WHERE token_hash = $1)`,
        'SA001',
      ],
      [
        `UPDATE auth.sign_in_event SET summary = '{}' WHERE id = (SELECT id FROM auth.sign_in_event LIMIT 1) AND $1::bytea IS NOT NULL`,
        'AP001',
      ],
    ] as const) {
      await expect(query(env.migratorUrl, statement, [h]), statement).rejects.toMatchObject({ code });
    }
    expect((await post(harness, `${AUTH_PREFIX}/sign-out`, s)).statusCode).toBe(204);
    await expect(
      query(
        env.migratorUrl,
        `UPDATE auth.seller_session SET revoked_at = NULL, revocation_reason = NULL WHERE token_hash = $1`,
        [h],
      ),
    ).rejects.toMatchObject({ code: 'SS002' });
    await expect(
      query(env.migratorUrl, `UPDATE auth.seller_session SET last_seen_at = now() WHERE token_hash = $1`, [
        h,
      ]),
    ).rejects.toMatchObject({ code: 'SS002' });
    for (const statement of [
      'SELECT * FROM auth.seller_account',
      'SELECT * FROM auth.seller_session',
      'SELECT * FROM auth.sign_in_throttle',
      'SELECT * FROM auth.sign_in_event',
      `INSERT INTO auth.seller_account (seller_id, email, email_normalized, password_hash) VALUES (gen_random_uuid(), 'x', 'x', 'x')`,
      'DELETE FROM auth.seller_session',
      'CREATE TABLE auth.evil (id int)',
      'ALTER TABLE auth.seller_session DISABLE TRIGGER seller_session_guard',
    ]) {
      await expect(query(env.runtimeUrl, statement), statement).rejects.toMatchObject({ code: '42501' });
    }
  });

  it('holds only synthetic accounts and data', async () => {
    const accounts = await query<{ email: string; email_normalized: string; display_name: string }>(
      env.superuserUrl,
      `SELECT a.email, a.email_normalized, s.display_name FROM auth.seller_account a JOIN app.seller s ON s.id = a.seller_id`,
    );
    expect(accounts.length).toBeGreaterThanOrEqual(2);
    for (const a of accounts) {
      expect(a.email.endsWith(`@${DOMAIN}`)).toBe(true);
      expect(a.email_normalized).toBe(a.email.toLowerCase());
      expect(a.display_name).toMatch(/^Synthetic Seller/);
    }
    expect(accountB.email).toContain('Seller-B');
    const signedInB = await signInRequest(harness, address('SELLER-B'), PASSWORD_B);
    expect(signedInB.statusCode).toBe(200);
    remember({
      token: cookieOf(signedInB, harness.cookieName)?.value ?? '',
      antiForgery: signedInB.json<{ antiForgery: string }>().antiForgery,
    });
  });

  it('exposes exactly the six authentication routes, all declared, and nothing else under the seller prefix', async () => {
    const routes = harness.app.printRoutes({ commonPrefix: false });
    expect(routes).toContain('/seller/auth/sign-in (POST)');
    expect(routes).not.toMatch(/sign-up|register|reset|verify|listing/);
    for (const [method, url] of [
      ['POST', '/seller/auth/sign-up'],
      ['POST', '/seller/auth/reset'],
      ['GET', '/seller/listings'],
      ['POST', '/seller/listings'],
    ] as const) {
      const res = await harness.app.inject({ method, url, headers: { origin: TEST_ORIGIN } });
      expect(res.statusCode, `${method} ${url}`).toBe(404);
      expect(res.json()).toEqual({ error: 'not_found' });
    }
  });

  it('refuses synthetic provisioning in production, weak passwords and duplicate addresses', async () => {
    const passwords = await auth.createPasswordVerifier();
    const migrator = (await import('../../src/db/kysely.ts')).createDb(env.migratorUrl, { max: 1 });
    const sellers = await import('../../src/modules/sellers/index.ts');
    const create = (db: typeof migrator.db, displayName: string, requestId: string) =>
      sellers.createSeller(db, { displayName, requestId });
    try {
      await expect(
        auth.provisionSyntheticAccount(
          migrator.db,
          passwords,
          'production',
          { displayName: 'Synthetic Seller P', email: address('seller-p'), password: PASSWORD_A },
          create,
          'req-p',
        ),
      ).rejects.toThrow(/production/);
      await expect(
        auth.provisionSyntheticAccount(
          migrator.db,
          passwords,
          'ci',
          { displayName: 'Synthetic Seller W', email: address('seller-w'), password: 'short' },
          create,
          'req-w',
        ),
      ).rejects.toBeInstanceOf(auth.PasswordPolicyError);
      await expect(
        auth.provisionSyntheticAccount(
          migrator.db,
          passwords,
          'ci',
          { displayName: 'Synthetic Seller D', email: address('SELLER-A'), password: PASSWORD_A },
          create,
          'req-d',
        ),
      ).rejects.toMatchObject({ code: '23505' });
    } finally {
      await migrator.close();
    }
    const config = testAuthConfig();
    expect(config.clientHashKey.length).toBe(32);
  });
});
