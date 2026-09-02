import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { JobWithMetadata, PgBoss } from 'pg-boss';
import { PGBOSS_SCHEMA } from '../src/db/constants.ts';
import { QUEUES } from '../src/jobs/queues.ts';
import { createRuntimeBoss } from '../src/worker/boss.ts';
import { startSpikeDatabase, type SpikeDatabase } from './helpers/database.ts';
import { query, sleep, waitFor, withTimeout } from './helpers/inspect.ts';

// Proof 5 — retry and redelivery.
//   * exception retry: a handler that throws is retried per the queue policy;
//   * exhausted policy: the final state is `failed`;
//   * crash redelivery: a worker PROCESS killed with SIGKILL mid-job; the monitor expires the
//     abandoned attempt and a different worker instance completes it;
//   * heartbeat redelivery: an active job whose heartbeat stops is failed by the monitor and
//     redelivered.
// Exception retry and crash/lease redelivery are separate proofs and are reported separately.

class TransientError extends Error {
  override name = 'TransientError';
}

interface Data {
  key: string;
}

describe('Retry and redelivery', () => {
  let env: SpikeDatabase;
  let boss: PgBoss;
  beforeAll(async () => {
    env = await startSpikeDatabase();
    boss = createRuntimeBoss({ connectionString: env.workerUrl, applicationName: 'spike-worker-p5', enableSpies: true, monitorIntervalSeconds: 1 });
    boss.on('error', (e) => console.error('pg-boss error', e));
    await boss.start();
  });
  afterAll(async () => {
    await boss?.stop({ close: true, graceful: false, timeout: 5_000 });
    await env?.stop();
  });

  const jobState = (name: string, id: string) =>
    query<{ state: string; retry_count: number; retry_limit: number; output: unknown }>(
      env.superuserUrl,
      `SELECT state::text, retry_count, retry_limit, output FROM ${PGBOSS_SCHEMA}.job WHERE name = $1 AND id = $2`,
      [name, id],
    ).then((r) => r[0]);

  it('a handler that fails on its first attempt is retried per the explicit policy and succeeds later; attempts are observable', async () => {
    const queue = QUEUES.retry.name;
    const attempts: number[] = [];
    await boss.work(queue, { includeMetadata: true, pollingIntervalSeconds: 0.5 }, async ([job]: JobWithMetadata<Data>[]) => {
      if (!job) return;
      const attempt = job.retryCount + 1;
      attempts.push(attempt);
      if (attempt === 1) throw new TransientError('first attempt fails on purpose');
      return { attempt };
    });
    const id = (await boss.send(queue, { key: 'retry-once' }))!;
    const spy = boss.getSpy<Data>(queue);
    const completed = await withTimeout(spy.waitForJobWithId(id, 'completed'), 30_000, 'retried job completes');
    expect(completed.state).toBe('completed');
    expect(attempts).toEqual([1, 2]);

    const meta = await boss.getJobById<Data>(queue, id);
    expect(meta?.state).toBe('completed');
    expect(meta?.retryCount).toBe(1);
    expect(meta?.retryLimit).toBe(QUEUES.retry.retryLimit);
    expect(meta?.output).toEqual({ attempt: 2 });
    const row = await jobState(queue, id);
    expect(row).toMatchObject({ state: 'completed', retry_count: 1, retry_limit: QUEUES.retry.retryLimit });
    await boss.offWork(queue);
  });

  it('a handler that always fails ends in the failed state once the policy is exhausted', async () => {
    const queue = QUEUES.exhaust.name;
    const attempts: number[] = [];
    await boss.work(queue, { includeMetadata: true, pollingIntervalSeconds: 0.5 }, async ([job]: JobWithMetadata<Data>[]) => {
      if (!job) return;
      attempts.push(job.retryCount + 1);
      throw new Error('permanent failure');
    });
    const id = (await boss.send(queue, { key: 'always-fails' }))!;
    const row = await waitFor(async () => {
      const r = await jobState(queue, id);
      return r?.state === 'failed' ? r : undefined;
    }, 30_000, 'job reaches failed');
    expect(row.retry_count).toBe(QUEUES.exhaust.retryLimit);
    expect(attempts).toEqual([1, 2]);
    expect(JSON.stringify(row.output)).toContain('permanent failure');
    await boss.offWork(queue);
  });

  it('crash redelivery: a worker process killed with SIGKILL mid-job is recovered by another instance after the attempt expires', async () => {
    const queue = QUEUES.crash.name;
    const id = (await boss.send(queue, { key: 'crash' }))!;

    const child = spawnCrashWorker(env.workerUrl, queue);
    try {
      const picked = await withTimeout(child.pickedJobId, 30_000, 'crash worker picks the job');
      expect(picked).toBe(id);
      expect((await jobState(queue, id))?.state).toBe('active');
      child.process.kill('SIGKILL');
      await withTimeout(child.exited, 10_000, 'crash worker exits');

      // The row is still active: nothing cleaned it up, exactly like a real crash.
      expect((await jobState(queue, id))?.state).toBe('active');

      // After expireInSeconds the monitor fails the abandoned attempt into `retry`.
      await sleep((QUEUES.crash.expireInSeconds + 0.5) * 1000);
      await boss.supervise(queue);
      const recovered = await jobState(queue, id);
      expect(recovered?.state).toBe('retry');
      expect(JSON.stringify(recovered?.output)).toContain('job timed out');

      // A different, live instance completes it on the next attempt.
      let completedBy = '';
      await boss.work(queue, { includeMetadata: true, pollingIntervalSeconds: 0.5 }, async ([job]: JobWithMetadata<Data>[]) => {
        if (!job) return;
        completedBy = `in-process-attempt-${job.retryCount + 1}`;
      });
      await withTimeout(boss.getSpy<Data>(queue).waitForJobWithId(id, 'completed'), 30_000, 'recovered job completes');
      const final = await jobState(queue, id);
      expect(final).toMatchObject({ state: 'completed', retry_count: 1 });
      expect(completedBy).toBe('in-process-attempt-2');
      await boss.offWork(queue);
    } finally {
      if (child.process.exitCode === null && !child.process.killed) child.process.kill('SIGKILL');
    }
  });

  it('heartbeat redelivery: an active job whose worker stops heartbeating is failed by the monitor and redelivered', async () => {
    const queue = QUEUES.heartbeat.name;
    const id = (await boss.send(queue, { key: 'heartbeat' }))!;
    // fetch() marks the job active with heartbeat_on = now() and, unlike work(), never sends a
    // heartbeat afterwards: the database-visible state of a worker that died holding the job.
    const [fetched] = await boss.fetch<Data>(queue);
    expect(fetched?.id).toBe(id);
    expect(fetched?.heartbeatSeconds).toBe(QUEUES.heartbeat.heartbeatSeconds);
    expect((await jobState(queue, id))?.state).toBe('active');

    await sleep((QUEUES.heartbeat.heartbeatSeconds! + 1) * 1000);
    await boss.supervise(queue);
    const recovered = await jobState(queue, id);
    expect(recovered?.state).toBe('retry');
    expect(JSON.stringify(recovered?.output)).toContain('job heartbeat timeout');

    await boss.work(queue, { includeMetadata: true, pollingIntervalSeconds: 0.5 }, async ([job]: JobWithMetadata<Data>[]) => {
      if (!job) return;
      return { attempt: job.retryCount + 1 };
    });
    await withTimeout(boss.getSpy<Data>(queue).waitForJobWithId(id, 'completed'), 30_000, 'heartbeat job completes');
    expect(await jobState(queue, id)).toMatchObject({ state: 'completed', retry_count: 1 });
    await boss.offWork(queue);
  }, 60_000);
});

function spawnCrashWorker(workerUrl: string, queue: string) {
  const fixture = fileURLToPath(new URL('./fixtures/crash-worker.ts', import.meta.url));
  const child: ChildProcess = spawn(process.execPath, [fixture], {
    env: { PATH: process.env['PATH'] ?? '', SPIKE_WORKER_DATABASE_URL: workerUrl, SPIKE_CRASH_QUEUE: queue },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr?.on('data', (d: Buffer) => (stderr += d.toString()));
  const pickedJobId = new Promise<string>((resolve, reject) => {
    let buffer = '';
    child.stdout?.on('data', (d: Buffer) => {
      buffer += d.toString();
      const m = /PICKED ([0-9a-f-]{36})/.exec(buffer);
      if (m) resolve(m[1]!);
    });
    child.on('exit', (code, signal) => reject(new Error(`crash worker exited early (${code ?? signal}): ${stderr}`)));
  });
  const exited = new Promise<void>((resolve) => child.on('exit', () => resolve()));
  return { process: child, pickedJobId, exited };
}
