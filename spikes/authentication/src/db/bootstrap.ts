import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { ROLES, TENANT_SETTING } from './constants.ts';

// Test-harness setup only. Replicates the production role bootstrap (backend/src/db/migrate.ts)
// and applies the production SQL migrations read from disk, unmodified, so the spike proves
// tenant resolution against the real schema. Nothing here is imported by production code and
// nothing here modifies production files.

const HEX_PASSWORD = /^[0-9a-f]{24,64}$/;

function assertPassword(value: string): string {
  if (!HEX_PASSWORD.test(value)) throw new Error('role passwords must be 24-64 hex characters');
  return value;
}

function assertIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) throw new Error(`unsafe identifier: ${value}`);
  return value;
}

async function withClient<T>(connectionString: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString, application_name: 'authentication-spike-setup' });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export async function bootstrapRoles(
  superuserUrl: string,
  database: string,
  passwords: { migrator: string; runtime: string },
): Promise<void> {
  const db = assertIdentifier(database);
  await withClient(superuserUrl, async (client) => {
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

/** backend/src/db/migrations, read only. */
export function backendMigrationsDirectory(): string {
  return path.resolve(here, '../../../../backend/src/db/migrations');
}

export function spikeAuthSchemaFile(): string {
  return path.join(here, 'auth-schema.sql');
}

export async function listSqlFiles(directory: string): Promise<string[]> {
  const names = (await readdir(directory)).filter((n) => n.endsWith('.sql')).sort();
  return names.map((n) => path.join(directory, n));
}

/** Applies each file in its own transaction as the migration role, in the given order. */
export async function applySqlFiles(migratorUrl: string, files: string[]): Promise<string[]> {
  const applied: string[] = [];
  await withClient(migratorUrl, async (client) => {
    for (const file of files) {
      const text = await readFile(file, 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(text);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
      applied.push(path.basename(file));
    }
  });
  return applied;
}

/**
 * Inserts a synthetic seller and one inventory item under that seller's own tenant context, as
 * the schema owner. FORCE ROW LEVEL SECURITY applies to the owner too, so the context is needed.
 */
export async function seedSyntheticSeller(
  migratorUrl: string,
  seller: { id: string; displayName: string },
): Promise<{ inventoryItemId: string }> {
  return withClient(migratorUrl, async (client) => {
    await client.query('BEGIN');
    await client.query('SELECT set_config($1, $2, true)', [TENANT_SETTING, seller.id]);
    await client.query('INSERT INTO app.seller (id, display_name) VALUES ($1, $2)', [
      seller.id,
      seller.displayName,
    ]);
    const item = await client.query<{ id: string }>(
      'INSERT INTO app.inventory_item (seller_id, request_id) VALUES ($1, $2) RETURNING id',
      [seller.id, `seed-${seller.id}`],
    );
    await client.query('COMMIT');
    const id = item.rows[0]?.id;
    if (!id) throw new Error('seed failed');
    return { inventoryItemId: id };
  });
}
