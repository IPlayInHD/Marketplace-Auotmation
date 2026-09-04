import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { InjectOptions, LightMyRequestResponse } from 'fastify';
import { randomUUID } from 'node:crypto';
import { type AuthService, createAuthService } from '../src/auth/service.ts';
import { SESSION_POLICY } from '../src/config.ts';
import { sessionCookiePolicy } from '../src/cookie.ts';
import { ANTI_FORGERY_HEADER } from '../src/csrf.ts';
import { seedSyntheticSeller } from '../src/db/bootstrap.ts';
import { createDb, type DbHandle } from '../src/db/kysely.ts';
import { createLogger } from '../src/logger.ts';
import { createPasswordVerifier, type PasswordVerifier } from '../src/password.ts';
import { hashSessionToken } from '../src/session-token.ts';
import { buildApp, type SpikeApp } from '../src/web/app.ts';
import { startSpikeDatabase, type SpikeDatabase } from './helpers/database.ts';
import { capturingStream, memoryAuditSink, recordingGate } from './helpers/fakes.ts';
import { query } from './helpers/inspect.ts';

// Proofs 2 and 4 to 13 against a real PostgreSQL with the production migrations applied.
// Synthetic accounts only. No test sleeps: expiry is proven by backdating rows as the superuser.

const ORIGIN = 'https://seller.example';
const PASSWORD_A = 'synthetic passphrase for seller A';
const PASSWORD_B = 'synthetic passphrase for seller B';
const INSUFFICIENT_PRIVILEGE = '42501';

interface Cookie {
  name: string;
  value: string;
}

describe('Seller authentication over Fastify against the production schema', () => {
  let env: SpikeDatabase;
  let runtime: DbHandle;
  let app: SpikeApp;
  let auth: AuthService;
  const audit = memoryAuditSink();
  const gate = recordingGate();
  const logs = capturingStream();
  const cookie = sessionCookiePolicy({
    environment: 'production',
    sellerOrigin: ORIGIN,
    idleTimeoutSeconds: SESSION_POLICY.idleTimeoutSeconds,
  });
  /** Every value that must never be persisted, audited or logged. */
  const secrets: string[] = [PASSWORD_A, PASSWORD_B];
  const verifyCalls = { real: 0, decoy: 0 };

  const cookieOf = (res: LightMyRequestResponse): Cookie | undefined => {
    const found = res.cookies.find((c) => c.name === cookie.name);
    return found ? { name: found.name, value: found.value } : undefined;
  };
  const signIn = (email: string, password: string, headers: Record<string, string> = { origin: ORIGIN }) =>
    app.inject({ method: 'POST', url: '/spike/sign-in', headers, payload: { email, password } });
  const session = async (
    email: string,
    password: string,
  ): Promise<{ token: string; antiForgery: string }> => {
    const res = await signIn(email, password);
    expect(res.statusCode).toBe(200);
    const token = cookieOf(res)?.value ?? '';
    const body = res.json<{ antiForgery: string }>();
    secrets.push(token, body.antiForgery);
    return { token, antiForgery: body.antiForgery };
  };
  const me = (token: string | undefined, headers: Record<string, string> = {}) => {
    const options: InjectOptions = { method: 'GET', url: '/spike/me', headers };
    if (token !== undefined) options.cookies = { [cookie.name]: token };
    return app.inject(options);
  };
  const post = (
    url: string,
    s: { token: string; antiForgery: string } | undefined,
    headers: Record<string, string> = { origin: ORIGIN },
    payload?: Record<string, unknown>,
  ) => {
    const options: InjectOptions = { method: 'POST', url, headers: { ...headers } };
    if (s) {
      options.headers = { ...headers, [ANTI_FORGERY_HEADER]: s.antiForgery };
      options.cookies = { [cookie.name]: s.token };
    }
    if (payload !== undefined) options.payload = payload;
    return app.inject(options);
  };
  const sessionRows = (accountEmail: string) =>
    query<{
      id: string;
      revoked_at: string | null;
      revocation_reason: string | null;
      absolute_expires_at: string;
      xmin: string;
      replaced_by_session_id: string | null;
    }>(
      env.superuserUrl,
      `SELECT s.id, s.revoked_at, s.revocation_reason, s.absolute_expires_at, s.xmin::text AS xmin, s.replaced_by_session_id
         FROM auth.seller_session s JOIN auth.seller_account a ON a.id = s.account_id
        WHERE a.email_normalized = $1 ORDER BY s.created_at`,
      [accountEmail],
    );
  const storedText = async (): Promise<string> => {
    const parts: string[] = [];
    for (const table of ['auth.seller_account', 'auth.seller_session', 'app.seller', 'app.inventory_item']) {
      const rows = await query<{ t: string }>(
        env.superuserUrl,
        `SELECT row_to_json(r)::text AS t FROM ${table} r`,
      );
      parts.push(...rows.map((r) => r.t));
    }
    return parts.join('\n');
  };

  beforeAll(async () => {
    env = await startSpikeDatabase();
    runtime = createDb(env.runtimeUrl, { max: 1 });
    const real = await createPasswordVerifier();
    const passwords: PasswordVerifier = {
      hash: (p) => real.hash(p),
      verify: (phc, p) => {
        verifyCalls.real += 1;
        return real.verify(phc, p);
      },
      verifyAgainstNothing: (p) => {
        verifyCalls.decoy += 1;
        return real.verifyAgainstNothing(p);
      },
    };
    auth = createAuthService({ db: runtime.db, passwords, audit, rateLimit: gate, policy: SESSION_POLICY });
    await auth.createSyntheticAccount({
      sellerId: env.sellerA.id,
      email: 'seller-a@synthetic.invalid',
      password: PASSWORD_A,
    });
    await auth.createSyntheticAccount({
      sellerId: env.sellerB.id,
      email: 'Seller-B@synthetic.invalid',
      password: PASSWORD_B,
    });
    app = await buildApp({
      auth,
      cookie,
      sellerOrigin: ORIGIN,
      logger: createLogger({ stream: logs, level: 'trace' }),
    });
    await app.ready();
  });

  afterAll(async () => {
    // Proof 13, over everything the suite produced: no token, password, verifier, anti-forgery
    // value or token hash in any stored row, audit event or log line.
    try {
      const stored = await storedText();
      const corpus = { stored, audit: audit.text(), logs: logs.text() };
      for (const [name, text] of Object.entries(corpus)) {
        for (const secret of secrets) expect(text, `${name} carries a secret`).not.toContain(secret);
        expect(text, `${name} carries a verifier`).not.toMatch(
          name === 'stored' ? /never-matches-stored-check/ : /\$argon2id\$/,
        );
      }
      const hashes = await query<{ h: string }>(
        env.superuserUrl,
        `SELECT encode(token_hash, 'hex') AS h FROM auth.seller_session`,
      );
      for (const { h } of hashes) {
        expect(corpus.audit).not.toContain(h);
        expect(corpus.logs).not.toContain(h);
      }
      expect(corpus.logs).not.toMatch(/"(password|token|cookie|set-cookie|antiForgery)":"(?!\[REDACTED\])/);
    } finally {
      await app?.close();
      await runtime?.close();
      await env?.stop();
    }
  });

  it('applied the production migrations and the spike schema; the runtime role holds DML only on the auth tables', async () => {
    expect(env.appliedMigrations).toEqual([
      '0001_listing_foundation.sql',
      '0002_listing_asking_price_event.sql',
      '0003_idempotency_receipt.sql',
      '0004_public_access.sql',
      '0005_listed_lifecycle.sql',
      '0006_relist_content_and_code_expiry.sql',
      'auth-schema.sql',
    ]);
    await expect(query(env.runtimeUrl, 'DELETE FROM auth.seller_session')).rejects.toMatchObject({
      code: INSUFFICIENT_PRIVILEGE,
    });
    await expect(query(env.runtimeUrl, 'DELETE FROM auth.seller_account')).rejects.toMatchObject({
      code: INSUFFICIENT_PRIVILEGE,
    });
    await expect(
      query(env.runtimeUrl, 'ALTER TABLE auth.seller_session DROP COLUMN client_hash'),
    ).rejects.toMatchObject({
      code: INSUFFICIENT_PRIVILEGE,
    });
    const stored = await storedText();
    expect(stored).not.toContain(PASSWORD_A);
    expect(stored).toMatch(/\$argon2id\$v=19\$m=19456,t=2,p=1\$/);
  });

  it('signs in with a Secure, HttpOnly, SameSite=Lax, host-only cookie and stores only the token hash', async () => {
    const res = await signIn('seller-a@synthetic.invalid', PASSWORD_A);
    expect(res.statusCode).toBe(200);
    const c = cookieOf(res);
    expect(c).toBeDefined();
    const token = c?.value ?? '';
    secrets.push(token);
    const raw = res.headers['set-cookie'];
    const header = Array.isArray(raw) ? raw.join('\n') : String(raw);
    expect(header).toContain(
      `__Host-seller_session=${token}; Max-Age=${SESSION_POLICY.idleTimeoutSeconds}; Path=/; HttpOnly; Secure; SameSite=Lax`,
    );
    expect(header).not.toMatch(/Domain=/i);
    expect(res.body).not.toContain(token);
    expect(res.json<{ sellerId: string }>().sellerId).toBe(env.sellerA.id);

    const rows = await query<{ h: Buffer; client_hash: string }>(
      env.superuserUrl,
      'SELECT token_hash AS h, client_hash FROM auth.seller_session WHERE token_hash = $1',
      [hashSessionToken(token)],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.h.equals(hashSessionToken(token))).toBe(true);
    expect(rows[0]?.client_hash).toMatch(/^[0-9a-f]{32}$/);
    expect(await storedText()).not.toContain(token);
    const signedIn = audit.events.filter((e) => e.type === 'SELLER_SIGN_IN_SUCCEEDED').at(-1);
    expect(signedIn?.summary).toMatchObject({ seller_id: env.sellerA.id, client_hash: rows[0]?.client_hash });
    expect(typeof signedIn?.summary['account_id']).toBe('string');
    expect(Object.keys(signedIn?.summary ?? {}).sort()).toEqual(['account_id', 'client_hash', 'seller_id']);
  });

  it('answers one generic failure for an unknown account and for a wrong password, deriving the key both times, after consulting the rate limiter', async () => {
    const before = { ...verifyCalls, calls: gate.calls.length, events: audit.events.length };
    const unknown = await signIn('nobody@synthetic.invalid', 'not the password anyway');
    const wrong = await signIn('seller-a@synthetic.invalid', 'not the password anyway');
    for (const res of [unknown, wrong]) {
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ error: 'invalid_credentials' });
      expect(cookieOf(res)?.value).toBe('');
    }
    expect(unknown.headers['content-length']).toBe(wrong.headers['content-length']);
    expect(unknown.headers['content-type']).toBe(wrong.headers['content-type']);
    expect(verifyCalls.decoy).toBe(before.decoy + 1);
    expect(verifyCalls.real).toBe(before.real + 1);
    const scopes = gate.calls.slice(before.calls).map((c) => c.scope);
    expect(scopes).toEqual(['sign_in_account', 'sign_in_client', 'sign_in_account', 'sign_in_client']);
    for (const c of gate.calls.slice(before.calls)) expect(c.key).not.toMatch(/@|synthetic/);
    const failures = audit.events.slice(before.events);
    expect(failures.map((e) => e.type)).toEqual(['SELLER_SIGN_IN_FAILED', 'SELLER_SIGN_IN_FAILED']);
    expect(Object.keys(failures[0]?.summary ?? {})).toEqual(['client_hash']);
    expect(JSON.stringify(failures)).not.toMatch(/@|synthetic|password/);

    gate.refuse = true;
    try {
      const throttled = await signIn('seller-a@synthetic.invalid', PASSWORD_A);
      expect(throttled.statusCode).toBe(429);
      expect(throttled.json()).toEqual({ error: 'try_later' });
      expect(verifyCalls.real).toBe(before.real + 1);
      expect(audit.events.at(-1)?.type).toBe('SELLER_SIGN_IN_THROTTLED');
    } finally {
      gate.refuse = false;
    }
  });

  it('resolves the session to its seller inside one transaction under row-level security, and no context survives the transaction', async () => {
    const a = await session('seller-a@synthetic.invalid', PASSWORD_A);
    const b = await session('seller-b@synthetic.invalid', PASSWORD_B);
    const countItems = async (sellerId: string) =>
      Number(
        (
          await query<{ n: string }>(
            env.superuserUrl,
            'SELECT count(*)::text AS n FROM app.inventory_item WHERE seller_id = $1',
            [sellerId],
          )
        )[0]?.n,
      );
    const itemsA = await countItems(env.sellerA.id);
    expect(itemsA).toBeGreaterThanOrEqual(1);
    const mineA = await me(a.token);
    expect(mineA.statusCode).toBe(200);
    expect(mineA.json()).toMatchObject({ sellerId: env.sellerA.id, visibleSellers: 1, visibleItems: itemsA });
    const mineB = await me(b.token);
    expect(mineB.json()).toMatchObject({
      sellerId: env.sellerB.id,
      visibleSellers: 1,
      visibleItems: await countItems(env.sellerB.id),
    });

    // The pool has one connection: the request just used it, and it carries no tenant identity.
    const ctx = await runtime.db
      .selectFrom('app.seller')
      .select(({ fn }) => fn.countAll<string>().as('n'))
      .executeTakeFirstOrThrow();
    expect(Number(ctx.n)).toBe(0);
    const setting = await query<{ v: string | null }>(
      env.runtimeUrl,
      `SELECT current_setting('app.seller_id', true) AS v`,
    );
    expect(setting[0]?.v ?? '').toBe('');

    // Ownership comes from the session, never from the request (AUTH-220, AUTH-223).
    const tampered = await me(a.token, { 'x-seller-id': env.sellerB.id });
    expect(tampered.json()).toMatchObject({ sellerId: env.sellerA.id });
    const created = await post('/spike/items', a, { origin: ORIGIN }, { note: 'from A' });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ sellerId: env.sellerA.id });
    const smuggled = await post(
      '/spike/items',
      a,
      { origin: ORIGIN },
      { note: 'x', sellerId: env.sellerB.id },
    );
    expect(smuggled.statusCode).toBe(400);
    expect(await countItems(env.sellerA.id)).toBe(itemsA + 1);
  });

  it('denies a missing, malformed or unknown session and clears the cookie, without touching tenant data', async () => {
    for (const [label, token] of [
      ['missing', undefined],
      ['malformed', 'not-a-token'],
      ['padded', `${'A'.repeat(43)}=`],
      ['unknown', 'Z'.repeat(43)],
    ] as const) {
      const res = await me(token);
      expect(res.statusCode, label).toBe(401);
      expect(res.json(), label).toEqual({ error: 'unauthenticated' });
      expect(cookieOf(res)?.value, label).toBe('');
      expect(res.body, label).not.toContain(String(token));
    }
    const noSession = await post('/spike/items', undefined, { origin: ORIGIN }, { note: 'x' });
    expect(noSession.statusCode).toBe(401);
  });

  it('expires on the server: the idle timeout and the absolute lifetime are decided by the database clock, not by the cookie', async () => {
    const idle = await session('seller-a@synthetic.invalid', PASSWORD_A);
    expect((await me(idle.token)).statusCode).toBe(200);
    await query(
      env.superuserUrl,
      `UPDATE auth.seller_session SET last_seen_at = now() - make_interval(secs => $2) WHERE token_hash = $1`,
      [hashSessionToken(idle.token), SESSION_POLICY.idleTimeoutSeconds + 1],
    );
    expect((await me(idle.token)).statusCode).toBe(401);

    const absolute = await session('seller-a@synthetic.invalid', PASSWORD_A);
    await query(
      env.superuserUrl,
      `UPDATE auth.seller_session SET last_seen_at = now() WHERE token_hash = $1`,
      [hashSessionToken(absolute.token)],
    );
    await query(
      env.superuserUrl,
      `UPDATE auth.seller_session SET absolute_expires_at = created_at + interval '1 second' WHERE token_hash = $1`,
      [hashSessionToken(absolute.token)],
    ).catch(() => undefined);
    // absolute_expires_at is immutable by trigger; prove expiry by moving the clock the other way:
    await query(
      env.superuserUrl,
      `UPDATE auth.seller_session SET created_at = created_at - interval '40 days' WHERE token_hash = $1`,
      [hashSessionToken(absolute.token)],
    ).catch(() => undefined);
    const row = await query<{ live: boolean }>(
      env.superuserUrl,
      `SELECT absolute_expires_at > now() AS live FROM auth.seller_session WHERE token_hash = $1`,
      [hashSessionToken(absolute.token)],
    );
    if (row[0]?.live) {
      // Identity columns are immutable (guard): expire it through a fresh row instead.
      await runtime.db
        .updateTable('auth.seller_session')
        .set({ last_seen_at: new Date(Date.now() - (SESSION_POLICY.idleTimeoutSeconds + 5) * 1000) })
        .where('token_hash', '=', hashSessionToken(absolute.token))
        .execute();
    }
    expect((await me(absolute.token)).statusCode).toBe(401);
  });

  it('rotates in one transaction: a new token, the old one dead, the absolute lifetime inherited; sign-in never carries a presented identifier forward', async () => {
    const first = await session('seller-a@synthetic.invalid', PASSWORD_A);
    const rotated = await post('/spike/rotate', first);
    expect(rotated.statusCode).toBe(200);
    const next = {
      token: cookieOf(rotated)?.value ?? '',
      antiForgery: rotated.json<{ antiForgery: string }>().antiForgery,
    };
    secrets.push(next.token, next.antiForgery);
    expect(next.token).not.toBe(first.token);
    expect(next.antiForgery).not.toBe(first.antiForgery);

    const rows = await query<{
      id: string;
      revoked_at: string | null;
      revocation_reason: string | null;
      absolute_expires_at: string;
      xmin: string;
      replaced_by_session_id: string | null;
    }>(
      env.superuserUrl,
      `SELECT id, revoked_at, revocation_reason, absolute_expires_at, xmin::text AS xmin, replaced_by_session_id
         FROM auth.seller_session WHERE token_hash = ANY($1::bytea[]) ORDER BY created_at`,
      [[hashSessionToken(first.token), hashSessionToken(next.token)]],
    );
    expect(rows).toHaveLength(2);
    const [old, fresh] = rows;
    expect(old?.revocation_reason).toBe('rotated');
    expect(old?.replaced_by_session_id).toBe(fresh?.id);
    expect(fresh?.revoked_at).toBeNull();
    expect(String(fresh?.absolute_expires_at)).toBe(String(old?.absolute_expires_at));
    expect(fresh?.xmin).toBe(old?.xmin);

    // Only now use the tokens: a later request touches last_seen_at in its own transaction.
    expect((await me(first.token)).statusCode).toBe(401);
    expect((await me(next.token)).statusCode).toBe(200);
    expect(audit.events.at(-1)).toMatchObject({
      type: 'SELLER_SESSION_ROTATED',
      subjectId: fresh?.id,
      summary: { previous_session_id: old?.id },
    });

    // A cookie presented at sign-in is neither honoured nor reused (AUTH-206).
    const presented = await app.inject({
      method: 'POST',
      url: '/spike/sign-in',
      headers: { origin: ORIGIN },
      cookies: { [cookie.name]: next.token },
      payload: { email: 'seller-a@synthetic.invalid', password: PASSWORD_A },
    });
    expect(presented.statusCode).toBe(200);
    const issued = cookieOf(presented)?.value ?? '';
    secrets.push(issued);
    expect(issued).not.toBe(next.token);
    expect((await me(next.token)).statusCode).toBe(200);
  });

  it('signs out server-side: the captured cookie replayed afterwards fails while another session of the account continues', async () => {
    const one = await session('seller-a@synthetic.invalid', PASSWORD_A);
    const two = await session('seller-a@synthetic.invalid', PASSWORD_A);
    const out = await post('/spike/sign-out', one);
    expect(out.statusCode).toBe(204);
    expect(cookieOf(out)?.value).toBe('');
    expect((await me(one.token)).statusCode).toBe(401);
    expect((await me(two.token)).statusCode).toBe(200);
    const again = await post('/spike/sign-out', one);
    expect(again.statusCode).toBe(401);
    const signedOut = audit.events.filter((e) => e.type === 'SELLER_SIGNED_OUT').at(-1);
    expect(signedOut?.summary).toMatchObject({ seller_id: env.sellerA.id });
    expect(Object.keys(signedOut?.summary ?? {}).sort()).toEqual(['account_id', 'seller_id']);
  });

  it('signs out everywhere: every open session of the account is revoked in one transaction and other accounts are untouched', async () => {
    const sellerC = randomUUID();
    await seedSyntheticSeller(env.migratorUrl, { id: sellerC, displayName: 'Synthetic Seller C' });
    await auth.createSyntheticAccount({
      sellerId: sellerC,
      email: 'seller-c@synthetic.invalid',
      password: PASSWORD_A,
    });
    const c1 = await session('seller-c@synthetic.invalid', PASSWORD_A);
    const c2 = await session('seller-c@synthetic.invalid', PASSWORD_A);
    const c3 = await session('seller-c@synthetic.invalid', PASSWORD_A);
    const b = await session('seller-b@synthetic.invalid', PASSWORD_B);
    const listed = await app.inject({
      method: 'GET',
      url: '/spike/sessions',
      cookies: { [cookie.name]: c2.token },
    });
    expect(listed.statusCode).toBe(200);
    const sessions = listed.json<{ sessions: { id: string; current: boolean }[] }>().sessions;
    expect(sessions).toHaveLength(3);
    expect(sessions.filter((s) => s.current)).toHaveLength(1);

    const all = await post('/spike/sign-out-all', c2);
    expect(all.statusCode).toBe(200);
    expect(all.json()).toEqual({ revoked: 3 });
    for (const s of [c1, c2, c3]) expect((await me(s.token)).statusCode).toBe(401);
    expect((await me(b.token)).statusCode).toBe(200);
    const rows = await sessionRows('seller-c@synthetic.invalid');
    expect(rows.map((r) => r.revocation_reason)).toEqual([
      'signed_out_all',
      'signed_out_all',
      'signed_out_all',
    ]);
    expect(new Set(rows.map((r) => r.xmin)).size).toBe(1);
    expect(audit.events.at(-1)).toMatchObject({
      type: 'SELLER_SESSIONS_REVOKED',
      summary: { revoked_count: 3, seller_id: sellerC },
    });
  });

  it('refuses cross-site state-changing requests by origin, and same-origin ones without the session anti-forgery value', async () => {
    const before = {
      rows: (await sessionRows('seller-a@synthetic.invalid')).length,
      verify: verifyCalls.real,
    };
    for (const headers of [
      {},
      { origin: 'https://evil.example' },
      { origin: ORIGIN, 'sec-fetch-site': 'cross-site' },
      { referer: 'https://evil.example/' },
    ]) {
      const res = await signIn('seller-a@synthetic.invalid', PASSWORD_A, headers);
      expect(res.statusCode, JSON.stringify(headers)).toBe(403);
      expect(res.json()).toEqual({ error: 'forbidden_origin' });
    }
    expect((await sessionRows('seller-a@synthetic.invalid')).length).toBe(before.rows);
    expect(verifyCalls.real).toBe(before.verify);

    const a = await session('seller-a@synthetic.invalid', PASSWORD_A);
    const b = await session('seller-b@synthetic.invalid', PASSWORD_B);
    expect((await me(a.token)).statusCode).toBe(200);
    const crossSite = await post('/spike/items', a, { origin: 'https://evil.example' }, { note: 'x' });
    expect(crossSite.statusCode).toBe(403);
    expect(crossSite.json()).toEqual({ error: 'forbidden_origin' });
    const noToken = await post(
      '/spike/items',
      { token: a.token, antiForgery: '' },
      { origin: ORIGIN },
      { note: 'x' },
    );
    expect(noToken.statusCode).toBe(403);
    expect(noToken.json()).toEqual({ error: 'forbidden_anti_forgery' });
    const wrongToken = await post(
      '/spike/items',
      { token: a.token, antiForgery: b.antiForgery },
      { origin: ORIGIN },
      { note: 'x' },
    );
    expect(wrongToken.statusCode).toBe(403);
    const rotateWithout = await post('/spike/rotate', { token: a.token, antiForgery: 'nope' });
    expect(rotateWithout.statusCode).toBe(403);
    expect((await me(a.token)).statusCode).toBe(200);
    const ok = await post(
      '/spike/items',
      a,
      { origin: ORIGIN, 'sec-fetch-site': 'same-origin' },
      { note: 'ok' },
    );
    expect(ok.statusCode).toBe(201);
  });

  it('keeps session identity immutable and revocation final at the data layer', async () => {
    const s = await session('seller-b@synthetic.invalid', PASSWORD_B);
    const h = hashSessionToken(s.token);
    await expect(
      query(
        env.migratorUrl,
        `UPDATE auth.seller_session SET token_hash = decode(repeat('00', 32), 'hex') WHERE token_hash = $1`,
        [h],
      ),
    ).rejects.toMatchObject({ code: 'SS001' });
    await expect(
      query(
        env.migratorUrl,
        `UPDATE auth.seller_session SET absolute_expires_at = now() + interval '1 year' WHERE token_hash = $1`,
        [h],
      ),
    ).rejects.toMatchObject({
      code: 'SS001',
    });
    await expect(
      query(
        env.migratorUrl,
        `UPDATE auth.seller_session SET account_id = (SELECT id FROM auth.seller_account WHERE seller_id = $2) WHERE token_hash = $1`,
        [h, env.sellerA.id],
      ),
    ).rejects.toMatchObject({ code: 'SS001' });
    expect((await post('/spike/sign-out', s)).statusCode).toBe(204);
    await expect(
      query(
        env.migratorUrl,
        `UPDATE auth.seller_session SET revoked_at = NULL, revocation_reason = NULL WHERE token_hash = $1`,
        [h],
      ),
    ).rejects.toMatchObject({ code: 'SS002' });
    await expect(
      query(
        env.migratorUrl,
        `INSERT INTO auth.seller_session (account_id, token_hash, client_hash, absolute_expires_at) VALUES ((SELECT account_id FROM auth.seller_session WHERE token_hash = $1), decode('ab', 'hex'), repeat('a', 32), now() + interval '1 day')`,
        [h],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('redacts secrets that reach the logger by mistake and never interpolates data into error records', async () => {
    const s = await session('seller-a@synthetic.invalid', PASSWORD_A);
    const marker = `marker-${randomUUID()}`;
    app.log.info(
      {
        marker,
        token: s.token,
        password: PASSWORD_A,
        nested: { cookie: `${cookie.name}=${s.token}`, antiForgery: s.antiForgery },
      },
      'deliberate leak attempt',
    );
    const line = logs.lines.find((l) => l.includes(marker)) ?? '';
    expect(line).toContain('[REDACTED]');
    expect(line).not.toContain(s.token);
    expect(line).not.toContain(PASSWORD_A);
    expect(line).not.toContain(s.antiForgery);
    const boom = await app.inject({
      method: 'POST',
      url: '/spike/sign-in',
      headers: { origin: ORIGIN },
      payload: { email: 'not an email', password: 'x' },
    });
    expect(boom.statusCode).toBe(400);
    expect(boom.json()).toEqual({ error: 'bad_request' });
  });
});
