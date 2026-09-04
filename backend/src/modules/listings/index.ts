// Module 3 — Inventory & Listings (ARCH §3). Owns app.inventory_item and app.listing and the
// listing lifecycle (STATE_MACHINES §1). It orchestrates content approval and policy versions
// through the Listing Content and Seller Policy modules' interfaces; it never calls a model.
export { LISTING_STATUSES, LISTING_TRANSITIONS, isListingTransitionAllowed } from './lifecycle.ts';
export {
  approveContent,
  archiveListing,
  cancelListing,
  createInventoryItem,
  createListing,
  expireListing,
  getListing,
  markListed,
  markReady,
  relistListing,
  readinessGaps,
  revertToDraft,
  setAskingPrice,
  setPolicy,
  type CloseListingResult,
  type InventoryItemRecord,
  type ListingRecord,
  type MarkListedResult,
} from './service.ts';
