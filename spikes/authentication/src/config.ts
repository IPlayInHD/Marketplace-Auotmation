// Policy constants of the spike. Values are proposals for D-19, not decisions; the canonical
// requirements they answer are cited inline.

/** AUTH-200, AUTH-202: the policy is enforced server-side; the numbers are a proposal. */
export const PASSWORD_POLICY = { minLength: 12, maxLength: 200 } as const;

/**
 * Argon2id parameters (AUTH-201). memory is in 1 KiB blocks: 19456 KiB = 19 MiB, 2 passes,
 * 1 lane, 32-byte tag, 16-byte salt. These are the RFC 9106 §4 "second recommended option"
 * figures and the defaults of @node-rs/argon2 2.2.0 (its README, "m=19456,t=2,p=1").
 */
export const ARGON2_POLICY = {
  memory: 19_456,
  passes: 2,
  parallelism: 1,
  tagLength: 32,
  saltLength: 16,
  version: 19,
} as const;

/** Upper bounds accepted when decoding a stored verifier, so a corrupted row cannot demand 1 TiB. */
export const ARGON2_LIMITS = { memory: 1 << 20, passes: 16, parallelism: 16, tagLength: 64 } as const;

/**
 * AUTH-205 (>= 128 bits; here 256), AUTH-207 (idle and absolute lifetimes, server-authoritative).
 * The lifetimes are proposals.
 */
export const SESSION_POLICY = {
  tokenBytes: 32,
  idleTimeoutSeconds: 12 * 60 * 60,
  absoluteLifetimeSeconds: 30 * 24 * 60 * 60,
} as const;

/** engineering/OPERATIONS.md §1: the four environments. */
export type Environment = 'local' | 'ci' | 'staging' | 'production';
