import { randomUUID } from 'node:crypto';
import fastifyCookie from '@fastify/cookie';
import Fastify, { LogController } from 'fastify';
import { sql, type Kysely } from 'kysely';
import type { Logger } from 'pino';
import { z } from 'zod';
import type { AppEnvironment, AuthConfig } from '../config.ts';
import type { Database } from '../db/schema.ts';
import * as auth from '../modules/identity-auth/index.ts';
import {
  AntiForgeryRefusedError,
  ClientIdentityError,
  DomainError,
  OriginRefusedError,
  UnauthenticatedError,
} from '../shared/errors.ts';
import { enforceRouteDeclarations } from './authorization.ts';
import { buyerRouteTree } from './routes/buyer.ts';
import { sellerRouteTree } from './routes/seller.ts';

// The `web` entry point (ARCH-015, OPS-510). It imports no queue library and nothing under a
// worker, so it never depends on a worker being present (OPS-770, OPS-521). Startup fails closed
// without the Argon2id capability (D-19 condition 1) and without an authorization declaration on
// every seller route (AUTH-222). Every failure response is a fixed body (AUTH-215).

export interface WebAppOptions {
  db: Kysely<Database>;
  logger: Logger;
  appEnv: AppEnvironment;
  authConfig: AuthConfig;
  /** Injected so tests can wrap it; production passes createPasswordVerifier(). */
  passwords: auth.PasswordVerifier;
  /** Injected so tests can relax the throttle; production passes createAuthService(). */
  authService?: auth.AuthService;
}

export const ROUTE_PREFIXES = { seller: '/seller', buyer: '/l' } as const;

const RESPONSES = {
  badRequest: { error: 'bad_request' },
  notFound: { error: 'not_found' },
  unauthenticated: { error: 'unauthenticated' },
  forbiddenOrigin: { error: 'forbidden_origin' },
  forbiddenAntiForgery: { error: 'forbidden_anti_forgery' },
  internal: { error: 'internal' },
} as const;

export async function buildWebApp(options: WebAppOptions) {
  await auth.assertArgon2Capability();
  const cookie = auth.sessionCookiePolicy({
    environment: options.appEnv,
    sellerOrigin: options.authConfig.sellerOrigin,
    idleTimeoutSeconds: options.authConfig.sessionIdleSeconds,
  });
  const authService =
    options.authService ??
    auth.createAuthService({ db: options.db, config: options.authConfig, passwords: options.passwords });

  const app = Fastify({
    loggerInstance: options.logger,
    genReqId: () => randomUUID(),
    logController: new LogController({ requestIdLogLabel: 'request_id' }),
    trustProxy: false,
    bodyLimit: 16 * 1024,
  });
  enforceRouteDeclarations(app, ROUTE_PREFIXES.seller);
  await app.register(fastifyCookie);

  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  app.setErrorHandler((err: unknown, request, reply) => {
    if (err instanceof UnauthenticatedError) {
      reply.clearCookie(cookie.name, auth.clearCookieOptions(cookie));
      return reply.code(401).send(RESPONSES.unauthenticated);
    }
    if (err instanceof OriginRefusedError) return reply.code(403).send(RESPONSES.forbiddenOrigin);
    if (err instanceof AntiForgeryRefusedError) return reply.code(403).send(RESPONSES.forbiddenAntiForgery);
    if (err instanceof ClientIdentityError) {
      request.log.warn({ reason: err.reason }, 'client identity refused');
      return reply.code(400).send(RESPONSES.badRequest);
    }
    if (err instanceof z.ZodError) return reply.code(400).send(RESPONSES.badRequest);
    const status =
      typeof (err as { statusCode?: unknown }).statusCode === 'number'
        ? (err as { statusCode: number }).statusCode
        : 500;
    if (status === 404) return reply.code(404).send(RESPONSES.notFound);
    if (status >= 400 && status < 500) return reply.code(status).send(RESPONSES.badRequest);
    // OPS-573: a type and the request id, never an interpolated message.
    request.log.error(
      { error_type: err instanceof DomainError ? err.code : err instanceof Error ? err.name : typeof err },
      'unhandled error',
    );
    return reply.code(500).send(RESPONSES.internal);
  });
  app.setNotFoundHandler((_request, reply) => reply.code(404).send(RESPONSES.notFound));

  app.get('/health', async () => {
    await sql`select 1`.execute(options.db);
    return { status: 'ok', database: 'reachable' };
  });

  await app.register(sellerRouteTree, {
    prefix: ROUTE_PREFIXES.seller,
    auth: authService,
    config: options.authConfig,
    cookie,
    passwords: options.passwords,
  });
  await app.register(buyerRouteTree, { prefix: ROUTE_PREFIXES.buyer });

  return app;
}

export type WebApp = Awaited<ReturnType<typeof buildWebApp>>;
