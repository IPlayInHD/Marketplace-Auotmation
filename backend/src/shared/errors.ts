import { SQLSTATE } from '../db/constants.ts';

// Typed domain errors. Messages carry identifiers and reason codes only, never a protected value,
// a credential or personal data (AUTH-215, OPS-573).

export abstract class DomainError extends Error {
  abstract readonly code: string;
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

/** AUTH-221: a record that is not visible to this tenant is reported exactly like one that does not exist. */
export class NotFoundError extends DomainError {
  readonly code = 'NOT_FOUND';
  readonly subjectType: string;
  constructor(subjectType: string) {
    super(`${subjectType} not found`);
    this.subjectType = subjectType;
  }
}

export class InvalidStateError extends DomainError {
  readonly code = 'INVALID_STATE';
  readonly subjectType: string;
  readonly current: string;
  readonly attempted: string;
  constructor(subjectType: string, current: string, attempted: string) {
    super(`${subjectType} in state ${current} cannot ${attempted}`);
    this.subjectType = subjectType;
    this.current = current;
    this.attempted = attempted;
  }
}

export type ReadinessGap =
  | 'asking_price'
  | 'approved_content'
  | 'seller_provided_facts'
  | 'policy_version'
  | 'minimum_price'
  | 'currency_match';

export const READINESS_GAPS: readonly ReadinessGap[] = [
  'asking_price',
  'approved_content',
  'seller_provided_facts',
  'policy_version',
  'minimum_price',
  'currency_match',
];

/** SM-L-01: READY refused, with the missing prerequisites named (LIST-134 AC1). */
export class ListingNotReadyError extends DomainError {
  readonly code = 'LISTING_NOT_READY';
  readonly missing: readonly ReadinessGap[];
  constructor(missing: readonly ReadinessGap[]) {
    super(`listing cannot reach READY: missing ${missing.join(', ')}`);
    this.missing = missing;
  }
}

/** OPS-738: the row changed since it was read. */
export class ConcurrentModificationError extends DomainError {
  readonly code = 'CONCURRENT_MODIFICATION';
  readonly subjectType: string;
  constructor(subjectType: string) {
    super(`${subjectType} was modified concurrently; re-read and retry`);
    this.subjectType = subjectType;
  }
}

/** OPS-732: an idempotency key reused for a different action or subject. */
export class IdempotencyConflictError extends DomainError {
  readonly code = 'IDEMPOTENCY_CONFLICT';
  constructor() {
    super('idempotency key was already used for a different action');
  }
}

export class ValidationError extends DomainError {
  readonly code = 'VALIDATION';
  readonly reason: string;
  readonly fields: readonly string[];
  constructor(reason: string, fields: readonly string[] = []) {
    super(`validation failed: ${reason}${fields.length > 0 ? ` (${fields.join(', ')})` : ''}`);
    this.reason = reason;
    this.fields = fields;
  }
}

interface PgErrorShape {
  code?: unknown;
  detail?: unknown;
}

function isReadinessGap(value: string): value is ReadinessGap {
  return (READINESS_GAPS as readonly string[]).includes(value);
}

/**
 * Maps a PostgreSQL error raised by the schema guards to the typed domain error, so the data
 * layer's refusal and the application's refusal are the same error to a caller.
 */
export function mapDatabaseError(err: unknown, subjectType: string): unknown {
  if (typeof err !== 'object' || err === null) return err;
  const { code, detail } = err as PgErrorShape;
  if (typeof code !== 'string') return err;
  switch (code) {
    case SQLSTATE.listingReadyPrerequisitesMissing: {
      const missing = typeof detail === 'string' ? detail.split(',').filter(isReadinessGap) : [];
      return new ListingNotReadyError(missing);
    }
    case SQLSTATE.listingTransitionIllegal:
    case SQLSTATE.contentVersionViolation:
    case SQLSTATE.appendOnlyViolation:
      return new InvalidStateError(
        subjectType,
        'unknown',
        'perform a transition the state machine does not draw',
      );
    case SQLSTATE.listingRowVersionMismatch:
      return new ConcurrentModificationError(subjectType);
    default:
      return err;
  }
}
