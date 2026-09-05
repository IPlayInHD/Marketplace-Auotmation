import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROUTE_PREFIXES } from '../../src/web/app.ts';
import {
  declaredRoutes,
  enforceRouteDeclarations,
  ROUTE_DECLARATION_FIELDS,
} from '../../src/web/authorization.ts';
import { SELLER_LISTING_DECLARATIONS } from '../../src/web/routes/seller-listings.ts';
import { SELLER_AUTH_DECLARATIONS } from '../../src/web/routes/seller.ts';
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

  it('registers exactly the twelve declared seller routes, each with its complete canonical AUTH-222 declaration, and no buyer route', async () => {
    const listingPrefix = `${ROUTE_PREFIXES.seller}/listings`;
    expect(declaredRoutes(harness.app)).toEqual([
      {
        method: 'POST',
        url: `${AUTH_PREFIX}/sign-in`,
        authorization: 'unauthenticated-sign-in',
        declaration: SELLER_AUTH_DECLARATIONS.signIn,
      },
      {
        method: 'GET',
        url: `${AUTH_PREFIX}/me`,
        authorization: 'seller-session',
        declaration: SELLER_AUTH_DECLARATIONS.me,
      },
      {
        method: 'GET',
        url: `${AUTH_PREFIX}/sessions`,
        authorization: 'seller-session',
        declaration: SELLER_AUTH_DECLARATIONS.sessions,
      },
      {
        method: 'POST',
        url: `${AUTH_PREFIX}/sessions/rotate`,
        authorization: 'seller-session',
        declaration: SELLER_AUTH_DECLARATIONS.rotate,
      },
      {
        method: 'POST',
        url: `${AUTH_PREFIX}/sign-out`,
        authorization: 'seller-session',
        declaration: SELLER_AUTH_DECLARATIONS.signOut,
      },
      {
        method: 'POST',
        url: `${AUTH_PREFIX}/sign-out-all`,
        authorization: 'seller-session',
        declaration: SELLER_AUTH_DECLARATIONS.signOutAll,
      },
      {
        method: 'POST',
        url: listingPrefix,
        authorization: 'seller-session',
        declaration: SELLER_LISTING_DECLARATIONS.create,
      },
      {
        method: 'GET',
        url: `${listingPrefix}/:listingId`,
        authorization: 'seller-session',
        declaration: SELLER_LISTING_DECLARATIONS.read,
      },
      {
        method: 'PATCH',
        url: `${listingPrefix}/:listingId/asking-price`,
        authorization: 'seller-session',
        declaration: SELLER_LISTING_DECLARATIONS.setAskingPrice,
      },
      {
        method: 'PUT',
        url: `${listingPrefix}/:listingId/facts`,
        authorization: 'seller-session',
        declaration: SELLER_LISTING_DECLARATIONS.replaceFacts,
      },
      {
        method: 'PUT',
        url: `${listingPrefix}/:listingId/draft`,
        authorization: 'seller-session',
        declaration: SELLER_LISTING_DECLARATIONS.saveDraft,
      },
      {
        method: 'POST',
        url: `${listingPrefix}/:listingId/content/:contentVersionId/approve`,
        authorization: 'seller-session',
        declaration: SELLER_LISTING_DECLARATIONS.approveContent,
      },
    ]);
    // Every declaration states every required field, and the tenant never comes from the request.
    for (const route of declaredRoutes(harness.app)) {
      for (const field of ROUTE_DECLARATION_FIELDS) {
        expect(
          route.declaration[field].trim().length,
          `${route.method} ${route.url} ${field}`,
        ).toBeGreaterThan(0);
      }
      expect(['none', 'session']).toContain(route.declaration.tenantSource);
      if (route.authorization === 'seller-session')
        expect(route.declaration.authentication).toBe('seller-session');
    }
    for (const url of [
      `${ROUTE_PREFIXES.buyer}/:publicId`,
      `${ROUTE_PREFIXES.buyer}`,
      `${listingPrefix}/:listingId/publish`,
      `${listingPrefix}/:listingId/status`,
      `${listingPrefix}/:listingId/approve`,
      `${listingPrefix}/:listingId/enhance`,
      `${listingPrefix}/:listingId/versions`,
      `${listingPrefix}/:listingId/images`,
      `${listingPrefix}/:listingId/content`,
      `${listingPrefix}/:listingId/content/:contentVersionId`,
      `${listingPrefix}/:listingId/content/:contentVersionId/enhance`,
      `${listingPrefix}/:listingId/content/:contentVersionId/publish`,
      `${listingPrefix}/:listingId/relist`,
      `${ROUTE_PREFIXES.seller}`,
      `${AUTH_PREFIX}/sign-up`,
      `${AUTH_PREFIX}/reset`,
      '/signup',
      '/login',
    ]) {
      expect(harness.app.hasRoute({ method: 'GET', url }), url).toBe(false);
      expect(harness.app.hasRoute({ method: 'POST', url }), url).toBe(false);
    }
    expect(harness.app.hasRoute({ method: 'DELETE', url: `${listingPrefix}/:listingId` })).toBe(false);
    for (const url of [`${listingPrefix}/:listingId/facts`, `${listingPrefix}/:listingId/draft`]) {
      expect(harness.app.hasRoute({ method: 'PUT', url }), url).toBe(true);
      for (const method of ['GET', 'POST', 'PATCH', 'DELETE'] as const)
        expect(harness.app.hasRoute({ method, url }), `${method} ${url}`).toBe(false);
    }
    const approve = `${listingPrefix}/:listingId/content/:contentVersionId/approve`;
    expect(harness.app.hasRoute({ method: 'POST', url: approve })).toBe(true);
    for (const method of ['GET', 'PUT', 'PATCH', 'DELETE'] as const)
      expect(harness.app.hasRoute({ method, url: approve }), `${method} ${approve}`).toBe(false);
    expect(harness.app.hasRoute({ method: 'GET', url: listingPrefix })).toBe(false);
    for (const url of [`${ROUTE_PREFIXES.buyer}/abcdefghijklmnop`, `${listingPrefix}/x/publish`, '/signup']) {
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
