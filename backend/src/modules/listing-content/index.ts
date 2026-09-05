// Module 4 — Listing Content (ARCH §3). Owns app.listing_content_version and app.product_fact:
// content versions with provenance and the seller-provided facts that ground them (D-10, DM-06).
// It never invents a fact and never writes a buyer projection.
export {
  PRODUCT_FACT_KEYS,
  SellerDraftContentSchema,
  SellerFactsSchema,
  carriesSameCopy,
  createSellerDraft,
  getApprovedVersion,
  getLatestVersion,
  getVersion,
  listFacts,
  listVersions,
  markApproved,
  recordFacts,
  replaceSellerFacts,
  supersedeApprovedVersion,
  uncoveredDetailKeys,
  type ApprovedContent,
  type ContentVersionPage,
  type ContentVersionRecord,
  type DraftCopy,
  type FactReplacement,
  type ProductFactKey,
  type ProductFactRecord,
  type SellerDraftContent,
  type SellerFacts,
} from './service.ts';
