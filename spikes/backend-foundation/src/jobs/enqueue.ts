import { sql, type Kysely } from 'kysely';
import { fromKysely, type PgBoss } from 'pg-boss';
import { withTenant } from '../db/kysely.ts';
import type { Database } from '../db/schema.ts';
import { PGBOSS_SCHEMA } from '../db/constants.ts';
import { QUEUES, type DemoJobData } from './queues.ts';

// Transactional enqueue (OPS-722, ARCH-011): the domain row and its job are written by the same
// PostgreSQL transaction on the same connection, using pg-boss's documented Kysely adapter
// (docs/api/adapters.md): `boss.send(name, data, { db: fromKysely(trx) })`.

export class ControlledFailure extends Error {
  override name = 'ControlledFailure';
}

export interface EnqueueEvidence {
  recordId: string;
  jobId: string;
  /** pg_backend_pid() observed before the domain insert. */
  backendPidBefore: number;
  /** pg_backend_pid() observed after the job insert. Equal to backendPidBefore on one connection. */
  backendPidAfter: number;
  /** The transaction's own id, as txid_current() modulo 2^32 so it is comparable with xmin. */
  currentXid: string;
  /** xmin of the domain row: the id of the transaction that wrote it. */
  recordXmin: string;
  /** xmin of the job row: the id of the transaction that wrote it. */
  jobXmin: string;
}

export interface EnqueueOptions {
  /** Throws after both writes so the transaction rolls back (rollback proof). */
  failAfterEnqueue?: boolean;
  queueName?: string;
}

interface XidRow {
  pid: number;
  xid: string;
}

export async function createDemoRecordWithJob(
  db: Kysely<Database>,
  boss: PgBoss,
  sellerId: string,
  payload: string,
  effectKey: string,
  options: EnqueueOptions = {},
): Promise<EnqueueEvidence> {
  const queueName = options.queueName ?? QUEUES.demo.name;
  return withTenant(db, sellerId, async (trx) => {
    const before = await sql<XidRow>`select pg_backend_pid() as pid, (txid_current() % 4294967296)::text as xid`
      .execute(trx)
      .then((r) => r.rows[0]!);

    const record = await trx
      .insertInto('demo_records')
      .values({ seller_id: sellerId, payload })
      .returning('id')
      .executeTakeFirstOrThrow();

    const data: DemoJobData = { recordId: record.id, sellerId, effectKey };
    const jobId = await boss.send(queueName, data, { db: fromKysely(trx) });
    if (!jobId) throw new Error('pg-boss did not return a job id');

    const recordXmin = await sql<{ xmin: string }>`select xmin::text as xmin from app.demo_records where id = ${record.id}::uuid`
      .execute(trx)
      .then((r) => r.rows[0]!.xmin);
    const jobXmin = await sql<{ xmin: string }>`select xmin::text as xmin from ${sql.id(PGBOSS_SCHEMA, 'job')} where id = ${jobId}::uuid`
      .execute(trx)
      .then((r) => r.rows[0]!.xmin);
    const after = await sql<XidRow>`select pg_backend_pid() as pid, (txid_current() % 4294967296)::text as xid`
      .execute(trx)
      .then((r) => r.rows[0]!);

    if (options.failAfterEnqueue) {
      throw new ControlledFailure('controlled failure after enqueue; the transaction must roll back');
    }

    return {
      recordId: record.id,
      jobId,
      backendPidBefore: before.pid,
      backendPidAfter: after.pid,
      currentXid: before.xid,
      recordXmin,
      jobXmin,
    };
  });
}
