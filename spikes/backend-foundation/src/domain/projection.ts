import { z } from 'zod';

// Buyer-safe projection (SEC-020, SEC-021, OPS-724, SEC-138).
//
// The internal listing record carries seller-private fields. The buyer-safe projection is a
// distinct, explicitly constructed type. It is never produced by filtering or spreading the
// internal record: every field is copied by name, and the result is validated against a strict
// schema that rejects unknown keys, so an accidental spread cannot smuggle a protected field out.

export const ListingRecordSchema = z.strictObject({
  id: z.uuid(),
  sellerId: z.uuid(),
  title: z.string().min(1),
  askingPriceMinor: z.int().nonnegative(),
  currency: z.string().length(3),
  /** Seller-private. Must never reach a buyer. */
  minimumPriceMinor: z.int().nonnegative(),
  /** Seller-private. Must never reach a buyer. */
  internalNotes: z.string(),
  sellerDisplayName: z.string().min(1),
});
export type ListingRecord = z.infer<typeof ListingRecordSchema>;

/** Keys of the internal record that are protected seller information (product invariant 10). */
export const PROTECTED_LISTING_KEYS = ['sellerId', 'minimumPriceMinor', 'internalNotes'] as const;
export type ProtectedListingKey = (typeof PROTECTED_LISTING_KEYS)[number];

export const BuyerSafeListingSchema = z.strictObject({
  publicId: z.string().min(1),
  title: z.string().min(1),
  askingPriceMinor: z.int().nonnegative(),
  currency: z.string().length(3),
  sellerDisplayName: z.string().min(1),
});
export type BuyerSafeListing = z.infer<typeof BuyerSafeListingSchema>;

/**
 * Type-level guarantee (SEC-021): the buyer-safe type cannot structurally hold a protected key.
 * If someone adds a protected key to BuyerSafeListingSchema this constant stops compiling.
 */
type ProtectedKeysPresent = Extract<keyof BuyerSafeListing, ProtectedListingKey>;
export const buyerSafeTypeHoldsNoProtectedKey: [ProtectedKeysPresent] extends [never] ? true : never = true;

/** Builds the projection field by field. The only place a buyer-visible listing is assembled. */
export function toBuyerSafe(record: ListingRecord, publicId: string): BuyerSafeListing {
  const projection: BuyerSafeListing = {
    publicId,
    title: record.title,
    askingPriceMinor: record.askingPriceMinor,
    currency: record.currency,
    sellerDisplayName: record.sellerDisplayName,
  };
  return BuyerSafeListingSchema.parse(projection);
}

/**
 * Egress gate for buyer responses. Whatever object reaches serialisation is re-validated against
 * the strict schema first, so an object assembled elsewhere with extra keys is rejected rather
 * than serialised.
 */
export function serializeBuyerSafe(value: unknown): string {
  return JSON.stringify(BuyerSafeListingSchema.parse(value));
}
