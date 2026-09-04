import { createHash } from 'node:crypto';
import fastifyCookie from '@fastify/cookie';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { AuthService, Principal } from '../auth/service.ts';
import { UnauthenticatedError } from '../auth/service.ts';
import { PASSWORD_POLICY } from '../config.ts';
import { clearCookieOptions, setCookieOptions, type SessionCookiePolicy } from '../cookie.ts';
import { checkStateChangingOrigin, STATE_CHANGING_METHODS, verifyAntiForgery } from '../csrf.ts';
import type { Trx } from '../auth/ports.ts';
import { antiForgeryTokenFor, isWellFormedToken } from '../session-token.ts';

// Spike routes under /spike/*. They are not the production seller route tree and exist only to
// exercise the authentication primitives end to end over Fastify. Every failure response is a
// fixed body: nothing about the request, the account or the session is interpolated (AUTH-215).

export interface AppOptions {
  auth: AuthService;
  cookie: SessionCookiePolicy;
  sellerOrigin: string;
  logger: Logger;
}

const SignInBody = z.strictObject({
  email: z.email().max(254),
  password: z.string().min(1).max(PASSWORD_POLICY.maxLength),
});

const ItemBody = z.strictObject({ note: z.string().max(80) });

const RESPONSES = {
  badRequest: { error: 'bad_request' },
  unauthenticated: { error: 'unauthenticated' },
  invalidCredentials: { error: 'invalid_credentials' },
  throttled: { error: 'try_later' },
  forbiddenOrigin: { error: 'forbidden_origin' },
  forbiddenAntiForgery: { error: 'forbidden_anti_forgery' },
  internal: { error: 'internal' },
} as const;

/** SEC-043: a hashed client identifier; the address itself is never stored or logged. */
export function clientHashOf(request: FastifyRequest): string {
  const agent = request.headers['user-agent'] ?? '';
  return createHash('sha256').update(`${request.ip}\n${agent}`, 'utf8').digest('hex').slice(0, 32);
}

class OriginRefused extends Error {
  readonly code = 'ORIGIN_REFUSED';
}
class AntiForgeryRefused extends Error {
  readonly code = 'ANTI_FORGERY_REFUSED';
}

export async function buildApp(options: AppOptions) {
  const { auth, cookie, sellerOrigin } = options;
  const app = Fastify({ loggerInstance: options.logger });
  await app.register(fastifyCookie);

  const setSession = (reply: FastifyReply, token: string) => {
    reply.setCookie(cookie.name, token, setCookieOptions(cookie));
  };
  const clearSession = (reply: FastifyReply) => {
    reply.clearCookie(cookie.name, clearCookieOptions(cookie));
  };
  const presentedToken = (request: FastifyRequest): unknown => request.cookies[cookie.name];

  // SEC-311 on every state-changing request, before any handler runs.
  app.addHook('onRequest', (request, _reply, done) => {
    if (!STATE_CHANGING_METHODS.has(request.method)) {
      done();
      return;
    }
    const verdict = checkStateChangingOrigin(request.headers, sellerOrigin);
    if (!verdict.ok) {
      request.log.warn({ route: request.routeOptions.url, reason: verdict.reason }, 'origin refused');
      done(new OriginRefused());
      return;
    }
    done();
  });

  /**
   * The presented token, checked for shape and, on a state-changing method, for the session's
   * anti-forgery value (SEC-310). Whether the token names a live session is decided by the
   * service inside the transaction that also sets the tenant context.
   */
  const provenToken = (request: FastifyRequest): string => {
    const token = presentedToken(request);
    if (!isWellFormedToken(token)) throw new UnauthenticatedError();
    if (STATE_CHANGING_METHODS.has(request.method) && !verifyAntiForgery(request.headers, token)) {
      throw new AntiForgeryRefused();
    }
    return token;
  };

  const withSession = <T>(
    request: FastifyRequest,
    fn: (trx: Trx, principal: Principal, token: string) => Promise<T>,
  ): Promise<T> => {
    const token = provenToken(request);
    return auth.withSellerSession(token, (trx, principal) => fn(trx, principal, token));
  };

  app.setErrorHandler((err: unknown, request, reply) => {
    if (err instanceof UnauthenticatedError) {
      clearSession(reply);
      return reply.code(401).send(RESPONSES.unauthenticated);
    }
    if (err instanceof OriginRefused) return reply.code(403).send(RESPONSES.forbiddenOrigin);
    if (err instanceof AntiForgeryRefused) return reply.code(403).send(RESPONSES.forbiddenAntiForgery);
    if (err instanceof z.ZodError) return reply.code(400).send(RESPONSES.badRequest);
    // OPS-573: a type and a request id, never an interpolated message.
    request.log.error({ error_type: err instanceof Error ? err.name : typeof err }, 'unhandled error');
    return reply.code(500).send(RESPONSES.internal);
  });

  app.post('/spike/sign-in', async (request, reply) => {
    const body = SignInBody.parse(request.body);
    const result = await auth.signIn({
      email: body.email,
      password: body.password,
      clientHash: clientHashOf(request),
    });
    if (!result.ok) {
      clearSession(reply);
      return result.reason === 'throttled'
        ? reply.code(429).send(RESPONSES.throttled)
        : reply.code(401).send(RESPONSES.invalidCredentials);
    }
    setSession(reply, result.token);
    return reply
      .code(200)
      .send({ sellerId: result.principal.sellerId, antiForgery: antiForgeryTokenFor(result.token) });
  });

  app.get('/spike/me', async (request, reply) => {
    const me = await withSession(request, async (trx, principal, token) => {
      const sellers = await trx
        .selectFrom('app.seller')
        .select(({ fn }) => fn.countAll<string>().as('n'))
        .executeTakeFirstOrThrow();
      const items = await trx
        .selectFrom('app.inventory_item')
        .select(({ fn }) => fn.countAll<string>().as('n'))
        .executeTakeFirstOrThrow();
      return {
        sellerId: principal.sellerId,
        sessionId: principal.sessionId,
        visibleSellers: Number(sellers.n),
        visibleItems: Number(items.n),
        antiForgery: antiForgeryTokenFor(token),
      };
    });
    return reply.code(200).send(me);
  });

  app.get('/spike/sessions', async (request, reply) => {
    const sessions = await auth.listSessions(presentedToken(request));
    return reply.code(200).send({ sessions });
  });

  // AUTH-220, AUTH-223: ownership comes from the session; the body cannot name a seller.
  app.post('/spike/items', async (request, reply) => {
    const body = ItemBody.parse(request.body);
    const created = await withSession(request, async (trx, principal) =>
      trx
        .insertInto('app.inventory_item')
        .values({ seller_id: principal.sellerId, request_id: `spike-${body.note}` })
        .returning(['id', 'seller_id'])
        .executeTakeFirstOrThrow(),
    );
    return reply.code(201).send({ id: created.id, sellerId: created.seller_id });
  });

  app.post('/spike/rotate', async (request, reply) => {
    const next = await auth.rotateSession(provenToken(request), clientHashOf(request));
    setSession(reply, next.token);
    return reply
      .code(200)
      .send({ sessionId: next.principal.sessionId, antiForgery: antiForgeryTokenFor(next.token) });
  });

  app.post('/spike/sign-out', async (request, reply) => {
    await auth.signOut(provenToken(request));
    clearSession(reply);
    return reply.code(204).send();
  });

  app.post('/spike/sign-out-all', async (request, reply) => {
    const result = await auth.signOutAll(provenToken(request));
    clearSession(reply);
    return reply.code(200).send({ revoked: result.revoked });
  });

  return app;
}

export type SpikeApp = Awaited<ReturnType<typeof buildApp>>;
