// Module 7 — Access Codes (ARCH §3). Owns app.listing_access_code: issue, hash, verify, rotate and
// revoke (SM-C-01 to SM-C-03, OPS-710, OPS-737). The code is public by design (D-03) and is still
// never persisted, logged or audited in plaintext (DM-08, ACCESS-013, SEC-040). This module grants
// nothing beyond one listing's surface and creates no buyer session; no buyer route exists (D-18).
export {
  ACCESS_CODE_LENGTH,
  SCRYPT_PARAMS,
  findActiveAccessCode,
  generateAccessCode,
  hashAccessCode,
  isWellFormedAccessCode,
  issueAccessCode,
  issueCode,
  listAccessCodes,
  nextVersionNumber,
  reviveAccessCode,
  reviveIssuedAccessCode,
  revokeAccessCode,
  rotateAccessCode,
  storeAccessCode,
  verifyAccessCode,
  verifyAccessCodeHash,
  type AccessCodeRecord,
  type IssuedAccessCode,
  type IssueAccessCodeResult,
  type RevokeAccessCodeResult,
  type RotateAccessCodeResult,
} from './service.ts';
