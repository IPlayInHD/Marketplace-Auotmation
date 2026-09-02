import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { PgBoss } from 'pg-boss';
import { PGBOSS_SCHEMA, ROLES } from './constants.ts';
import type { QueueDefinition } from '../jobs/queues.ts';

// Everything in this file runs under a privileged role and only during setup:
//   * bootstrapRoles      — container superuser, once, creates the three roles.
//   * migrateApp          — migration/owner role, applies the SQL migration file.
//   * installPgBossSchema — migration/owner role, installs pg-boss through its own CLI.
//   * grantPgBossRuntime  — migration/owner role, grants DML-only access to the runtime roles.
//   * createQueues        — migration/owner role, declares the queues (a controlled step).
// The runtime roles never execute any of it.

export interface RolePasswords {
  migrator: string;
  web: string;
  worker: string;
}

const HEX_PASSWORD = /^[0-9a-f]{24,64}$/;

function assertPassword(value: string): string {
  // Passwords are generated per run as hex so they can be interpolated into CREATE ROLE, which
  // does not accept bind parameters, without any quoting risk.
  if (!HEX_PASSWORD.test(value)) throw new Error('role passwords must be 24-64 hex characters');
  return value;
}

function assertIdentifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) throw new Error(`unsafe identifier: ${value}`);
  return value;
}

async function withClient<T>(connectionString: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString, application_name: 'spike-migration' });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Creates the migration/owner role and the two runtime roles. Runs as the container superuser. */
export async function bootstrapRoles(superuserUrl: string, database: string, passwords: RolePasswords): Promise<void> {
  const db = assertIdentifier(database);
  await withClient(superuserUrl, async (client) => {
    await client.query('BEGIN');
    // The migration/owner role: not a superuser, cannot bypass RLS, cannot create roles or
    // databases. It may CREATE schemas in this database and owns what it creates.
    await client.query(
      `CREATE ROLE ${ROLES.migrator} LOGIN PASSWORD '${assertPassword(passwords.migrator)}'
         NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION`,
    );
    // The runtime roles: no superuser, no BYPASSRLS, no CREATEDB, no CREATEROLE, and they
    // inherit nothing from any other role.
    for (const [role, password] of [
      [ROLES.web, passwords.web],
      [ROLES.worker, passwords.worker],
    ] as const) {
      await client.query(
        `CREATE ROLE ${role} LOGIN PASSWORD '${assertPassword(password)}'
           NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION`,
      );
    }
    await client.query(`REVOKE ALL ON DATABASE ${db} FROM PUBLIC`);
    await client.query(`REVOKE ALL ON SCHEMA public FROM PUBLIC`);
    await client.query(`GRANT CONNECT ON DATABASE ${db} TO ${ROLES.migrator}, ${ROLES.web}, ${ROLES.worker}`);
    await client.query(`GRANT CREATE ON DATABASE ${db} TO ${ROLES.migrator}`);
    await client.query('COMMIT');
  });
}

const here = path.dirname(fileURLToPath(import.meta.url));

/** Applies the explicit SQL migration under the migration/owner role, in one transaction. */
export async function migrateApp(migratorUrl: string): Promise<void> {
  const file = path.join(here, 'migrations', '0001_app_schema.sql');
  const ddl = await readFile(file, 'utf8');
  await withClient(migratorUrl, async (client) => {
    await client.query('BEGIN');
    await client.query(ddl);
    await client.query('COMMIT');
  });
}

export interface PgBossInstallResult {
  createOutput: string;
  versionOutput: string;
}

function runPgBossCli(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  // Resolve the CLI shipped inside the pinned pg-boss package, not a global install.
  const require = createRequire(import.meta.url);
  const cli = path.join(path.dirname(require.resolve('pg-boss/package.json')), 'dist', 'cli.js');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

/**
 * Installs the pg-boss schema using the supported CLI path (`pg-boss create`), connected as the
 * migration/owner role. The connection string is passed through the documented
 * PGBOSS_DATABASE_URL environment variable so it never appears on a command line.
 * Upgrades would use `pg-boss migrate` the same way. No runtime process ever runs either.
 */
export async function installPgBossSchema(migratorUrl: string): Promise<PgBossInstallResult> {
  const env: NodeJS.ProcessEnv = { PATH: process.env['PATH'] ?? '', PGBOSS_DATABASE_URL: migratorUrl, PGBOSS_SCHEMA: PGBOSS_SCHEMA };
  const create = await runPgBossCli(['create'], env);
  if (create.code !== 0) throw new Error(`pg-boss create failed (${create.code}): ${create.stderr || create.stdout}`);
  const version = await runPgBossCli(['version'], env);
  if (version.code !== 0) throw new Error(`pg-boss version failed (${version.code}): ${version.stderr || version.stdout}`);
  return { createOutput: create.stdout.trim(), versionOutput: version.stdout.trim() };
}

/**
 * Grants the runtime roles DML-only access to the pg-boss schema. Ownership stays with the
 * migration role. The `version` table is read-only for both runtime roles; queue topology
 * functions are not executable by them, so queues are declared only through createQueues().
 */
export async function grantPgBossRuntime(migratorUrl: string): Promise<void> {
  const s = PGBOSS_SCHEMA;
  await withClient(migratorUrl, async (client) => {
    await client.query('BEGIN');
    await client.query(`GRANT USAGE ON SCHEMA ${s} TO ${ROLES.web}, ${ROLES.worker}`);
    // worker: full DML on job storage and queue bookkeeping, read-only on the schema version.
    await client.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${s} TO ${ROLES.worker}`);
    await client.query(`REVOKE INSERT, UPDATE, DELETE ON ${s}.version FROM ${ROLES.worker}`);
    // web: may enqueue (INSERT into the job tables) and read queue metadata; nothing else.
    await client.query(`GRANT SELECT ON ALL TABLES IN SCHEMA ${s} TO ${ROLES.web}`);
    const jobTables = await client.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = $1 AND tablename LIKE 'job%'`,
      [s],
    );
    for (const row of jobTables.rows) {
      await client.query(`GRANT INSERT ON ${s}.${assertIdentifier(row.tablename)} TO ${ROLES.web}`);
    }
    // Queue topology is a migration concern in this design.
    await client.query(`REVOKE EXECUTE ON FUNCTION ${s}.create_queue(text, jsonb) FROM PUBLIC, ${ROLES.web}, ${ROLES.worker}`);
    await client.query(`REVOKE EXECUTE ON FUNCTION ${s}.delete_queue(text) FROM PUBLIC, ${ROLES.web}, ${ROLES.worker}`);
    await client.query('COMMIT');
  });
}

/** Declares the spike queues as a controlled migration-role step. */
export async function createQueues(migratorUrl: string, queues: readonly QueueDefinition[]): Promise<void> {
  const boss = new PgBoss({
    connectionString: migratorUrl,
    schema: PGBOSS_SCHEMA,
    application_name: 'spike-migration-queues',
    migrate: false,
    createSchema: false,
    supervise: false,
    schedule: false,
    reindex: false,
    max: 2,
  });
  await boss.start();
  try {
    for (const q of queues) {
      const { name, ...options } = q;
      await boss.createQueue(name, options);
    }
  } finally {
    await boss.stop({ close: true, graceful: false, timeout: 5_000 });
  }
}
