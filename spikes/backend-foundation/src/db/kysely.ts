import { Kysely, PostgresDialect, sql, type Transaction } from 'kysely';
import pg from 'pg';
import { z } from 'zod';
import { APP_SCHEMA, TENANT_SETTING } from './constants.ts';
import type { Database } from './schema.ts';

export interface DbHandle {
  db: Kysely<Database>;
  pool: pg.Pool;
  close(): Promise<void>;
}

/**
 * Creates a Kysely instance over a node-postgres pool for one runtime role.
 * The pool is bounded so the pooled-connection reuse proof can force reuse deterministically.
 */
export function createDb(connectionString: string, max = 4, applicationName = 'spike'): DbHandle {
  const pool = new pg.Pool({ connectionString, max, application_name: applicationName });
  const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) }).withSchema(APP_SCHEMA);
  return {
    db,
    pool,
    close: async () => {
      await db.destroy();
    },
  };
}

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
  fn: (trx: Transaction<Database>) => Promise<T>,
): Promise<T> {
  const validSellerId = SellerId.parse(sellerId);
  return db.transaction().execute(async (trx) => {
    await sql`select set_config(${TENANT_SETTING}, ${validSellerId}, true)`.execute(trx);
    return fn(trx);
  });
}
