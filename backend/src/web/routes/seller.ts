import type { FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuthConfig } from '../../config.ts';
import * as auth from '../../modules/identity-auth/index.ts';
import * as sellers from '../../modules/sellers/index.ts';
import { AntiForgeryRefusedError, ClientIdentityError, OriginRefusedError } from '../../shared/errors.ts';
import type { RouteDeclaration } from '../authorization.ts';
import { registerSellerListingRoutes } from './seller-listings.ts';
import { presentedToken, provenToken, requiredIdempotencyKey } from './seller-request.ts';

// The authenticated seller route tree (ARCH-002, D-19). Its own plugin scope: the origin hook
// below applies to every state-changing request in this tree and to nothing else. Every route
// declares its authorization (AUTH-222). Nothing here exposes a listing, a sign-up page, a
// password reset, a second factor or a buyer capability (D-19 condition 7).
//
// Idempotency (D-20): the two GET routes and sign-in take no key; an Idempotency-Key header on
// sign-in or rotation is ignored, never a promise of exact replay, because the token those
// routes answer is stored nowhere it could be replayed from (AUTH-205). Sign-out converges to
// signed-out with one fixed response. Sign-out-all requires a client-generated UUID key.
//
// The listing routes of Slice 1e are registered into this same scope by seller-listings.ts, so
// the origin hook below covers them too.
//
// Cache policy: every response of this tree is private to one seller (P2 and P3 data,
// DATA_AND_PRIVACY §2), so the onSend hook below answers `Cache-Control: no-store` on all of
// them, reads, mutations and refusals alike, and a scoped not-found handler keeps unknown paths
// under the prefix inside the same policy. Nothing outside this tree is touched.

/** The canonical AUTH-222 declarations of the authentication routes, mirrored in the README inventory. */
export const SELLER_AUTH_DECLARATIONS = {
  signIn: {
    actor: 'anonymous',
    resource: 'seller_session',
    action: 'sign_in',
    authentication: 'none',
    authorization: 'the password verifies for the presented address, inside the account and client throttles',
    tenantSource: 'none',
    classification: 'one-time-secret',
    idempotency: 'none; an Idempotency-Key is ignored and promises nothing (D-20)',
    audit:
      'SELLER_SIGN_IN_SUCCEEDED and SELLER_SESSION_EVICTED in the seller trail; SELLER_SIGN_IN_FAILED and SELLER_SIGN_IN_THROTTLED in auth.sign_in_event',
    failure: '401 invalid_credentials; 429 try_later with Retry-After; 403 forbidden_origin; 400 bad_request',
  },
  me: {
    actor: 'seller',
    resource: 'seller_session',
    action: 'read',
    authentication: 'seller-session',
    authorization: 'the presented live session',
    tenantSource: 'session',
    classification: 'read-only',
    idempotency: 'none; no Idempotency-Key',
    audit: 'none',
    failure: '401 unauthenticated',
  },
  sessions: {
    actor: 'seller',
    resource: 'seller_session',
    action: 'list',
    authentication: 'seller-session',
    authorization: 'the presented live session; only its own account is listed',
    tenantSource: 'session',
    classification: 'read-only',
    idempotency: 'none; no Idempotency-Key',
    audit: 'none',
    failure: '401 unauthenticated',
  },
  rotate: {
    actor: 'seller',
    resource: 'seller_session',
    action: 'rotate',
    authentication: 'seller-session',
    authorization: 'the presented live session, replaced by its successor in one transaction',
    tenantSource: 'session',
    classification: 'one-time-secret',
    idempotency:
      'none; an Idempotency-Key is ignored; a retry with the revoked predecessor creates nothing (D-20)',
    audit: 'SELLER_SESSION_ROTATED',
    failure: '401 unauthenticated; 403 forbidden_origin or forbidden_anti_forgery',
  },
  signOut: {
    actor: 'seller',
    resource: 'seller_session',
    action: 'sign_out',
    authentication: 'seller-session',
    authorization:
      'a presented live session is revoked; a missing, unknown, expired or revoked one converges to signed-out',
    tenantSource: 'session',
    classification: 'naturally-idempotent',
    idempotency: 'none; one fixed 204 however often it is repeated (D-20)',
    audit: 'SELLER_SIGNED_OUT once, for the revocation only',
    failure: '403 forbidden_origin or forbidden_anti_forgery for a well-formed token; otherwise always 204',
  },
  signOutAll: {
    actor: 'seller',
    resource: 'seller_account',
    action: 'revoke_all_sessions',
    authentication: 'seller-session',
    authorization: 'the presented live session, or the exact D-20 replay of the sign-out-all it initiated',
    tenantSource: 'session',
    classification: 'consequential',
    idempotency: 'Idempotency-Key required (client UUID); exact replay returns the stored outcome (D-20)',
    audit: 'SELLER_SESSIONS_REVOKED in the same transaction as the receipt',
    failure:
      '401 unauthenticated; 403 forbidden_origin or forbidden_anti_forgery; 400 idempotency_key_required; 409 idempotency_conflict',
  },
} as const satisfies Record<string, RouteDeclaration>;

export interface SellerRoutesOptions {
  auth: auth.AuthService;
  config: AuthConfig;
  cookie: auth.SessionCookiePolicy;
  passwords: auth.PasswordVerifier;
}

const SignInBody = z.strictObject({
  email: z.string().min(3).max(254),
  password: z.string().min(1).max(auth.PASSWORD_POLICY.maxLength),
});

export const sellerRouteTree: FastifyPluginCallback<SellerRoutesOptions> = (app, options, done) => {
  try {
    registerSellerRoutes(app, options);
    done();
  } catch (err) {
    // AUTH-222: a route refused by the declaration guard fails registration, and so startup.
    done(err instanceof Error ? err : new Error(String(err)));
  }
};

function registerSellerRoutes(
  app: Parameters<FastifyPluginCallback<SellerRoutesOptions>>[0],
  options: SellerRoutesOptions,
): void {
  const { cookie, config } = options;
  const proxies = auth.trustedProxyPolicy(config.trustedProxies);
  const key: auth.IdentifierKey = { key: config.clientHashKey, version: config.clientHashKeyVersion };

  const setSession = (reply: FastifyReply, token: string) =>
    reply.setCookie(cookie.name, token, auth.setCookieOptions(cookie));
  const clearSession = (reply: FastifyReply) =>
    reply.clearCookie(cookie.name, auth.clearCookieOptions(cookie));

  /** D-19 condition 6: the client identity, from the peer and trusted proxies only; fails closed. */
  const identifyClient = (request: FastifyRequest): auth.ClientIdentity => {
    const resolved = auth.resolveClient(
      { peerAddress: request.socket.remoteAddress, headers: request.headers },
      proxies,
    );
    if (!resolved.ok) throw new ClientIdentityError(resolved.reason);
    return auth.hashClientIdentifier(resolved.canonical, key);
  };

  // No shared or private cache may store a seller response: the whole tree answers no-store. A
  // handler that already set a cache directive keeps it; none does today.
  app.addHook('onSend', (_request, reply, _payload, done) => {
    if (!reply.hasHeader('cache-control')) reply.header('cache-control', 'no-store');
    done();
  });
  // An unknown path under the seller prefix answers the same fixed body as everywhere else, from
  // inside this scope, so the cache policy above applies to it too.
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ error: 'not_found' }));

  // SEC-311 on every state-changing request in this tree, sign-in included, before any handler.
  app.addHook('onRequest', (request, _reply, done) => {
    if (!auth.STATE_CHANGING_METHODS.has(request.method)) return done();
    const verdict = auth.checkStateChangingOrigin(request.headers, config.sellerOrigin);
    if (!verdict.ok) {
      request.log.warn({ route: request.routeOptions.url, reason: verdict.reason }, 'origin refused');
      return done(new OriginRefusedError());
    }
    return done();
  });

  app.post(
    '/auth/sign-in',
    { config: { authorization: 'unauthenticated-sign-in', declaration: SELLER_AUTH_DECLARATIONS.signIn } },
    async (request, reply) => {
      const body = SignInBody.parse(request.body);
      const client = identifyClient(request);
      const result = await options.auth.signIn({
        email: body.email,
        password: body.password,
        client,
        requestId: request.id,
      });
      if (!result.ok) {
        clearSession(reply);
        if (result.reason === 'throttled') {
          return reply
            .code(429)
            .header('retry-after', String(result.retryAfterSeconds))
            .send({ error: 'try_later' });
        }
        return reply.code(401).send({ error: 'invalid_credentials' });
      }
      setSession(reply, result.token);
      return reply
        .code(200)
        .send({ sellerId: result.principal.sellerId, antiForgery: auth.antiForgeryTokenFor(result.token) });
    },
  );

  app.get(
    '/auth/me',
    { config: { authorization: 'seller-session', declaration: SELLER_AUTH_DECLARATIONS.me } },
    async (request, reply) => {
      const token = provenToken(request, cookie.name);
      const me = await options.auth.withSellerSession(token, async (trx, principal) => {
        const seller = await sellers.getSeller(trx, principal.sellerId);
        return {
          sellerId: principal.sellerId,
          displayName: seller.displayName,
          sessionId: principal.sessionId,
        };
      });
      return reply.code(200).send({ ...me, antiForgery: auth.antiForgeryTokenFor(token) });
    },
  );

  app.get(
    '/auth/sessions',
    { config: { authorization: 'seller-session', declaration: SELLER_AUTH_DECLARATIONS.sessions } },
    async (request, reply) => {
      const sessions = await options.auth.listSessions(provenToken(request, cookie.name));
      return reply.code(200).send({ sessions });
    },
  );

  app.post(
    '/auth/sessions/rotate',
    { config: { authorization: 'seller-session', declaration: SELLER_AUTH_DECLARATIONS.rotate } },
    async (request, reply) => {
      const next = await options.auth.rotateSession(
        provenToken(request, cookie.name),
        identifyClient(request),
        request.id,
      );
      setSession(reply, next.token);
      return reply
        .code(200)
        .send({ sessionId: next.principal.sessionId, antiForgery: auth.antiForgeryTokenFor(next.token) });
    },
  );

  // AUTH-231 (D-20): one fixed 204 whether a live session was revoked or nothing was there to
  // revoke. A well-formed token still needs its anti-forgery value, a check on the request alone
  // that discloses nothing about any session; without a well-formed token nothing could be
  // mutated and nothing is looked up.
  app.post(
    '/auth/sign-out',
    { config: { authorization: 'seller-session', declaration: SELLER_AUTH_DECLARATIONS.signOut } },
    async (request, reply) => {
      const presented = presentedToken(request, cookie.name);
      if (auth.isWellFormedToken(presented)) {
        if (!auth.verifyAntiForgery(request.headers, presented)) throw new AntiForgeryRefusedError();
        await options.auth.signOut(presented, request.id);
      }
      clearSession(reply);
      return reply.code(204).send();
    },
  );

  // AUTH-232 (D-20): consequential; the key is required before any lookup or mutation.
  app.post(
    '/auth/sign-out-all',
    { config: { authorization: 'seller-session', declaration: SELLER_AUTH_DECLARATIONS.signOutAll } },
    async (request, reply) => {
      const token = provenToken(request, cookie.name);
      const key = requiredIdempotencyKey(request);
      const result = await options.auth.signOutAll(token, key, request.id);
      clearSession(reply);
      return reply.code(200).send({ revoked: result.revoked });
    },
  );

  registerSellerListingRoutes(app, { auth: options.auth, cookieName: cookie.name });
}
