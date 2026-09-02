import { createRuntimeBoss } from '../../src/worker/boss.ts';

// A worker process that takes one job and then never finishes it. The test kills this process
// with SIGKILL after it reports PICKED, which is the closest reproduction of a crashed worker
// available: an `active` job row whose owning process is gone without any cleanup.
//   SPIKE_WORKER_DATABASE_URL  worker-role connection string
//   SPIKE_CRASH_QUEUE          queue to work

const url = process.env['SPIKE_WORKER_DATABASE_URL'];
const queue = process.env['SPIKE_CRASH_QUEUE'];
if (!url || !queue) {
  console.error('SPIKE_WORKER_DATABASE_URL and SPIKE_CRASH_QUEUE are required');
  process.exit(2);
}

const boss = createRuntimeBoss({ connectionString: url, applicationName: 'spike-crash-worker' });
boss.on('error', (err) => console.error('pg-boss error', err));
await boss.start();
await boss.work(queue, { pollingIntervalSeconds: 0.5 }, async ([job]) => {
  if (job) {
    process.stdout.write(`PICKED ${job.id}\n`);
  }
  // Never resolve: simulate a worker that dies mid-job. The parent sends SIGKILL.
  await new Promise<never>(() => {});
});
process.stdout.write('READY\n');
