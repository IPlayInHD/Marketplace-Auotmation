import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import { withTenant, type TenantTransaction } from '../../db/kysely.ts';
import type { Database } from '../../db/schema.ts';
import { NotFoundError } from '../../shared/errors.ts';

export interface SellerRecord {
  id: string;
  displayName: string;
  createdAt: Date;
}

const CreateSellerInput = z.strictObject({
  displayName: z.string().trim().min(1).max(80),
  requestId: z.string().min(1).max(128),
});

/**
 * Creates a seller tenant. The new seller id is generated here and used as the tenant context of
 * the inserting transaction, so even the seller's own row is written under row-level security.
 */
export async function createSeller(
  db: Kysely<Database>,
  input: { displayName: string; requestId: string },
): Promise<SellerRecord> {
  const valid = CreateSellerInput.parse(input);
  const id = randomUUID();
  return withTenant(db, id, async (trx) => {
    const row = await trx
      .insertInto('seller')
      .values({ id, display_name: valid.displayName })
      .returning(['id', 'display_name', 'created_at'])
      .executeTakeFirstOrThrow();
    return { id: row.id, displayName: row.display_name, createdAt: row.created_at };
  });
}

/** The seller of the current tenant context. Anyone else's row is invisible (SEC-100). */
export async function getSeller(trx: TenantTransaction, sellerId: string): Promise<SellerRecord> {
  const row = await trx
    .selectFrom('seller')
    .select(['id', 'display_name', 'created_at'])
    .where('id', '=', sellerId)
    .executeTakeFirst();
  if (!row) throw new NotFoundError('seller');
  return { id: row.id, displayName: row.display_name, createdAt: row.created_at };
}
