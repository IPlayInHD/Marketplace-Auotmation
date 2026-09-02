import type { Kysely } from 'kysely';
import { withTenant } from '../db/kysely.ts';
import type { Database } from '../db/schema.ts';
import type { DemoJobData } from './queues.ts';

// Idempotent job effect (ARCH-013, OPS-722): a redelivered job re-runs this handler, and the
// unique constraint on app.side_effects.effect_key makes the second run a database no-op.
// The handler carries the tenant context of the job (SEC-102).

export interface SideEffectResult {
  /** true when this run inserted the effect; false when the effect already existed. */
  applied: boolean;
}

export async function applySideEffect(db: Kysely<Database>, data: DemoJobData, jobId: string): Promise<SideEffectResult> {
  return withTenant(db, data.sellerId, async (trx) => {
    const inserted = await trx
      .insertInto('side_effects')
      .values({ seller_id: data.sellerId, effect_key: data.effectKey, job_id: jobId })
      .onConflict((oc) => oc.column('effect_key').doNothing())
      .returning('id')
      .executeTakeFirst();
    return { applied: inserted !== undefined };
  });
}
