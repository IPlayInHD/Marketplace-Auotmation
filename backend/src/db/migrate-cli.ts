import { loadMigrationConfig } from '../config.ts';
import { runMigrations } from './migrate.ts';

// Controlled migration step (OPS-513, OPS-716): run by an operator or CI as the migration/owner
// role, never by a running web or worker process.
//   MIGRATION_DATABASE_URL   connection string for the app_migrator role

const config = loadMigrationConfig(process.env);
const result = await runMigrations(config.migrationDatabaseUrl);
process.stdout.write(
  `${JSON.stringify({ applied: result.applied, already_applied: result.alreadyApplied })}\n`,
);
