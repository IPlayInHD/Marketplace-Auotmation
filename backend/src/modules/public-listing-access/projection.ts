import { z } from 'zod';
import { CurrencyCodeSchema, MinorUnitsSchema, type Money } from '../../shared/money.ts';
import type { ApprovedContent } from '../listing-content/index.ts';

// The buyer-safe projection is a distinct, explicitly constructed type (SEC-020, OPS-724). It is
// never produced by filtering or spreading an internal record: every field is copied by name, and
// the result is validated against a strict schema that rejects unknown keys, so an accidental
// spread cannot smuggle a protected field out. It is built from APPROVED content only (SM-CT-03).

export const BuyerSafeListingProjectionSchema = z.strictObject({
  title: z.string().min(1),
  summary: z.string().nullable(),
  description: z.string().nullable(),
  structuredDetails: z.record(z.string(), z.string()),
  askingPriceMinor: MinorUnitsSchema,
  currency: CurrencyCodeSchema,
  /** OPS-726: the only seller identity field a buyer payload may carry. */
  sellerDisplayName: z.string().min(1),
});
export type BuyerSafeListingProjection = z.infer<typeof BuyerSafeListingProjectionSchema>;

/**
 * Keys that name protected seller information or internal state (product invariant 10, D-04,
 * SEC-020). The buyer-safe type cannot hold any of them; see the type-level guard below.
 */
export const PROTECTED_LISTING_KEYS = [
  'sellerId',
  'seller_id',
  'listingId',
  'inventoryItemId',
  'minimumPrice',
  'minimumPriceMinor',
  'minimum_price_minor',
  'maxAutonomousConcession',
  'acquisitionCost',
  'currentPolicyVersionId',
  'rowVersion',
  'requestId',
] as const;
export type ProtectedListingKey = (typeof PROTECTED_LISTING_KEYS)[number];

/**
 * Type-level guarantee (SEC-021): the buyer-safe type cannot structurally hold a protected key.
 * If someone adds a protected key to the schema this constant stops compiling.
 */
type ProtectedKeysPresent = Extract<keyof BuyerSafeListingProjection, ProtectedListingKey>;
export const buyerSafeTypeHoldsNoProtectedKey: [ProtectedKeysPresent] extends [never] ? true : never = true;

export interface BuyerSafeProjectionInput {
  content: ApprovedContent;
  askingPrice: Money;
  sellerDisplayName: string;
}

/** Builds the projection field by field. The only place a buyer-visible listing is assembled (DM-10). */
export function buildBuyerSafeProjection(input: BuyerSafeProjectionInput): BuyerSafeListingProjection {
  // Runtime backstop for the type: only content that carries an approval timestamp is projected.
  if (!(input.content.approvedAt instanceof Date) || Number.isNaN(input.content.approvedAt.getTime())) {
    throw new Error('a buyer-safe projection is built from APPROVED content only (SM-CT-03)');
  }
  const projection: BuyerSafeListingProjection = {
    title: input.content.title,
    summary: input.content.summary,
    description: input.content.description,
    structuredDetails: { ...input.content.structuredDetails },
    askingPriceMinor: input.askingPrice.amountMinor,
    currency: input.askingPrice.currency,
    sellerDisplayName: input.sellerDisplayName,
  };
  return BuyerSafeListingProjectionSchema.parse(projection);
}

/**
 * Egress gate for buyer responses. Whatever object reaches serialisation is re-validated against
 * the strict schema first, so an object assembled elsewhere with extra keys is rejected rather
 * than serialised.
 */
export function serializeBuyerSafeProjection(value: unknown): string {
  return JSON.stringify(BuyerSafeListingProjectionSchema.parse(value));
}
