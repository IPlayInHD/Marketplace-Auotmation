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

/** SM-L-02: LISTED refused because no enabled public access with an ACTIVE code exists. */
export class PublicAccessRequiredError extends DomainError {
  readonly code = 'PUBLIC_ACCESS_REQUIRED';
  constructor() {
    super('listing cannot become LISTED without an enabled public access and an ACTIVE code (SM-L-02)');
  }
}

/** SM-L-06: relisting needs a new seller-approved content version, created and approved after the previous publication. */
export class RelistContentRequiredError extends DomainError {
  readonly code = 'RELIST_CONTENT_REQUIRED';
  constructor() {
    super(
      'relisting requires a new seller-approved content version created after the previous publication (SM-L-06)',
    );
  }
}

/** AUTH-205, AUTH-219: no live seller session was presented. One generic failure for every cause. */
export class UnauthenticatedError extends DomainError {
  readonly code = 'UNAUTHENTICATED';
  constructor() {
    super('no valid seller session');
  }
}

/** SEC-311: a state-changing request without acceptable origin evidence. */
export class OriginRefusedError extends DomainError {
  readonly code = 'ORIGIN_REFUSED';
  constructor() {
    super('request origin refused');
  }
}

/** SEC-310: a state-changing request without the session's anti-forgery value. */
export class AntiForgeryRefusedError extends DomainError {
  readonly code = 'ANTI_FORGERY_REFUSED';
  constructor() {
    super('anti-forgery check failed');
  }
}

/** D-19 trusted-proxy policy: the client could not be identified from the peer and its forwarding headers. */
export class ClientIdentityError extends DomainError {
  readonly code = 'CLIENT_IDENTITY';
  readonly reason: string;
  constructor(reason: string) {
    super('client identity could not be established');
    this.reason = reason;
  }
}

/** OPS-732: an idempotency key reused for a different command or with a different payload. */
export class IdempotencyConflictError extends DomainError {
  readonly code = 'IDEMPOTENCY_CONFLICT';
  constructor() {
    super('idempotency key was already used for a different command or payload');
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
    case SQLSTATE.accessCodeTransitionIllegal:
    case SQLSTATE.accessCodeImmutable:
    case SQLSTATE.publicAccessImmutable:
      return new InvalidStateError(
        subjectType,
        'unknown',
        'perform a transition the state machine does not draw',
      );
    case SQLSTATE.listingPublicAccessMissing:
      return new PublicAccessRequiredError();
    case SQLSTATE.listingCloseWithOpenAccess:
      return new InvalidStateError(
        subjectType,
        'open',
        'close while public access is enabled or an ACTIVE code remains (SM-L-02)',
      );
    case SQLSTATE.publicAccessOnClosedListing:
    case SQLSTATE.accessCodeOnClosedAccess:
      return new InvalidStateError(subjectType, 'closed', 'hold an open surface (SM-L-02)');
    case SQLSTATE.listingRelistContentRequired:
      return new RelistContentRequiredError();
    case SQLSTATE.sellerAccountImmutable:
    case SQLSTATE.sellerSessionImmutable:
    case SQLSTATE.sellerSessionRevocationFinal:
      return new InvalidStateError(subjectType, 'immutable', 'be changed or deleted');
    case SQLSTATE.sellerSessionNotLive:
      return new UnauthenticatedError();
    case SQLSTATE.listingRowVersionMismatch:
    case SQLSTATE.publicAccessRowVersionMismatch:
      return new ConcurrentModificationError(subjectType);
    default:
      return err;
  }
}
