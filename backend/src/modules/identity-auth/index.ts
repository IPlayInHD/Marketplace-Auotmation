// Module 1 — Identity & Auth (ARCH §3, D-19 Accepted 2026-09-04). Owns schema auth: seller
// accounts, opaque database-backed sessions, sign-in throttling and the pre-authentication
// ledger. Knows nothing about listings. No open registration exists (D-18): accounts are
// provisioned by an operator as the migration role.
export {
  ARGON2_LIMITS,
  ARGON2_POLICY,
  ARGON2_SELF_TEST,
  Argon2UnavailableError,
  PASSWORD_POLICY,
  PasswordPolicyError,
  assertArgon2Capability,
  assertPasswordPolicy,
  createPasswordVerifier,
  decodeVerifier,
  deriveArgon2id,
  encodeVerifier,
  hashPassword,
  needsRehash,
  verifyPassword,
  type Argon2Params,
  type PasswordVerifier,
} from './password.ts';
export {
  SESSION_TOKEN_BYTES,
  TOKEN_PATTERN,
  antiForgeryTokenFor,
  constantTimeEquals,
  generateSessionToken,
  hashSessionToken,
  isWellFormedToken,
} from './session-token.ts';
export {
  CookiePolicyError,
  clearCookieOptions,
  sessionCookiePolicy,
  setCookieOptions,
  type SessionCookiePolicy,
} from './cookie.ts';
export {
  ANTI_FORGERY_HEADER,
  STATE_CHANGING_METHODS,
  checkStateChangingOrigin,
  verifyAntiForgery,
  type OriginCheck,
} from './csrf.ts';
export {
  canonicalClientIdentifier,
  expandIpv6,
  hashAccountIdentifier,
  hashClientIdentifier,
  resolveClient,
  trustedProxyPolicy,
  type ClientIdentity,
  type ClientResolution,
  type IdentifierKey,
  type TrustedProxyPolicy,
} from './client-identity.ts';
export {
  THROTTLE_POLICY,
  delayAfterFailures,
  type ThrottlePolicy,
  type ThrottleScopePolicy,
} from './throttle.ts';
export {
  ProvisionInputSchema,
  createAuthService,
  normalizeEmail,
  provisionSyntheticAccount,
  type AuthService,
  type AuthServiceOptions,
  type Principal,
  type ProvisionInput,
  type ProvisionedAccount,
  type SessionSummary,
  type SignInInput,
  type SignInResult,
} from './service.ts';
