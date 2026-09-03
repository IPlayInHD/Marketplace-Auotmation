import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { MIGRATION_SCHEMA, ROLES } from './constants.ts';

// Everything in this file runs under a privileged role and only during setup:
//   * bootstrapRoles — container or cluster superuser, once, creates the two roles.
//   * runMigrations  — migration/owner role, applies the forward-only SQL migrations.
// The runtime role never executes any of it (OPS-716).

export interface RolePasswords {
  migrator: string;
  runtime: string;
}

const HEX_PASSWORD = /^[0-9a-f]{24,64}$/;

function assertPassword(value: string): string {
  // Passwords are generated per environment as hex so they can be interpolated into CREATE ROLE,
  // which does not accept bind parameters, without any quoting risk.
  if (!HEX_PASSWORD.test(value)) throw new Error('role passwords must be 24-64 hex characters');
  return value;
}

function assertIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) throw new Error(`unsafe identifier: ${value}`);
  return value;
}

async function withClient<T>(
  connectionString: string,
  applicationName: string,
  fn: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ connectionString, application_name: applicationName });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/**
 * Creates the migration/owner role and the runtime role. Runs as a superuser, once per database.
 * Neither role is a superuser, neither can bypass row-level security, create roles or databases,
 * and neither inherits anything from any other role (OPS-716, SEC-100).
 */
export async function bootstrapRoles(
  superuserUrl: string,
  database: string,
  passwords: RolePasswords,
): Promise<void> {
  const db = assertIdentifier(database);
  await withClient(superuserUrl, 'marketplace-bootstrap', async (client) => {
    await client.query('BEGIN');
    await client.query(
      `CREATE ROLE ${ROLES.migrator} LOGIN PASSWORD '${assertPassword(passwords.migrator)}'
         NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION`,
    );
    await client.query(
      `CREATE ROLE ${ROLES.runtime} LOGIN PASSWORD '${assertPassword(passwords.runtime)}'
         NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION`,
    );
    await client.query(`REVOKE ALL ON DATABASE ${db} FROM PUBLIC`);
    await client.query(`REVOKE ALL ON SCHEMA public FROM PUBLIC`);
    await client.query(`GRANT CONNECT ON DATABASE ${db} TO ${ROLES.migrator}, ${ROLES.runtime}`);
    await client.query(`GRANT CREATE ON DATABASE ${db} TO ${ROLES.migrator}`);
    await client.query('COMMIT');
  });
}

const here = path.dirname(fileURLToPath(import.meta.url));

/** The directory holding the versioned SQL migrations of this codebase. */
export function defaultMigrationsDirectory(): string {
  return path.join(here, 'migrations');
}

export interface MigrationFile {
  /** File name, e.g. `0001_listing_foundation.sql`. */
  name: string;
  /** Sequence number parsed from the name. */
  sequence: number;
  sql: string;
  /** SHA-256 of the file content, hex. Stored in the ledger so an applied file can never change. */
  checksum: string;
}

const MIGRATION_NAME = /^(\d{4})_[a-z0-9_]+\.sql$/;

/** Lists the migrations in a directory, validating names and contiguous numbering from 0001. */
export async function listMigrations(directory: string): Promise<MigrationFile[]> {
  const entries = (await readdir(directory)).filter((f) => f.endsWith('.sql')).sort();
  const files: MigrationFile[] = [];
  for (const name of entries) {
    const match = MIGRATION_NAME.exec(name);
    if (!match) throw new Error(`migration file name is not NNNN_name.sql: ${name}`);
    const sequence = Number(match[1]);
    const expected = files.length + 1;
    if (sequence !== expected) {
      throw new Error(`migration ${name} is out of sequence: expected ${String(expected).padStart(4, '0')}`);
    }
    const sql = await readFile(path.join(directory, name), 'utf8');
    files.push({ name, sequence, sql, checksum: createHash('sha256').update(sql).digest('hex') });
  }
  return files;
}

export interface MigrationRunResult {
  applied: string[];
  alreadyApplied: string[];
}

/**
 * Applies pending migrations in order under the migration/owner role. Forward-only (OPS-513,
 * OPS-514): there is no down path, and a migration whose file changed after it was applied
 * fails the run instead of being re-applied or ignored. Concurrent runners serialise on an
 * advisory lock so a migration is never applied twice.
 */
export async function runMigrations(
  migratorUrl: string,
  directory: string = defaultMigrationsDirectory(),
): Promise<MigrationRunResult> {
  const migrations = await listMigrations(directory);
  return withClient(migratorUrl, 'marketplace-migration', async (client) => {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['marketplace-backend-migrations']);
    await client.query(`CREATE SCHEMA IF NOT EXISTS ${MIGRATION_SCHEMA}`);
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${MIGRATION_SCHEMA}.applied (
         name        text        PRIMARY KEY,
         checksum    text        NOT NULL,
         applied_at  timestamptz NOT NULL DEFAULT now()
       )`,
    );
    const ledger = await client.query<{ name: string; checksum: string }>(
      `SELECT name, checksum FROM ${MIGRATION_SCHEMA}.applied ORDER BY name`,
    );
    const applied = new Map(ledger.rows.map((r) => [r.name, r.checksum]));
    await client.query('COMMIT');

    const result: MigrationRunResult = { applied: [], alreadyApplied: [] };
    for (const migration of migrations) {
      const recorded = applied.get(migration.name);
      if (recorded !== undefined) {
        if (recorded !== migration.checksum) {
          throw new Error(
            `migration ${migration.name} was modified after it was applied; migrations are forward-only, add a new one`,
          );
        }
        result.alreadyApplied.push(migration.name);
        continue;
      }
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['marketplace-backend-migrations']);
      const check = await client.query(`SELECT 1 FROM ${MIGRATION_SCHEMA}.applied WHERE name = $1`, [
        migration.name,
      ]);
      if (check.rowCount === 0) {
        await client.query(migration.sql);
        await client.query(`INSERT INTO ${MIGRATION_SCHEMA}.applied (name, checksum) VALUES ($1, $2)`, [
          migration.name,
          migration.checksum,
        ]);
        result.applied.push(migration.name);
      } else {
        result.alreadyApplied.push(migration.name);
      }
      await client.query('COMMIT');
    }
    return result;
  });
}
