import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import { withTenant } from '../../src/db/kysely.ts';
import type { Database } from '../../src/db/schema.ts';
import * as listings from '../../src/modules/listings/index.ts';
import * as content from '../../src/modules/listing-content/index.ts';
import * as sellers from '../../src/modules/sellers/index.ts';
import type { CommandContext } from '../../src/shared/command.ts';
import type { Money } from '../../src/shared/money.ts';

// Synthetic fixtures only (D-18, OPS-500, DATA-110). Every name, item and amount below is
// fictional and exists for automated tests. No real seller, buyer, item, price or contact route
// appears here; test/unit/fixtures.test.ts scans for that.

export const FIXTURE = {
  sellers: { a: 'Fixture Seller A', b: 'Fixture Seller B' },
  facts: {
    name: 'Synthetic road bicycle',
    brand: 'Fictional Cycles',
    condition: 'used, rideable',
    defects: 'rear brake pads worn',
  },
  copy: {
    title: 'Synthetic road bicycle by Fictional Cycles',
    summary: 'A fictional bicycle that exists only in automated tests.',
    description: 'Fixture description. Nothing here describes a real item.',
  },
  askingPrice: { amountMinor: 25_000, currency: 'CAD' } as Money,
  minimumPrice: { amountMinor: 20_000, currency: 'CAD' } as Money,
  policy: {
    negotiationEnabled: true,
    tradesAllowed: false,
    deliveryAllowed: false,
    pickupAllowed: true,
    locationDisclosureMode: 'AREA' as const,
  },
} as const;

export function command(sellerId: string, tag: string): CommandContext {
  return { sellerId, requestId: `req-${tag}-${randomUUID()}`, idempotencyKey: `idem-${tag}-${randomUUID()}` };
}

export async function seedSeller(db: Kysely<Database>, displayName: string): Promise<string> {
  const seller = await sellers.createSeller(db, { displayName, requestId: `req-seed-${randomUUID()}` });
  return seller.id;
}

export interface BuildOptions {
  /** Record the fixture facts (default true). */
  facts?: boolean;
  /** Create and approve the seller draft (default true). `draftOnly` creates but does not approve. */
  approve?: boolean | 'draftOnly';
  /** Structured details to put on the draft (default: the recorded facts). */
  details?: Record<string, string>;
  /** Set the asking price (default true). */
  price?: boolean | Money;
  /** Create the policy version (default true). */
  policy?: boolean | Money;
}

export interface BuiltListing {
  sellerId: string;
  inventoryItemId: string;
  listingId: string;
  versionId: string | undefined;
  policyVersionId: string | undefined;
  rowVersion: number;
}

/** Builds a listing up to, but not including, READY, with the requested prerequisites present. */
export async function buildListing(
  db: Kysely<Database>,
  sellerId: string,
  options: BuildOptions = {},
): Promise<BuiltListing> {
  return withTenant(db, sellerId, async (trx) => {
    const item = await listings.createInventoryItem(trx, command(sellerId, 'item'));
    let listing = await listings.createListing(trx, command(sellerId, 'create'), {
      inventoryItemId: item.id,
    });

    if (options.facts !== false) {
      await content.recordFacts(trx, command(sellerId, 'facts'), {
        listingId: listing.id,
        facts: FIXTURE.facts,
      });
    }

    let versionId: string | undefined;
    if (options.approve !== false) {
      const details = options.details ?? (options.facts !== false ? { ...FIXTURE.facts } : {});
      const draft = await content.createSellerDraft(trx, command(sellerId, 'draft'), {
        listingId: listing.id,
        ...FIXTURE.copy,
        structuredDetails: details,
      });
      versionId = draft.id;
      if (options.approve !== 'draftOnly') {
        const approved = await listings.approveContent(trx, command(sellerId, 'approve'), {
          listingId: listing.id,
          versionId: draft.id,
          expectedRowVersion: listing.rowVersion,
        });
        listing = approved.listing;
      }
    }

    if (options.price !== false) {
      const price = typeof options.price === 'object' ? options.price : FIXTURE.askingPrice;
      listing = await listings.setAskingPrice(trx, command(sellerId, 'price'), {
        listingId: listing.id,
        price,
        expectedRowVersion: listing.rowVersion,
      });
    }

    let policyVersionId: string | undefined;
    if (options.policy !== false) {
      const minimumPrice = typeof options.policy === 'object' ? options.policy : FIXTURE.minimumPrice;
      const result = await listings.setPolicy(trx, command(sellerId, 'policy'), {
        listingId: listing.id,
        expectedRowVersion: listing.rowVersion,
        policy: { ...FIXTURE.policy, minimumPrice },
      });
      listing = result.listing;
      policyVersionId = result.policyVersion.id;
    }

    return {
      sellerId,
      inventoryItemId: item.id,
      listingId: listing.id,
      versionId,
      policyVersionId,
      rowVersion: listing.rowVersion,
    };
  });
}
