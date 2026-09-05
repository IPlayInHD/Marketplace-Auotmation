import { sql, type Kysely } from 'kysely';
import { z } from 'zod';
import type { AppEnvironment, AuthConfig } from '../../config.ts';
import { establishTenantContext, type TenantTransaction } from '../../db/kysely.ts';
import type { Database } from '../../db/schema.ts';
import { commandContext } from '../../shared/command.ts';
import { IdempotencyConflictError, UnauthenticatedError, ValidationError } from '../../shared/errors.ts';
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
//
// Idempotency (D-20, OPS-730 to OPS-732): sign-in and rotation answer a one-time secret and keep
// no exact-response receipt; the active-session cap bounds what a retried sign-in can create.
// Sign-out converges to signed-out. Sign-out-all has two strictly separated paths (migration
// 0010): the exact-replay keyhole, which takes the token digest and the key and answers only the
// stored outcome, a conflict, or nothing, and establishes no tenant context here; then, when
// there is no exact replay, the ordinary live-session path through withSellerSession. A revoked
// token therefore authorises nothing but the replay of the sign-out-all it initiated, and
// resolves to no seller, session or token identifier in application code.

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
  /** Converges to signed-out: revokes a live session once, does nothing otherwise, never throws for an absent one. */
  signOut(token: unknown, requestId: string): Promise<void>;
  /** OPS-730/OPS-731 under `idempotencyKey`: exactly one revocation per key; a replay returns the stored outcome. */
  signOutAll(token: unknown, idempotencyKey: string, requestId: string): Promise<{ revoked: number }>;
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
interface CreatedSessionRow extends SessionRow {
  evicted_session_ids: string[];
}
interface SignedOutRow {
  session_id: string;
  account_id: string;
  seller_id: string;
}
interface ReplayRow {
  verdict: 'replay' | 'conflict';
  outcome: Record<string, unknown> | null;
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

/** The command name under which sign-out-all consumes its idempotency key (OPS-732, D-20). */
export const SIGN_OUT_ALL_COMMAND = 'seller.sign_out_all';

/**
 * D-20 exact replay, and nothing else: the digest and the key go in; the stored outcome, a
 * conflict or nothing comes out. No identifier, no session status, no tenant context.
 */
async function replaySignOutAll(
  db: Kysely<Database>,
  tokenHash: Buffer,
  idempotencyKey: string,
): Promise<ReplayRow | undefined> {
  const result = await sql<ReplayRow>`
    select verdict, outcome from auth.replay_sign_out_all(${tokenHash}, ${idempotencyKey})`.execute(db);
  return result.rows[0];
}

function revokedFromOutcome(outcome: Record<string, unknown> | null): { revoked: number } {
  return { revoked: Number(outcome?.['revoked'] ?? 0) };
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
        // AUTH-230 (D-20): the cap is applied after the password proved the account, under the
        // account's row lock; the oldest live sessions beyond it are evicted in this transaction.
        const created = await sql<CreatedSessionRow>`
          select id, absolute_expires_at, evicted_session_ids
            from auth.create_session(${account.account_id}::uuid, ${tokenHash}, ${input.client.hash},
              ${input.client.keyVersion}::smallint, ${config.sessionAbsoluteSeconds}::integer,
              ${config.sessionIdleSeconds}::integer, ${config.maxActiveSessions}::integer)`.execute(trx);
        const session = created.rows[0];
        if (!session) throw new Error('session keyhole returned no row');
        // The seller is proven; the tenant context follows the proof, never the request.
        await establishTenantContext(trx, account.seller_id);
        for (const evictedId of session.evicted_session_ids) {
          await audit.appendAuditEvent(trx, account.seller_id, {
            eventType: 'SELLER_SESSION_EVICTED',
            actorType: 'SELLER',
            actorRef: account.seller_id,
            subjectType: 'seller_session',
            subjectId: evictedId,
            requestId: input.requestId,
            summary: {
              account_id: account.account_id,
              replaced_by_session_id: session.id,
              active_session_cap: config.maxActiveSessions,
            },
          });
        }
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
            evicted_count: session.evicted_session_ids.length,
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

    // AUTH-231 (D-20): a live session is revoked once, with one event; a missing, unknown,
    // expired or already revoked one changes nothing and resolves to nothing. The caller answers
    // the same fixed response either way, so nothing here may distinguish the cases.
    signOut: async (token, requestId) => {
      if (!isWellFormedToken(token)) return;
      const tokenHash = hashSessionToken(token);
      await db.transaction().execute(async (trx) => {
        const result = await sql<SignedOutRow>`
          select session_id, account_id, seller_id
            from auth.sign_out_session(${tokenHash}, ${config.sessionIdleSeconds}::integer)`.execute(trx);
        const revoked = result.rows[0];
        if (!revoked) return;
        // The seller was proven by the live session this statement just revoked.
        await establishTenantContext(trx, revoked.seller_id);
        await audit.appendAuditEvent(trx, revoked.seller_id, {
          eventType: 'SELLER_SIGNED_OUT',
          actorType: 'SELLER',
          actorRef: revoked.seller_id,
          subjectType: 'seller_session',
          subjectId: revoked.session_id,
          requestId,
          summary: { account_id: revoked.account_id },
        });
      });
    },

    // AUTH-232 (D-20, migration 0010). Path A, exact replay: the keyhole answers the stored
    // outcome for the very token that initiated the receipt under this key, a conflict for that
    // key under another command or session, or nothing; no tenant context is created here.
    // Path B, fresh execution: the ordinary live-session path, then the idempotency store, all
    // in one transaction. A concurrent duplicate that loses the race sees its session revoked
    // by its twin and answers 401 in B; the replay keyhole is consulted once more so it, like
    // any later retry, receives the stored outcome instead.
    signOutAll: async (token, idempotencyKey, requestId) => {
      if (!isWellFormedToken(token)) throw new UnauthenticatedError();
      const tokenHash = hashSessionToken(token);
      const replay = async () => {
        const found = await replaySignOutAll(db, tokenHash, idempotencyKey);
        if (found?.verdict === 'conflict') throw new IdempotencyConflictError();
        return found?.verdict === 'replay' ? revokedFromOutcome(found.outcome) : undefined;
      };
      const replayed = await replay();
      if (replayed) return replayed;
      try {
        return await withSellerSession(token, async (trx, principal) => {
          const ctx = commandContext({ sellerId: principal.sellerId, requestId, idempotencyKey });
          const outcome = await audit.runIdempotent<{ revoked: number }>(trx, ctx, {
            command: SIGN_OUT_ALL_COMMAND,
            payload: { sessionId: principal.sessionId },
            eventType: 'SELLER_SESSIONS_REVOKED',
            subjectType: 'seller_account',
            run: async () => {
              const result = await sql<{ revoked: number }>`
                select auth.revoke_account_sessions(${principal.accountId}::uuid, 'signed_out_all'::auth.revocation_reason) as revoked`.execute(
                trx,
              );
              const revoked = Number(result.rows[0]?.revoked ?? 0);
              return {
                value: { revoked },
                subjectId: principal.accountId,
                summary: { revoked_count: revoked, initiated_by_session_id: principal.sessionId },
              };
            },
            serialize: (value) => ({ revoked: value.revoked }),
            revive: (stored) => revokedFromOutcome(stored),
          });
          return outcome.value;
        });
      } catch (err) {
        if (!(err instanceof UnauthenticatedError)) throw err;
        const late = await replay();
        if (late) return late;
        throw err;
      }
    },

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
