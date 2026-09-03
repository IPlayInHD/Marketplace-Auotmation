// Module 6 — Public Listing Access (ARCH §3). In this slice it holds only the buyer-safe projection
// type and its constructor (SEC-020, SEC-021, OPS-724, DM-10). No public route, no opaque public
// id and no access code exist yet; nothing here is reachable by a buyer (D-18 boundaries).
// This module never imports Seller Policy: it cannot read the minimum price by construction.
export {
  PROTECTED_LISTING_KEYS,
  buildBuyerSafeProjection,
  buyerSafeTypeHoldsNoProtectedKey,
  BuyerSafeListingProjectionSchema,
  serializeBuyerSafeProjection,
  type BuyerSafeListingProjection,
  type ProtectedListingKey,
} from './projection.ts';
