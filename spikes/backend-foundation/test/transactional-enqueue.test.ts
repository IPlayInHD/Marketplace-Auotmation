import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { APP_SCHEMA, PGBOSS_SCHEMA } from '../src/db/constants.ts';
import { createDb, type DbHandle } from '../src/db/kysely.ts';
import { ControlledFailure, createDemoRecordWithJob } from '../src/jobs/enqueue.ts';
import { QUEUES } from '../src/jobs/queues.ts';
import { createRuntimeBoss } from '../src/worker/boss.ts';
import { startSpikeDatabase, type SpikeDatabase } from './helpers/database.ts';
import { query } from './helpers/inspect.ts';
import type { PgBoss } from 'pg-boss';

// Proof 4 — transactional job enqueueing through Kysely and pg-boss's Kysely adapter.

describe('Transactional enqueue', () => {
  let env: SpikeDatabase;
  let web: DbHandle;
  let boss: PgBoss;
  beforeAll(async () => {
    env = await startSpikeDatabase();
    web = createDb(env.webUrl, 2, 'spike-web-p4');
    boss = createRuntimeBoss({ connectionString: env.webUrl, applicationName: 'spike-web-p4-boss' });
    await boss.start();
  });
  afterAll(async () => {
    await boss?.stop({ close: true, graceful: false, timeout: 5_000 });
    await web?.close();
    await env?.stop();
  });

  const recordCount = async (payload: string) =>
    (await query<{ n: string }>(env.superuserUrl, `SELECT count(*)::text AS n FROM ${APP_SCHEMA}.demo_records WHERE payload = $1`, [payload]))[0]!.n;
  const jobCount = async (effectKey: string) =>
    (await query<{ n: string }>(env.superuserUrl, `SELECT count(*)::text AS n FROM ${PGBOSS_SCHEMA}.job WHERE data->>'effectKey' = $1`, [effectKey]))[0]!.n;

  it('commit case: the domain row and the job are written by one transaction on one connection and both exist after commit', async () => {
    const payload = `commit-${randomUUID()}`;
    const effectKey = `effect-${randomUUID()}`;
    const evidence = await createDemoRecordWithJob(web.db, boss, env.demo.sellerId, payload, effectKey);

    // Same backend process before and after the job insert: one connection.
    expect(evidence.backendPidAfter).toBe(evidence.backendPidBefore);
    // Both rows carry the transaction's own id as xmin: written by the same transaction.
    expect(evidence.recordXmin).toBe(evidence.currentXid);
    expect(evidence.jobXmin).toBe(evidence.currentXid);

    expect(await recordCount(payload)).toBe('1');
    expect(await jobCount(effectKey)).toBe('1');
    const job = await query<{ id: string; state: string; name: string }>(env.superuserUrl, `SELECT id, state::text, name FROM ${PGBOSS_SCHEMA}.job WHERE id = $1`, [evidence.jobId]);
    expect(job).toEqual([{ id: evidence.jobId, state: 'created', name: QUEUES.demo.name }]);
  });

  it('rollback case: a failure after both writes leaves neither the record nor the job', async () => {
    const payload = `rollback-${randomUUID()}`;
    const effectKey = `effect-${randomUUID()}`;
    await expect(createDemoRecordWithJob(web.db, boss, env.demo.sellerId, payload, effectKey, { failAfterEnqueue: true })).rejects.toBeInstanceOf(ControlledFailure);
    expect(await recordCount(payload)).toBe('0');
    expect(await jobCount(effectKey)).toBe('0');
  });

  it('control: enqueueing outside the transaction is not atomic, which is why the adapter is required', async () => {
    const effectKey = `effect-control-${randomUUID()}`;
    // Send through pg-boss's own pool (no db option), then roll back an unrelated transaction:
    // the job survives, demonstrating the failure mode the adapter prevents.
    const jobId = await boss.send(QUEUES.demo.name, { recordId: 'control', sellerId: env.demo.sellerId, effectKey });
    expect(jobId).toBeTruthy();
    const jobXmin = (await query<{ xmin: string }>(env.superuserUrl, `SELECT xmin::text AS xmin FROM ${PGBOSS_SCHEMA}.job WHERE id = $1`, [jobId]))[0]!.xmin;
    const payload = `control-${randomUUID()}`;
    await expect(
      createDemoRecordWithJob(web.db, boss, env.demo.sellerId, payload, `effect-${randomUUID()}`, { failAfterEnqueue: true }),
    ).rejects.toBeInstanceOf(ControlledFailure);
    expect(await jobCount(effectKey)).toBe('1');
    const rolledBackXid = (await query<{ xid: string }>(env.superuserUrl, `SELECT (txid_current() % 4294967296)::text AS xid`))[0]!.xid;
    expect(jobXmin).not.toBe(rolledBackXid);
  });
});
