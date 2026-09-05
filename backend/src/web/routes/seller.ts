import type { FastifyPluginCallback, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AuthConfig } from '../../config.ts';
import * as auth from '../../modules/identity-auth/index.ts';
import * as sellers from '../../modules/sellers/index.ts';
import { IDEMPOTENCY_KEY_HEADER, IdempotencyKeyHeaderSchema } from '../../shared/command.ts';
import {
  AntiForgeryRefusedError,
  ClientIdentityError,
  IdempotencyKeyRequiredError,
  OriginRefusedError,
  UnauthenticatedError,
} from '../../shared/errors.ts';

// The authenticated seller route tree (ARCH-002, D-19). Its own plugin scope: the origin hook
// below applies to every state-changing request in this tree and to nothing else. Every route
// declares its authorization (AUTH-222). Nothing here exposes a listing, a sign-up page, a
// password reset, a second factor or a buyer capability (D-19 condition 7).
//
// Idempotency (D-20): the two GET routes and sign-in take no key; an Idempotency-Key header on
// sign-in or rotation is ignored, never a promise of exact replay, because the token those
// routes answer is stored nowhere it could be replayed from (AUTH-205). Sign-out converges to
// signed-out with one fixed response. Sign-out-all requires a client-generated UUID key.

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

  const presentedToken = (request: FastifyRequest): unknown => request.cookies[cookie.name];
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

  /** OPS-730 (D-20): one well-formed client-generated UUID, or the request is refused before any work. */
  const requiredIdempotencyKey = (request: FastifyRequest): string => {
    const parsed = IdempotencyKeyHeaderSchema.safeParse(request.headers[IDEMPOTENCY_KEY_HEADER]);
    if (!parsed.success) throw new IdempotencyKeyRequiredError();
    return parsed.data;
  };

  /**
   * The presented token, checked for shape and, on a state-changing method, for the session's
   * anti-forgery value (SEC-310) before anything is resolved or mutated.
   */
  const provenToken = (request: FastifyRequest): string => {
    const token = presentedToken(request);
    if (!auth.isWellFormedToken(token)) throw new UnauthenticatedError();
    if (auth.STATE_CHANGING_METHODS.has(request.method) && !auth.verifyAntiForgery(request.headers, token)) {
      throw new AntiForgeryRefusedError();
    }
    return token;
  };

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
    { config: { authorization: 'unauthenticated-sign-in' } },
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

  app.get('/auth/me', { config: { authorization: 'seller-session' } }, async (request, reply) => {
    const token = provenToken(request);
    const me = await options.auth.withSellerSession(token, async (trx, principal) => {
      const seller = await sellers.getSeller(trx, principal.sellerId);
      return {
        sellerId: principal.sellerId,
        displayName: seller.displayName,
        sessionId: principal.sessionId,
      };
    });
    return reply.code(200).send({ ...me, antiForgery: auth.antiForgeryTokenFor(token) });
  });

  app.get('/auth/sessions', { config: { authorization: 'seller-session' } }, async (request, reply) => {
    const sessions = await options.auth.listSessions(provenToken(request));
    return reply.code(200).send({ sessions });
  });

  app.post(
    '/auth/sessions/rotate',
    { config: { authorization: 'seller-session' } },
    async (request, reply) => {
      const next = await options.auth.rotateSession(
        provenToken(request),
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
  app.post('/auth/sign-out', { config: { authorization: 'seller-session' } }, async (request, reply) => {
    const presented = presentedToken(request);
    if (auth.isWellFormedToken(presented)) {
      if (!auth.verifyAntiForgery(request.headers, presented)) throw new AntiForgeryRefusedError();
      await options.auth.signOut(presented, request.id);
    }
    clearSession(reply);
    return reply.code(204).send();
  });

  // AUTH-232 (D-20): consequential; the key is required before any lookup or mutation.
  app.post('/auth/sign-out-all', { config: { authorization: 'seller-session' } }, async (request, reply) => {
    const token = provenToken(request);
    const key = requiredIdempotencyKey(request);
    const result = await options.auth.signOutAll(token, key, request.id);
    clearSession(reply);
    return reply.code(200).send({ revoked: result.revoked });
  });
}
