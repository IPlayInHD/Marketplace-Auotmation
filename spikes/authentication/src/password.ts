import { argon2, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { ARGON2_LIMITS, ARGON2_POLICY, PASSWORD_POLICY } from './config.ts';

// Password verifiers (AUTH-201): Argon2id from node:crypto (added in Node.js v24.7.0, marked
// stable in v24.19.0), a per-password 16-byte CSPRNG salt, and the PHC string encoding
// `$argon2id$v=19$m=<KiB>,t=<passes>,p=<lanes>$<salt>$<tag>` used by the reference implementation
// (P-H-C/phc-winner-argon2 src/test.c), so a stored verifier is portable to any Argon2 library.
// No code path can recover a password: only the tag is stored and only equality is ever computed.

const argon2Async = promisify(argon2);

export interface Argon2Params {
  memory: number;
  passes: number;
  parallelism: number;
  tagLength: number;
}

export interface DecodedVerifier {
  params: Argon2Params;
  salt: Buffer;
  tag: Buffer;
}

const PHC_PATTERN =
  /^\$argon2id\$v=19\$m=(\d{1,7}),t=(\d{1,3}),p=(\d{1,3})\$([A-Za-z0-9+/]{11,})\$([A-Za-z0-9+/]{6,})$/;

/** PHC B64: standard base64 alphabet, no padding. */
function b64(buf: Buffer): string {
  return buf.toString('base64').replace(/=+$/, '');
}

function fromB64(text: string): Buffer {
  return Buffer.from(text, 'base64');
}

export function encodeVerifier(params: Argon2Params, salt: Buffer, tag: Buffer): string {
  return `$argon2id$v=19$m=${params.memory},t=${params.passes},p=${params.parallelism}$${b64(salt)}$${b64(tag)}`;
}

/** Returns null for anything that is not a well-formed, in-bounds Argon2id PHC string. */
export function decodeVerifier(phc: string): DecodedVerifier | null {
  const m = PHC_PATTERN.exec(phc);
  if (!m) return null;
  const memory = Number(m[1]);
  const passes = Number(m[2]);
  const parallelism = Number(m[3]);
  const salt = fromB64(m[4] ?? '');
  const tag = fromB64(m[5] ?? '');
  if (
    memory < 8 * parallelism ||
    memory > ARGON2_LIMITS.memory ||
    passes < 1 ||
    passes > ARGON2_LIMITS.passes ||
    parallelism < 1 ||
    parallelism > ARGON2_LIMITS.parallelism ||
    salt.length < 8 ||
    tag.length < 4 ||
    tag.length > ARGON2_LIMITS.tagLength ||
    b64(salt) !== m[4] ||
    b64(tag) !== m[5]
  ) {
    return null;
  }
  return { params: { memory, passes, parallelism, tagLength: tag.length }, salt, tag };
}

/** The raw KDF. Exposed for the known-answer test; production code uses hashPassword/verifyPassword. */
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

export class PasswordPolicyError extends Error {
  readonly code = 'PASSWORD_POLICY';
  readonly violation: 'too_short' | 'too_long' | 'not_a_string';
  constructor(violation: 'too_short' | 'too_long' | 'not_a_string') {
    super('password does not meet the policy');
    this.violation = violation;
  }
}

/** AUTH-202: the policy is a server-side check; a client that skips it is rejected here. */
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

/** Constant-time equality on the tag; a malformed verifier verifies nothing. */
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
   * AUTH-203: the work done for an unknown account. Runs the same KDF with the same parameters
   * against a verifier nobody knows the password for, and always answers false.
   */
  verifyAgainstNothing(password: string): Promise<false>;
}

/** Builds the verifier, precomputing the decoy verifier used for unknown accounts. */
export async function createPasswordVerifier(): Promise<PasswordVerifier> {
  const decoy = await hashPassword(randomBytes(32).toString('base64url'));
  return {
    hash: (password) => hashPassword(password),
    verify: (phc, password) => verifyPassword(phc, password),
    verifyAgainstNothing: async (password) => {
      await verifyPassword(decoy, password);
      return false;
    },
  };
}
