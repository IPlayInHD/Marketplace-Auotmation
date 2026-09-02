import pg from 'pg';

// Small helpers for assertions. Privileged inspection uses the container superuser explicitly
// and is never part of any runtime path.

export async function withClient<T>(connectionString: string, fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString, application_name: 'spike-test' });
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
}

/** Runs a statement expected to fail and returns the PostgreSQL error code and message. */
export async function expectPgError(connectionString: string, text: string, values: unknown[] = []): Promise<PgError> {
  return withClient(connectionString, async (client) => {
    try {
      await client.query(text, values);
    } catch (err) {
      const e = err as { code?: string; message?: string };
      return { code: e.code ?? 'NO_CODE', message: e.message ?? String(err) };
    }
    throw new Error(`expected the statement to fail but it succeeded: ${text}`);
  });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Rejects if the promise does not settle within `ms`, so a broken worker cannot hang a test. */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms: ${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Polls `probe` until it returns a value, failing after `ms`. */
export async function waitFor<T>(probe: () => Promise<T | undefined>, ms: number, label: string, intervalMs = 100): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timeout after ${ms}ms: ${label}`);
    await sleep(intervalMs);
  }
}
