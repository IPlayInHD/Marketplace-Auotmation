import { cp, mkdtemp, appendFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_SCHEMA, MIGRATION_SCHEMA, ROLES } from '../../src/db/constants.ts';
import { defaultMigrationsDirectory, listMigrations, runMigrations } from '../../src/db/migrate.ts';
import { AUDIT_EVENT_TYPES } from '../../src/db/schema.ts';
import { startDatabase, type TestDatabase } from '../helpers/database.ts';
import { query } from '../helpers/inspect.ts';

// OPS-513, OPS-514, OPS-714 (forward-only migrations) and the schema-level scans of OPS-703,
// OPS-709, OPS-713, OPS-716, OPS-725, SEC-100.

describe('Migrations', () => {
  let env: TestDatabase;
  beforeAll(async () => {
    env = await startDatabase({ applyMigrations: false });
  });
  afterAll(async () => {
    await env?.stop();
  });

  it('apply cleanly to a fresh database, record the ledger, and are a no-op when re-run', async () => {
    const first = await runMigrations(env.migratorUrl);
    expect(first.applied).toEqual([
      '0001_listing_foundation.sql',
      '0002_listing_asking_price_event.sql',
      '0003_idempotency_receipt.sql',
      '0004_public_access.sql',
      '0005_listed_lifecycle.sql',
    ]);
    expect(first.alreadyApplied).toEqual([]);

    const ledger = await query<{ name: string; checksum: string }>(
      env.superuserUrl,
      `SELECT name, checksum FROM ${MIGRATION_SCHEMA}.applied ORDER BY name`,
    );
    const files = await listMigrations(defaultMigrationsDirectory());
    expect(ledger).toEqual(files.map((f) => ({ name: f.name, checksum: f.checksum })));

    const second = await runMigrations(env.migratorUrl);
    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied).toEqual([
      '0001_listing_foundation.sql',
      '0002_listing_asking_price_event.sql',
      '0003_idempotency_receipt.sql',
      '0004_public_access.sql',
      '0005_listed_lifecycle.sql',
    ]);
  });

  it('refuse a migration file that changed after it was applied (forward-only, no rewrite)', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'migrations-'));
    await cp(defaultMigrationsDirectory(), dir, { recursive: true });
    // Same content as the applied ledger: a no-op.
    const same = await runMigrations(env.migratorUrl, dir);
    expect(same.applied).toEqual([]);
    await appendFile(path.join(dir, '0001_listing_foundation.sql'), '\n-- tampered after apply\n');
    await expect(runMigrations(env.migratorUrl, dir)).rejects.toThrow(/modified after it was applied/);
  });

  it('refuse badly named or out-of-sequence migration files', async () => {
    const gap = await mkdtemp(path.join(tmpdir(), 'migrations-gap-'));
    await writeFile(path.join(gap, '0002_orphan.sql'), 'SELECT 1;\n');
    await expect(listMigrations(gap)).rejects.toThrow(/out of sequence/);

    const named = await mkdtemp(path.join(tmpdir(), 'migrations-name-'));
    await writeFile(path.join(named, 'listing.sql'), 'SELECT 1;\n');
    await expect(listMigrations(named)).rejects.toThrow(/NNNN_name\.sql/);

    const down = await mkdtemp(path.join(tmpdir(), 'migrations-down-'));
    await writeFile(path.join(down, '0001_a.sql'), 'SELECT 1;\n');
    await writeFile(path.join(down, '0001_a.down.sql'), 'SELECT 1;\n');
    await expect(listMigrations(down)).rejects.toThrow();
  });

  it('give every seller-owned table a seller id, forced row-level security, one policy and the migration role as owner', async () => {
    const tables = await query<{
      relname: string;
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
      owner: string;
      policies: string;
      has_seller_id: boolean;
    }>(
      env.superuserUrl,
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity, pg_get_userbyid(c.relowner) AS owner,
              (SELECT count(*)::text FROM pg_policy p WHERE p.polrelid = c.oid) AS policies,
              EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attname = 'seller_id' AND NOT a.attisdropped) AS has_seller_id
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relkind = 'r' ORDER BY 1`,
      [APP_SCHEMA],
    );
    expect(tables.map((t) => t.relname)).toEqual([
      'audit_event',
      'idempotency_receipt',
      'inventory_item',
      'listing',
      'listing_access_code',
      'listing_content_version',
      'product_fact',
      'public_listing_access',
      'seller',
      'seller_policy_version',
    ]);
    for (const t of tables) {
      expect(t.relrowsecurity, `${t.relname} RLS enabled`).toBe(true);
      expect(t.relforcerowsecurity, `${t.relname} RLS forced`).toBe(true);
      expect(t.owner, `${t.relname} owner`).toBe(ROLES.migrator);
      expect(t.policies, `${t.relname} policy count`).toBe('1');
      // DM-01 / OPS-709: every entity except the tenant itself carries the seller id.
      expect(t.has_seller_id, `${t.relname} seller_id`).toBe(t.relname !== 'seller');
    }
  });

  it('store money as bigint minor units with a currency and hold no float, numeric or decimal column (OPS-703)', async () => {
    const columns = await query<{
      table_name: string;
      column_name: string;
      data_type: string;
      domain_name: string | null;
    }>(
      env.superuserUrl,
      `SELECT table_name, column_name, data_type, domain_name FROM information_schema.columns WHERE table_schema = $1`,
      [APP_SCHEMA],
    );
    const floating = columns.filter((c) =>
      ['real', 'double precision', 'numeric', 'money'].includes(c.data_type),
    );
    expect(floating).toEqual([]);
    const minor = columns.filter((c) => c.column_name.endsWith('_minor'));
    expect(minor.length).toBeGreaterThanOrEqual(4);
    for (const c of minor) {
      expect(c.data_type, `${c.table_name}.${c.column_name}`).toBe('bigint');
      expect(c.domain_name, `${c.table_name}.${c.column_name}`).toBe('minor_units');
    }
    const currency = columns.filter((c) => c.column_name.endsWith('currency'));
    for (const c of currency) expect(c.domain_name, `${c.table_name}.${c.column_name}`).toBe('currency_code');
  });

  it('store every timestamp with a time zone (OPS-713) and name no valuation-shaped column (OPS-725)', async () => {
    const columns = await query<{ table_name: string; column_name: string; data_type: string }>(
      env.superuserUrl,
      `SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = $1`,
      [APP_SCHEMA],
    );
    const naive = columns.filter((c) => c.data_type === 'timestamp without time zone');
    expect(naive).toEqual([]);
    const valuation = columns.filter((c) =>
      /(estimat|valuation|worth|market|comparable|suggest|demand)/i.test(c.column_name),
    );
    expect(valuation).toEqual([]);
  });

  it('give the database exactly the audit event types of the canonical catalogue (OPS-781)', async () => {
    const rows = await query<{ value: string }>(
      env.superuserUrl,
      `SELECT unnest(enum_range(NULL::${APP_SCHEMA}.audit_event_type))::text AS value`,
    );
    expect(rows.map((r) => r.value).sort()).toEqual([...AUDIT_EVENT_TYPES].sort());
  });

  it('keep the migration ledger out of the runtime role’s reach', async () => {
    const privileges = await query<{ has_usage: boolean }>(
      env.superuserUrl,
      `SELECT has_schema_privilege($1, $2, 'USAGE') AS has_usage`,
      [ROLES.runtime, MIGRATION_SCHEMA],
    );
    expect(privileges[0]?.has_usage).toBe(false);
  });
});
