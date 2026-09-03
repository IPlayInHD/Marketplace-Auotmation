import pg from 'pg';

// Small helpers for assertions. Privileged inspection uses the container superuser explicitly
// and is never part of any runtime path.

export async function withClient<T>(
  connectionString: string,
  fn: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ connectionString, application_name: 'marketplace-test' });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export async function query<R extends pg.QueryResultRow = pg.QueryResultRow>(
  connectionString: string,
  text: string,
  values: unknown[] = [],
): Promise<R[]> {
  return withClient(connectionString, async (client) => (await client.query<R>(text, values)).rows);
}

export interface PgError {
  code: string;
  message: string;
  detail: string | undefined;
}

/** Runs a statement expected to fail and returns the PostgreSQL error code, message and detail. */
export async function expectPgError(
  connectionString: string,
  text: string,
  values: unknown[] = [],
  setup?: (client: pg.Client) => Promise<void>,
): Promise<PgError> {
  return withClient(connectionString, async (client) => {
    await client.query('BEGIN');
    if (setup) await setup(client);
    try {
      await client.query(text, values);
    } catch (err) {
      const e = err as { code?: string; message?: string; detail?: string };
      await client.query('ROLLBACK');
      return { code: e.code ?? 'NO_CODE', message: e.message ?? String(err), detail: e.detail };
    }
    await client.query('ROLLBACK');
    throw new Error(`expected the statement to fail but it succeeded: ${text}`);
  });
}

/** Sets the transaction-scoped tenant context on a raw client (for direct-SQL tests). */
export async function setTenant(client: pg.Client, sellerId: string): Promise<void> {
  await client.query(`SELECT set_config('app.seller_id', $1, true)`, [sellerId]);
}
