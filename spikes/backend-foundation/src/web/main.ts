import { createDb } from '../db/kysely.ts';
import { createLogger } from '../observability/logger.ts';
import { buildWebApp } from './app.ts';

// Manual entry point for the spike web process. Not used by the tests, which build the app
// in-process. Requires an already-migrated database reachable as the web role.
//   SPIKE_WEB_DATABASE_URL  connection string for the spike_web role
//   SPIKE_DEMO_SELLER_ID    uuid of the seeded demo seller
//   SPIKE_DEMO_LISTING_ID   uuid of the seeded demo listing
// Binds to 127.0.0.1 only.

const url = process.env['SPIKE_WEB_DATABASE_URL'];
const sellerId = process.env['SPIKE_DEMO_SELLER_ID'];
const listingId = process.env['SPIKE_DEMO_LISTING_ID'];
if (!url || !sellerId || !listingId) {
  console.error('SPIKE_WEB_DATABASE_URL, SPIKE_DEMO_SELLER_ID and SPIKE_DEMO_LISTING_ID are required');
  process.exit(2);
}

const logger = createLogger({ module: 'web' });
const handle = createDb(url, 4, 'spike-web');
const app = buildWebApp({ db: handle.db, logger, demo: { sellerId, listingId, publicId: 'demo-public-listing-id' } });

const address = await app.listen({ host: '127.0.0.1', port: Number(process.env['SPIKE_WEB_PORT'] ?? 0) });
logger.info({ address }, 'web listening');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    await app.close();
    await handle.close();
    process.exit(0);
  });
}
