import type { CookieSerializeOptions } from '@fastify/cookie';
import type { AppEnvironment } from '../../config.ts';

// The session cookie (AUTH-205, D-19 condition 4): httpOnly always, Secure everywhere but local
// http development on loopback, SameSite=Lax, Path=/, host-only (no Domain), and the __Host-
// prefix whenever Secure applies. There is no cookie-signing secret: the server validates the
// token's high-entropy hash.

export interface SessionCookiePolicy {
  name: string;
  secure: boolean;
  /** Advisory only: the server decides expiry (AUTH-207). */
  maxAgeSeconds: number;
}

export class CookiePolicyError extends Error {
  readonly code = 'COOKIE_POLICY';
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

export function sessionCookiePolicy(input: {
  environment: AppEnvironment;
  sellerOrigin: string;
  idleTimeoutSeconds: number;
}): SessionCookiePolicy {
  let origin: URL;
  try {
    origin = new URL(input.sellerOrigin);
  } catch {
    throw new CookiePolicyError('seller origin is not a URL');
  }
  if (origin.origin !== input.sellerOrigin)
    throw new CookiePolicyError('seller origin must be an origin, nothing more');
  const secure = origin.protocol === 'https:';
  if (!secure && input.environment !== 'local') {
    throw new CookiePolicyError('outside local development the seller origin must be https (AUTH-205)');
  }
  if (!secure && !LOOPBACK.has(origin.hostname)) {
    throw new CookiePolicyError('an http seller origin is permitted on loopback only');
  }
  return {
    name: secure ? '__Host-seller_session' : 'seller_session',
    secure,
    maxAgeSeconds: input.idleTimeoutSeconds,
  };
}

export function setCookieOptions(policy: SessionCookiePolicy): CookieSerializeOptions {
  return { httpOnly: true, secure: policy.secure, sameSite: 'lax', path: '/', maxAge: policy.maxAgeSeconds };
}

export function clearCookieOptions(policy: SessionCookiePolicy): CookieSerializeOptions {
  return { httpOnly: true, secure: policy.secure, sameSite: 'lax', path: '/' };
}
