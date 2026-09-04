import { createHash } from 'node:crypto';
import { sql, type Kysely } from 'kysely';
import { TENANT_SETTING } from '../db/constants.ts';
import type { Database } from '../db/schema.ts';
import { assertPasswordPolicy, type PasswordVerifier } from '../password.ts';
import { generateSessionToken, hashSessionToken, isWellFormedToken } from '../session-token.ts';
import { assertAuditSummary, type AuditSink, type RateLimitGate, type Trx } from './ports.ts';

// The seller authentication service of the spike: focused primitives, no framework.
//   * sign-in with one generic failure for unknown account and wrong password (AUTH-203)
//   * opaque sessions stored as hashes, idle and absolute lifetimes decided by the database clock
//     (AUTH-205, AUTH-207, OPS-741)
//   * rotation, single revocation and revoke-all in one transaction each (AUTH-206, AUTH-219)
//   * withSellerSession: the single construction site of tenant context (SEC-101). Resolution
//     of the session and set_config(app.seller_id, ..., true) happen in the same transaction that
//     runs the caller's work, so no seller-owned row is reachable before the session is proven.

export class UnauthenticatedError extends Error {
  readonly code = 'UNAUTHENTICATED';
  constructor() {
    super('no valid seller session');
  }
}

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
  current: boolean;
}

export type SignInResult =
  | { ok: true; token: string; principal: Principal }
  | { ok: false; reason: 'invalid_credentials' | 'throttled' };

export interface AuthService {
  /** Test fixture only: sign-up is out of scope (D-18 forbids open registration). */
  createSyntheticAccount(input: {
    sellerId: string;
    email: string;
    password: string;
  }): Promise<{ accountId: string }>;
  signIn(input: { email: string; password: string; clientHash: string }): Promise<SignInResult>;
  withSellerSession<T>(token: unknown, fn: (trx: Trx, principal: Principal) => Promise<T>): Promise<T>;
  rotateSession(token: unknown, clientHash: string): Promise<{ token: string; principal: Principal }>;
  signOut(token: unknown): Promise<void>;
  signOutAll(token: unknown): Promise<{ revoked: number }>;
  listSessions(token: unknown): Promise<SessionSummary[]>;
}

export interface AuthServiceOptions {
  db: Kysely<Database>;
  passwords: PasswordVerifier;
  audit: AuditSink;
  rateLimit: RateLimitGate;
  policy: { idleTimeoutSeconds: number; absoluteLifetimeSeconds: number };
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** A hashed account key for the rate limiter: never the address itself (SEC-043 in spirit). */
function accountKey(emailNormalized: string): string {
  return createHash('sha256').update(emailNormalized, 'utf8').digest('hex').slice(0, 32);
}

export function createAuthService(options: AuthServiceOptions): AuthService {
  const { db, passwords, audit, rateLimit, policy } = options;

  async function append(trx: Trx, event: Parameters<AuditSink['append']>[1]): Promise<void> {
    assertAuditSummary(event.summary);
    await audit.append(trx, event);
  }

  interface ResolvedSession {
    id: string;
    accountId: string;
    sellerId: string;
    absoluteExpiresAt: Date;
  }

  /**
   * Finds the live session for a presented token, locking its row. Liveness is decided by the
   * database clock: not revoked, before the absolute lifetime, and seen within the idle timeout.
   */
  async function resolve(trx: Trx, token: string): Promise<ResolvedSession | undefined> {
    const row = await trx
      .selectFrom('auth.seller_session as s')
      .innerJoin('auth.seller_account as a', 'a.id', 's.account_id')
      .select([
        's.id as id',
        's.account_id as accountId',
        'a.seller_id as sellerId',
        's.absolute_expires_at as absoluteExpiresAt',
      ])
      .where('s.token_hash', '=', hashSessionToken(token))
      .where('s.revoked_at', 'is', null)
      .where(sql<boolean>`s.absolute_expires_at > now()`)
      .where(sql<boolean>`s.last_seen_at > now() - make_interval(secs => ${policy.idleTimeoutSeconds})`)
      .forUpdate('s')
      .executeTakeFirst();
    return row;
  }

  async function insertSession(
    trx: Trx,
    input: { accountId: string; clientHash: string; absoluteExpiresAt?: Date },
  ): Promise<{ token: string; id: string; absoluteExpiresAt: Date }> {
    const token = generateSessionToken();
    const inserted = await trx
      .insertInto('auth.seller_session')
      .values({
        account_id: input.accountId,
        token_hash: hashSessionToken(token),
        client_hash: input.clientHash,
        absolute_expires_at:
          input.absoluteExpiresAt ??
          sql<Date>`now() + make_interval(secs => ${policy.absoluteLifetimeSeconds})`,
      })
      .returning(['id', 'absolute_expires_at'])
      .executeTakeFirstOrThrow();
    return { token, id: inserted.id, absoluteExpiresAt: inserted.absolute_expires_at };
  }

  const withSellerSession: AuthService['withSellerSession'] = async (token, fn) => {
    if (!isWellFormedToken(token)) throw new UnauthenticatedError();
    return db.transaction().execute(async (trx) => {
      const session = await resolve(trx, token);
      if (!session) throw new UnauthenticatedError();
      await sql`select set_config(${TENANT_SETTING}, ${session.sellerId}, true)`.execute(trx);
      await trx
        .updateTable('auth.seller_session')
        .set({ last_seen_at: sql`now()` })
        .where('id', '=', session.id)
        .execute();
      return fn(trx, {
        sellerId: session.sellerId,
        accountId: session.accountId,
        sessionId: session.id,
        absoluteExpiresAt: session.absoluteExpiresAt,
      });
    });
  };

  return {
    async createSyntheticAccount(input) {
      assertPasswordPolicy(input.password);
      const emailNormalized = normalizeEmail(input.email);
      const passwordHash = await passwords.hash(input.password);
      const row = await db
        .insertInto('auth.seller_account')
        .values({
          seller_id: input.sellerId,
          email: input.email,
          email_normalized: emailNormalized,
          password_hash: passwordHash,
        })
        .returning('id')
        .executeTakeFirstOrThrow();
      return { accountId: row.id };
    },

    async signIn(input) {
      const emailNormalized = normalizeEmail(input.email);
      const key = accountKey(emailNormalized);
      const allowed =
        (await rateLimit.consume('sign_in_account', key)) &&
        (await rateLimit.consume('sign_in_client', input.clientHash));
      return db.transaction().execute(async (trx): Promise<SignInResult> => {
        if (!allowed) {
          await append(trx, {
            type: 'SELLER_SIGN_IN_THROTTLED',
            subjectType: 'sign_in_attempt',
            subjectId: key,
            summary: { client_hash: input.clientHash },
          });
          return { ok: false, reason: 'throttled' };
        }
        const account = await trx
          .selectFrom('auth.seller_account')
          .select(['id', 'seller_id', 'password_hash'])
          .where('email_normalized', '=', emailNormalized)
          .executeTakeFirst();
        // AUTH-203: the same key derivation runs whether or not the account exists.
        const verified = account
          ? await passwords.verify(account.password_hash, input.password)
          : await passwords.verifyAgainstNothing(input.password);
        if (!account || !verified) {
          await append(trx, {
            type: 'SELLER_SIGN_IN_FAILED',
            subjectType: 'sign_in_attempt',
            subjectId: key,
            summary: { client_hash: input.clientHash },
          });
          return { ok: false, reason: 'invalid_credentials' };
        }
        // AUTH-206: a fresh identifier on every authentication; nothing presented is carried forward.
        const session = await insertSession(trx, { accountId: account.id, clientHash: input.clientHash });
        await append(trx, {
          type: 'SELLER_SIGN_IN_SUCCEEDED',
          subjectType: 'seller_session',
          subjectId: session.id,
          summary: { account_id: account.id, seller_id: account.seller_id, client_hash: input.clientHash },
        });
        return {
          ok: true,
          token: session.token,
          principal: {
            sellerId: account.seller_id,
            accountId: account.id,
            sessionId: session.id,
            absoluteExpiresAt: session.absoluteExpiresAt,
          },
        };
      });
    },

    withSellerSession,

    rotateSession: (token, clientHash) =>
      withSellerSession(token, async (trx, principal) => {
        // The absolute lifetime is inherited: rotation never extends it (AUTH-207).
        const next = await insertSession(trx, {
          accountId: principal.accountId,
          clientHash,
          absoluteExpiresAt: principal.absoluteExpiresAt,
        });
        await trx
          .updateTable('auth.seller_session')
          .set({ revoked_at: sql`now()`, revocation_reason: 'rotated', replaced_by_session_id: next.id })
          .where('id', '=', principal.sessionId)
          .execute();
        await append(trx, {
          type: 'SELLER_SESSION_ROTATED',
          subjectType: 'seller_session',
          subjectId: next.id,
          summary: {
            account_id: principal.accountId,
            seller_id: principal.sellerId,
            previous_session_id: principal.sessionId,
          },
        });
        return {
          token: next.token,
          principal: { ...principal, sessionId: next.id, absoluteExpiresAt: next.absoluteExpiresAt },
        };
      }),

    signOut: (token) =>
      withSellerSession(token, async (trx, principal) => {
        await trx
          .updateTable('auth.seller_session')
          .set({ revoked_at: sql`now()`, revocation_reason: 'signed_out' })
          .where('id', '=', principal.sessionId)
          .execute();
        await append(trx, {
          type: 'SELLER_SIGNED_OUT',
          subjectType: 'seller_session',
          subjectId: principal.sessionId,
          summary: { account_id: principal.accountId, seller_id: principal.sellerId },
        });
      }),

    signOutAll: (token) =>
      withSellerSession(token, async (trx, principal) => {
        const result = await trx
          .updateTable('auth.seller_session')
          .set({ revoked_at: sql`now()`, revocation_reason: 'signed_out_all' })
          .where('account_id', '=', principal.accountId)
          .where('revoked_at', 'is', null)
          .executeTakeFirst();
        const revoked = Number(result.numUpdatedRows);
        await append(trx, {
          type: 'SELLER_SESSIONS_REVOKED',
          subjectType: 'seller_account',
          subjectId: principal.accountId,
          summary: {
            seller_id: principal.sellerId,
            revoked_count: revoked,
            initiated_by_session_id: principal.sessionId,
          },
        });
        return { revoked };
      }),

    listSessions: (token) =>
      withSellerSession(token, async (trx, principal) => {
        const rows = await trx
          .selectFrom('auth.seller_session')
          .select(['id', 'created_at', 'last_seen_at'])
          .where('account_id', '=', principal.accountId)
          .where('revoked_at', 'is', null)
          .where(sql<boolean>`absolute_expires_at > now()`)
          .orderBy('created_at', 'asc')
          .execute();
        return rows.map((r) => ({
          id: r.id,
          createdAt: r.created_at,
          lastSeenAt: r.last_seen_at,
          current: r.id === principal.sessionId,
        }));
      }),
  };
}
