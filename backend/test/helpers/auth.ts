import { randomBytes, randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import type { InjectOptions, LightMyRequestResponse } from 'fastify';
import type { AuthConfig } from '../../src/config.ts';
import { createDb, type DbHandle } from '../../src/db/kysely.ts';
import * as auth from '../../src/modules/identity-auth/index.ts';
import * as sellers from '../../src/modules/sellers/index.ts';
import { createLogger } from '../../src/observability/logger.ts';
import { buildWebApp, ROUTE_PREFIXES, type WebApp } from '../../src/web/app.ts';
import type { TestDatabase } from './database.ts';
import { query } from './inspect.ts';

// Seller-authentication test harness (D-19). Every account, address and password below is
// synthetic (D-18, DATA-110); the keyed-hash key is random per run and never a fixed constant.

export const TEST_ORIGIN = 'https://seller.example';
export const AUTH_PREFIX = `${ROUTE_PREFIXES.seller}/auth`;

/** Effectively unlimited: for suites that are not about throttling. */
export const RELAXED_THROTTLE: auth.ThrottlePolicy = {
  account: { freeAttempts: 1_000_000, baseSeconds: 1, capSeconds: 1, decaySeconds: 3600 },
  client: { freeAttempts: 1_000_000, baseSeconds: 1, capSeconds: 1, decaySeconds: 3600 },
};

export function testAuthConfig(overrides: Partial<AuthConfig> = {}): AuthConfig {
  return {
    sellerOrigin: TEST_ORIGIN,
    clientHashKey: randomBytes(32),
    clientHashKeyVersion: 1,
    trustedProxies: [],
    sessionIdleSeconds: 12 * 60 * 60,
    sessionAbsoluteSeconds: 30 * 24 * 60 * 60,
    ...overrides,
  };
}

export interface SyntheticAccount {
  sellerId: string;
  accountId: string;
  email: string;
  password: string;
}

/** Provisions one synthetic account as the migration role, through the production path. */
export async function provisionAccount(
  env: TestDatabase,
  input: { displayName: string; email: string; password: string },
): Promise<SyntheticAccount> {
  const migrator = createDb(env.migratorUrl, { max: 1, applicationName: 'provision-test' });
  try {
    const passwords = await auth.createPasswordVerifier();
    const created = await auth.provisionSyntheticAccount(
      migrator.db,
      passwords,
      'ci',
      input,
      async (db, displayName, requestId) => sellers.createSeller(db, { displayName, requestId }),
      `req-provision-${randomUUID()}`,
    );
    return { ...created, email: input.email, password: input.password };
  } finally {
    await migrator.close();
  }
}

export interface VerifyCounts {
  real: number;
  decoy: number;
}

export interface AuthApp {
  app: WebApp;
  runtime: DbHandle;
  config: AuthConfig;
  cookieName: string;
  logs: string[];
  logText(): string;
  verifyCalls: VerifyCounts;
  close(): Promise<void>;
}

export async function startAuthApp(
  env: TestDatabase,
  options: { throttle?: auth.ThrottlePolicy; config?: Partial<AuthConfig>; poolMax?: number } = {},
): Promise<AuthApp> {
  const config = testAuthConfig(options.config);
  const runtime = createDb(env.runtimeUrl, { max: options.poolMax ?? 2, applicationName: 'auth-test' });
  const logs: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      logs.push(chunk.toString());
      callback();
    },
  });
  const real = await auth.createPasswordVerifier();
  const verifyCalls: VerifyCounts = { real: 0, decoy: 0 };
  const passwords: auth.PasswordVerifier = {
    hash: (p) => real.hash(p),
    verify: (phc, p) => {
      verifyCalls.real += 1;
      return real.verify(phc, p);
    },
    verifyAgainstDecoy: (p) => {
      verifyCalls.decoy += 1;
      return real.verifyAgainstDecoy(p);
    },
  };
  const authService = auth.createAuthService({
    db: runtime.db,
    config,
    passwords,
    throttle: options.throttle ?? RELAXED_THROTTLE,
  });
  const app = await buildWebApp({
    db: runtime.db,
    logger: createLogger({ module: 'web', env: 'ci', release: 'test', level: 'trace', stream }),
    appEnv: 'ci',
    authConfig: config,
    passwords,
    authService,
  });
  await app.ready();
  const cookieName = '__Host-seller_session';
  return {
    app,
    runtime,
    config,
    cookieName,
    logs,
    logText: () => logs.join(''),
    verifyCalls,
    close: async () => {
      await app.close();
      await runtime.close();
    },
  };
}

export interface Session {
  token: string;
  antiForgery: string;
}

export function cookieOf(res: LightMyRequestResponse, name: string): { value: string } | undefined {
  const found = res.cookies.find((c) => c.name === name);
  return found ? { value: found.value } : undefined;
}

export function signInRequest(
  harness: AuthApp,
  email: string,
  password: string,
  extra: { headers?: Record<string, string>; remoteAddress?: string; cookie?: string } = {},
): Promise<LightMyRequestResponse> {
  const options: InjectOptions = {
    method: 'POST',
    url: `${AUTH_PREFIX}/sign-in`,
    headers: extra.headers ?? { origin: TEST_ORIGIN },
    payload: { email, password },
  };
  if (extra.remoteAddress !== undefined) options.remoteAddress = extra.remoteAddress;
  if (extra.cookie !== undefined) options.cookies = { [harness.cookieName]: extra.cookie };
  return harness.app.inject(options);
}

/** Signs in and returns the session; fails the test if sign-in does not succeed. */
export async function signIn(harness: AuthApp, account: SyntheticAccount): Promise<Session> {
  const res = await signInRequest(harness, account.email, account.password);
  if (res.statusCode !== 200) throw new Error(`sign-in failed with ${res.statusCode}: ${res.body}`);
  const token = cookieOf(res, harness.cookieName)?.value;
  if (!token) throw new Error('sign-in set no cookie');
  return { token, antiForgery: res.json<{ antiForgery: string }>().antiForgery };
}

export function get(
  harness: AuthApp,
  url: string,
  token: string | undefined,
  headers: Record<string, string> = {},
): Promise<LightMyRequestResponse> {
  const options: InjectOptions = { method: 'GET', url, headers };
  if (token !== undefined) options.cookies = { [harness.cookieName]: token };
  return harness.app.inject(options);
}

export function post(
  harness: AuthApp,
  url: string,
  session: Session | undefined,
  extra: { headers?: Record<string, string>; payload?: Record<string, unknown>; remoteAddress?: string } = {},
): Promise<LightMyRequestResponse> {
  const headers = { ...(extra.headers ?? { origin: TEST_ORIGIN }) };
  const options: InjectOptions = { method: 'POST', url, headers };
  if (session) {
    options.headers = { ...headers, [auth.ANTI_FORGERY_HEADER]: session.antiForgery };
    options.cookies = { [harness.cookieName]: session.token };
  }
  if (extra.payload !== undefined) options.payload = extra.payload;
  if (extra.remoteAddress !== undefined) options.remoteAddress = extra.remoteAddress;
  return harness.app.inject(options);
}

/** Everything persisted by authentication, as text, for the secret scans (D-19 condition 6). */
export async function authStoredText(superuserUrl: string): Promise<string> {
  const parts: string[] = [];
  for (const table of [
    'auth.seller_account',
    'auth.seller_session',
    'auth.sign_in_throttle',
    'auth.sign_in_event',
    'app.audit_event',
    'app.idempotency_receipt',
    'app.seller',
  ]) {
    const rows = await query<{ t: string }>(superuserUrl, `SELECT row_to_json(r)::text AS t FROM ${table} r`);
    parts.push(...rows.map((r) => r.t));
  }
  return parts.join('\n');
}

export interface SessionRow {
  id: string;
  account_id: string;
  token_hash_hex: string;
  client_hash: string;
  client_key_version: number;
  revoked_at: Date | null;
  revocation_reason: string | null;
  replaced_by_session_id: string | null;
  absolute_expires_at: Date;
  last_seen_at: Date;
  xmin: string;
}

export async function sessionRows(superuserUrl: string, accountId?: string): Promise<SessionRow[]> {
  return query<SessionRow>(
    superuserUrl,
    `SELECT id, account_id, encode(token_hash, 'hex') AS token_hash_hex, client_hash, client_key_version,
            revoked_at, revocation_reason, replaced_by_session_id, absolute_expires_at, last_seen_at, xmin::text AS xmin
       FROM auth.seller_session WHERE ($1::uuid IS NULL OR account_id = $1::uuid) ORDER BY created_at`,
    [accountId ?? null],
  );
}

export async function sellerAuditEvents(
  superuserUrl: string,
  sellerId: string,
): Promise<
  {
    event_type: string;
    subject_type: string;
    subject_id: string;
    summary: Record<string, unknown>;
    request_id: string;
    xmin: string;
  }[]
> {
  return query(
    superuserUrl,
    `SELECT event_type::text, subject_type, subject_id, summary, request_id, xmin::text AS xmin
       FROM app.audit_event WHERE seller_id = $1 AND event_type::text LIKE 'SELLER_S%' ORDER BY seq`,
    [sellerId],
  );
}

export async function signInEvents(superuserUrl: string): Promise<
  {
    event_type: string;
    account_subject_hash: string;
    client_hash: string;
    summary: Record<string, unknown>;
    request_id: string;
  }[]
> {
  return query(
    superuserUrl,
    `SELECT event_type::text, account_subject_hash, client_hash, summary, request_id FROM auth.sign_in_event ORDER BY seq`,
  );
}
