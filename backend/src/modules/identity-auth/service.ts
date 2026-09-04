import { sql, type Kysely } from 'kysely';
import { z } from 'zod';
import type { AppEnvironment, AuthConfig } from '../../config.ts';
import { establishTenantContext, type TenantTransaction } from '../../db/kysely.ts';
import type { Database } from '../../db/schema.ts';
import { UnauthenticatedError, ValidationError } from '../../shared/errors.ts';
import * as audit from '../audit/index.ts';
import { hashAccountIdentifier, type ClientIdentity, type IdentifierKey } from './client-identity.ts';
import { assertPasswordPolicy, type PasswordVerifier } from './password.ts';
import { generateSessionToken, hashSessionToken, isWellFormedToken } from './session-token.ts';
import { THROTTLE_POLICY, type ThrottlePolicy, type ThrottleScopePolicy } from './throttle.ts';

// Module 1 — Identity & Auth (ARCH §3, D-19). Every database access goes through the keyhole
// functions of migrations 0007 and 0008: the runtime role holds no table privilege in schema auth.
//
// Sign-in (AUTH-203, AUTH-204): reserve capacity per client and per account under a row lock,
// look up at most one verifier, run exactly one Argon2id derivation (against the decoy when no
// account exists), then finalize both reservations by the outcome in the transaction that records
// it (migration 0008): only a completed failure counts, a success counts nowhere and clears the
// account's failures. Both failure paths do the same database work and answer the same result.
//
// withSellerSession (SEC-101, D-19 condition 3): the single site where a presented session
// becomes a tenant. Resolution, expiry, revocation and set_config happen in one transaction that
// also runs the caller's work; the setting dies with the transaction.

export interface Principal {
  sellerId: string;
  accountId: string;
  sessionId: string;
  absoluteExpiresAt: Date;
}

export interface SessionSummary {
  id: string;
  createdAt: Date;
  lastSeenAt: Date;
  absoluteExpiresAt: Date;
  current: boolean;
}

export type SignInResult =
  | { ok: true; token: string; principal: Principal }
  | { ok: false; reason: 'invalid_credentials' }
  | { ok: false; reason: 'throttled'; retryAfterSeconds: number };

export interface SignInInput {
  email: string;
  password: string;
  client: ClientIdentity;
  requestId: string;
}

export interface AuthService {
  signIn(input: SignInInput): Promise<SignInResult>;
  withSellerSession<T>(
    token: unknown,
    fn: (trx: TenantTransaction, principal: Principal) => Promise<T>,
  ): Promise<T>;
  rotateSession(
    token: unknown,
    client: ClientIdentity,
    requestId: string,
  ): Promise<{ token: string; principal: Principal }>;
  signOut(token: unknown, requestId: string): Promise<void>;
  signOutAll(token: unknown, requestId: string): Promise<{ revoked: number }>;
  listSessions(token: unknown): Promise<SessionSummary[]>;
}

export interface AuthServiceOptions {
  db: Kysely<Database>;
  config: AuthConfig;
  passwords: PasswordVerifier;
  /** Policy override for tests; production uses THROTTLE_POLICY. */
  throttle?: ThrottlePolicy;
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

const Email = z.email().max(254);

interface LookupRow {
  account_id: string;
  seller_id: string;
  password_hash: string;
}
interface ReserveRow {
  allowed: boolean;
  retry_after_seconds: number;
  failures: number;
  pending: number;
}
interface SessionRow {
  id: string;
  absolute_expires_at: Date;
}
interface ResolvedRow {
  session_id: string;
  account_id: string;
  seller_id: string;
  absolute_expires_at: Date;
}
interface ListedRow {
  id: string;
  created_at: Date;
  last_seen_at: Date;
  absolute_expires_at: Date;
}

type ThrottleScope = 'account' | 'client';

/** Admits or refuses an attempt before any credential work; an admitted attempt is in flight. */
async function reserve(
  trx: TenantTransaction,
  scope: ThrottleScope,
  subjectHash: string,
  policy: ThrottleScopePolicy,
): Promise<ReserveRow> {
  const result = await sql<ReserveRow>`
    select allowed, retry_after_seconds, failures, pending
      from auth.reserve_sign_in_attempt(${scope}::auth.throttle_scope, ${subjectHash},
        ${policy.freeFailures}::integer, ${policy.baseSeconds}::integer, ${policy.capSeconds}::integer,
        ${policy.decaySeconds}::integer, ${policy.reservationSeconds}::integer)`.execute(trx);
  const row = result.rows[0];
  if (!row) throw new Error('throttle keyhole returned no row');
  return row;
}

/** Settles a reservation by its outcome: `failed` counts one failure, otherwise none. */
async function finalize(
  trx: TenantTransaction,
  scope: ThrottleScope,
  subjectHash: string,
  failed: boolean,
  policy: ThrottleScopePolicy,
): Promise<void> {
  await sql`
    select auth.finalize_sign_in_attempt(${scope}::auth.throttle_scope, ${subjectHash}, ${failed}::boolean,
      ${policy.freeFailures}::integer, ${policy.baseSeconds}::integer, ${policy.capSeconds}::integer,
      ${policy.decaySeconds}::integer)`.execute(trx);
}

async function recordSignInEvent(
  trx: TenantTransaction,
  eventType: 'SELLER_SIGN_IN_FAILED' | 'SELLER_SIGN_IN_THROTTLED',
  accountSubjectHash: string,
  client: ClientIdentity,
  requestId: string,
  summary: Record<string, string | number | boolean | null>,
): Promise<void> {
  audit.assertAuditSummaryIsSafe(summary);
  await sql`select auth.record_sign_in_event(${eventType}::app.audit_event_type, ${accountSubjectHash}, ${client.hash},
    ${client.keyVersion}::smallint, ${requestId}, ${JSON.stringify(summary)}::jsonb)`.execute(trx);
}

export function createAuthService(options: AuthServiceOptions): AuthService {
  const { db, config, passwords } = options;
  const throttle = options.throttle ?? THROTTLE_POLICY;
  const key: IdentifierKey = { key: config.clientHashKey, version: config.clientHashKeyVersion };

  const withSellerSession: AuthService['withSellerSession'] = async (token, fn) => {
    if (!isWellFormedToken(token)) throw new UnauthenticatedError();
    const tokenHash = hashSessionToken(token);
    return db.transaction().execute(async (trx) => {
      const resolved = await sql<ResolvedRow>`
        select session_id, account_id, seller_id, absolute_expires_at
          from auth.resolve_session(${tokenHash}, ${config.sessionIdleSeconds}::integer)`.execute(trx);
      const row = resolved.rows[0];
      if (!row) throw new UnauthenticatedError();
      await establishTenantContext(trx, row.seller_id);
      return fn(trx, {
        sellerId: row.seller_id,
        accountId: row.account_id,
        sessionId: row.session_id,
        absoluteExpiresAt: row.absolute_expires_at,
      });
    });
  };

  return {
    async signIn(input) {
      const emailNormalized = normalizeEmail(input.email);
      if (!Email.safeParse(emailNormalized).success || typeof input.password !== 'string') {
        // Shape failures answer like a wrong password: nothing about accounts is learned.
        return { ok: false, reason: 'invalid_credentials' };
      }
      const accountSubject = hashAccountIdentifier(emailNormalized, key);

      // 1. Reserve capacity (client first, so a throttled client never touches the account). A
      // refusal is recorded in the same transaction; a client reservation whose account is
      // refused is released without a failure, since no credential was checked.
      const reservation = await db.transaction().execute(async (trx) => {
        const refuse = async (scope: ThrottleScope, retryAfterSeconds: number) => {
          await recordSignInEvent(
            trx,
            'SELLER_SIGN_IN_THROTTLED',
            accountSubject,
            input.client,
            input.requestId,
            {
              scope,
              retry_after_seconds: retryAfterSeconds,
            },
          );
          return { allowed: false as const, retryAfterSeconds };
        };
        const client = await reserve(trx, 'client', input.client.hash, throttle.client);
        if (!client.allowed) return refuse('client', client.retry_after_seconds);
        const account = await reserve(trx, 'account', accountSubject, throttle.account);
        if (!account.allowed) {
          await finalize(trx, 'client', input.client.hash, false, throttle.client);
          return refuse('account', account.retry_after_seconds);
        }
        return { allowed: true as const };
      });
      if (!reservation.allowed) {
        return { ok: false, reason: 'throttled', retryAfterSeconds: reservation.retryAfterSeconds };
      }

      // 2. One verifier at most, then exactly one key derivation (AUTH-203).
      const lookup = await sql<LookupRow>`
        select account_id, seller_id, password_hash from auth.sign_in_lookup(${emailNormalized})`.execute(db);
      const account = lookup.rows[0];
      const verified = account
        ? await passwords.verify(account.password_hash, input.password)
        : await passwords.verifyAgainstDecoy(input.password);

      // 3. Finalize both reservations by the outcome, in the transaction that records it. Both
      // failure paths finalize identically; a success is a failure nowhere.
      if (!account || !verified) {
        await db.transaction().execute(async (trx) => {
          await finalize(trx, 'client', input.client.hash, true, throttle.client);
          await finalize(trx, 'account', accountSubject, true, throttle.account);
          await recordSignInEvent(
            trx,
            'SELLER_SIGN_IN_FAILED',
            accountSubject,
            input.client,
            input.requestId,
            {},
          );
        });
        return { ok: false, reason: 'invalid_credentials' };
      }
      const token = generateSessionToken();
      const tokenHash = hashSessionToken(token);
      const principal = await db.transaction().execute(async (trx) => {
        await finalize(trx, 'client', input.client.hash, false, throttle.client);
        await finalize(trx, 'account', accountSubject, false, throttle.account);
        const created = await sql<SessionRow>`
          select id, absolute_expires_at from auth.create_session(${account.account_id}::uuid, ${tokenHash},
            ${input.client.hash}, ${input.client.keyVersion}::smallint, ${config.sessionAbsoluteSeconds}::integer)`.execute(
          trx,
        );
        const session = created.rows[0];
        if (!session) throw new Error('session keyhole returned no row');
        // The seller is proven; the tenant context follows the proof, never the request.
        await establishTenantContext(trx, account.seller_id);
        await audit.appendAuditEvent(trx, account.seller_id, {
          eventType: 'SELLER_SIGN_IN_SUCCEEDED',
          actorType: 'SELLER',
          actorRef: account.seller_id,
          subjectType: 'seller_session',
          subjectId: session.id,
          requestId: input.requestId,
          summary: {
            account_id: account.account_id,
            client_hash: input.client.hash,
            client_key_version: input.client.keyVersion,
          },
        });
        return {
          sellerId: account.seller_id,
          accountId: account.account_id,
          sessionId: session.id,
          absoluteExpiresAt: session.absolute_expires_at,
        };
      });
      return { ok: true, token, principal };
    },

    withSellerSession,

    rotateSession: (token, client, requestId) =>
      withSellerSession(token, async (trx, principal) => {
        const next = generateSessionToken();
        const rotated = await sql<SessionRow>`
          select id, absolute_expires_at from auth.rotate_session(${principal.sessionId}::uuid, ${hashSessionToken(next)},
            ${client.hash}, ${client.keyVersion}::smallint)`.execute(trx);
        const row = rotated.rows[0];
        if (!row) throw new UnauthenticatedError();
        await audit.appendAuditEvent(trx, principal.sellerId, {
          eventType: 'SELLER_SESSION_ROTATED',
          actorType: 'SELLER',
          actorRef: principal.sellerId,
          subjectType: 'seller_session',
          subjectId: row.id,
          requestId,
          summary: {
            account_id: principal.accountId,
            previous_session_id: principal.sessionId,
            client_hash: client.hash,
          },
        });
        return {
          token: next,
          principal: { ...principal, sessionId: row.id, absoluteExpiresAt: row.absolute_expires_at },
        };
      }),

    signOut: (token, requestId) =>
      withSellerSession(token, async (trx, principal) => {
        const result = await sql<{ revoked: boolean }>`
          select auth.revoke_session(${principal.sessionId}::uuid, 'signed_out'::auth.revocation_reason) as revoked`.execute(
          trx,
        );
        if (!result.rows[0]?.revoked) throw new UnauthenticatedError();
        await audit.appendAuditEvent(trx, principal.sellerId, {
          eventType: 'SELLER_SIGNED_OUT',
          actorType: 'SELLER',
          actorRef: principal.sellerId,
          subjectType: 'seller_session',
          subjectId: principal.sessionId,
          requestId,
          summary: { account_id: principal.accountId },
        });
      }),

    signOutAll: (token, requestId) =>
      withSellerSession(token, async (trx, principal) => {
        const result = await sql<{ revoked: number }>`
          select auth.revoke_account_sessions(${principal.accountId}::uuid, 'signed_out_all'::auth.revocation_reason) as revoked`.execute(
          trx,
        );
        const revoked = Number(result.rows[0]?.revoked ?? 0);
        await audit.appendAuditEvent(trx, principal.sellerId, {
          eventType: 'SELLER_SESSIONS_REVOKED',
          actorType: 'SELLER',
          actorRef: principal.sellerId,
          subjectType: 'seller_account',
          subjectId: principal.accountId,
          requestId,
          summary: { revoked_count: revoked, initiated_by_session_id: principal.sessionId },
        });
        return { revoked };
      }),

    listSessions: (token) =>
      withSellerSession(token, async (trx, principal) => {
        const rows = await sql<ListedRow>`
          select id, created_at, last_seen_at, absolute_expires_at from auth.list_account_sessions(${principal.accountId}::uuid)`.execute(
          trx,
        );
        return rows.rows.map((r) => ({
          id: r.id,
          createdAt: r.created_at,
          lastSeenAt: r.last_seen_at,
          absoluteExpiresAt: r.absolute_expires_at,
          current: r.id === principal.sessionId,
        }));
      }),
  };
}

// ---------------------------------------------------------------------------------------------
// Founder-controlled synthetic provisioning (D-18, D-19 condition 7). Runs as the migration role
// through an operator action; the runtime role cannot create an account. Not a route.
// ---------------------------------------------------------------------------------------------

export const ProvisionInputSchema = z.strictObject({
  displayName: z.string().trim().min(1).max(80),
  email: z.email().max(254),
  password: z.string().min(1).max(200),
});
export type ProvisionInput = z.infer<typeof ProvisionInputSchema>;

export interface ProvisionedAccount {
  sellerId: string;
  accountId: string;
}

/**
 * Creates one synthetic seller tenant and its account with the production password path.
 * `migratorDb` must be a Kysely instance for app_migrator; `createSellerTenant` is Module 2's
 * `createSeller`, injected so this module never reaches into another module's internals.
 */
export async function provisionSyntheticAccount(
  migratorDb: Kysely<Database>,
  passwords: PasswordVerifier,
  environment: AppEnvironment,
  input: ProvisionInput,
  createSellerTenant: (
    db: Kysely<Database>,
    displayName: string,
    requestId: string,
  ) => Promise<{ id: string }>,
  requestId: string,
): Promise<ProvisionedAccount> {
  if (environment === 'production') {
    throw new ValidationError(
      'synthetic provisioning is a private-alpha tool and is refused in production (D-18)',
    );
  }
  const valid = ProvisionInputSchema.parse(input);
  assertPasswordPolicy(valid.password);
  const emailNormalized = normalizeEmail(valid.email);
  const verifier = await passwords.hash(valid.password);
  const seller = await createSellerTenant(migratorDb, valid.displayName, requestId);
  const inserted = await sql<{ id: string }>`
    insert into auth.seller_account (seller_id, email, email_normalized, password_hash)
    values (${seller.id}::uuid, ${valid.email}, ${emailNormalized}, ${verifier})
    returning id`.execute(migratorDb);
  const row = inserted.rows[0];
  if (!row) throw new Error('account insert returned no row');
  return { sellerId: seller.id, accountId: row.id };
}
