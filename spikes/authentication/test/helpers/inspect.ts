import pg from 'pg';

/** Privileged inspection for assertions only. */
export async function query<T extends Record<string, unknown>>(
  connectionString: string,
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const client = new pg.Client({ connectionString, application_name: 'authentication-spike-inspect' });
  await client.connect();
  try {
    const result = await client.query<T>(text, params);
    return result.rows;
  } finally {
    await client.end();
  }
}
