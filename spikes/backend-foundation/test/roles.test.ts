import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_SCHEMA, PGBOSS_SCHEMA, ROLES } from '../src/db/constants.ts';
import { startSpikeDatabase, type SpikeDatabase } from './helpers/database.ts';
import { expectPgError, query, withClient } from './helpers/inspect.ts';

// Proof 1 — PostgreSQL role separation.
// Every negative case asserts SQLSTATE 42501 (insufficient_privilege): the statement was refused
// for the privilege reason, not because of a syntax or connection error.

const INSUFFICIENT_PRIVILEGE = '42501';
const RUNTIME_ROLES = [ROLES.web, ROLES.worker] as const;

describe('PostgreSQL role separation', () => {
  let env: SpikeDatabase;
  beforeAll(async () => {
    env = await startSpikeDatabase();
  });
  afterAll(async () => {
    await env?.stop();
  });

  const urlFor = (role: (typeof RUNTIME_ROLES)[number]) => (role === ROLES.web ? env.webUrl : env.workerUrl);

  it('runtime roles are not superusers, cannot bypass RLS and hold no role-level power', async () => {
    const rows = await query<{
      rolname: string;
      rolsuper: boolean;
      rolbypassrls: boolean;
      rolcreaterole: boolean;
      rolcreatedb: boolean;
      rolinherit: boolean;
      rolreplication: boolean;
    }>(env.superuserUrl, `SELECT rolname, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolinherit, rolreplication FROM pg_roles WHERE rolname = ANY($1)`, [
      [ROLES.migrator, ROLES.web, ROLES.worker],
    ]);
    expect(rows.map((r) => r.rolname).sort()).toEqual([ROLES.migrator, ROLES.web, ROLES.worker].sort());
    for (const r of rows) {
      expect(r.rolsuper, `${r.rolname} superuser`).toBe(false);
      expect(r.rolbypassrls, `${r.rolname} bypassrls`).toBe(false);
      expect(r.rolcreaterole, `${r.rolname} createrole`).toBe(false);
      expect(r.rolcreatedb, `${r.rolname} createdb`).toBe(false);
      expect(r.rolinherit, `${r.rolname} inherit`).toBe(false);
      expect(r.rolreplication, `${r.rolname} replication`).toBe(false);
    }
    const memberships = await query<{ n: string }>(env.superuserUrl, `SELECT count(*)::text AS n FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member WHERE r.rolname = ANY($1)`, [
      [ROLES.web, ROLES.worker],
    ]);
    expect(memberships[0]?.n).toBe('0');
  });

  it('runtime roles own no schema, table, index, sequence or function; the migration role owns the protected objects', async () => {
    const owned = await query<{ kind: string; name: string; owner: string }>(
      env.superuserUrl,
      `SELECT 'relation' AS kind, n.nspname || '.' || c.relname AS name, pg_get_userbyid(c.relowner) AS owner
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE pg_get_userbyid(c.relowner) = ANY($1)
       UNION ALL
       SELECT 'schema', n.nspname, pg_get_userbyid(n.nspowner) FROM pg_namespace n WHERE pg_get_userbyid(n.nspowner) = ANY($1)
       UNION ALL
       SELECT 'function', n.nspname || '.' || p.proname, pg_get_userbyid(p.proowner)
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE pg_get_userbyid(p.proowner) = ANY($1)`,
      [[ROLES.web, ROLES.worker]],
    );
    expect(owned).toEqual([]);

    const protectedTables = await query<{ name: string; owner: string }>(
      env.superuserUrl,
      `SELECT n.nspname || '.' || c.relname AS name, pg_get_userbyid(c.relowner) AS owner
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relkind IN ('r','p') AND n.nspname = ANY($1) ORDER BY 1`,
      [[APP_SCHEMA, PGBOSS_SCHEMA]],
    );
    expect(protectedTables.length).toBeGreaterThan(3);
    for (const t of protectedTables) expect(t.owner, t.name).toBe(ROLES.migrator);
    const schemas = await query<{ nspname: string; owner: string }>(env.superuserUrl, `SELECT nspname, pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname = ANY($1)`, [
      [APP_SCHEMA, PGBOSS_SCHEMA],
    ]);
    expect(schemas.map((s) => s.owner)).toEqual([ROLES.migrator, ROLES.migrator]);
  });

  it.each(RUNTIME_ROLES)('%s cannot create, alter, drop, index or truncate protected tables', async (role) => {
    const url = urlFor(role);
    const statements = [
      `CREATE TABLE ${APP_SCHEMA}.intruder (id int)`,
      `CREATE TABLE ${PGBOSS_SCHEMA}.intruder (id int)`,
      `CREATE TABLE public.intruder (id int)`,
      `ALTER TABLE ${APP_SCHEMA}.listings ADD COLUMN intruder int`,
      `ALTER TABLE ${PGBOSS_SCHEMA}.job ADD COLUMN intruder int`,
      `DROP TABLE ${APP_SCHEMA}.listings`,
      `DROP TABLE ${PGBOSS_SCHEMA}.version`,
      `CREATE INDEX intruder_idx ON ${APP_SCHEMA}.listings (title)`,
      `CREATE INDEX intruder_idx ON ${PGBOSS_SCHEMA}.job_common (name)`,
      `TRUNCATE ${APP_SCHEMA}.listings`,
      `ALTER TABLE ${APP_SCHEMA}.listings OWNER TO ${role}`,
    ];
    for (const text of statements) {
      const err = await expectPgError(url, text);
      expect(err.code, `${role}: ${text} -> ${err.message}`).toBe(INSUFFICIENT_PRIVILEGE);
    }
  });

  it.each(RUNTIME_ROLES)('%s cannot change the protected schemas or add objects to them', async (role) => {
    const url = urlFor(role);
    const statements = [
      `ALTER SCHEMA ${APP_SCHEMA} RENAME TO app_renamed`,
      `DROP SCHEMA ${APP_SCHEMA} CASCADE`,
      `DROP SCHEMA ${PGBOSS_SCHEMA} CASCADE`,
      `CREATE SCHEMA intruder`,
      `CREATE FUNCTION ${APP_SCHEMA}.intruder() RETURNS int LANGUAGE sql AS 'SELECT 1'`,
      `CREATE OR REPLACE FUNCTION ${APP_SCHEMA}.current_seller_id() RETURNS uuid LANGUAGE sql AS 'SELECT NULL::uuid'`,
      `DROP FUNCTION ${PGBOSS_SCHEMA}.create_queue(text, jsonb)`,
    ];
    for (const text of statements) {
      const err = await expectPgError(url, text);
      expect(err.code, `${role}: ${text} -> ${err.message}`).toBe(INSUFFICIENT_PRIVILEGE);
    }
  });

  it.each(RUNTIME_ROLES)('%s cannot disable, un-force or rewrite row-level security', async (role) => {
    const url = urlFor(role);
    const statements = [
      `ALTER TABLE ${APP_SCHEMA}.listings DISABLE ROW LEVEL SECURITY`,
      `ALTER TABLE ${APP_SCHEMA}.listings NO FORCE ROW LEVEL SECURITY`,
      `DROP POLICY listings_tenant_isolation ON ${APP_SCHEMA}.listings`,
      `ALTER POLICY listings_tenant_isolation ON ${APP_SCHEMA}.listings USING (true)`,
      `CREATE POLICY intruder ON ${APP_SCHEMA}.listings USING (true)`,
    ];
    for (const text of statements) {
      const err = await expectPgError(url, text);
      expect(err.code, `${role}: ${text} -> ${err.message}`).toBe(INSUFFICIENT_PRIVILEGE);
    }
  });

  it.each(RUNTIME_ROLES)('%s cannot assume the migration role', async (role) => {
    const url = urlFor(role);
    for (const text of [`SET ROLE ${ROLES.migrator}`, `SET SESSION AUTHORIZATION ${ROLES.migrator}`, `SET ROLE postgres`]) {
      const err = await expectPgError(url, text);
      expect(err.code, `${role}: ${text} -> ${err.message}`).toBe(INSUFFICIENT_PRIVILEGE);
    }
  });

  it('runtime roles hold only the DML privileges the spike needs, and nothing outside app and pgboss', async () => {
    const grants = await query<{ grantee: string; table_schema: string; table_name: string; privilege_type: string }>(
      env.superuserUrl,
      `SELECT grantee, table_schema, table_name, privilege_type FROM information_schema.role_table_grants WHERE grantee = ANY($1) ORDER BY 1,2,3,4`,
      [[ROLES.web, ROLES.worker]],
    );
    expect(grants.length).toBeGreaterThan(0);
    const privs = new Map<string, Set<string>>();
    for (const g of grants) {
      expect([APP_SCHEMA, PGBOSS_SCHEMA], `${g.grantee} has a grant outside protected schemas: ${g.table_schema}.${g.table_name}`).toContain(g.table_schema);
      const key = `${g.grantee}|${g.table_schema}.${g.table_name}`;
      privs.set(key, (privs.get(key) ?? new Set()).add(g.privilege_type));
    }
    const dml = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE']);
    for (const [key, set] of privs) {
      for (const p of set) expect(dml, `${key} holds non-DML privilege ${p}`).toContain(p);
    }
    const expectApp = (role: string, table: string, expected: string[]) =>
      expect([...(privs.get(`${role}|${APP_SCHEMA}.${table}`) ?? [])].sort(), `${role} on ${table}`).toEqual(expected.sort());
    expectApp(ROLES.web, 'listings', ['SELECT', 'INSERT', 'UPDATE', 'DELETE']);
    expectApp(ROLES.web, 'demo_records', ['SELECT', 'INSERT']);
    expectApp(ROLES.web, 'side_effects', []);
    expectApp(ROLES.worker, 'listings', ['SELECT']);
    expectApp(ROLES.worker, 'demo_records', ['SELECT']);
    expectApp(ROLES.worker, 'side_effects', ['SELECT', 'INSERT']);
    for (const [key, set] of privs) {
      const [role, name] = key.split('|') as [string, string];
      if (!name.startsWith(`${PGBOSS_SCHEMA}.`)) continue;
      const table = name.slice(PGBOSS_SCHEMA.length + 1);
      if (role === ROLES.web) {
        const allowed = table.startsWith('job') ? ['SELECT', 'INSERT'] : ['SELECT'];
        for (const p of set) expect(allowed, `${key} ${p}`).toContain(p);
      } else if (table === 'version') {
        expect([...set]).toEqual(['SELECT']);
      }
    }
    const fn = await query<{ web_create_queue: boolean; worker_create_queue: boolean; web_ctx: boolean; worker_ctx: boolean }>(
      env.superuserUrl,
      `SELECT has_function_privilege($1, '${PGBOSS_SCHEMA}.create_queue(text, jsonb)', 'EXECUTE') AS web_create_queue,
              has_function_privilege($2, '${PGBOSS_SCHEMA}.create_queue(text, jsonb)', 'EXECUTE') AS worker_create_queue,
              has_function_privilege($1, '${APP_SCHEMA}.current_seller_id()', 'EXECUTE') AS web_ctx,
              has_function_privilege($2, '${APP_SCHEMA}.current_seller_id()', 'EXECUTE') AS worker_ctx`,
      [ROLES.web, ROLES.worker],
    );
    expect(fn[0]).toEqual({ web_create_queue: false, worker_create_queue: false, web_ctx: true, worker_ctx: true });
    const dbPrivs = await query<{ role: string; create_db: boolean; create_app: boolean; create_pgboss: boolean; create_public: boolean }>(
      env.superuserUrl,
      `SELECT r AS role, has_database_privilege(r, current_database(), 'CREATE') AS create_db,
              has_schema_privilege(r, '${APP_SCHEMA}', 'CREATE') AS create_app,
              has_schema_privilege(r, '${PGBOSS_SCHEMA}', 'CREATE') AS create_pgboss,
              has_schema_privilege(r, 'public', 'CREATE') AS create_public
         FROM unnest($1::text[]) AS r`,
      [[ROLES.web, ROLES.worker]],
    );
    for (const p of dbPrivs) expect(p, p.role).toEqual({ role: p.role, create_db: false, create_app: false, create_pgboss: false, create_public: false });
  });

  it('the migration role can install and upgrade schema objects (positive control)', async () => {
    await withClient(env.migratorUrl, async (client) => {
      await client.query('BEGIN');
      await client.query(`CREATE TABLE ${APP_SCHEMA}.migration_probe (id int)`);
      await client.query(`ALTER TABLE ${APP_SCHEMA}.migration_probe ADD COLUMN note text`);
      await client.query(`DROP TABLE ${APP_SCHEMA}.migration_probe`);
      await client.query('ROLLBACK');
    });
  });
});
