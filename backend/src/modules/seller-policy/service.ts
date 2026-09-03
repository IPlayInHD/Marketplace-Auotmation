import { z } from 'zod';
import type { TenantTransaction } from '../../db/kysely.ts';
import type { LocationDisclosureMode } from '../../db/schema.ts';
import type { WriteContext } from '../../shared/command.ts';
import { mapDatabaseError, NotFoundError } from '../../shared/errors.ts';
import { MoneySchema, type Money } from '../../shared/money.ts';

const PolicyVersionInputSchema = z.strictObject({
  listingId: z.uuid(),
  minimumPrice: MoneySchema,
  negotiationEnabled: z.boolean(),
  maxAutonomousConcession: MoneySchema.optional(),
  tradesAllowed: z.boolean(),
  deliveryAllowed: z.boolean(),
  pickupAllowed: z.boolean(),
  locationDisclosureMode: z.enum(['NONE', 'AREA']),
  holdWindowSeconds: z.number().int().positive().optional(),
});
export type PolicyVersionInput = z.input<typeof PolicyVersionInputSchema>;

export interface PolicyVersionRecord {
  id: string;
  listingId: string;
  versionNumber: number;
  /** Protected (P3). Read by the policy engine and the seller only. */
  minimumPrice: Money;
  negotiationEnabled: boolean;
  maxAutonomousConcession: Money | null;
  tradesAllowed: boolean;
  deliveryAllowed: boolean;
  pickupAllowed: boolean;
  locationDisclosureMode: LocationDisclosureMode;
  holdWindowSeconds: number | null;
  createdAt: Date;
}

function toRecord(row: {
  id: string;
  listing_id: string;
  version_number: number;
  minimum_price_minor: number;
  currency: string;
  negotiation_enabled: boolean;
  max_autonomous_concession_minor: number | null;
  trades_allowed: boolean;
  delivery_allowed: boolean;
  pickup_allowed: boolean;
  location_disclosure_mode: LocationDisclosureMode;
  hold_window_seconds: number | null;
  created_at: Date;
}): PolicyVersionRecord {
  return {
    id: row.id,
    listingId: row.listing_id,
    versionNumber: row.version_number,
    minimumPrice: { amountMinor: row.minimum_price_minor, currency: row.currency },
    negotiationEnabled: row.negotiation_enabled,
    maxAutonomousConcession:
      row.max_autonomous_concession_minor === null
        ? null
        : { amountMinor: row.max_autonomous_concession_minor, currency: row.currency },
    tradesAllowed: row.trades_allowed,
    deliveryAllowed: row.delivery_allowed,
    pickupAllowed: row.pickup_allowed,
    locationDisclosureMode: row.location_disclosure_mode,
    holdWindowSeconds: row.hold_window_seconds,
    createdAt: row.created_at,
  };
}

/**
 * Appends a new policy version for a listing (LIST-132, DM-06). A change never edits a version;
 * it creates the next one. The concession limit, if given, is in the minimum's currency (OPS-704).
 */
export async function createPolicyVersion(
  trx: TenantTransaction,
  ctx: WriteContext,
  input: PolicyVersionInput,
  versionNumber: number,
): Promise<PolicyVersionRecord> {
  const valid = PolicyVersionInputSchema.parse(input);
  if (
    valid.maxAutonomousConcession &&
    valid.maxAutonomousConcession.currency !== valid.minimumPrice.currency
  ) {
    throw mapDatabaseError(
      new Error('concession currency differs from minimum price currency'),
      'policy_version',
    );
  }
  try {
    const row = await trx
      .insertInto('seller_policy_version')
      .values({
        seller_id: ctx.sellerId,
        listing_id: valid.listingId,
        version_number: versionNumber,
        minimum_price_minor: valid.minimumPrice.amountMinor,
        currency: valid.minimumPrice.currency,
        negotiation_enabled: valid.negotiationEnabled,
        max_autonomous_concession_minor: valid.maxAutonomousConcession?.amountMinor ?? null,
        trades_allowed: valid.tradesAllowed,
        delivery_allowed: valid.deliveryAllowed,
        pickup_allowed: valid.pickupAllowed,
        location_disclosure_mode: valid.locationDisclosureMode,
        hold_window_seconds: valid.holdWindowSeconds ?? null,
        request_id: ctx.requestId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toRecord(row);
  } catch (err) {
    throw mapDatabaseError(err, 'policy_version');
  }
}

export async function getPolicyVersion(
  trx: TenantTransaction,
  listingId: string,
  versionId: string,
): Promise<PolicyVersionRecord> {
  const row = await trx
    .selectFrom('seller_policy_version')
    .selectAll()
    .where('listing_id', '=', listingId)
    .where('id', '=', versionId)
    .executeTakeFirst();
  if (!row) throw new NotFoundError('policy_version');
  return toRecord(row);
}
