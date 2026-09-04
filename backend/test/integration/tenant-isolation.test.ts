import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_SCHEMA, MIGRATION_SCHEMA, ROLES, SQLSTATE, TENANT_SETTING } from '../../src/db/constants.ts';
import { createDb, withTenant } from '../../src/db/kysely.ts';
import { startDatabase, type TestDatabase } from '../helpers/database.ts';
import { FIXTURE, publishListing, seedSeller } from '../helpers/fixtures.ts';
import { expectPgError, query, withClient } from '../helpers/inspect.ts';

// SEC-100, SEC-101, OPS-716, D-17: tenant isolation at the data layer, fail-closed context,
// pooled-connection reset, and a runtime role that cannot reach past the RLS boundary.

const SELLER_OWNED = [
  'inventory_item',
  'listing',
  'listing_content_version',
  'product_fact',
  'seller_policy_version',
  'audit_event',
  'idempotency_receipt',
  'public_listing_access',
  'listing_access_code',
] as const;

describe('Tenant isolation', () => {
  let env: TestDatabase;
  let sellerA: string;
  let sellerB: string;
  let listingA: string;
  let listingB: string;
  let policyB: string;

  beforeAll(async () => {
    env = await startDatabase();
    const runtime = createDb(env.runtimeUrl, { max: 2, applicationName: 'isolation-seed' });
    try {
      sellerA = await seedSeller(runtime.db, FIXTURE.sellers.a);
      sellerB = await seedSeller(runtime.db, FIXTURE.sellers.b);
      // Published listings, so every seller-owned table, access and codes included, holds rows.
      listingA = (await publishListing(runtime.db, sellerA)).built.listingId;
      const b = await publishListing(runtime.db, sellerB);
      listingB = b.built.listingId;
      policyB = b.built.policyVersionId ?? '';
    } finally {
      await runtime.close();
    }
  });
  afterAll(async () => {
    await env?.stop();
  });

  it('lets seller A read only its own rows on every seller-owned table', async () => {
    const runtime = createDb(env.runtimeUrl, { max: 2 });
    try {
      for (const table of SELLER_OWNED) {
        const rows = await withTenant(runtime.db, sellerA, (trx) =>
          trx.selectFrom(table).select('seller_id').execute(),
        );
        expect(rows.length, table).toBeGreaterThan(0);
        for (const r of rows) expect(r.seller_id, table).toBe(sellerA);
      }
      const theirs = await withTenant(runtime.db, sellerA, (trx) =>
        trx.selectFrom('listing').select('id').where('id', '=', listingB).executeTakeFirst(),
      );
      expect(theirs).toBeUndefined();
      const sellerRows = await withTenant(runtime.db, sellerA, (trx) =>
        trx.selectFrom('seller').select('id').execute(),
      );
      expect(sellerRows).toEqual([{ id: sellerA }]);
    } finally {
      await runtime.close();
    }
  });

  it('lets seller A neither update nor insert into seller B’s tenant', async () => {
    const runtime = createDb(env.runtimeUrl, { max: 2 });
    try {
      const updated = await withTenant(runtime.db, sellerA, (trx) =>
        trx
          .updateTable('listing')
          .set({ request_id: 'hijack', row_version: sql`row_version + 1` })
          .where('id', '=', listingB)
          .executeTakeFirst(),
      );
      expect(Number(updated.numUpdatedRows)).toBe(0);
      const still = await query<{ request_id: string }>(
        env.superuserUrl,
        `SELECT request_id FROM ${APP_SCHEMA}.listing WHERE id = $1`,
        [listingB],
      );
      expect(still[0]?.request_id).not.toBe('hijack');

      const insertListing = withTenant(runtime.db, sellerA, (trx) =>
        trx
          .insertInto('listing')
          .values({ seller_id: sellerB, inventory_item_id: listingB, request_id: 'hijack' })
          .execute(),
      );
      await expect(insertListing).rejects.toMatchObject({ code: SQLSTATE.insufficientPrivilege });
      await expect(insertListing).rejects.toThrow(/row-level security policy/);

      const insertAudit = withTenant(runtime.db, sellerA, (trx) =>
        trx
          .insertInto('audit_event')
          .values({
            seller_id: sellerB,
            event_type: 'LISTING_STATUS_CHANGED',
            actor_type: 'SELLER',
            actor_ref: sellerA,
            subject_type: 'listing',
            subject_id: listingB,
            policy_version_id: null,
            request_id: 'hijack',
            idempotency_key: null,
            summary: '{}',
          })
          .execute(),
      );
      await expect(insertAudit).rejects.toMatchObject({ code: SQLSTATE.insufficientPrivilege });

      const readPolicy = await withTenant(runtime.db, sellerA, (trx) =>
        trx.selectFrom('seller_policy_version').select('id').where('id', '=', policyB).executeTakeFirst(),
      );
      expect(readPolicy).toBeUndefined();
    } finally {
      await runtime.close();
    }
  });

  it('exposes no row and permits no write without a tenant context (fail closed)', async () => {
    await withClient(env.runtimeUrl, async (client) => {
      const ctx = await client.query<{ ctx: string | null }>(`SELECT current_setting($1, true) AS ctx`, [
        TENANT_SETTING,
      ]);
      expect(ctx.rows[0]?.ctx ?? null).toBeNull();
      for (const table of [...SELLER_OWNED, 'seller']) {
        const rows = await client.query(`SELECT * FROM ${APP_SCHEMA}.${table}`);
        expect(rows.rowCount, table).toBe(0);
      }
      const updated = await client.query(
        `UPDATE ${APP_SCHEMA}.listing SET request_id = 'x', row_version = row_version + 1`,
      );
      expect(updated.rowCount).toBe(0);
      await expect(
        client.query(
          `INSERT INTO ${APP_SCHEMA}.inventory_item (seller_id, request_id) VALUES ($1, 'no-context')`,
          [sellerA],
        ),
      ).rejects.toMatchObject({ code: SQLSTATE.insufficientPrivilege });
    });
    const total = await query<{ n: string }>(
      env.superuserUrl,
      `SELECT count(*)::text AS n FROM ${APP_SCHEMA}.listing`,
    );
    expect(total[0]?.n).toBe('2');
  });

  it('exposes no row with an invalid context: a non-UUID value errors, an unknown UUID matches nothing', async () => {
    await withClient(env.runtimeUrl, async (client) => {
      await client.query('BEGIN');
      await client.query(`SELECT set_config($1, 'not-a-uuid', true)`, [TENANT_SETTING]);
      await expect(client.query(`SELECT * FROM ${APP_SCHEMA}.listing`)).rejects.toMatchObject({
        code: SQLSTATE.invalidTextRepresentation,
      });
      await client.query('ROLLBACK');

      await client.query('BEGIN');
      await client.query(`SELECT set_config($1, '00000000-0000-4000-8000-000000000000', true)`, [
        TENANT_SETTING,
      ]);
      const unknown = await client.query(`SELECT * FROM ${APP_SCHEMA}.listing`);
      expect(unknown.rowCount).toBe(0);
      await client.query('ROLLBACK');
    });
  });

  it('does not let a reused pooled connection retain the previous request’s tenant identity (SEC-101)', async () => {
    const runtime = createDb(env.runtimeUrl, { max: 1 }); // every statement runs on the same physical connection
    try {
      const first = await withTenant(runtime.db, sellerA, async (trx) => {
        const pid = await sql<{ pid: number }>`select pg_backend_pid() as pid`
          .execute(trx)
          .then((r) => r.rows[0]!.pid);
        const rows = await trx.selectFrom('listing').select('id').execute();
        return { pid, rows };
      });
      expect(first.rows).toEqual([{ id: listingA }]);

      const bare = await sql<{
        pid: number;
        ctx: string | null;
        n: string;
      }>`select pg_backend_pid() as pid, current_setting(${TENANT_SETTING}, true) as ctx, (select count(*) from app.listing)::text as n`
        .execute(runtime.db)
        .then((r) => r.rows[0]!);
      expect(bare.pid).toBe(first.pid);
      expect(bare.ctx === null || bare.ctx === '').toBe(true);
      expect(bare.n).toBe('0');

      const second = await withTenant(runtime.db, sellerB, async (trx) => {
        const pid = await sql<{ pid: number }>`select pg_backend_pid() as pid`
          .execute(trx)
          .then((r) => r.rows[0]!.pid);
        const rows = await trx.selectFrom('listing').select('id').execute();
        return { pid, rows };
      });
      expect(second.pid).toBe(first.pid);
      expect(second.rows).toEqual([{ id: listingB }]);

      await expect(
        withTenant(runtime.db, sellerA, async (trx) => {
          await trx.selectFrom('listing').select('id').execute();
          throw new Error('forced rollback');
        }),
      ).rejects.toThrow('forced rollback');
      const afterRollback = await sql<{
        ctx: string | null;
        n: string;
      }>`select current_setting(${TENANT_SETTING}, true) as ctx, (select count(*) from app.listing)::text as n`
        .execute(runtime.db)
        .then((r) => r.rows[0]!);
      expect(afterRollback.ctx === null || afterRollback.ctx === '').toBe(true);
      expect(afterRollback.n).toBe('0');
    } finally {
      await runtime.close();
    }
  });

  it('control: a session-scoped setting WOULD leak across pool reuse, which is why withTenant() uses transaction scope only', async () => {
    const runtime = createDb(env.runtimeUrl, { max: 1 });
    try {
      await sql`select set_config(${TENANT_SETTING}, ${sellerA}, false)`.execute(runtime.db);
      const leaked = await sql<{ n: string }>`select count(*)::text as n from app.listing`
        .execute(runtime.db)
        .then((r) => r.rows[0]!.n);
      expect(leaked).toBe('1');
      await sql`reset all`.execute(runtime.db);
      const reset = await sql<{ n: string }>`select count(*)::text as n from app.listing`
        .execute(runtime.db)
        .then((r) => r.rows[0]!.n);
      expect(reset).toBe('0');
    } finally {
      await runtime.close();
    }
  });

  it('gives the runtime role no superuser, BYPASSRLS, ownership, DDL, role assumption or RLS control (OPS-716)', async () => {
    const roles = await query<{
      rolname: string;
      rolsuper: boolean;
      rolbypassrls: boolean;
      rolcreaterole: boolean;
      rolcreatedb: boolean;
      rolinherit: boolean;
    }>(
      env.superuserUrl,
      `SELECT rolname, rolsuper, rolbypassrls, rolcreaterole, rolcreatedb, rolinherit FROM pg_roles WHERE rolname = ANY($1)`,
      [[ROLES.migrator, ROLES.runtime]],
    );
    expect(roles.map((r) => r.rolname).sort()).toEqual([ROLES.migrator, ROLES.runtime].sort());
    for (const r of roles) {
      expect(r.rolsuper, `${r.rolname} superuser`).toBe(false);
      expect(r.rolbypassrls, `${r.rolname} bypassrls`).toBe(false);
      expect(r.rolcreaterole, `${r.rolname} createrole`).toBe(false);
      expect(r.rolcreatedb, `${r.rolname} createdb`).toBe(false);
      expect(r.rolinherit, `${r.rolname} inherit`).toBe(false);
    }
    const memberships = await query<{ n: string }>(
      env.superuserUrl,
      `SELECT count(*)::text AS n FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member WHERE r.rolname = $1`,
      [ROLES.runtime],
    );
    expect(memberships[0]?.n).toBe('0');

    const owned = await query<{ name: string }>(
      env.superuserUrl,
      `SELECT n.nspname || '.' || c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE pg_get_userbyid(c.relowner) = $1
       UNION ALL SELECT nspname FROM pg_namespace WHERE pg_get_userbyid(nspowner) = $1
       UNION ALL SELECT n.nspname || '.' || p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE pg_get_userbyid(p.proowner) = $1`,
      [ROLES.runtime],
    );
    expect(owned).toEqual([]);

    const statements = [
      `CREATE TABLE ${APP_SCHEMA}.intruder (id int)`,
      `CREATE TABLE public.intruder (id int)`,
      `ALTER TABLE ${APP_SCHEMA}.listing ADD COLUMN intruder int`,
      `DROP TABLE ${APP_SCHEMA}.listing`,
      `TRUNCATE ${APP_SCHEMA}.audit_event`,
      `ALTER TABLE ${APP_SCHEMA}.listing DISABLE ROW LEVEL SECURITY`,
      `ALTER TABLE ${APP_SCHEMA}.listing NO FORCE ROW LEVEL SECURITY`,
      `DROP POLICY listing_tenant_isolation ON ${APP_SCHEMA}.listing`,
      `ALTER POLICY listing_tenant_isolation ON ${APP_SCHEMA}.listing USING (true)`,
      `CREATE POLICY intruder ON ${APP_SCHEMA}.listing USING (true)`,
      `CREATE OR REPLACE FUNCTION ${APP_SCHEMA}.current_seller_id() RETURNS uuid LANGUAGE sql AS 'SELECT NULL::uuid'`,
      `DROP TRIGGER listing_guard ON ${APP_SCHEMA}.listing`,
      `ALTER TABLE ${APP_SCHEMA}.listing DISABLE TRIGGER listing_guard`,
      `SET ROLE ${ROLES.migrator}`,
      `SET SESSION AUTHORIZATION ${ROLES.migrator}`,
      `SET ROLE postgres`,
      `SELECT * FROM ${MIGRATION_SCHEMA}.applied`,
    ];
    for (const text of statements) {
      const err = await expectPgError(env.runtimeUrl, text);
      expect(err.code, `${text} -> ${err.message}`).toBe(SQLSTATE.insufficientPrivilege);
    }
  });

  it('grants the runtime role exactly the intended DML per table and nothing outside schema app', async () => {
    const grants = await query<{ table_schema: string; table_name: string; privilege_type: string }>(
      env.superuserUrl,
      `SELECT table_schema, table_name, privilege_type FROM information_schema.role_table_grants WHERE grantee = $1 ORDER BY 1,2,3`,
      [ROLES.runtime],
    );
    const byTable = new Map<string, string[]>();
    for (const g of grants) {
      expect(g.table_schema, `${g.table_name}`).toBe(APP_SCHEMA);
      byTable.set(g.table_name, [...(byTable.get(g.table_name) ?? []), g.privilege_type].sort());
    }
    expect(Object.fromEntries(byTable)).toEqual({
      seller: ['INSERT', 'SELECT', 'UPDATE'],
      inventory_item: ['INSERT', 'SELECT', 'UPDATE'],
      listing: ['INSERT', 'SELECT', 'UPDATE'],
      listing_content_version: ['INSERT', 'SELECT', 'UPDATE'],
      product_fact: ['INSERT', 'SELECT', 'UPDATE'],
      seller_policy_version: ['INSERT', 'SELECT'],
      audit_event: ['INSERT', 'SELECT'],
      idempotency_receipt: ['INSERT', 'SELECT'],
      public_listing_access: ['INSERT', 'SELECT', 'UPDATE'],
      listing_access_code: ['INSERT', 'SELECT', 'UPDATE'],
    });
    const schemaPrivs = await query<{
      create_db: boolean;
      create_app: boolean;
      create_public: boolean;
      usage_migration: boolean;
    }>(
      env.superuserUrl,
      `SELECT has_database_privilege($1, current_database(), 'CREATE') AS create_db,
              has_schema_privilege($1, $2, 'CREATE') AS create_app,
              has_schema_privilege($1, 'public', 'CREATE') AS create_public,
              has_schema_privilege($1, $3, 'USAGE') AS usage_migration`,
      [ROLES.runtime, APP_SCHEMA, MIGRATION_SCHEMA],
    );
    expect(schemaPrivs[0]).toEqual({
      create_db: false,
      create_app: false,
      create_public: false,
      usage_migration: false,
    });
  });

  it('applies FORCE to the owner too: the migration role without context sees nothing', async () => {
    for (const table of [...SELLER_OWNED, 'seller']) {
      const rows = await query<{ n: string }>(
        env.migratorUrl,
        `SELECT count(*)::text AS n FROM ${APP_SCHEMA}.${table}`,
      );
      expect(rows[0]?.n, table).toBe('0');
    }
  });
});
