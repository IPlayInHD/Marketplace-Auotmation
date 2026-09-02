import { randomBytes, randomUUID } from 'node:crypto';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ROLES } from '../../src/db/constants.ts';
import { createDb } from '../../src/db/kysely.ts';
import {
  bootstrapRoles,
  createQueues,
  grantPgBossRuntime,
  installPgBossSchema,
  migrateApp,
  type PgBossInstallResult,
} from '../../src/db/migrate.ts';
import { seedListing } from '../../src/db/seed.ts';
import { ALL_QUEUES } from '../../src/jobs/queues.ts';

// One fresh PostgreSQL container per test file. Nothing is shared between files, nothing depends
// on a developer's local database, and every container is stopped in afterAll (Ryuk reaps any
// container a crashed run leaves behind).
//
// Image selection: SPIKE_POSTGRES_IMAGE (default postgres:16-alpine). Testcontainers honours
// TESTCONTAINERS_HUB_IMAGE_NAME_PREFIX for environments that must pull through a mirror.

export interface SpikeDatabase {
  container: StartedPostgreSqlContainer;
  database: string;
  host: string;
  port: number;
  /** Container superuser. Used only for bootstrap and for privileged inspection in assertions. */
  superuserUrl: string;
  migratorUrl: string;
  webUrl: string;
  workerUrl: string;
  pgboss: PgBossInstallResult;
  demo: { sellerId: string; listingId: string; publicId: string; otherSellerId: string; otherListingId: string };
  stop(): Promise<void>;
}

function secret(): string {
  return randomBytes(24).toString('hex');
}

export const DEMO_LISTING = {
  title: 'Spike demo bicycle',
  askingPriceMinor: 25_000,
  currency: 'EUR',
  minimumPriceMinor: 20_000,
  internalNotes: 'PRIVATE: bought at 150, needs new chain',
  sellerDisplayName: 'Demo Seller',
} as const;

export async function startSpikeDatabase(): Promise<SpikeDatabase> {
  const image = process.env['SPIKE_POSTGRES_IMAGE'] ?? 'postgres:16-alpine';
  const database = 'spike';
  const superPassword = secret();
  const container = await new PostgreSqlContainer(image)
    .withDatabase(database)
    .withUsername('postgres')
    .withPassword(superPassword)
    .start();

  const host = container.getHost();
  const port = container.getPort();
  const superuserUrl = container.getConnectionUri();
  const passwords = { migrator: secret(), web: secret(), worker: secret() };
  const url = (role: string, password: string) => `postgresql://${role}:${password}@${host}:${port}/${database}`;
  const migratorUrl = url(ROLES.migrator, passwords.migrator);
  const webUrl = url(ROLES.web, passwords.web);
  const workerUrl = url(ROLES.worker, passwords.worker);

  await bootstrapRoles(superuserUrl, database, passwords);
  await migrateApp(migratorUrl);
  const pgboss = await installPgBossSchema(migratorUrl);
  await grantPgBossRuntime(migratorUrl);
  await createQueues(migratorUrl, ALL_QUEUES);

  // Seed two tenants through the web role so the seed itself is subject to RLS.
  const sellerId = randomUUID();
  const otherSellerId = randomUUID();
  const web = createDb(webUrl, 2, 'spike-seed');
  try {
    const listingId = await seedListing(web.db, { sellerId, ...DEMO_LISTING });
    const otherListingId = await seedListing(web.db, {
      sellerId: otherSellerId,
      ...DEMO_LISTING,
      title: 'Other seller listing',
      internalNotes: 'PRIVATE: other seller notes',
      sellerDisplayName: 'Other Seller',
    });
    return {
      container,
      database,
      host,
      port,
      superuserUrl,
      migratorUrl,
      webUrl,
      workerUrl,
      pgboss,
      demo: { sellerId, listingId, publicId: 'demo-public-listing-id', otherSellerId, otherListingId },
      stop: async () => {
        await container.stop();
      },
    };
  } finally {
    await web.close();
  }
}
