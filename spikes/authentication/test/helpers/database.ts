import { randomBytes, randomUUID } from 'node:crypto';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  applySqlFiles,
  backendMigrationsDirectory,
  bootstrapRoles,
  listSqlFiles,
  seedSyntheticSeller,
  spikeAuthSchemaFile,
} from '../../src/db/bootstrap.ts';
import { ROLES } from '../../src/db/constants.ts';

// One fresh PostgreSQL container for the integration file. The production migrations are applied
// from backend/src/db/migrations unmodified, then the spike-only auth schema, then two synthetic
// sellers. Image: SPIKE_POSTGRES_IMAGE (default postgres:16-alpine); Testcontainers honours
// TESTCONTAINERS_HUB_IMAGE_NAME_PREFIX for mirrors.

export interface SyntheticSeller {
  id: string;
  displayName: string;
  inventoryItemId: string;
}

export interface SpikeDatabase {
  container: StartedPostgreSqlContainer;
  superuserUrl: string;
  migratorUrl: string;
  runtimeUrl: string;
  appliedMigrations: string[];
  sellerA: SyntheticSeller;
  sellerB: SyntheticSeller;
  stop(): Promise<void>;
}

function secret(): string {
  return randomBytes(24).toString('hex');
}

export async function startSpikeDatabase(): Promise<SpikeDatabase> {
  const image = process.env['SPIKE_POSTGRES_IMAGE'] ?? 'postgres:16-alpine';
  const database = 'spike';
  const container = await new PostgreSqlContainer(image)
    .withDatabase(database)
    .withUsername('postgres')
    .withPassword(secret())
    .start();
  const host = container.getHost();
  const port = container.getPort();
  const superuserUrl = container.getConnectionUri();
  const passwords = { migrator: secret(), runtime: secret() };
  const url = (role: string, password: string) =>
    `postgresql://${role}:${password}@${host}:${port}/${database}`;
  const migratorUrl = url(ROLES.migrator, passwords.migrator);
  const runtimeUrl = url(ROLES.runtime, passwords.runtime);

  await bootstrapRoles(superuserUrl, database, passwords);
  const files = [...(await listSqlFiles(backendMigrationsDirectory())), spikeAuthSchemaFile()];
  const appliedMigrations = await applySqlFiles(migratorUrl, files);

  const seed = async (displayName: string): Promise<SyntheticSeller> => {
    const id = randomUUID();
    const { inventoryItemId } = await seedSyntheticSeller(migratorUrl, { id, displayName });
    return { id, displayName, inventoryItemId };
  };
  const sellerA = await seed('Synthetic Seller A');
  const sellerB = await seed('Synthetic Seller B');

  return {
    container,
    superuserUrl,
    migratorUrl,
    runtimeUrl,
    appliedMigrations,
    sellerA,
    sellerB,
    stop: async () => {
      await container.stop();
    },
  };
}
