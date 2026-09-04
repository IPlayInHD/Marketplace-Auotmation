import { Kysely, PostgresDialect } from 'kysely';
import pg from 'pg';
import type { Database } from './schema.ts';

export interface DbHandle {
  db: Kysely<Database>;
  pool: pg.Pool;
  close(): Promise<void>;
}

/** A Kysely instance over a bounded node-postgres pool for one database role. */
export function createDb(connectionString: string, options: { max?: number } = {}): DbHandle {
  const pool = new pg.Pool({
    connectionString,
    max: options.max ?? 4,
    application_name: 'authentication-spike',
  });
  const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
  return { db, pool, close: () => db.destroy() };
}
