// Module 6 — Public Listing Access (ARCH §3). Owns app.public_listing_access: the opaque public
// id (SEC-003, OPS-711) and the surface's enabled state, plus the buyer-safe projection type and
// its constructor (SEC-020, SEC-021, OPS-724, DM-10). No public route exists: nothing here is
// reachable by a buyer (D-18 boundaries). This module never imports Seller Policy or Audit: it
// cannot read the minimum price by construction, and the commands that audit live in Modules 3 and 7.
export {
  PROTECTED_LISTING_KEYS,
  buildBuyerSafeProjection,
  buyerSafeTypeHoldsNoProtectedKey,
  BuyerSafeListingProjectionSchema,
  serializeBuyerSafeProjection,
  type BuyerSafeListingProjection,
  type ProtectedListingKey,
} from './projection.ts';
export {
  PUBLIC_ID_ALPHABET,
  PUBLIC_ID_ENTROPY_BITS,
  PUBLIC_ID_LENGTH,
  PublicIdSchema,
  createPublicAccess,
  findPublicAccessByListing,
  findPublicAccessByPublicId,
  generatePublicId,
  getPublicAccess,
  revivePublicAccess,
  updatePublicAccess,
  type PublicAccessRecord,
} from './service.ts';
