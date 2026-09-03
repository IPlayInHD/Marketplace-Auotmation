import { z } from 'zod';
import type { TenantTransaction } from '../../db/kysely.ts';
import type { ListingStatus } from '../../db/schema.ts';
import type { CommandContext, WriteContext } from '../../shared/command.ts';
import {
  ConcurrentModificationError,
  InvalidStateError,
  ListingNotReadyError,
  mapDatabaseError,
  NotFoundError,
  type ReadinessGap,
} from '../../shared/errors.ts';
import { MoneySchema, type Money } from '../../shared/money.ts';
import * as audit from '../audit/index.ts';
import * as content from '../listing-content/index.ts';
import * as policy from '../seller-policy/index.ts';

export interface InventoryItemRecord {
  id: string;
  sellerId: string;
  /** Seller-entered, P3. Never shown to a buyer (D-09 analytics rule, DATA_AND_PRIVACY §3.1). */
  acquisitionCost: Money | null;
  acquisitionDate: string | null;
  createdAt: Date;
}

export interface ListingRecord {
  id: string;
  sellerId: string;
  inventoryItemId: string;
  status: ListingStatus;
  askingPrice: Money | null;
  currentContentVersionId: string | null;
  currentPolicyVersionId: string | null;
  rowVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

interface ListingRow {
  id: string;
  seller_id: string;
  inventory_item_id: string;
  status: ListingStatus;
  asking_price_minor: number | null;
  currency: string | null;
  current_content_version_id: string | null;
  current_policy_version_id: string | null;
  row_version: number;
  created_at: Date;
  updated_at: Date;
}

function toListing(row: ListingRow): ListingRecord {
  return {
    id: row.id,
    sellerId: row.seller_id,
    inventoryItemId: row.inventory_item_id,
    status: row.status,
    askingPrice:
      row.asking_price_minor !== null && row.currency !== null
        ? { amountMinor: row.asking_price_minor, currency: row.currency }
        : null,
    currentContentVersionId: row.current_content_version_id,
    currentPolicyVersionId: row.current_policy_version_id,
    rowVersion: row.row_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const CreateInventoryItemInput = z.strictObject({
  acquisitionCost: MoneySchema.optional(),
  acquisitionDate: IsoDate.optional(),
});

export async function createInventoryItem(
  trx: TenantTransaction,
  ctx: WriteContext,
  input: z.input<typeof CreateInventoryItemInput> = {},
): Promise<InventoryItemRecord> {
  const valid = CreateInventoryItemInput.parse(input);
  const row = await trx
    .insertInto('inventory_item')
    .values({
      seller_id: ctx.sellerId,
      acquisition_cost_minor: valid.acquisitionCost?.amountMinor ?? null,
      acquisition_currency: valid.acquisitionCost?.currency ?? null,
      acquisition_date: valid.acquisitionDate ?? null,
      request_id: ctx.requestId,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return {
    id: row.id,
    sellerId: row.seller_id,
    acquisitionCost:
      row.acquisition_cost_minor !== null && row.acquisition_currency !== null
        ? { amountMinor: row.acquisition_cost_minor, currency: row.acquisition_currency }
        : null,
    acquisitionDate: row.acquisition_date,
    createdAt: row.created_at,
  };
}

async function findListing(trx: TenantTransaction, listingId: string): Promise<ListingRecord | undefined> {
  const row = await trx.selectFrom('listing').selectAll().where('id', '=', listingId).executeTakeFirst();
  return row ? toListing(row) : undefined;
}

/** AUTH-221: a listing of another tenant is indistinguishable from a listing that does not exist. */
export async function getListing(trx: TenantTransaction, listingId: string): Promise<ListingRecord> {
  const listing = await findListing(trx, listingId);
  if (!listing) throw new NotFoundError('listing');
  return listing;
}

/** LIST-100: a listing starts in DRAFT (the data layer refuses any other start). */
export async function createListing(
  trx: TenantTransaction,
  ctx: CommandContext,
  input: { inventoryItemId: string },
): Promise<ListingRecord> {
  const outcome = await audit.runIdempotent<ListingRecord>(trx, ctx, {
    eventType: 'LISTING_CREATED',
    subjectType: 'listing',
    run: async () => {
      try {
        const row = await trx
          .insertInto('listing')
          .values({
            seller_id: ctx.sellerId,
            inventory_item_id: z.uuid().parse(input.inventoryItemId),
            asking_price_minor: null,
            currency: null,
            current_content_version_id: null,
            current_policy_version_id: null,
            request_id: ctx.requestId,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        const listing = toListing(row);
        return { value: listing, subjectId: listing.id, summary: { status: listing.status } };
      } catch (err) {
        throw mapDatabaseError(err, 'listing');
      }
    },
    replay: (event) => getListing(trx, event.subjectId),
  });
  return outcome.value;
}

function requireStatus(listing: ListingRecord, expected: ListingStatus, attempted: string): void {
  if (listing.status !== expected) throw new InvalidStateError('listing', listing.status, attempted);
}

interface ListingPatch {
  status?: ListingStatus;
  asking_price_minor?: number | null;
  currency?: string | null;
  current_content_version_id?: string | null;
  current_policy_version_id?: string | null;
}

/**
 * The only write path to a listing row. Optimistic concurrency on row_version (OPS-738): the
 * update applies only if the row still carries the version the caller read, and the data-layer
 * guard independently requires the increment. Every write records its request id (OPS-720).
 */
async function updateListingRow(
  trx: TenantTransaction,
  ctx: WriteContext,
  listingId: string,
  expectedRowVersion: number,
  patch: ListingPatch,
): Promise<ListingRecord> {
  let row: ListingRow | undefined;
  try {
    row = await trx
      .updateTable('listing')
      .set({ ...patch, row_version: expectedRowVersion + 1, request_id: ctx.requestId })
      .where('id', '=', listingId)
      .where('row_version', '=', expectedRowVersion)
      .returningAll()
      .executeTakeFirst();
  } catch (err) {
    throw mapDatabaseError(err, 'listing');
  }
  if (row) return toListing(row);
  const current = await findListing(trx, listingId);
  if (!current) throw new NotFoundError('listing');
  throw new ConcurrentModificationError('listing');
}

/** LIST-130: the seller sets the asking price. Nothing suggests one (D-09). */
export async function setAskingPrice(
  trx: TenantTransaction,
  ctx: WriteContext,
  input: { listingId: string; price: Money; expectedRowVersion: number },
): Promise<ListingRecord> {
  const price = MoneySchema.parse(input.price);
  const listing = await getListing(trx, input.listingId);
  requireStatus(listing, 'DRAFT', 'change its asking price');
  return updateListingRow(trx, ctx, listing.id, input.expectedRowVersion, {
    asking_price_minor: price.amountMinor,
    currency: price.currency,
  });
}

export interface ApproveContentResult {
  listing: ListingRecord;
  version: content.ContentVersionRecord;
}

/**
 * LIST-105 / LIST-108: the owning seller approves one content version; any previously approved
 * version is superseded in the same transaction (SM-CT-01, SM-CT-02). Audited as
 * LISTING_CONTENT_APPROVED under the seller's idempotency key.
 */
export async function approveContent(
  trx: TenantTransaction,
  ctx: CommandContext,
  input: { listingId: string; versionId: string; expectedRowVersion: number },
): Promise<ApproveContentResult> {
  const listing = await getListing(trx, input.listingId);
  const version = await content.getVersion(trx, listing.id, input.versionId);
  const outcome = await audit.runIdempotent<ApproveContentResult>(trx, ctx, {
    eventType: 'LISTING_CONTENT_APPROVED',
    subjectType: 'content_version',
    subjectId: version.id,
    run: async () => {
      requireStatus(listing, 'DRAFT', 'approve content');
      if (version.status !== 'SELLER_DRAFT') {
        throw new InvalidStateError('content_version', version.status, 'be approved');
      }
      const supersededId = await content.supersedeApprovedVersion(trx, listing.id);
      const approved = await content.markApproved(trx, ctx, { listingId: listing.id, versionId: version.id });
      const updated = await updateListingRow(trx, ctx, listing.id, input.expectedRowVersion, {
        current_content_version_id: approved.id,
      });
      return {
        value: { listing: updated, version: approved },
        subjectId: approved.id,
        summary: {
          version_number: approved.versionNumber,
          superseded_version_id: supersededId ?? null,
        },
      };
    },
    replay: async (event) => ({
      listing: await getListing(trx, listing.id),
      version: await content.getVersion(trx, listing.id, event.subjectId),
    }),
  });
  return outcome.value;
}

export interface SetPolicyResult {
  listing: ListingRecord;
  policyVersion: policy.PolicyVersionRecord;
}

/**
 * LIST-131 / LIST-132: a new policy version carrying the minimum price and the negotiation rules
 * becomes the listing's current policy. Audited as SELLER_POLICY_CHANGED, plus
 * MINIMUM_PRICE_CHANGED when the minimum differs from the previous version's. Neither payload
 * carries the amount (OPS-569, OPS-783).
 */
export async function setPolicy(
  trx: TenantTransaction,
  ctx: CommandContext,
  input: {
    listingId: string;
    expectedRowVersion: number;
    policy: Omit<policy.PolicyVersionInput, 'listingId'>;
  },
): Promise<SetPolicyResult> {
  const listing = await getListing(trx, input.listingId);
  const previous =
    listing.currentPolicyVersionId === null
      ? undefined
      : await policy.getPolicyVersion(trx, listing.id, listing.currentPolicyVersionId);
  const outcome = await audit.runIdempotent<SetPolicyResult>(trx, ctx, {
    eventType: 'SELLER_POLICY_CHANGED',
    subjectType: 'listing',
    subjectId: listing.id,
    run: async () => {
      requireStatus(listing, 'DRAFT', 'change its policy');
      const created = await policy.createPolicyVersion(
        trx,
        ctx,
        { ...input.policy, listingId: listing.id },
        (previous?.versionNumber ?? 0) + 1,
      );
      const updated = await updateListingRow(trx, ctx, listing.id, input.expectedRowVersion, {
        current_policy_version_id: created.id,
      });
      return {
        value: { listing: updated, policyVersion: created },
        subjectId: listing.id,
        policyVersionId: created.id,
        summary: { policy_version_number: created.versionNumber },
      };
    },
    replay: async (event) => {
      const current = await getListing(trx, listing.id);
      if (event.policyVersionId === null) throw new NotFoundError('policy_version');
      return {
        listing: current,
        policyVersion: await policy.getPolicyVersion(trx, listing.id, event.policyVersionId),
      };
    },
  });
  if (!outcome.replayed) {
    const created = outcome.value.policyVersion;
    const minimumChanged =
      previous === undefined ||
      previous.minimumPrice.amountMinor !== created.minimumPrice.amountMinor ||
      previous.minimumPrice.currency !== created.minimumPrice.currency;
    if (minimumChanged) {
      await audit.appendAuditEvent(trx, ctx.sellerId, {
        eventType: 'MINIMUM_PRICE_CHANGED',
        actorType: 'SELLER',
        actorRef: ctx.sellerId,
        subjectType: 'listing',
        subjectId: listing.id,
        policyVersionId: created.id,
        requestId: ctx.requestId,
        summary: { policy_version_number: created.versionNumber },
      });
    }
  }
  return outcome.value;
}

/**
 * SM-L-01 as the application sees it, named gap by gap (LIST-134 AC1). The data-layer guard
 * evaluates the same conditions independently; this function exists so a refusal is explained
 * before the write is attempted.
 */
export async function readinessGaps(trx: TenantTransaction, listing: ListingRecord): Promise<ReadinessGap[]> {
  const gaps: ReadinessGap[] = [];
  if (listing.askingPrice === null) gaps.push('asking_price');

  const approved = await content.getApprovedVersion(trx, listing.id);
  if (!approved || approved.versionId !== listing.currentContentVersionId || approved.title.trim() === '') {
    gaps.push('approved_content');
  } else {
    const uncovered = await content.uncoveredDetailKeys(trx, listing.id, approved.versionId);
    if (uncovered.length > 0) gaps.push('seller_provided_facts');
  }

  if (listing.currentPolicyVersionId === null) {
    gaps.push('policy_version', 'minimum_price');
  } else {
    const current = await policy
      .getPolicyVersion(trx, listing.id, listing.currentPolicyVersionId)
      .catch(() => undefined);
    if (!current) gaps.push('policy_version', 'minimum_price');
    else if (listing.askingPrice !== null && current.minimumPrice.currency !== listing.askingPrice.currency) {
      gaps.push('currency_match');
    }
  }
  return gaps;
}

/**
 * LIST-134: DRAFT → READY. Refused, with the missing items named, unless approved copy, an asking
 * price, a minimum price and a policy version are all present (SM-L-01). The transition is
 * audited as LISTING_STATUS_CHANGED with the policy version in force.
 */
export async function markReady(
  trx: TenantTransaction,
  ctx: CommandContext,
  input: { listingId: string; expectedRowVersion: number },
): Promise<ListingRecord> {
  const listing = await getListing(trx, input.listingId);
  const outcome = await audit.runIdempotent<ListingRecord>(trx, ctx, {
    eventType: 'LISTING_STATUS_CHANGED',
    subjectType: 'listing',
    subjectId: listing.id,
    run: async () => {
      requireStatus(listing, 'DRAFT', 'become READY');
      const gaps = await readinessGaps(trx, listing);
      if (gaps.length > 0) throw new ListingNotReadyError(gaps);
      const updated = await updateListingRow(trx, ctx, listing.id, input.expectedRowVersion, {
        status: 'READY',
      });
      return {
        value: updated,
        subjectId: updated.id,
        ...(updated.currentPolicyVersionId !== null
          ? { policyVersionId: updated.currentPolicyVersionId }
          : {}),
        summary: { from: 'DRAFT', to: 'READY', row_version: updated.rowVersion },
      };
    },
    replay: () => getListing(trx, listing.id),
  });
  return outcome.value;
}

/** STATE_MACHINES §1: READY → DRAFT when the seller edits (LIST-134 AC3). */
export async function revertToDraft(
  trx: TenantTransaction,
  ctx: CommandContext,
  input: { listingId: string; expectedRowVersion: number },
): Promise<ListingRecord> {
  const listing = await getListing(trx, input.listingId);
  const outcome = await audit.runIdempotent<ListingRecord>(trx, ctx, {
    eventType: 'LISTING_STATUS_CHANGED',
    subjectType: 'listing',
    subjectId: listing.id,
    run: async () => {
      requireStatus(listing, 'READY', 'return to DRAFT');
      const updated = await updateListingRow(trx, ctx, listing.id, input.expectedRowVersion, {
        status: 'DRAFT',
      });
      return {
        value: updated,
        subjectId: updated.id,
        ...(updated.currentPolicyVersionId !== null
          ? { policyVersionId: updated.currentPolicyVersionId }
          : {}),
        summary: { from: 'READY', to: 'DRAFT', row_version: updated.rowVersion },
      };
    },
    replay: () => getListing(trx, listing.id),
  });
  return outcome.value;
}
