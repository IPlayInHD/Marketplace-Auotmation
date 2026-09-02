import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgBoss } from 'pg-boss';
import { PGBOSS_SCHEMA, ROLES } from '../src/db/constants.ts';
import { QUEUES } from '../src/jobs/queues.ts';
import { createRuntimeBoss } from '../src/worker/boss.ts';
import { startSpikeDatabase, type SpikeDatabase } from './helpers/database.ts';
import { expectPgError, query, withClient, withTimeout } from './helpers/inspect.ts';

// Proof 3 — pg-boss schema ownership and migration/runtime separation.

const INSUFFICIENT_PRIVILEGE = '42501';

/** A fingerprint of every relation, column, index, constraint and function in the pg-boss schema. */
async function schemaFingerprint(url: string): Promise<string> {
  const rows = await query<{ fp: string }>(
    url,
    `SELECT md5(string_agg(line, E'\\n' ORDER BY line)) AS fp FROM (
       SELECT 'rel:' || c.relname || ':' || c.relkind::text || ':' || pg_get_userbyid(c.relowner) AS line
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1
       UNION ALL
       SELECT 'col:' || c.relname || ':' || a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull::text
         FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1 AND a.attnum > 0 AND NOT a.attisdropped
       UNION ALL
       SELECT 'idx:' || pg_get_indexdef(i.indexrelid) FROM pg_index i JOIN pg_class c ON c.oid = i.indrelid
         JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1
       UNION ALL
       SELECT 'con:' || conrelid::regclass::text || ':' || conname || ':' || pg_get_constraintdef(oid) FROM pg_constraint
        WHERE connamespace = (SELECT oid FROM pg_namespace WHERE nspname = $1)
       UNION ALL
       SELECT 'fn:' || p.proname || ':' || md5(p.prosrc) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname = $1
       UNION ALL
       SELECT 'version:' || version::text FROM ${PGBOSS_SCHEMA}.version
     ) s`,
    [PGBOSS_SCHEMA],
  );
  return rows[0]!.fp;
}

describe('pg-boss schema ownership', () => {
  let env: SpikeDatabase;
  beforeAll(async () => {
    env = await startSpikeDatabase();
  });
  afterAll(async () => {
    await env?.stop();
  });

  it('the schema was installed through the pg-boss CLI by the migration role and is at the current version', async () => {
    expect(env.pgboss.createOutput).toMatch(/Successfully created pg-boss schema "pgboss" at version \d+/);
    const current = /Current schema version: (\d+)/.exec(env.pgboss.versionOutput)?.[1];
    const latest = /Latest schema version: (\d+)/.exec(env.pgboss.versionOutput)?.[1];
    expect(current).toBeDefined();
    expect(current).toBe(latest);
    expect(env.pgboss.versionOutput).not.toMatch(/Migrations pending/);

    const owners = await query<{ relname: string; owner: string }>(
      env.superuserUrl,
      `SELECT c.relname, pg_get_userbyid(c.relowner) AS owner FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relkind IN ('r','p','i','S')`,
      [PGBOSS_SCHEMA],
    );
    expect(owners.length).toBeGreaterThan(0);
    for (const o of owners) expect(o.owner, o.relname).toBe(ROLES.migrator);
    const version = await query<{ version: number }>(env.superuserUrl, `SELECT version FROM ${PGBOSS_SCHEMA}.version`);
    expect(String(version[0]?.version)).toBe(current);
  });

  it('the worker starts under the runtime role, processes a job, runs maintenance, and changes nothing in the schema', async () => {
    const before = await schemaFingerprint(env.superuserUrl);
    const boss = createRuntimeBoss({ connectionString: env.workerUrl, applicationName: 'spike-worker-p3', enableSpies: true, monitorIntervalSeconds: 1 });
    const errors: unknown[] = [];
    boss.on('error', (e) => errors.push(e));
    try {
      await boss.start();
      expect(await boss.isInstalled()).toBe(true);
      const id = await boss.send(QUEUES.demo.name, { recordId: 'p3', sellerId: env.demo.sellerId, effectKey: 'p3' });
      expect(id).toBeTruthy();
      await boss.work(QUEUES.demo.name, async () => ({ ok: true }));
      const done = await withTimeout(boss.getSpy(QUEUES.demo.name).waitForJobWithId(id!, 'completed'), 20_000, 'job completion');
      expect(done.state).toBe('completed');
      await boss.supervise(QUEUES.demo.name); // monitoring, expiry, retention: all DML under this role
      const job = await boss.getJobById(QUEUES.demo.name, id!);
      expect(job?.state).toBe('completed');
    } finally {
      await boss.stop({ close: true, graceful: false, timeout: 5_000 });
    }
    expect(errors).toEqual([]);
    const after = await schemaFingerprint(env.superuserUrl);
    expect(after).toBe(before);
    const sessions = await query<{ usename: string }>(env.superuserUrl, `SELECT usename FROM pg_stat_activity WHERE application_name = 'spike-worker-p3'`);
    expect(sessions.every((s) => s.usename === ROLES.worker)).toBe(true);
  });

  it('the worker role cannot create, alter, drop or reindex pg-boss objects, nor call the queue-topology functions', async () => {
    const statements = [
      `CREATE TABLE ${PGBOSS_SCHEMA}.intruder (id int)`,
      `ALTER TABLE ${PGBOSS_SCHEMA}.job ADD COLUMN intruder int`,
      `ALTER TABLE ${PGBOSS_SCHEMA}.queue ADD COLUMN intruder int`,
      `DROP TABLE ${PGBOSS_SCHEMA}.job_common`,
      `DROP TABLE ${PGBOSS_SCHEMA}.version`,
      `CREATE INDEX intruder_idx ON ${PGBOSS_SCHEMA}.job_common (name)`,
      `DROP FUNCTION ${PGBOSS_SCHEMA}.create_queue(text, jsonb)`,
      `SELECT ${PGBOSS_SCHEMA}.create_queue('intruder', '{"partition": true}'::jsonb)`,
      `SELECT ${PGBOSS_SCHEMA}.delete_queue('${QUEUES.demo.name}')`,
      `UPDATE ${PGBOSS_SCHEMA}.version SET version = version + 1`,
      `DELETE FROM ${PGBOSS_SCHEMA}.version`,
      `CREATE TABLE ${PGBOSS_SCHEMA}.job_intruder PARTITION OF ${PGBOSS_SCHEMA}.job FOR VALUES IN ('intruder')`,
    ];
    for (const text of statements) {
      const err = await expectPgError(env.workerUrl, text);
      expect(err.code, `${text} -> ${err.message}`).toBe(INSUFFICIENT_PRIVILEGE);
    }
    const reindex = await query<{ indexname: string }>(env.superuserUrl, `SELECT indexname FROM pg_indexes WHERE schemaname = $1 LIMIT 1`, [PGBOSS_SCHEMA]);
    const err = await expectPgError(env.workerUrl, `REINDEX INDEX ${PGBOSS_SCHEMA}.${reindex[0]!.indexname}`);
    expect(err.code).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('with migrations pending, start() refuses instead of migrating; even a misconfigured instance cannot migrate under the runtime role', async () => {
    const fingerprint = await schemaFingerprint(env.superuserUrl);
    const version = (await query<{ version: number }>(env.migratorUrl, `SELECT version FROM ${PGBOSS_SCHEMA}.version`))[0]!.version;
    await withClient(env.migratorUrl, (c) => c.query(`UPDATE ${PGBOSS_SCHEMA}.version SET version = $1`, [version - 1]));
    try {
      // Correctly configured runtime (migrate: false): refuses to start.
      const runtime = createRuntimeBoss({ connectionString: env.workerUrl, applicationName: 'spike-worker-p3-pending' });
      await expect(runtime.start()).rejects.toThrow(/requires migrations/);
      await runtime.stop({ close: true, graceful: false, timeout: 2_000 }).catch(() => undefined);

      // Misconfigured runtime (migrate: true, the library default): the role stops it.
      const misconfigured = new PgBoss({ connectionString: env.workerUrl, schema: PGBOSS_SCHEMA, migrate: true, supervise: false, schedule: false, reindex: false, max: 1 });
      misconfigured.on('error', () => undefined);
      await expect(misconfigured.start()).rejects.toMatchObject({ code: INSUFFICIENT_PRIVILEGE });
      await misconfigured.stop({ close: true, graceful: false, timeout: 2_000 }).catch(() => undefined);

      const stillPending = await query<{ version: number }>(env.superuserUrl, `SELECT version FROM ${PGBOSS_SCHEMA}.version`);
      expect(stillPending[0]?.version).toBe(version - 1);
    } finally {
      await withClient(env.migratorUrl, (c) => c.query(`UPDATE ${PGBOSS_SCHEMA}.version SET version = $1`, [version]));
    }
    expect(await schemaFingerprint(env.superuserUrl)).toBe(fingerprint);
  });
});
