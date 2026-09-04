import type { ColumnType, Generated, JSONColumnType } from 'kysely';

// Kysely table types for schema `app` (see src/db/migrations). Table keys are unqualified because
// the Kysely instance is created with withSchema('app') (src/db/kysely.ts).
//
// bigint money columns arrive as JavaScript numbers through the safe-integer parser installed in
// src/db/kysely.ts; `date` columns arrive as ISO strings.

/** The listing lifecycle states of architecture/STATE_MACHINES.md §1, as the database enum names them. */
export const LISTING_STATUSES = [
  'DRAFT',
  'READY',
  'LISTED',
  'ACTIVE_CONVERSATIONS',
  'OFFER_PENDING',
  'PENDING_SALE',
  'SOLD',
  'CANCELLED',
  'ARCHIVED',
  'EXPIRED',
] as const;
export type ListingStatus = (typeof LISTING_STATUSES)[number];

export type ContentProvenance = 'SELLER_PROVIDED_FACT' | 'AI_ENHANCED_COPY' | 'SELLER_APPROVED_COPY';

export type ContentVersionStatus =
  | 'SELLER_DRAFT'
  | 'ENHANCEMENT_PENDING'
  | 'ENHANCED'
  | 'ENHANCEMENT_FAILED'
  | 'SELLER_EDITED'
  | 'APPROVED'
  | 'SUPERSEDED';

export type LocationDisclosureMode = 'NONE' | 'AREA';

export type AuditActorType = 'SELLER' | 'BUYER_SESSION' | 'SYSTEM' | 'MODEL';

/** The access-code lifecycle of architecture/STATE_MACHINES.md §2, as the database enum names it. */
export const ACCESS_CODE_STATUSES = ['ACTIVE', 'ROTATED', 'REVOKED', 'EXPIRED'] as const;
export type AccessCodeStatus = (typeof ACCESS_CODE_STATUSES)[number];

/**
 * The audit event catalogue of ai/POLICY_AND_AUTHORIZATION.md §12, in its order. A unit test keeps
 * this list, the document and the migrations' enum identical (OPS-781).
 */
export const AUDIT_EVENT_TYPES = [
  'LISTING_CREATED',
  'LISTING_CONTENT_ENHANCED',
  'LISTING_CONTENT_APPROVED',
  'LISTING_ASKING_PRICE_CHANGED',
  'LISTING_STATUS_CHANGED',
  'SELLER_POLICY_CHANGED',
  'MINIMUM_PRICE_CHANGED',
  'ACCESS_CODE_CREATED',
  'ACCESS_CODE_ROTATED',
  'ACCESS_CODE_REVOKED',
  'BUYER_SESSION_CREATED',
  'OFFER_CREATED',
  'OFFER_CHANGED',
  'COUNTEROFFER_SENT',
  'SELLER_ACTION_REQUIRED',
  'SELLER_APPROVED',
  'SELLER_DECLINED',
  'SELLER_COUNTERED',
  'APPROVAL_INVALIDATED',
  'BUYER_ACCEPTANCE_COMMUNICATED',
  'DEAL_PENDING',
  'DEAL_CANCELLED',
  'LISTING_SOLD',
  'GUARDRAIL_DENIED',
  'ESCALATED_TO_SELLER',
] as const;
export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;

export interface SellerTable {
  id: string;
  display_name: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface InventoryItemTable {
  id: Generated<string>;
  seller_id: string;
  acquisition_cost_minor: number | null;
  acquisition_currency: string | null;
  acquisition_date: string | null;
  request_id: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ListingTable {
  id: Generated<string>;
  seller_id: string;
  inventory_item_id: string;
  status: ColumnType<ListingStatus, ListingStatus | undefined, ListingStatus>;
  asking_price_minor: number | null;
  currency: string | null;
  current_content_version_id: string | null;
  current_policy_version_id: string | null;
  row_version: Generated<number>;
  request_id: string;
  created_at: Generated<Date>;
  updated_at: Timestamp;
}

export interface ListingContentVersionTable {
  id: Generated<string>;
  seller_id: string;
  listing_id: string;
  version_number: number;
  status: ContentVersionStatus;
  provenance: ContentProvenance;
  title: string;
  summary: string | null;
  description: string | null;
  structured_details: JSONColumnType<Record<string, string>>;
  source_version_id: string | null;
  request_id: string;
  created_at: Generated<Date>;
  approved_at: Date | null;
  approved_by: string | null;
}

export interface ProductFactTable {
  id: Generated<string>;
  seller_id: string;
  listing_id: string;
  key: string;
  value: string;
  provenance: ContentProvenance;
  supplied_at: Generated<Date>;
  request_id: string;
}

export interface SellerPolicyVersionTable {
  id: Generated<string>;
  seller_id: string;
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
  request_id: string;
  created_at: Generated<Date>;
}

export interface AuditEventTable {
  id: Generated<string>;
  seq: Generated<number>;
  seller_id: string;
  event_type: AuditEventType;
  actor_type: AuditActorType;
  actor_ref: string | null;
  subject_type: string;
  subject_id: string;
  policy_version_id: string | null;
  request_id: string;
  idempotency_key: string | null;
  summary: JSONColumnType<Record<string, unknown>>;
  created_at: Generated<Date>;
}

/**
 * The idempotency store (OPS-730 to OPS-733, migration 0003): one receipt per key per seller with
 * the command's fingerprint and the outcome returned to the caller. `audit_event_id` is null when
 * the command was a valid no-op that changed nothing.
 */
export interface IdempotencyReceiptTable {
  seller_id: string;
  idempotency_key: string;
  command: string;
  fingerprint: string;
  subject_type: string;
  subject_id: string;
  outcome: JSONColumnType<Record<string, unknown>>;
  audit_event_id: string | null;
  request_id: string;
  created_at: Generated<Date>;
}

/** PublicListingAccess (migration 0004): the buyer-facing surface record and its opaque public id. */
export interface PublicListingAccessTable {
  id: Generated<string>;
  seller_id: string;
  listing_id: string;
  public_id: string;
  enabled: Generated<boolean>;
  row_version: Generated<number>;
  request_id: string;
  created_at: Generated<Date>;
  updated_at: Timestamp;
}

/** ListingAccessCode (migration 0004): a hashed code bound to one public access. No plaintext column exists. */
export interface ListingAccessCodeTable {
  id: Generated<string>;
  seller_id: string;
  public_access_id: string;
  version_number: number;
  status: ColumnType<AccessCodeStatus, AccessCodeStatus | undefined, AccessCodeStatus>;
  code_hash: string;
  issued_at: Generated<Date>;
  expires_at: Date | null;
  status_changed_at: Generated<Date>;
  request_id: string;
}

export interface Database {
  seller: SellerTable;
  inventory_item: InventoryItemTable;
  listing: ListingTable;
  listing_content_version: ListingContentVersionTable;
  product_fact: ProductFactTable;
  seller_policy_version: SellerPolicyVersionTable;
  audit_event: AuditEventTable;
  idempotency_receipt: IdempotencyReceiptTable;
  public_listing_access: PublicListingAccessTable;
  listing_access_code: ListingAccessCodeTable;
}
