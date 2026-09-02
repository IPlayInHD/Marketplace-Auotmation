import type { Kysely } from 'kysely';
import { withTenant } from './kysely.ts';
import type { Database } from './schema.ts';

export interface SeedListing {
  sellerId: string;
  title: string;
  askingPriceMinor: number;
  currency: string;
  minimumPriceMinor: number;
  internalNotes: string;
  sellerDisplayName: string;
}

/** Inserts a listing for one seller under that seller's tenant context. Returns the listing id. */
export async function seedListing(db: Kysely<Database>, listing: SeedListing): Promise<string> {
  return withTenant(db, listing.sellerId, async (trx) => {
    const row = await trx
      .insertInto('listings')
      .values({
        seller_id: listing.sellerId,
        title: listing.title,
        asking_price_minor: listing.askingPriceMinor,
        currency: listing.currency,
        minimum_price_minor: listing.minimumPriceMinor,
        internal_notes: listing.internalNotes,
        seller_display_name: listing.sellerDisplayName,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id;
  });
}
