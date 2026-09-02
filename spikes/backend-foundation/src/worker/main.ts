import type { JobWithMetadata } from 'pg-boss';
import { createDb } from '../db/kysely.ts';
import { applySideEffect } from '../jobs/handler.ts';
import { QUEUES, type DemoJobData } from '../jobs/queues.ts';
import { categorizeError, createLogger, logJobOutcome } from '../observability/logger.ts';
import { createRuntimeBoss } from './boss.ts';

// Manual entry point for the spike worker process. Not used by the tests, which drive pg-boss
// in-process. Requires an already-migrated database reachable as the worker role.
//   SPIKE_WORKER_DATABASE_URL  connection string for the spike_worker role

const url = process.env['SPIKE_WORKER_DATABASE_URL'];
if (!url) {
  console.error('SPIKE_WORKER_DATABASE_URL is required');
  process.exit(2);
}

const logger = createLogger({ module: 'worker' });
const handle = createDb(url, 4, 'spike-worker');
const boss = createRuntimeBoss({ connectionString: url, applicationName: 'spike-worker', supervise: true });
boss.on('error', (err) => logger.error(categorizeError(err), 'pg-boss error'));

await boss.start();
await boss.work(QUEUES.demo.name, { includeMetadata: true }, async ([job]: JobWithMetadata<DemoJobData>[]) => {
  if (!job) return;
  const started = Date.now();
  const attempt = job.retryCount + 1;
  try {
    const result = await applySideEffect(handle.db, job.data, job.id);
    logJobOutcome(logger, {
      job_id: job.id,
      job_name: job.name,
      job_attempt: attempt,
      seller_id: job.data.sellerId,
      outcome: result.applied ? 'completed' : 'skipped_duplicate',
      duration_ms: Date.now() - started,
    });
  } catch (err) {
    logJobOutcome(logger, {
      job_id: job.id,
      job_name: job.name,
      job_attempt: attempt,
      seller_id: job.data.sellerId,
      outcome: 'failed',
      ...categorizeError(err),
      duration_ms: Date.now() - started,
    });
    throw err;
  }
});
logger.info({ queue: QUEUES.demo.name }, 'worker started');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    await boss.stop({ graceful: true, timeout: 10_000, close: true });
    await handle.close();
    process.exit(0);
  });
}
