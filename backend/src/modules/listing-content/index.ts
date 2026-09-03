// Module 4 — Listing Content (ARCH §3). Owns app.listing_content_version and app.product_fact:
// content versions with provenance and the seller-provided facts that ground them (D-10, DM-06).
// It never invents a fact and never writes a buyer projection.
export {
  PRODUCT_FACT_KEYS,
  createSellerDraft,
  getApprovedVersion,
  getVersion,
  listFacts,
  markApproved,
  recordFacts,
  supersedeApprovedVersion,
  uncoveredDetailKeys,
  type ApprovedContent,
  type ContentVersionRecord,
  type ProductFactKey,
  type ProductFactRecord,
} from './service.ts';
