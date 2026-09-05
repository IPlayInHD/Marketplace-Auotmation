// Names shared by the migration process, the runtime process and the tests.
// Nothing here is a secret. Passwords are supplied at runtime and never stored in source (OPS-729).

/** Schema owned by the migration role and holding every application table. */
export const APP_SCHEMA = 'app';
/** Schema holding the forward-only migration ledger. Never readable by the runtime role. */
export const MIGRATION_SCHEMA = 'migration';

export const ROLES = {
  /** Owns schema `app` and everything in it. Runs migrations. Never used by a running process (OPS-716). */
  migrator: 'app_migrator',
  /** The single runtime role of this slice: DML only, no ownership, no DDL, no BYPASSRLS (OPS-716, SEC-100). */
  runtime: 'app_runtime',
} as const;

export type RoleName = (typeof ROLES)[keyof typeof ROLES];

/** The PostgreSQL setting that carries the transaction-scoped tenant context (SEC-101). */
export const TENANT_SETTING = 'app.seller_id';

/**
 * SQLSTATE codes the schema raises. The custom codes are defined in the migration that raises
 * them; application code maps them to typed domain errors (src/shared/errors.ts).
 */
export const SQLSTATE = {
  insufficientPrivilege: '42501',
  invalidTextRepresentation: '22P02',
  uniqueViolation: '23505',
  foreignKeyViolation: '23503',
  checkViolation: '23514',
  /** A listing transition not drawn in STATE_MACHINES §1 (OPS-707). */
  listingTransitionIllegal: 'LS001',
  /** READY refused: SM-L-01 prerequisites missing; DETAIL lists them. */
  listingReadyPrerequisitesMissing: 'LS002',
  /** row_version was not incremented by exactly one (OPS-738). */
  listingRowVersionMismatch: 'LS003',
  /** Identity columns of a listing changed. */
  listingIdentityImmutable: 'LS004',
  /** Content version text changed, or a transition not drawn in STATE_MACHINES §8. */
  contentVersionViolation: 'CV001',
  /** UPDATE or DELETE on an append-only or immutable table (OPS-705, OPS-706). */
  appendOnlyViolation: 'AP001',
  /** LISTED entered without an enabled public access carrying an ACTIVE code (SM-L-02). */
  listingPublicAccessMissing: 'LS005',
  /** Public access identity columns changed, or a delete attempted. */
  publicAccessImmutable: 'PA001',
  /** Public access row_version was not incremented by exactly one (OPS-738). */
  publicAccessRowVersionMismatch: 'PA002',
  /** An access-code transition not drawn in STATE_MACHINES §2, or a code issued in another status. */
  accessCodeTransitionIllegal: 'AC001',
  /** Access-code identity, hash, version or expiry changed, or a delete attempted. */
  accessCodeImmutable: 'AC002',
  /** A closing state entered while public access is enabled or an ACTIVE code remains (SM-L-02). */
  listingCloseWithOpenAccess: 'LS006',
  /** Public access enabled for a listing that is closed, a DRAFT, or not open at commit (SM-L-02). */
  publicAccessOnClosedListing: 'PA003',
  /** An ACTIVE code without an enabled access on an open listing (SM-L-02). */
  accessCodeOnClosedAccess: 'AC003',
  /** LISTED entered without an APPROVED current version, or a relist without a new one (SM-L-06). */
  listingRelistContentRequired: 'LS007',
  /** Seller account identity changed or a delete attempted (D-19). */
  sellerAccountImmutable: 'SA001',
  /** Session identity changed or a delete attempted (D-19 condition 3). */
  sellerSessionImmutable: 'SS001',
  /** A revoked session was modified: revocation is final (AUTH-219). */
  sellerSessionRevocationFinal: 'SS002',
  /** Rotation of a session that is not live (AUTH-206). */
  sellerSessionNotLive: 'SS003',
  /** An invalid throttle policy was passed to the keyhole (AUTH-204). */
  signInThrottlePolicyInvalid: 'ST001',
  /** An invalid session policy (cap or lifetimes) was passed to the keyhole (AUTH-230, D-20). */
  sessionPolicyInvalid: 'SC001',
  /** Invalid arguments to the sign-out keyhole (migration 0010). */
  signOutArgumentsInvalid: 'SO001',
  /** Invalid arguments to the sign-out-all replay keyhole (migration 0010). */
  replayArgumentsInvalid: 'SO002',
} as const;
