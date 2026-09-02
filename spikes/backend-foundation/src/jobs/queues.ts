// Queue declarations. Queues are created by the migration role in a controlled step
// (src/db/migrate.ts createQueues), never by a runtime process.
//
// pg-boss semantics used here (pg-boss 12.29.0, docs/api/queues.md):
//   retryLimit      number of retries after the first attempt before the job is `failed`
//   retryDelay      seconds between attempts (0 = immediate)
//   expireInSeconds how long one attempt may stay `active` before the monitor fails it
//                   ("job timed out"); the failure follows the normal retry logic
//   heartbeatSeconds worker liveness contract; the monitor fails an active job whose
//                   heartbeat_on is older than this ("job heartbeat timeout"); minimum 10

export interface QueueDefinition {
  name: string;
  retryLimit: number;
  retryDelay: number;
  expireInSeconds: number;
  heartbeatSeconds?: number;
}

export const QUEUES = {
  /** Domain-write plus enqueue atomicity (proof 4). */
  demo: { name: 'spike_demo', retryLimit: 2, retryDelay: 0, expireInSeconds: 30 },
  /** Fails first, succeeds later (proof 5). */
  retry: { name: 'spike_retry', retryLimit: 2, retryDelay: 0, expireInSeconds: 30 },
  /** Always fails; proves the terminal state after the policy is exhausted (proof 5). */
  exhaust: { name: 'spike_exhaust', retryLimit: 1, retryDelay: 0, expireInSeconds: 30 },
  /** Worker killed mid-job; short expiry so the monitor recovers it quickly (proof 5, crash). */
  crash: { name: 'spike_crash', retryLimit: 2, retryDelay: 0, expireInSeconds: 3 },
  /** Heartbeat-based abandonment detection (proof 5, crash). */
  heartbeat: { name: 'spike_heartbeat', retryLimit: 2, retryDelay: 0, expireInSeconds: 120, heartbeatSeconds: 10 },
  /** Redelivery must not duplicate a side effect (proof 6). */
  idempotent: { name: 'spike_idempotent', retryLimit: 2, retryDelay: 0, expireInSeconds: 30 },
} as const satisfies Record<string, QueueDefinition>;

export const ALL_QUEUES: readonly QueueDefinition[] = Object.values(QUEUES);

export interface DemoJobData {
  recordId: string;
  sellerId: string;
  /** Logical identity of the effect; the database enforces uniqueness on it. */
  effectKey: string;
}
