import { randomUUID } from 'node:crypto';
import Fastify, { LogController } from 'fastify';
import { sql, type Kysely } from 'kysely';
import type { Logger } from 'pino';
import { withTenant } from '../db/kysely.ts';
import type { Database } from '../db/schema.ts';
import { ListingRecordSchema, toBuyerSafe } from '../domain/projection.ts';
import { renderBuyerPage, renderNotFound } from './render.ts';

// The `web` entry point. It imports neither pg-boss nor anything under src/worker, which a test
// asserts, so it can never depend on a worker being present (OPS-770, SEC-131, OPS-521).

export interface WebAppOptions {
  db: Kysely<Database>;
  logger: Logger;
  /** Spike only: the demo tenant and listing the buyer route renders. */
  demo: { sellerId: string; listingId: string; publicId: string };
}

export function buildWebApp(options: WebAppOptions) {
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
    return { status: 'ok', database: 'reachable', worker_required: false };
  });

  app.get('/buyer/demo', async (request, reply) => {
    const { sellerId, listingId, publicId } = options.demo;
    const row = await withTenant(options.db, sellerId, (trx) =>
      trx.selectFrom('listings').selectAll().where('id', '=', listingId).executeTakeFirst(),
    );
    reply
      .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'")
      .header('x-frame-options', 'DENY')
      .header('referrer-policy', 'no-referrer')
      .header('x-robots-tag', 'noindex')
      .type('text/html; charset=utf-8');
    if (!row) {
      request.log.info({ listing_found: false }, 'buyer demo page');
      return reply.code(404).send(renderNotFound());
    }
    const record = ListingRecordSchema.parse({
      id: row.id,
      sellerId: row.seller_id,
      title: row.title,
      askingPriceMinor: row.asking_price_minor,
      currency: row.currency,
      minimumPriceMinor: row.minimum_price_minor,
      internalNotes: row.internal_notes,
      sellerDisplayName: row.seller_display_name,
    });
    const safe = toBuyerSafe(record, publicId);
    request.log.info({ listing_found: true, seller_id: record.sellerId }, 'buyer demo page');
    return reply.send(renderBuyerPage(safe));
  });

  return app;
}

export type WebApp = ReturnType<typeof buildWebApp>;
