// Module 3 — Inventory & Listings (ARCH §3). Owns app.inventory_item and app.listing and the
// listing lifecycle (STATE_MACHINES §1). It orchestrates content approval and policy versions
// through the Listing Content and Seller Policy modules' interfaces; it never calls a model.
export { LISTING_STATUSES, LISTING_TRANSITIONS, isListingTransitionAllowed } from './lifecycle.ts';
export {
  approveContent,
  createInventoryItem,
  createListing,
  getListing,
  markReady,
  readinessGaps,
  revertToDraft,
  setAskingPrice,
  setPolicy,
  type InventoryItemRecord,
  type ListingRecord,
} from './service.ts';
