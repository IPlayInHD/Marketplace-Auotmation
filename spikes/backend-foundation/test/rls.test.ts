import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'kysely';
import { APP_SCHEMA, ROLES, TENANT_SETTING } from '../src/db/constants.ts';
import { createDb, withTenant } from '../src/db/kysely.ts';
import { DEMO_LISTING, startSpikeDatabase, type SpikeDatabase } from './helpers/database.ts';
import { query, withClient } from './helpers/inspect.ts';

// Proof 2 — tenant isolation and fail-closed row-level security.

const RLS_VIOLATION = '42501'; // "new row violates row-level security policy"
const INVALID_TEXT = '22P02'; // invalid input syntax for type uuid
const SELLER_TABLES = ['listings', 'demo_records', 'side_effects'];

describe('Row-level security and tenant context', () => {
  let env: SpikeDatabase;
  beforeAll(async () => {
    env = await startSpikeDatabase();
  });
  afterAll(async () => {
    await env?.stop();
  });

  it('seller A reads its own row and cannot read seller B’s row', async () => {
    const web = createDb(env.webUrl, 2);
    try {
      const mine = await withTenant(web.db, env.demo.sellerId, (trx) => trx.selectFrom('listings').select(['id', 'seller_id']).execute());
      expect(mine).toEqual([{ id: env.demo.listingId, seller_id: env.demo.sellerId }]);
      const theirs = await withTenant(web.db, env.demo.sellerId, (trx) =>
        trx.selectFrom('listings').select('id').where('id', '=', env.demo.otherListingId).executeTakeFirst(),
      );
      expect(theirs).toBeUndefined();
      const asB = await withTenant(web.db, env.demo.otherSellerId, (trx) => trx.selectFrom('listings').select('id').execute());
      expect(asB).toEqual([{ id: env.demo.otherListingId }]);
    } finally {
      await web.close();
    }
  });

  it('seller A cannot update or delete seller B’s row', async () => {
    const web = createDb(env.webUrl, 2);
    try {
      const updated = await withTenant(web.db, env.demo.sellerId, (trx) =>
        trx.updateTable('listings').set({ title: 'hijacked' }).where('id', '=', env.demo.otherListingId).executeTakeFirst(),
      );
      expect(Number(updated.numUpdatedRows)).toBe(0);
      const deleted = await withTenant(web.db, env.demo.sellerId, (trx) =>
        trx.deleteFrom('listings').where('id', '=', env.demo.otherListingId).executeTakeFirst(),
      );
      expect(Number(deleted.numDeletedRows)).toBe(0);
      const stillThere = await query<{ title: string }>(env.superuserUrl, `SELECT title FROM ${APP_SCHEMA}.listings WHERE id = $1`, [env.demo.otherListingId]);
      expect(stillThere).toEqual([{ title: 'Other seller listing' }]);
    } finally {
      await web.close();
    }
  });

  it('seller A cannot insert a row assigned to seller B', async () => {
    const web = createDb(env.webUrl, 2);
    try {
      const attempt = withTenant(web.db, env.demo.sellerId, (trx) =>
        trx
          .insertInto('listings')
          .values({ ...toRow(DEMO_LISTING), seller_id: env.demo.otherSellerId })
          .execute(),
      );
      await expect(attempt).rejects.toMatchObject({ code: RLS_VIOLATION });
      await expect(attempt).rejects.toThrow(/row-level security policy/);
      const count = await query<{ n: string }>(env.superuserUrl, `SELECT count(*)::text AS n FROM ${APP_SCHEMA}.listings WHERE seller_id = $1`, [env.demo.otherSellerId]);
      expect(count[0]?.n).toBe('1');
    } finally {
      await web.close();
    }
  });

  it('missing tenant context exposes no row and permits no write', async () => {
    await withClient(env.webUrl, async (client) => {
      const ctx = await client.query<{ ctx: string | null }>(`SELECT current_setting($1, true) AS ctx`, [TENANT_SETTING]);
      expect(ctx.rows[0]?.ctx ?? null).toBeNull();
      for (const table of ['listings', 'demo_records']) {
        const rows = await client.query(`SELECT * FROM ${APP_SCHEMA}.${table}`);
        expect(rows.rowCount, table).toBe(0);
      }
      const updated = await client.query(`UPDATE ${APP_SCHEMA}.listings SET title = 'x'`);
      expect(updated.rowCount).toBe(0);
      const deleted = await client.query(`DELETE FROM ${APP_SCHEMA}.listings`);
      expect(deleted.rowCount).toBe(0);
      await expect(
        client.query(`INSERT INTO ${APP_SCHEMA}.demo_records (seller_id, payload) VALUES ($1, 'no-context')`, [env.demo.sellerId]),
      ).rejects.toMatchObject({ code: RLS_VIOLATION });
    });
    // The worker role, which may read side_effects, is equally blind without context.
    await withClient(env.workerUrl, async (client) => {
      const rows = await client.query(`SELECT * FROM ${APP_SCHEMA}.side_effects`);
      expect(rows.rowCount).toBe(0);
      await expect(
        client.query(`INSERT INTO ${APP_SCHEMA}.side_effects (seller_id, effect_key, job_id) VALUES ($1, 'no-context', gen_random_uuid())`, [env.demo.sellerId]),
      ).rejects.toMatchObject({ code: RLS_VIOLATION });
    });
    const total = await query<{ n: string }>(env.superuserUrl, `SELECT count(*)::text AS n FROM ${APP_SCHEMA}.listings`);
    expect(total[0]?.n).toBe('2'); // both seeded rows exist; the role simply cannot see them without context
  });

  it('invalid tenant context exposes no row: a non-UUID value errors, an unknown UUID matches nothing', async () => {
    await withClient(env.webUrl, async (client) => {
      await client.query('BEGIN');
      await client.query(`SELECT set_config($1, 'not-a-uuid', true)`, [TENANT_SETTING]);
      await expect(client.query(`SELECT * FROM ${APP_SCHEMA}.listings`)).rejects.toMatchObject({ code: INVALID_TEXT });
      await client.query('ROLLBACK');

      await client.query('BEGIN');
      await client.query(`SELECT set_config($1, '', true)`, [TENANT_SETTING]);
      const empty = await client.query(`SELECT * FROM ${APP_SCHEMA}.listings`);
      expect(empty.rowCount).toBe(0);
      await client.query('ROLLBACK');

      await client.query('BEGIN');
      await client.query(`SELECT set_config($1, '00000000-0000-0000-0000-000000000000', true)`, [TENANT_SETTING]);
      const unknown = await client.query(`SELECT * FROM ${APP_SCHEMA}.listings`);
      expect(unknown.rowCount).toBe(0);
      await client.query('ROLLBACK');
    });
  });

  it('a reused pooled connection does not retain the previous request’s tenant identity', async () => {
    const web = createDb(env.webUrl, 1); // max 1: every statement below runs on the same physical connection
    try {
      const first = await withTenant(web.db, env.demo.sellerId, async (trx) => {
        const pid = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(trx).then((r) => r.rows[0]!.pid);
        const rows = await trx.selectFrom('listings').select('id').execute();
        return { pid, rows };
      });
      expect(first.rows).toEqual([{ id: env.demo.listingId }]);

      // Next use of the pool, no tenant context: same backend, no context, no rows.
      const bare = await sql<{ pid: number; ctx: string | null; n: string }>`select pg_backend_pid() as pid, current_setting(${TENANT_SETTING}, true) as ctx, (select count(*) from app.listings)::text as n`
        .execute(web.db)
        .then((r) => r.rows[0]!);
      expect(bare.pid).toBe(first.pid);
      // After a transaction-local setting reverts, PostgreSQL reports the placeholder as '' rather
      // than NULL. app.current_seller_id() maps '' to NULL (NULLIF), so both mean "no context".
      expect(bare.ctx === null || bare.ctx === '').toBe(true);
      expect(bare.n).toBe('0');

      // Then seller B on the same backend sees only B.
      const second = await withTenant(web.db, env.demo.otherSellerId, async (trx) => {
        const pid = await sql<{ pid: number }>`select pg_backend_pid() as pid`.execute(trx).then((r) => r.rows[0]!.pid);
        const rows = await trx.selectFrom('listings').select('id').execute();
        return { pid, rows };
      });
      expect(second.pid).toBe(first.pid);
      expect(second.rows).toEqual([{ id: env.demo.otherListingId }]);

      // A rolled-back transaction also leaves nothing behind.
      await expect(
        withTenant(web.db, env.demo.sellerId, async (trx) => {
          await trx.selectFrom('listings').select('id').execute();
          throw new Error('forced rollback');
        }),
      ).rejects.toThrow('forced rollback');
      const afterRollback = await sql<{ ctx: string | null; n: string }>`select current_setting(${TENANT_SETTING}, true) as ctx, (select count(*) from app.listings)::text as n`
        .execute(web.db)
        .then((r) => r.rows[0]!);
      expect(afterRollback.ctx === null || afterRollback.ctx === '').toBe(true);
      expect(afterRollback.n).toBe('0');
    } finally {
      await web.close();
    }
  });

  it('control: a session-scoped setting WOULD leak across pool reuse, which is why the helper only uses transaction scope', async () => {
    const web = createDb(env.webUrl, 1);
    try {
      // Deliberately wrong: is_local = false makes the setting session-scoped.
      await sql`select set_config(${TENANT_SETTING}, ${env.demo.sellerId}, false)`.execute(web.db);
      const leaked = await sql<{ n: string }>`select count(*)::text as n from app.listings`.execute(web.db).then((r) => r.rows[0]!.n);
      expect(leaked).toBe('1'); // the leak is observable, so the pooled-reset proof above is sensitive to it
      await sql`reset all`.execute(web.db);
      const reset = await sql<{ n: string }>`select count(*)::text as n from app.listings`.execute(web.db).then((r) => r.rows[0]!.n);
      expect(reset).toBe('0');
    } finally {
      await web.close();
    }
  });

  it('seller-owned tables have RLS enabled and forced, and are owned by the migration role, not a runtime role', async () => {
    const rows = await query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean; owner: string; policies: string }>(
      env.superuserUrl,
      `SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity, pg_get_userbyid(c.relowner) AS owner,
              (SELECT count(*)::text FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND c.relkind = 'r' ORDER BY 1`,
      [APP_SCHEMA],
    );
    expect(rows.map((r) => r.relname)).toEqual(SELLER_TABLES.slice().sort());
    for (const r of rows) {
      expect(r.relrowsecurity, `${r.relname} RLS enabled`).toBe(true);
      expect(r.relforcerowsecurity, `${r.relname} RLS forced`).toBe(true);
      expect(r.owner, `${r.relname} owner`).toBe(ROLES.migrator);
      expect([ROLES.web, ROLES.worker]).not.toContain(r.owner);
      expect(r.policies, `${r.relname} policy count`).toBe('1');
    }
  });

  it('FORCE applies to the owner too: the migration role without tenant context sees nothing', async () => {
    const rows = await query<{ n: string }>(env.migratorUrl, `SELECT count(*)::text AS n FROM ${APP_SCHEMA}.listings`);
    expect(rows[0]?.n).toBe('0');
  });
});

function toRow(l: typeof DEMO_LISTING) {
  return {
    title: l.title,
    asking_price_minor: l.askingPriceMinor,
    currency: l.currency,
    minimum_price_minor: l.minimumPriceMinor,
    internal_notes: l.internalNotes,
    seller_display_name: l.sellerDisplayName,
  };
}
