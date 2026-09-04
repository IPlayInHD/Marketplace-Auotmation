import { createHash, randomBytes } from 'node:crypto';
import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import * as auth from '../../src/modules/identity-auth/index.ts';
import { declaredRoutes, enforceRouteDeclarations } from '../../src/web/authorization.ts';

// D-19 conditions 3 to 6 (unit): tokens, cookie policy, origin and anti-forgery checks, the
// trusted-proxy resolution, keyed client identifiers, the throttle policy arithmetic, and the
// AUTH-222 route-declaration guard.

describe('Session tokens', () => {
  it('are 256 bits of CSPRNG output as 43 base64url characters, unique, and well-formed only in that shape', () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 2000; i += 1) {
      const t = auth.generateSessionToken();
      expect(auth.isWellFormedToken(t)).toBe(true);
      expect(Buffer.from(t, 'base64url').length).toBe(auth.SESSION_TOKEN_BYTES);
      tokens.add(t);
    }
    expect(tokens.size).toBe(2000);
    expect(auth.SESSION_TOKEN_BYTES * 8).toBeGreaterThanOrEqual(128);
    for (const bad of [
      undefined,
      null,
      42,
      '',
      'a',
      `${auth.generateSessionToken()}=`,
      auth.generateSessionToken().slice(1),
      `${'x'.repeat(42)}!`,
    ]) {
      expect(auth.isWellFormedToken(bad)).toBe(false);
    }
  });

  it('are stored only as a 32-byte SHA-256 digest that does not contain the token', () => {
    const t = auth.generateSessionToken();
    const h = auth.hashSessionToken(t);
    expect(h.length).toBe(32);
    expect(h.equals(createHash('sha256').update(t).digest())).toBe(true);
    expect(h.toString('base64url')).not.toBe(t);
  });

  it('derive a per-session anti-forgery value that differs per token and compares in constant time', () => {
    const a = auth.generateSessionToken();
    const b = auth.generateSessionToken();
    expect(auth.antiForgeryTokenFor(a)).toBe(auth.antiForgeryTokenFor(a));
    expect(auth.antiForgeryTokenFor(a)).not.toBe(auth.antiForgeryTokenFor(b));
    expect(auth.antiForgeryTokenFor(a)).not.toContain(a);
    expect(auth.constantTimeEquals('abc', 'abc')).toBe(true);
    expect(auth.constantTimeEquals('abc', 'abd')).toBe(false);
    expect(auth.constantTimeEquals('abc', 'ab')).toBe(false);
    expect(auth.verifyAntiForgery({ [auth.ANTI_FORGERY_HEADER]: auth.antiForgeryTokenFor(a) }, a)).toBe(true);
    expect(auth.verifyAntiForgery({ [auth.ANTI_FORGERY_HEADER]: auth.antiForgeryTokenFor(b) }, a)).toBe(
      false,
    );
    expect(auth.verifyAntiForgery({ [auth.ANTI_FORGERY_HEADER]: 'x'.repeat(200) }, a)).toBe(false);
    expect(auth.verifyAntiForgery({}, a)).toBe(false);
  });
});

describe('Session cookie policy (D-19 condition 4)', () => {
  it('is httpOnly, Secure, SameSite=Lax, Path=/, host-only and __Host- prefixed on an https origin', () => {
    const policy = auth.sessionCookiePolicy({
      environment: 'production',
      sellerOrigin: 'https://seller.example',
      idleTimeoutSeconds: 43_200,
    });
    expect(policy).toEqual({ name: '__Host-seller_session', secure: true, maxAgeSeconds: 43_200 });
    expect(auth.setCookieOptions(policy)).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 43_200,
    });
    expect(auth.setCookieOptions(policy)).not.toHaveProperty('domain');
    expect(auth.clearCookieOptions(policy)).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
    });
  });

  it('permits an http origin on loopback in local development only', () => {
    expect(
      auth.sessionCookiePolicy({
        environment: 'local',
        sellerOrigin: 'http://localhost:3000',
        idleTimeoutSeconds: 60,
      }),
    ).toEqual({
      name: 'seller_session',
      secure: false,
      maxAgeSeconds: 60,
    });
    for (const environment of ['ci', 'staging', 'production'] as const) {
      expect(() =>
        auth.sessionCookiePolicy({
          environment,
          sellerOrigin: 'http://localhost:3000',
          idleTimeoutSeconds: 60,
        }),
      ).toThrow(auth.CookiePolicyError);
    }
    expect(() =>
      auth.sessionCookiePolicy({
        environment: 'local',
        sellerOrigin: 'http://seller.example',
        idleTimeoutSeconds: 60,
      }),
    ).toThrow(auth.CookiePolicyError);
    expect(() =>
      auth.sessionCookiePolicy({
        environment: 'local',
        sellerOrigin: 'https://seller.example/app',
        idleTimeoutSeconds: 60,
      }),
    ).toThrow(auth.CookiePolicyError);
    expect(() =>
      auth.sessionCookiePolicy({ environment: 'local', sellerOrigin: 'not a url', idleTimeoutSeconds: 60 }),
    ).toThrow(auth.CookiePolicyError);
  });
});

describe('Origin check for state-changing requests (SEC-311)', () => {
  const origin = 'https://seller.example';
  it('allows same-origin evidence and refuses everything else, including absence', () => {
    expect(auth.checkStateChangingOrigin({ origin }, origin)).toEqual({ ok: true });
    expect(auth.checkStateChangingOrigin({ origin, 'sec-fetch-site': 'same-origin' }, origin)).toEqual({
      ok: true,
    });
    expect(auth.checkStateChangingOrigin({ referer: `${origin}/dashboard/listings?x=1` }, origin)).toEqual({
      ok: true,
    });
    expect(auth.checkStateChangingOrigin({}, origin)).toEqual({ ok: false, reason: 'origin_missing' });
    expect(auth.checkStateChangingOrigin({ origin: 'https://evil.example' }, origin)).toEqual({
      ok: false,
      reason: 'origin_mismatch',
    });
    expect(auth.checkStateChangingOrigin({ origin: 'null' }, origin)).toEqual({
      ok: false,
      reason: 'origin_mismatch',
    });
    expect(auth.checkStateChangingOrigin({ origin: `${origin}.evil.example` }, origin)).toEqual({
      ok: false,
      reason: 'origin_mismatch',
    });
    expect(auth.checkStateChangingOrigin({ origin, 'sec-fetch-site': 'cross-site' }, origin)).toEqual({
      ok: false,
      reason: 'fetch_site',
    });
    expect(auth.checkStateChangingOrigin({ origin, 'sec-fetch-site': 'same-site' }, origin)).toEqual({
      ok: false,
      reason: 'fetch_site',
    });
    expect(auth.checkStateChangingOrigin({ referer: 'https://evil.example/' }, origin)).toEqual({
      ok: false,
      reason: 'referer_mismatch',
    });
    expect(auth.checkStateChangingOrigin({ referer: 'garbage' }, origin)).toEqual({
      ok: false,
      reason: 'referer_mismatch',
    });
  });
});

describe('Trusted-proxy policy and client identifiers (D-19 condition 6, SEC-043)', () => {
  const none = auth.trustedProxyPolicy([]);
  const edge = auth.trustedProxyPolicy(['10.0.0.0/8', '2001:db8:100::/48', '192.0.2.10']);

  it('ignores every forwarding header from an untrusted peer', () => {
    const headers = { 'x-forwarded-for': '203.0.113.9, 198.51.100.7', forwarded: 'for=203.0.113.9' };
    expect(auth.resolveClient({ peerAddress: '198.51.100.20', headers }, none)).toEqual({
      ok: true,
      address: '198.51.100.20',
      canonical: '198.51.100.20',
      viaTrustedProxy: false,
    });
    expect(auth.resolveClient({ peerAddress: '198.51.100.20', headers }, edge)).toMatchObject({
      canonical: '198.51.100.20',
    });
  });

  it('walks the chain from the right past trusted proxies only, and fails closed on malformed or ambiguous chains', () => {
    const peer = '10.1.2.3';
    expect(
      auth.resolveClient({ peerAddress: peer, headers: { 'x-forwarded-for': '203.0.113.9' } }, edge),
    ).toMatchObject({
      ok: true,
      canonical: '203.0.113.9',
      viaTrustedProxy: true,
    });
    // Two trusted hops after the client; the client's own left-hand garbage is ignored.
    expect(
      auth.resolveClient(
        { peerAddress: peer, headers: { 'x-forwarded-for': 'garbage, 203.0.113.9, 10.9.9.9, 192.0.2.10' } },
        edge,
      ),
    ).toMatchObject({ ok: true, canonical: '203.0.113.9' });
    expect(
      auth.resolveClient({ peerAddress: peer, headers: { 'x-forwarded-for': '10.9.9.9, 192.0.2.10' } }, edge),
    ).toEqual({
      ok: false,
      reason: 'ambiguous_chain',
    });
    expect(auth.resolveClient({ peerAddress: peer, headers: {} }, edge)).toEqual({
      ok: false,
      reason: 'ambiguous_chain',
    });
    expect(
      auth.resolveClient(
        { peerAddress: peer, headers: { 'x-forwarded-for': '203.0.113.9, not-an-ip' } },
        edge,
      ),
    ).toEqual({
      ok: false,
      reason: 'malformed_chain',
    });
    expect(
      auth.resolveClient({ peerAddress: peer, headers: { 'x-forwarded-for': 'unknown' } }, edge),
    ).toEqual({
      ok: false,
      reason: 'malformed_chain',
    });
    expect(auth.resolveClient({ peerAddress: undefined, headers: {} }, edge)).toEqual({
      ok: false,
      reason: 'no_peer',
    });
    expect(auth.resolveClient({ peerAddress: 'nope', headers: {} }, edge)).toEqual({
      ok: false,
      reason: 'malformed_peer',
    });
  });

  it('understands the Forwarded header and refuses it when it contradicts X-Forwarded-For', () => {
    const peer = '10.1.2.3';
    expect(
      auth.resolveClient({ peerAddress: peer, headers: { forwarded: 'for=203.0.113.9;proto=https' } }, edge),
    ).toMatchObject({
      ok: true,
      canonical: '203.0.113.9',
    });
    expect(
      auth.resolveClient(
        { peerAddress: peer, headers: { forwarded: 'for="[2001:db8:1:2:3:4:5:6]:4711"' } },
        edge,
      ),
    ).toMatchObject({
      ok: true,
      canonical: '2001:0db8:0001:0002::/64',
    });
    expect(auth.resolveClient({ peerAddress: peer, headers: { forwarded: 'for=_hidden' } }, edge)).toEqual({
      ok: false,
      reason: 'malformed_chain',
    });
    expect(
      auth.resolveClient(
        { peerAddress: peer, headers: { forwarded: 'for=203.0.113.9', 'x-forwarded-for': '203.0.113.9' } },
        edge,
      ),
    ).toMatchObject({ ok: true, canonical: '203.0.113.9' });
    expect(
      auth.resolveClient(
        { peerAddress: peer, headers: { forwarded: 'for=203.0.113.9', 'x-forwarded-for': '198.51.100.7' } },
        edge,
      ),
    ).toEqual({ ok: false, reason: 'conflicting_headers' });
  });

  it('canonicalises identifiers: IPv4 exact, IPv6 by /64, mapped IPv4 unwrapped, and rejects garbage', () => {
    expect(auth.canonicalClientIdentifier('203.0.113.9')).toBe('203.0.113.9');
    expect(auth.canonicalClientIdentifier('::ffff:203.0.113.9')).toBe('203.0.113.9');
    expect(auth.canonicalClientIdentifier('2001:db8::1')).toBe('2001:0db8:0000:0000::/64');
    expect(auth.canonicalClientIdentifier('2001:DB8:0:0:0:0:0:1')).toBe('2001:0db8:0000:0000::/64');
    expect(auth.canonicalClientIdentifier('2001:db8:0:0:ffff::1')).toBe(
      auth.canonicalClientIdentifier('2001:db8::abcd:1'),
    );
    expect(auth.canonicalClientIdentifier('::1')).toBe('0000:0000:0000:0000::/64');
    expect(auth.canonicalClientIdentifier('300.1.1.1')).toBeNull();
    expect(auth.canonicalClientIdentifier('2001:db8:::1')).toBeNull();
    expect(auth.expandIpv6('::ffff:192.0.2.128')).toBe('0000:0000:0000:0000:0000:ffff:c000:0280');
  });

  it('hashes client and account identifiers with the configured key and version, never storing the input', () => {
    const key = { key: randomBytes(32), version: 3 };
    const other = { key: randomBytes(32), version: 3 };
    const client = auth.hashClientIdentifier('203.0.113.9', key);
    expect(client).toEqual({ hash: expect.stringMatching(/^[0-9a-f]{64}$/) as string, keyVersion: 3 });
    expect(auth.hashClientIdentifier('203.0.113.9', key).hash).toBe(client.hash);
    expect(auth.hashClientIdentifier('203.0.113.9', other).hash).not.toBe(client.hash);
    expect(auth.hashClientIdentifier('203.0.113.9', { ...key, version: 4 }).hash).not.toBe(client.hash);
    expect(client.hash).not.toContain('203');
    const account = auth.hashAccountIdentifier(['seller-a', 'synthetic.invalid'].join('@'), key);
    expect(account).toMatch(/^[0-9a-f]{64}$/);
    expect(account).not.toBe(
      auth.hashClientIdentifier(['seller-a', 'synthetic.invalid'].join('@'), key).hash,
    );
  });

  it('rejects an invalid trusted-proxy configuration at startup', () => {
    expect(() => auth.trustedProxyPolicy(['not-an-ip'])).toThrow(/trusted proxy/);
    expect(() => auth.trustedProxyPolicy(['10.0.0.0/33'])).toThrow(/prefix/);
    expect(edge.isTrusted('10.255.255.255')).toBe(true);
    expect(edge.isTrusted('11.0.0.1')).toBe(false);
    expect(edge.isTrusted('2001:db8:100:ffff::1')).toBe(true);
    expect(edge.isTrusted('2001:db8:101::1')).toBe(false);
    expect(edge.isTrusted('::ffff:192.0.2.10')).toBe(true);
    expect(none.isTrusted('127.0.0.1')).toBe(false);
  });
});

describe('Progressive delay policy (AUTH-204)', () => {
  it('is free up to the allowance, then doubles from the base to the cap', () => {
    const a = auth.THROTTLE_POLICY.account;
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 50].map((n) => auth.delayAfterAttempts(a, n))).toEqual([
      0, 0, 0, 2, 4, 8, 16, 32, 60, 60,
    ]);
    const c = auth.THROTTLE_POLICY.client;
    expect([10, 11, 12, 19, 20, 100].map((n) => auth.delayAfterAttempts(c, n))).toEqual([
      0, 2, 4, 512, 900, 900,
    ]);
    expect(a.capSeconds).toBeLessThanOrEqual(60);
    expect(c.capSeconds).toBeLessThanOrEqual(900);
  });
});

describe('Route authorization declarations (AUTH-222)', () => {
  it('refuse to build an app with an undeclared route under the protected prefix and record declared ones', async () => {
    const declared = Fastify();
    enforceRouteDeclarations(declared, '/seller');
    declared.get('/health', () => ({ ok: true }));
    declared.get('/seller/x', { config: { authorization: 'seller-session' } }, () => ({ ok: true }));
    await declared.ready();
    expect(declaredRoutes(declared)).toEqual([
      { method: 'GET', url: '/seller/x', authorization: 'seller-session' },
    ]);
    await declared.close();

    const undeclared = Fastify();
    enforceRouteDeclarations(undeclared, '/seller');
    await expect(
      undeclared.register((scope, _opts, done) => {
        try {
          scope.post('/seller/undeclared', () => ({ ok: true }));
          done();
        } catch (err) {
          done(err as Error);
        }
      }),
    ).rejects.toThrow(/AUTH-222/);
    await undeclared.close();
  });
});
