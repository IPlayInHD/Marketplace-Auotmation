import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { JobWithMetadata, PgBoss } from 'pg-boss';
import { APP_SCHEMA } from '../src/db/constants.ts';
import { createDb, type DbHandle } from '../src/db/kysely.ts';
import { applySideEffect } from '../src/jobs/handler.ts';
import { QUEUES, type DemoJobData } from '../src/jobs/queues.ts';
import { createRuntimeBoss } from '../src/worker/boss.ts';
import { startSpikeDatabase, type SpikeDatabase } from './helpers/database.ts';
import { query, withTimeout } from './helpers/inspect.ts';

// Proof 6 — database-enforced idempotent processing.

describe('Idempotent processing', () => {
  let env: SpikeDatabase;
  let worker: DbHandle;
  let boss: PgBoss;
  beforeAll(async () => {
    env = await startSpikeDatabase();
    worker = createDb(env.workerUrl, 4, 'spike-worker-p6');
    boss = createRuntimeBoss({ connectionString: env.workerUrl, applicationName: 'spike-worker-p6-boss', enableSpies: true });
    boss.on('error', (e) => console.error('pg-boss error', e));
    await boss.start();
  });
  afterAll(async () => {
    await boss?.stop({ close: true, graceful: false, timeout: 5_000 });
    await worker?.close();
    await env?.stop();
  });

  const effectCount = async (effectKey: string) =>
    (await query<{ n: string }>(env.superuserUrl, `SELECT count(*)::text AS n FROM ${APP_SCHEMA}.side_effects WHERE effect_key = $1`, [effectKey]))[0]!.n;

  it('pg-boss redelivery after a lost acknowledgement does not duplicate the effect', async () => {
    const queue = QUEUES.idempotent.name;
    const effectKey = `effect-${randomUUID()}`;
    const runs: Array<{ attempt: number; applied: boolean }> = [];
    await boss.work(queue, { includeMetadata: true, pollingIntervalSeconds: 0.5 }, async ([job]: JobWithMetadata<DemoJobData>[]) => {
      if (!job) return;
      const attempt = job.retryCount + 1;
      const result = await applySideEffect(worker.db, job.data, job.id);
      runs.push({ attempt, applied: result.applied });
      // The effect is committed, then the acknowledgement is "lost": pg-boss redelivers.
      if (attempt === 1) throw new Error('acknowledgement lost after the effect was committed');
    });
    const id = (await boss.send(queue, { recordId: 'p6', sellerId: env.demo.sellerId, effectKey } satisfies DemoJobData))!;
    await withTimeout(boss.getSpy<DemoJobData>(queue).waitForJobWithId(id, 'completed'), 30_000, 'redelivered job completes');
    expect(runs).toEqual([
      { attempt: 1, applied: true },
      { attempt: 2, applied: false },
    ]);
    expect(await effectCount(effectKey)).toBe('1');
    await boss.offWork(queue);
  });

  it('concurrent duplicate deliveries of one logical job produce exactly one effect', async () => {
    const effectKey = `effect-${randomUUID()}`;
    const data: DemoJobData = { recordId: 'p6-concurrent', sellerId: env.demo.sellerId, effectKey };
    const results = await Promise.all([1, 2, 3, 4].map(() => applySideEffect(worker.db, data, randomUUID())));
    expect(results.filter((r) => r.applied)).toHaveLength(1);
    expect(await effectCount(effectKey)).toBe('1');
  });

  it('the idempotency key is enforced by the database, not by application memory', async () => {
    const effectKey = `effect-${randomUUID()}`;
    const constraint = await query<{ conname: string; contype: string }>(
      env.superuserUrl,
      `SELECT conname, contype FROM pg_constraint WHERE conrelid = '${APP_SCHEMA}.side_effects'::regclass AND contype = 'u'`,
    );
    expect(constraint).toEqual([{ conname: 'side_effects_effect_key_unique', contype: 'u' }]);
    // A fresh process (no memory of the first insert) attempting the same key is refused by PostgreSQL.
    const first = await applySideEffect(worker.db, { recordId: 'a', sellerId: env.demo.sellerId, effectKey }, randomUUID());
    expect(first.applied).toBe(true);
    const fresh = createDb(env.workerUrl, 1, 'spike-worker-p6-fresh');
    try {
      const second = await applySideEffect(fresh.db, { recordId: 'b', sellerId: env.demo.sellerId, effectKey }, randomUUID());
      expect(second.applied).toBe(false);
    } finally {
      await fresh.close();
    }
    expect(await effectCount(effectKey)).toBe('1');
  });
});
