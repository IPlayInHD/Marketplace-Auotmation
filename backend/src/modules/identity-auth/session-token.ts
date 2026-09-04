import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

// Opaque seller session tokens (AUTH-205, OPS-712, D-19 condition 3): 32 CSPRNG bytes (256 bits)
// as base64url, stored only as a SHA-256 digest. The plaintext exists in the cookie and in the
// request that presents it; nothing server-side keeps it.

export const SESSION_TOKEN_BYTES = 32;
/** 32 bytes of base64url without padding are exactly 43 characters. */
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export function generateSessionToken(): string {
  return randomBytes(SESSION_TOKEN_BYTES).toString('base64url');
}

export function isWellFormedToken(value: unknown): value is string {
  return typeof value === 'string' && TOKEN_PATTERN.test(value);
}

/** The only form of a token that is ever written to PostgreSQL. */
export function hashSessionToken(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

/**
 * SEC-310, D-19 condition 5: the per-session anti-forgery value, derived from the session token
 * with HMAC-SHA256. Unique per session, rotates with the session, is stored nowhere and needs no
 * server secret; a page that cannot read the httpOnly cookie cannot compute it.
 */
export function antiForgeryTokenFor(sessionToken: string): string {
  return createHmac('sha256', sessionToken).update('seller-anti-forgery-v1').digest('base64url');
}

/** Length-independent constant-time string comparison. */
export function constantTimeEquals(a: string, b: string): boolean {
  const da = createHash('sha256').update(a, 'utf8').digest();
  const db = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(da, db) && a.length === b.length;
}
