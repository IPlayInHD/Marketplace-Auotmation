import { randomUUID } from 'node:crypto';
import Fastify, { LogController } from 'fastify';
import { sql, type Kysely } from 'kysely';
import type { Logger } from 'pino';
import type { Database } from '../db/schema.ts';
import { buyerRouteTree } from './routes/buyer.ts';
import { sellerRouteTree } from './routes/seller.ts';

// The `web` entry point (ARCH-015, OPS-510). It imports no queue library and nothing under a
// worker, so it never depends on a worker being present (OPS-770, OPS-521).

export interface WebAppOptions {
  db: Kysely<Database>;
  logger: Logger;
}

export const ROUTE_PREFIXES = { seller: '/seller', buyer: '/l' } as const;

export async function buildWebApp(options: WebAppOptions) {
  const app = Fastify({
    loggerInstance: options.logger,
    genReqId: () => randomUUID(),
    logController: new LogController({ requestIdLogLabel: 'request_id' }),
    trustProxy: false,
  });

  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  app.get('/health', async () => {
    await sql`select 1`.execute(options.db);
    return { status: 'ok', database: 'reachable' };
  });

  await app.register(sellerRouteTree, { prefix: ROUTE_PREFIXES.seller });
  await app.register(buyerRouteTree, { prefix: ROUTE_PREFIXES.buyer });

  return app;
}

export type WebApp = Awaited<ReturnType<typeof buildWebApp>>;
