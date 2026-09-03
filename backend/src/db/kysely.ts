import { Kysely, PostgresDialect, sql, type Transaction } from 'kysely';
import pg from 'pg';
import { z } from 'zod';
import { APP_SCHEMA, TENANT_SETTING } from './constants.ts';
import type { Database } from './schema.ts';

// int8 (bigint) columns hold money in minor units (DM-07). node-postgres returns them as strings;
// they are parsed to numbers only while they are exact, and the parser fails loudly otherwise.
pg.types.setTypeParser(pg.types.builtins.INT8, (value: string) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new RangeError(`int8 value ${value} is not a safe integer`);
  return n;
});
// `date` columns are ISO strings, never a local-midnight Date object.
pg.types.setTypeParser(pg.types.builtins.DATE, (value: string) => value);

export interface DbHandle {
  db: Kysely<Database>;
  pool: pg.Pool;
  close(): Promise<void>;
}

export interface DbOptions {
  max?: number;
  applicationName?: string;
}

/** Creates a Kysely instance over a bounded node-postgres pool for one database role. */
export function createDb(connectionString: string, options: DbOptions = {}): DbHandle {
  const pool = new pg.Pool({
    connectionString,
    max: options.max ?? 4,
    application_name: options.applicationName ?? 'marketplace-backend',
  });
  const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) }).withSchema(APP_SCHEMA);
  return {
    db,
    pool,
    close: async () => {
      await db.destroy();
    },
  };
}

/** A transaction that carries a tenant context. Every module function that touches seller-owned data takes one. */
export type TenantTransaction = Transaction<Database>;

const SellerId = z.uuid();

/**
 * The single construction site for tenant context (SEC-101).
 *
 * Runs `fn` inside one database transaction after establishing the tenant context with
 * set_config(name, value, is_local = true). A local setting lives exactly as long as the
 * transaction: PostgreSQL discards it at COMMIT and at ROLLBACK, so nothing is carried onto the
 * next transaction that reuses the same pooled connection. The seller id is validated as a UUID
 * before it reaches the database; the database independently rejects a non-UUID value (22P02).
 */
export async function withTenant<T>(
  db: Kysely<Database>,
  sellerId: string,
  fn: (trx: TenantTransaction) => Promise<T>,
): Promise<T> {
  const validSellerId = SellerId.parse(sellerId);
  return db.transaction().execute(async (trx) => {
    await sql`select set_config(${TENANT_SETTING}, ${validSellerId}, true)`.execute(trx);
    return fn(trx);
  });
}
