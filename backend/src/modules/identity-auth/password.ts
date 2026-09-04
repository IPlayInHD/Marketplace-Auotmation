import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

// Password verifiers (AUTH-201, D-19 conditions 1 and 2): Argon2id from node:crypto (added in
// Node.js v24.7.0, stable since v24.19.0), a fresh 16-byte CSPRNG salt per verifier, and the PHC
// string `$argon2id$v=19$m=<KiB>,t=<passes>,p=<lanes>$<salt>$<tag>` of the reference
// implementation, so a verifier is portable to any Argon2 library. Only the tag is stored, only
// equality is ever computed, and only the asynchronous API is used on request paths. There is no
// fallback implementation: a runtime without crypto.argon2 fails closed at startup.

const argon2Async = promisify(argon2);

export interface Argon2Params {
  memory: number;
  passes: number;
  parallelism: number;
  tagLength: number;
}

/**
 * Policy (D-19): RFC 9106 §4 second recommended option, 19 MiB, 2 passes, 1 lane, 32-byte tag,
 * 16-byte salt. Changing a value here is a policy change: `needsRehash` re-derives old verifiers
 * on the next successful sign-in.
 */
export const ARGON2_POLICY = {
  memory: 19_456,
  passes: 2,
  parallelism: 1,
  tagLength: 32,
  saltLength: 16,
  version: 19,
} as const;

/** Bounds accepted when decoding a stored verifier, so a corrupted row cannot demand a gigabyte or a minute. */
export const ARGON2_LIMITS = {
  memory: 1 << 18,
  passes: 8,
  parallelism: 8,
  tagLength: 64,
  saltLength: 64,
} as const;

/** AUTH-200, AUTH-202: enforced server-side; the numbers are the private-alpha policy. */
export const PASSWORD_POLICY = { minLength: 12, maxLength: 200 } as const;

export interface DecodedVerifier {
  params: Argon2Params;
  salt: Buffer;
  tag: Buffer;
}

const PHC_PATTERN =
  /^\$argon2id\$v=(\d{1,3})\$m=(\d{1,7}),t=(\d{1,3}),p=(\d{1,3})\$([A-Za-z0-9+/]{11,})\$([A-Za-z0-9+/]{6,})$/;

/** PHC B64: standard base64 alphabet without padding. */
function b64(buf: Buffer): string {
  return buf.toString('base64').replace(/=+$/, '');
}

export function encodeVerifier(params: Argon2Params, salt: Buffer, tag: Buffer): string {
  return `$argon2id$v=${ARGON2_POLICY.version}$m=${params.memory},t=${params.passes},p=${params.parallelism}$${b64(salt)}$${b64(tag)}`;
}

/** Null for anything that is not a well-formed, supported-version, in-bounds Argon2id PHC string. */
export function decodeVerifier(phc: string): DecodedVerifier | null {
  if (typeof phc !== 'string' || phc.length > 512) return null;
  const m = PHC_PATTERN.exec(phc);
  if (!m) return null;
  const version = Number(m[1]);
  const memory = Number(m[2]);
  const passes = Number(m[3]);
  const parallelism = Number(m[4]);
  const saltText = m[5] ?? '';
  const tagText = m[6] ?? '';
  const salt = Buffer.from(saltText, 'base64');
  const tag = Buffer.from(tagText, 'base64');
  if (
    version !== ARGON2_POLICY.version ||
    parallelism < 1 ||
    parallelism > ARGON2_LIMITS.parallelism ||
    memory < 8 * parallelism ||
    memory > ARGON2_LIMITS.memory ||
    passes < 1 ||
    passes > ARGON2_LIMITS.passes ||
    salt.length < 8 ||
    salt.length > ARGON2_LIMITS.saltLength ||
    tag.length < 4 ||
    tag.length > ARGON2_LIMITS.tagLength ||
    b64(salt) !== saltText ||
    b64(tag) !== tagText
  ) {
    return null;
  }
  return { params: { memory, passes, parallelism, tagLength: tag.length }, salt, tag };
}

export type Argon2Implementation = typeof argon2;

/** The raw asynchronous KDF. Exposed for the capability self-test and the known-answer tests. */
export async function deriveArgon2id(
  message: Buffer,
  salt: Buffer,
  params: Argon2Params,
  extra: { secret?: Buffer; associatedData?: Buffer } = {},
): Promise<Buffer> {
  return argon2Async('argon2id', {
    message,
    nonce: salt,
    parallelism: params.parallelism,
    tagLength: params.tagLength,
    memory: params.memory,
    passes: params.passes,
    ...(extra.secret ? { secret: extra.secret } : {}),
    ...(extra.associatedData ? { associatedData: extra.associatedData } : {}),
  });
}

/**
 * Known-answer vector of the reference implementation (P-H-C/phc-winner-argon2 src/test.c):
 * Argon2id v19, m=256, t=2, p=1, "password", "somesalt". Small enough to run at startup.
 */
export const ARGON2_SELF_TEST = {
  params: { memory: 256, passes: 2, parallelism: 1, tagLength: 32 },
  password: 'password',
  salt: 'somesalt',
  tagHex: '9dfeb910e80bad0311fee20f9c0e2b12c17987b4cac90c2ef54d5b3021c68bfe',
} as const;

export class Argon2UnavailableError extends Error {
  readonly code = 'ARGON2_UNAVAILABLE';
}

/**
 * D-19 condition 1: startup fails closed unless the runtime provides crypto.argon2 and it
 * reproduces a reference vector. No fallback library is consulted.
 */
export async function assertArgon2Capability(implementation: unknown = argon2): Promise<void> {
  if (typeof implementation !== 'function') {
    throw new Argon2UnavailableError(
      'crypto.argon2 is not available in this Node.js runtime (D-19 condition 1)',
    );
  }
  const impl = promisify(implementation as Argon2Implementation);
  let tag: Buffer;
  try {
    tag = await impl('argon2id', {
      message: Buffer.from(ARGON2_SELF_TEST.password),
      nonce: Buffer.from(ARGON2_SELF_TEST.salt),
      ...ARGON2_SELF_TEST.params,
    });
  } catch {
    throw new Argon2UnavailableError('crypto.argon2 failed its self-test (D-19 condition 1)');
  }
  if (!Buffer.isBuffer(tag) || tag.toString('hex') !== ARGON2_SELF_TEST.tagHex) {
    throw new Argon2UnavailableError(
      'crypto.argon2 did not reproduce the reference vector (D-19 condition 1)',
    );
  }
}

export class PasswordPolicyError extends Error {
  readonly code = 'PASSWORD_POLICY';
  readonly violation: 'too_short' | 'too_long' | 'not_a_string';
  constructor(violation: 'too_short' | 'too_long' | 'not_a_string') {
    super('password does not meet the policy');
    this.violation = violation;
  }
}

/** AUTH-202: the policy is a server-side check; the error never carries the password. */
export function assertPasswordPolicy(password: unknown): asserts password is string {
  if (typeof password !== 'string') throw new PasswordPolicyError('not_a_string');
  const length = [...password].length;
  if (length < PASSWORD_POLICY.minLength) throw new PasswordPolicyError('too_short');
  if (length > PASSWORD_POLICY.maxLength) throw new PasswordPolicyError('too_long');
}

export async function hashPassword(password: string, params: Argon2Params = ARGON2_POLICY): Promise<string> {
  const salt = randomBytes(ARGON2_POLICY.saltLength);
  const tag = await deriveArgon2id(Buffer.from(password, 'utf8'), salt, params);
  return encodeVerifier(params, salt, tag);
}

/** Constant-time equality on the tag; a malformed verifier verifies nothing and derives nothing. */
export async function verifyPassword(phc: string, password: string): Promise<boolean> {
  const decoded = decodeVerifier(phc);
  if (!decoded) return false;
  const tag = await deriveArgon2id(Buffer.from(password, 'utf8'), decoded.salt, decoded.params);
  return tag.length === decoded.tag.length && timingSafeEqual(tag, decoded.tag);
}

/** True when a stored verifier was produced with parameters other than the current policy. */
export function needsRehash(phc: string, params: Argon2Params = ARGON2_POLICY): boolean {
  const decoded = decodeVerifier(phc);
  if (!decoded) return true;
  return (
    decoded.params.memory !== params.memory ||
    decoded.params.passes !== params.passes ||
    decoded.params.parallelism !== params.parallelism ||
    decoded.params.tagLength !== params.tagLength
  );
}

export interface PasswordVerifier {
  hash(password: string): Promise<string>;
  verify(phc: string, password: string): Promise<boolean>;
  /**
   * AUTH-203: the work done for an unknown account. The same key derivation with the same policy
   * against a decoy verifier nobody knows the password for; always false.
   */
  verifyAgainstDecoy(password: string): Promise<false>;
}

/** Builds the verifier, precomputing the decoy verifier used for unknown accounts. */
export async function createPasswordVerifier(): Promise<PasswordVerifier> {
  const decoy = await hashPassword(randomBytes(32).toString('base64url'));
  return {
    hash: (password) => hashPassword(password),
    verify: (phc, password) => verifyPassword(phc, password),
    verifyAgainstDecoy: async (password) => {
      await verifyPassword(decoy, password);
      return false;
    },
  };
}
