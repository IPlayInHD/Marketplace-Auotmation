import { randomBytes } from 'node:crypto';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { ROLES } from '../../src/db/constants.ts';
import { bootstrapRoles, runMigrations, type MigrationRunResult } from '../../src/db/migrate.ts';

// One fresh PostgreSQL container per test file. Nothing is shared between files, nothing depends
// on a developer's local database, and every container is stopped in afterAll (Ryuk reaps any
// container a crashed run leaves behind).
//
// Image selection: BACKEND_POSTGRES_IMAGE (default postgres:16-alpine). Testcontainers honours
// TESTCONTAINERS_HUB_IMAGE_NAME_PREFIX for environments that must pull through a mirror. The
// digest the suite was accepted against is recorded in backend/README.md.

export interface TestDatabase {
  container: StartedPostgreSqlContainer;
  database: string;
  /** Container superuser. Used only for bootstrap and for privileged inspection in assertions. */
  superuserUrl: string;
  migratorUrl: string;
  runtimeUrl: string;
  migrations: MigrationRunResult | undefined;
  stop(): Promise<void>;
}

function secret(): string {
  return randomBytes(24).toString('hex');
}

export async function startDatabase(options: { applyMigrations?: boolean } = {}): Promise<TestDatabase> {
  const image = process.env['BACKEND_POSTGRES_IMAGE'] ?? 'postgres:16-alpine';
  const database = 'marketplace';
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
  const migrations = options.applyMigrations === false ? undefined : await runMigrations(migratorUrl);

  return {
    container,
    database,
    superuserUrl,
    migratorUrl,
    runtimeUrl,
    migrations,
    stop: async () => {
      await container.stop();
    },
  };
}
