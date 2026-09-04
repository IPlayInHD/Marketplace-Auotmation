import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SESSION_POLICY } from '../src/config.ts';
import {
  clearCookieOptions,
  CookiePolicyError,
  sessionCookiePolicy,
  setCookieOptions,
} from '../src/cookie.ts';
import { ANTI_FORGERY_HEADER, checkStateChangingOrigin, verifyAntiForgery } from '../src/csrf.ts';
import {
  antiForgeryTokenFor,
  constantTimeEquals,
  generateSessionToken,
  hashSessionToken,
  isWellFormedToken,
} from '../src/session-token.ts';

// Proof 3 (opaque tokens), proof 4 (hash form), proof 5 (cookie construction), proof 10 (origin
// and anti-forgery rules as pure functions).

describe('Session tokens', () => {
  it('are 256 bits of CSPRNG output as 43 base64url characters, unique, and well-formed only in that shape', () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 2000; i += 1) {
      const t = generateSessionToken();
      expect(isWellFormedToken(t)).toBe(true);
      expect(Buffer.from(t, 'base64url').length).toBe(SESSION_POLICY.tokenBytes);
      tokens.add(t);
    }
    expect(tokens.size).toBe(2000);
    expect(SESSION_POLICY.tokenBytes * 8).toBeGreaterThanOrEqual(128);
    for (const bad of [
      undefined,
      null,
      42,
      '',
      'a',
      `${generateSessionToken()}=`,
      generateSessionToken().slice(1),
      'x'.repeat(43) + '!',
    ]) {
      expect(isWellFormedToken(bad)).toBe(false);
    }
  });

  it('are stored only as a 32-byte SHA-256 digest that does not contain the token', () => {
    const t = generateSessionToken();
    const h = hashSessionToken(t);
    expect(h.length).toBe(32);
    expect(h.equals(createHash('sha256').update(t).digest())).toBe(true);
    expect(h.toString('hex')).not.toContain(t);
    expect(h.toString('base64url')).not.toBe(t);
    expect(hashSessionToken(t).equals(h)).toBe(true);
    expect(hashSessionToken(generateSessionToken()).equals(h)).toBe(false);
  });

  it('derive a per-session anti-forgery value that differs per token and compares in constant time', () => {
    const a = generateSessionToken();
    const b = generateSessionToken();
    expect(antiForgeryTokenFor(a)).toBe(antiForgeryTokenFor(a));
    expect(antiForgeryTokenFor(a)).not.toBe(antiForgeryTokenFor(b));
    expect(antiForgeryTokenFor(a)).not.toContain(a);
    expect(constantTimeEquals('abc', 'abc')).toBe(true);
    expect(constantTimeEquals('abc', 'abd')).toBe(false);
    expect(constantTimeEquals('abc', 'ab')).toBe(false);
    expect(verifyAntiForgery({ [ANTI_FORGERY_HEADER]: antiForgeryTokenFor(a) }, a)).toBe(true);
    expect(verifyAntiForgery({ [ANTI_FORGERY_HEADER]: antiForgeryTokenFor(b) }, a)).toBe(false);
    expect(verifyAntiForgery({}, a)).toBe(false);
  });
});

describe('Session cookie policy', () => {
  it('is httpOnly, Secure, SameSite=Lax, Path=/, host-only and __Host- prefixed on an https origin', () => {
    const policy = sessionCookiePolicy({
      environment: 'production',
      sellerOrigin: 'https://seller.example',
      idleTimeoutSeconds: SESSION_POLICY.idleTimeoutSeconds,
    });
    expect(policy).toEqual({
      name: '__Host-seller_session',
      secure: true,
      maxAgeSeconds: SESSION_POLICY.idleTimeoutSeconds,
    });
    expect(setCookieOptions(policy)).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_POLICY.idleTimeoutSeconds,
    });
    expect(setCookieOptions(policy)).not.toHaveProperty('domain');
    expect(clearCookieOptions(policy)).toEqual({ httpOnly: true, secure: true, sameSite: 'lax', path: '/' });
  });

  it('permits an http origin on loopback in local development only', () => {
    const local = sessionCookiePolicy({
      environment: 'local',
      sellerOrigin: 'http://localhost:3000',
      idleTimeoutSeconds: 60,
    });
    expect(local).toEqual({ name: 'seller_session', secure: false, maxAgeSeconds: 60 });
    for (const environment of ['ci', 'staging', 'production'] as const) {
      expect(() =>
        sessionCookiePolicy({ environment, sellerOrigin: 'http://localhost:3000', idleTimeoutSeconds: 60 }),
      ).toThrow(CookiePolicyError);
    }
    expect(() =>
      sessionCookiePolicy({
        environment: 'local',
        sellerOrigin: 'http://seller.example',
        idleTimeoutSeconds: 60,
      }),
    ).toThrow(CookiePolicyError);
    expect(() =>
      sessionCookiePolicy({
        environment: 'local',
        sellerOrigin: 'https://seller.example/app',
        idleTimeoutSeconds: 60,
      }),
    ).toThrow(CookiePolicyError);
    expect(() =>
      sessionCookiePolicy({ environment: 'local', sellerOrigin: 'not a url', idleTimeoutSeconds: 60 }),
    ).toThrow(CookiePolicyError);
  });
});

describe('Origin check for state-changing requests', () => {
  const origin = 'https://seller.example';
  it('allows same-origin evidence and refuses everything else, including absence', () => {
    expect(checkStateChangingOrigin({ origin }, origin)).toEqual({ ok: true });
    expect(checkStateChangingOrigin({ origin, 'sec-fetch-site': 'same-origin' }, origin)).toEqual({
      ok: true,
    });
    expect(checkStateChangingOrigin({ referer: `${origin}/dashboard/listings?x=1` }, origin)).toEqual({
      ok: true,
    });
    expect(checkStateChangingOrigin({}, origin)).toEqual({ ok: false, reason: 'origin_missing' });
    expect(checkStateChangingOrigin({ origin: 'https://evil.example' }, origin)).toEqual({
      ok: false,
      reason: 'origin_mismatch',
    });
    expect(checkStateChangingOrigin({ origin: 'null' }, origin)).toEqual({
      ok: false,
      reason: 'origin_mismatch',
    });
    expect(checkStateChangingOrigin({ origin: `${origin}.evil.example` }, origin)).toEqual({
      ok: false,
      reason: 'origin_mismatch',
    });
    expect(checkStateChangingOrigin({ origin, 'sec-fetch-site': 'cross-site' }, origin)).toEqual({
      ok: false,
      reason: 'fetch_site',
    });
    expect(checkStateChangingOrigin({ origin, 'sec-fetch-site': 'same-site' }, origin)).toEqual({
      ok: false,
      reason: 'fetch_site',
    });
    expect(checkStateChangingOrigin({ referer: 'https://evil.example/' }, origin)).toEqual({
      ok: false,
      reason: 'referer_mismatch',
    });
    expect(checkStateChangingOrigin({ referer: 'garbage' }, origin)).toEqual({
      ok: false,
      reason: 'referer_mismatch',
    });
  });
});
