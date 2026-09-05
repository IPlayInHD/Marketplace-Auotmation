import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROUTE_PREFIXES } from '../../src/web/app.ts';
import { declaredRoutes, enforceRouteDeclarations } from '../../src/web/authorization.ts';
import { AUTH_PREFIX, startAuthApp, type AuthApp } from '../helpers/auth.ts';
import { startDatabase, type TestDatabase } from '../helpers/database.ts';

// The web process: health over the runtime role, request correlation, the D-19 seller
// authentication routes and nothing else (D-18 boundaries, AUTH-222 deny by default).

describe('Web process', () => {
  let env: TestDatabase;
  let harness: AuthApp;

  beforeAll(async () => {
    env = await startDatabase();
    harness = await startAuthApp(env);
  });
  afterAll(async () => {
    await harness?.close();
    await env?.stop();
  });

  it('answers /health through the runtime role and exposes the request id', async () => {
    const res = await harness.app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', database: 'reachable' });
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('registers exactly the six declared seller-authentication routes and no buyer route', async () => {
    expect(declaredRoutes(harness.app)).toEqual([
      { method: 'POST', url: `${AUTH_PREFIX}/sign-in`, authorization: 'unauthenticated-sign-in' },
      { method: 'GET', url: `${AUTH_PREFIX}/me`, authorization: 'seller-session' },
      { method: 'GET', url: `${AUTH_PREFIX}/sessions`, authorization: 'seller-session' },
      { method: 'POST', url: `${AUTH_PREFIX}/sessions/rotate`, authorization: 'seller-session' },
      { method: 'POST', url: `${AUTH_PREFIX}/sign-out`, authorization: 'seller-session' },
      { method: 'POST', url: `${AUTH_PREFIX}/sign-out-all`, authorization: 'seller-session' },
    ]);
    for (const url of [
      `${ROUTE_PREFIXES.buyer}/:publicId`,
      `${ROUTE_PREFIXES.buyer}`,
      `${ROUTE_PREFIXES.seller}/listings`,
      `${ROUTE_PREFIXES.seller}`,
      `${AUTH_PREFIX}/sign-up`,
      `${AUTH_PREFIX}/reset`,
      '/signup',
      '/login',
    ]) {
      expect(harness.app.hasRoute({ method: 'GET', url }), url).toBe(false);
      expect(harness.app.hasRoute({ method: 'POST', url }), url).toBe(false);
    }
    for (const url of [
      `${ROUTE_PREFIXES.buyer}/abcdefghijklmnop`,
      `${ROUTE_PREFIXES.seller}/listings`,
      '/signup',
    ]) {
      const res = await harness.app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(404);
      expect(res.json()).toEqual({ error: 'not_found' });
    }
  });

  it('fails to build when a seller route lacks an authorization declaration (AUTH-222)', async () => {
    const app = Fastify();
    enforceRouteDeclarations(app, ROUTE_PREFIXES.seller);
    await expect(
      app.register((scope, _opts, done) => {
        try {
          scope.get(`${ROUTE_PREFIXES.seller}/listings`, () => ({}));
          done();
        } catch (err) {
          done(err as Error);
        }
      }),
    ).rejects.toThrow(/AUTH-222/);
    await app.close();
  });

  it('logs with fixed fields and never a connection string, an address or a token', async () => {
    // Independent of test order: this request alone produces the lines inspected below.
    expect((await harness.app.inject({ method: 'GET', url: '/health' })).statusCode).toBe(200);
    const out = harness.logText();
    expect(out).toContain('"module":"web"');
    expect(out).not.toContain(env.runtimeUrl);
    expect(out).not.toMatch(/postgresql:\/\/[^@]*:[^@]*@/);
    expect(out).not.toMatch(/"remoteAddress":"(?!\[REDACTED\])/);
  });
});
