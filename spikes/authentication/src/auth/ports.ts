import type { Transaction } from 'kysely';
import type { Database } from '../db/schema.ts';

// The two integration points the authentication module needs from the rest of the system.
// In production both are existing modules: Audit & Events (module 19) and the rate limiter
// (AUTH-204, SEC-010). The spike supplies in-memory implementations to prove the seams.

export type Trx = Transaction<Database>;

export type AuditSummaryValue = string | number | boolean | null;

export interface AuditEvent {
  type: AuthAuditEventType;
  subjectType: 'seller_account' | 'seller_session' | 'sign_in_attempt';
  subjectId: string;
  summary: Record<string, AuditSummaryValue>;
}

/**
 * Proposed additions to the ai/POLICY_AND_AUTHORIZATION.md §12 catalogue if D-19 is accepted.
 * They record AUTH-217 (sign-in, sign-out, failure, lockout) and AUTH-206 (rotation).
 */
export type AuthAuditEventType =
  | 'SELLER_SIGN_IN_SUCCEEDED'
  | 'SELLER_SIGN_IN_FAILED'
  | 'SELLER_SIGN_IN_THROTTLED'
  | 'SELLER_SESSION_ROTATED'
  | 'SELLER_SIGNED_OUT'
  | 'SELLER_SESSIONS_REVOKED';

/** The same forbidden-key guard as backend/src/modules/audit/service.ts (OPS-783). */
export const FORBIDDEN_SUMMARY_KEY =
  /(minimum|target|concession|auto_decline|threshold|password|token|secret|code|plaintext|copy_?block|cookie|email|phone|address|note|transcript|prompt|completion|message_body)/i;

export interface AuditSink {
  /** Appends inside the caller's transaction (OPS-787): no event, no commit. */
  append(trx: Trx, event: AuditEvent): Promise<void>;
}

export type RateLimitScope = 'sign_in_account' | 'sign_in_client';

export interface RateLimitGate {
  /**
   * AUTH-204: consulted before any credential work, per account and per client. Returns false
   * when the attempt must be refused with a neutral response (SEC-011). The delay policy itself
   * is not the spike's subject.
   */
  consume(scope: RateLimitScope, key: string): Promise<boolean>;
}

export class AuditGuardError extends Error {
  readonly code = 'AUDIT_FORBIDDEN_KEY';
}

export function assertAuditSummary(summary: Record<string, AuditSummaryValue>): void {
  for (const key of Object.keys(summary)) {
    if (FORBIDDEN_SUMMARY_KEY.test(key))
      throw new AuditGuardError(`audit summary carries a forbidden key: ${key}`);
  }
}
