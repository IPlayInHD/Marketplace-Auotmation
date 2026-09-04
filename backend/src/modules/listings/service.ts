import { z } from 'zod';
import type { TenantTransaction } from '../../db/kysely.ts';
import { LISTING_STATUSES, type ListingStatus } from '../../db/schema.ts';
import type { CommandContext, WriteContext } from '../../shared/command.ts';
import {
  ConcurrentModificationError,
  InvalidStateError,
  ListingNotReadyError,
  mapDatabaseError,
  NotFoundError,
  type ReadinessGap,
} from '../../shared/errors.ts';
import { parseBuyerOrigin } from '../../shared/buyer-url.ts';
import { MoneySchema, type Money } from '../../shared/money.ts';
import * as accessCodes from '../access-codes/index.ts';
import * as audit from '../audit/index.ts';
import * as content from '../listing-content/index.ts';
import * as marketplace from '../marketplace-abstractions/index.ts';
import * as publicAccess from '../public-listing-access/index.ts';
import * as policy from '../seller-policy/index.ts';
import * as sellers from '../sellers/index.ts';
import { isListingTransitionAllowed } from './lifecycle.ts';

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
  /** Database time of the latest entry to LISTED (INVENTORY_AND_SALES §3.2). */
  listedAt: Date | null;
  /** Database time of entry to SOLD, CANCELLED, ARCHIVED or EXPIRED; null while open or after a relist. */
  closedAt: Date | null;
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
  listed_at: Date | null;
  closed_at: Date | null;
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
    listedAt: row.listed_at,
    closedAt: row.closed_at,
  };
}

/**
 * A listing outcome as an idempotency receipt stores it and as a replay rebuilds it (OPS-731).
 * The stored form is the record itself with its timestamps as ISO strings; it carries no
 * protected value, and the receipt store's forbidden-key guard checks that on every write.
 */
const StoredListing = z.object({
  id: z.uuid(),
  sellerId: z.uuid(),
  inventoryItemId: z.uuid(),
  status: z.enum(LISTING_STATUSES),
  askingPrice: MoneySchema.nullable(),
  currentContentVersionId: z.uuid().nullable(),
  currentPolicyVersionId: z.uuid().nullable(),
  rowVersion: z.number().int(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  listedAt: z.coerce.date().nullable(),
  closedAt: z.coerce.date().nullable(),
});

function storeListing(listing: ListingRecord): Record<string, unknown> {
  return { listing };
}

function reviveListing(stored: Record<string, unknown>): ListingRecord {
  return StoredListing.parse(stored['listing']);
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

/** The listing with its row locked for the rest of the transaction, so concurrent publications serialise. */
async function getListingForUpdate(trx: TenantTransaction, listingId: string): Promise<ListingRecord> {
  const row = await trx
    .selectFrom('listing')
    .selectAll()
    .where('id', '=', listingId)
    .forUpdate()
    .executeTakeFirst();
  if (!row) throw new NotFoundError('listing');
  return toListing(row);
}

/** LIST-100: a listing starts in DRAFT (the data layer refuses any other start). */
export async function createListing(
  trx: TenantTransaction,
  ctx: CommandContext,
  input: { inventoryItemId: string },
): Promise<ListingRecord> {
  const outcome = await audit.runIdempotent<ListingRecord>(trx, ctx, {
    command: 'listing.create',
    payload: input,
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
    serialize: storeListing,
    revive: reviveListing,
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

function sameMoney(a: Money | null, b: Money): boolean {
  return a !== null && a.amountMinor === b.amountMinor && a.currency === b.currency;
}

/**
 * LIST-130: the seller sets the asking price; nothing suggests one (D-09). A change is a
 * consequential action, audited as LISTING_ASKING_PRICE_CHANGED under the seller's idempotency
 * key in the same transaction as the write (OPS-780, OPS-781, OPS-787). The previous and new
 * asking price are seller-published information (DATA_AND_PRIVACY §3.1, §8) and appear in the
 * payload; the minimum price never does.
 *
 * Submitting the price a DRAFT listing already carries is a successful no-op: no write, no
 * row_version change, no change event. It still consumes the key and stores its outcome, so a
 * retry returns that outcome whatever the listing looks like by then (OPS-731); the same key with
 * another price, or for another command, is a conflict (OPS-732).
 */
export async function setAskingPrice(
  trx: TenantTransaction,
  ctx: CommandContext,
  input: { listingId: string; price: Money; expectedRowVersion: number },
): Promise<ListingRecord> {
  const price = MoneySchema.parse(input.price);
  const outcome = await audit.runIdempotent<ListingRecord>(trx, ctx, {
    command: 'listing.set_asking_price',
    payload: { listingId: input.listingId, price, expectedRowVersion: input.expectedRowVersion },
    eventType: 'LISTING_ASKING_PRICE_CHANGED',
    subjectType: 'listing',
    run: async () => {
      const listing = await getListing(trx, input.listingId);
      requireStatus(listing, 'DRAFT', 'change its asking price');
      if (sameMoney(listing.askingPrice, price)) {
        return { value: listing, subjectId: listing.id, changed: false };
      }
      const updated = await updateListingRow(trx, ctx, listing.id, input.expectedRowVersion, {
        asking_price_minor: price.amountMinor,
        currency: price.currency,
      });
      return {
        value: updated,
        subjectId: updated.id,
        ...(updated.currentPolicyVersionId !== null
          ? { policyVersionId: updated.currentPolicyVersionId }
          : {}),
        summary: {
          previous_asking_price_minor: listing.askingPrice?.amountMinor ?? null,
          previous_currency: listing.askingPrice?.currency ?? null,
          asking_price_minor: price.amountMinor,
          currency: price.currency,
          row_version: updated.rowVersion,
        },
      };
    },
    serialize: storeListing,
    revive: reviveListing,
  });
  return outcome.value;
}

export interface ApproveContentResult {
  listing: ListingRecord;
  version: content.ContentVersionRecord;
}

/**
 * LIST-105 / LIST-108: the owning seller approves one content version; any previously approved
 * version is superseded in the same transaction (SM-CT-01, SM-CT-02). Audited as
 * LISTING_CONTENT_APPROVED under the seller's idempotency key. The receipt keeps the listing and
 * the version id; the approved words are immutable (SM-CT-04), so a replay reads them back.
 */
export async function approveContent(
  trx: TenantTransaction,
  ctx: CommandContext,
  input: { listingId: string; versionId: string; expectedRowVersion: number },
): Promise<ApproveContentResult> {
  const outcome = await audit.runIdempotent<ApproveContentResult>(trx, ctx, {
    command: 'listing.approve_content',
    payload: input,
    eventType: 'LISTING_CONTENT_APPROVED',
    subjectType: 'content_version',
    run: async () => {
      const listing = await getListing(trx, input.listingId);
      const version = await content.getVersion(trx, listing.id, input.versionId);
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
    serialize: ({ listing, version }) => ({ listing, versionId: version.id }),
    revive: async (stored) => {
      const listing = reviveListing(stored);
      const versionId = z.uuid().parse(stored['versionId']);
      return { listing, version: await content.getVersion(trx, listing.id, versionId) };
    },
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
 * carries the amount (OPS-569, OPS-783), and neither does the receipt: it keeps the listing and
 * the immutable policy version's id, which a replay reads back.
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
  let minimumChanged = false;
  const outcome = await audit.runIdempotent<SetPolicyResult>(trx, ctx, {
    command: 'listing.set_policy',
    payload: input,
    eventType: 'SELLER_POLICY_CHANGED',
    subjectType: 'listing',
    run: async () => {
      const listing = await getListing(trx, input.listingId);
      requireStatus(listing, 'DRAFT', 'change its policy');
      const previous =
        listing.currentPolicyVersionId === null
          ? undefined
          : await policy.getPolicyVersion(trx, listing.id, listing.currentPolicyVersionId);
      const created = await policy.createPolicyVersion(
        trx,
        ctx,
        { ...input.policy, listingId: listing.id },
        (previous?.versionNumber ?? 0) + 1,
      );
      minimumChanged =
        previous === undefined ||
        previous.minimumPrice.amountMinor !== created.minimumPrice.amountMinor ||
        previous.minimumPrice.currency !== created.minimumPrice.currency;
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
    serialize: ({ listing, policyVersion }) => ({ listing, policyVersionId: policyVersion.id }),
    revive: async (stored) => {
      const listing = reviveListing(stored);
      const policyVersionId = z.uuid().parse(stored['policyVersionId']);
      return { listing, policyVersion: await policy.getPolicyVersion(trx, listing.id, policyVersionId) };
    },
  });
  if (!outcome.replayed && minimumChanged) {
    const created = outcome.value.policyVersion;
    await audit.appendAuditEvent(trx, ctx.sellerId, {
      eventType: 'MINIMUM_PRICE_CHANGED',
      actorType: 'SELLER',
      actorRef: ctx.sellerId,
      subjectType: 'listing',
      subjectId: outcome.value.listing.id,
      policyVersionId: created.id,
      requestId: ctx.requestId,
      summary: { policy_version_number: created.versionNumber },
    });
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
  const outcome = await audit.runIdempotent<ListingRecord>(trx, ctx, {
    command: 'listing.mark_ready',
    payload: input,
    eventType: 'LISTING_STATUS_CHANGED',
    subjectType: 'listing',
    run: async () => {
      const listing = await getListing(trx, input.listingId);
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
    serialize: storeListing,
    revive: reviveListing,
  });
  return outcome.value;
}

/** STATE_MACHINES §1: READY → DRAFT when the seller edits (LIST-134 AC3). */
export async function revertToDraft(
  trx: TenantTransaction,
  ctx: CommandContext,
  input: { listingId: string; expectedRowVersion: number },
): Promise<ListingRecord> {
  const outcome = await audit.runIdempotent<ListingRecord>(trx, ctx, {
    command: 'listing.revert_to_draft',
    payload: input,
    eventType: 'LISTING_STATUS_CHANGED',
    subjectType: 'listing',
    run: async () => {
      const listing = await getListing(trx, input.listingId);
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
    serialize: storeListing,
    revive: reviveListing,
  });
  return outcome.value;
}

export interface MarkListedResult {
  listing: ListingRecord;
  access: publicAccess.PublicAccessRecord;
  /** The issued code. Its plaintext is present once, here; a replay returns it as null (ACCESS-013). */
  code: accessCodes.IssuedAccessCode;
  /**
   * The pasteable marketplace block (ACCESS-103), present only when a buyer origin was supplied
   * and the plaintext is available, so null on a replay. Never stored, logged or audited.
   */
  copyBlock: marketplace.MarketplaceCopyBlock | null;
}

/** Validates the caller-supplied origin up front; a malformed origin never reaches a key or a receipt. */
function normaliseBuyerOrigin(buyerOrigin: string | undefined): string | undefined {
  return buyerOrigin === undefined ? undefined : parseBuyerOrigin(buyerOrigin);
}

/** The copy block for a freshly issued code, from the buyer-safe projection only (SEC-020, DM-10). */
async function composeCopyBlock(
  trx: TenantTransaction,
  ctx: CommandContext,
  listing: ListingRecord,
  access: publicAccess.PublicAccessRecord,
  code: accessCodes.IssuedAccessCode,
  buyerOrigin: string | undefined,
): Promise<marketplace.MarketplaceCopyBlock | null> {
  if (buyerOrigin === undefined || code.plaintextCode === null || listing.askingPrice === null) return null;
  const approved = await content.getApprovedVersion(trx, listing.id);
  if (!approved) return null;
  const seller = await sellers.getSeller(trx, ctx.sellerId);
  const projection = publicAccess.buildBuyerSafeProjection({
    content: approved,
    askingPrice: listing.askingPrice,
    sellerDisplayName: seller.displayName,
  });
  return marketplace.buildMarketplaceCopyBlock({
    listing: projection,
    publicId: access.publicId,
    plaintextCode: code.plaintextCode,
    buyerOrigin,
  });
}

/** Opens the surface and issues the next code for a listing about to become LISTED (SM-L-02). */
async function openAccessAndIssue(
  trx: TenantTransaction,
  ctx: CommandContext,
  listing: ListingRecord,
): Promise<{ access: publicAccess.PublicAccessRecord; code: accessCodes.IssuedAccessCode }> {
  let access =
    (await publicAccess.findPublicAccessByListing(trx, listing.id)) ??
    (await publicAccess.createPublicAccess(trx, ctx, { listingId: listing.id }));
  if (!access.enabled) {
    access = await publicAccess.updatePublicAccess(trx, ctx, access.id, access.rowVersion, { enabled: true });
  }
  if (await accessCodes.findActiveAccessCode(trx, access.id)) {
    throw new InvalidStateError('access_code', 'ACTIVE', 'be issued while one is active (SM-C-01)');
  }
  const code = await accessCodes.issueCode(trx, ctx, {
    access,
    versionNumber: await accessCodes.nextVersionNumber(trx, access.id),
  });
  const policyVersionId = listing.currentPolicyVersionId ?? undefined;
  await audit.appendAuditEvent(trx, ctx.sellerId, {
    eventType: 'ACCESS_CODE_CREATED',
    actorType: 'SELLER',
    actorRef: ctx.sellerId,
    subjectType: 'listing_access_code',
    subjectId: code.id,
    ...(policyVersionId !== undefined ? { policyVersionId } : {}),
    requestId: ctx.requestId,
    summary: { public_access_id: access.id, listing_id: listing.id, version_number: code.versionNumber },
  });
  return { access, code };
}

const storePublished = ({ listing, access, code }: MarkListedResult): Record<string, unknown> => ({
  listing,
  access,
  issued: accessCodes.storeAccessCode(code),
});

const revivePublished = (stored: Record<string, unknown>): MarkListedResult => ({
  listing: reviveListing(stored),
  access: publicAccess.revivePublicAccess(stored['access']),
  code: accessCodes.reviveIssuedAccessCode(stored['issued']),
  copyBlock: null,
});

/**
 * SM-L-02, ACCESS-100: READY → LISTED with public access issued in the same transaction. The
 * listing row is locked first, so two publications of one listing serialise and the second is
 * refused by state. The access record is created (or, on a relist, re-enabled), the initial
 * ACTIVE code is issued and audited as ACCESS_CODE_CREATED, and only then does the listing become
 * LISTED, audited as LISTING_STATUS_CHANGED under the seller's key. The data layer independently
 * refuses LISTED without an enabled access and an ACTIVE code (LS005). Any failure leaves no
 * listing change, no access, no code, no event and no receipt (OPS-787).
 */
export async function markListed(
  trx: TenantTransaction,
  ctx: CommandContext,
  input: { listingId: string; expectedRowVersion: number; buyerOrigin?: string },
): Promise<MarkListedResult> {
  const buyerOrigin = normaliseBuyerOrigin(input.buyerOrigin);
  const outcome = await audit.runIdempotent<MarkListedResult>(trx, ctx, {
    command: 'listing.mark_listed',
    payload: { listingId: input.listingId, expectedRowVersion: input.expectedRowVersion, buyerOrigin },
    eventType: 'LISTING_STATUS_CHANGED',
    subjectType: 'listing',
    run: async () => {
      const listing = await getListingForUpdate(trx, input.listingId);
      requireStatus(listing, 'READY', 'become LISTED');
      if (listing.rowVersion !== input.expectedRowVersion) throw new ConcurrentModificationError('listing');
      const { access, code } = await openAccessAndIssue(trx, ctx, listing);
      const updated = await updateListingRow(trx, ctx, listing.id, input.expectedRowVersion, {
        status: 'LISTED',
      });
      const copyBlock = await composeCopyBlock(trx, ctx, updated, access, code, buyerOrigin);
      const policyVersionId = listing.currentPolicyVersionId ?? undefined;
      return {
        value: { listing: updated, access, code, copyBlock },
        subjectId: updated.id,
        ...(policyVersionId !== undefined ? { policyVersionId } : {}),
        summary: {
          from: 'READY',
          to: 'LISTED',
          row_version: updated.rowVersion,
          public_access_id: access.id,
        },
      };
    },
    serialize: storePublished,
    revive: revivePublished,
  });
  return outcome.value;
}

export interface CloseListingResult {
  listing: ListingRecord;
  /** The surface, now disabled; null when the listing never had one. */
  access: publicAccess.PublicAccessRecord | null;
  /** The code that was ACTIVE, now REVOKED (cancel) or EXPIRED (expiry); null when none was. */
  closed: accessCodes.AccessCodeRecord | null;
}

const storeClosed = ({ listing, access, closed }: CloseListingResult): Record<string, unknown> => ({
  listing,
  access,
  closed: closed === null ? null : accessCodes.storeAccessCode(closed),
});

const reviveClosed = (stored: Record<string, unknown>): CloseListingResult => ({
  listing: reviveListing(stored),
  access: stored['access'] === null ? null : publicAccess.revivePublicAccess(stored['access']),
  closed: stored['closed'] === null ? null : accessCodes.reviveAccessCode(stored['closed']),
});

/**
 * One closing transition (SM-L-02): the listing row is locked, the caller's version is asserted,
 * the surface is disabled and the ACTIVE code ended with the terminal status, then the listing
 * moves, all in one transaction. The data layer refuses the move while access is open (LS006).
 */
async function closeListing(
  trx: TenantTransaction,
  ctx: CommandContext,
  input: { listingId: string; expectedRowVersion: number },
  command: string,
  to: 'CANCELLED' | 'EXPIRED' | 'ARCHIVED',
  terminal: 'REVOKED' | 'EXPIRED',
): Promise<CloseListingResult> {
  const outcome = await audit.runIdempotent<CloseListingResult>(trx, ctx, {
    command,
    payload: input,
    eventType: 'LISTING_STATUS_CHANGED',
    subjectType: 'listing',
    run: async () => {
      const listing = await getListingForUpdate(trx, input.listingId);
      if (!isListingTransitionAllowed(listing.status, to)) {
        throw new InvalidStateError('listing', listing.status, `become ${to}`);
      }
      if (listing.rowVersion !== input.expectedRowVersion) throw new ConcurrentModificationError('listing');
      const policyVersionId = listing.currentPolicyVersionId ?? undefined;
      const existing = await publicAccess.findPublicAccessByListing(trx, listing.id);
      const closure = existing
        ? await accessCodes.closeAccess(trx, ctx, {
            access: existing,
            terminal,
            ...(policyVersionId !== undefined ? { policyVersionId } : {}),
          })
        : undefined;
      const updated = await updateListingRow(trx, ctx, listing.id, input.expectedRowVersion, { status: to });
      return {
        value: { listing: updated, access: closure?.access ?? null, closed: closure?.closed ?? null },
        subjectId: updated.id,
        ...(policyVersionId !== undefined ? { policyVersionId } : {}),
        summary: {
          from: listing.status,
          to,
          row_version: updated.rowVersion,
          public_access_id: closure?.access.id ?? null,
          ...(closure?.closed
            ? {
                access_terminal_status: closure.closed.status,
                access_version_number: closure.closed.versionNumber,
              }
            : {}),
        },
      };
    },
    serialize: storeClosed,
    revive: reviveClosed,
  });
  return outcome.value;
}

/**
 * STATE_MACHINES §1: LISTED, ACTIVE_CONVERSATIONS or OFFER_PENDING → CANCELLED (OPS-254: never
 * from PENDING_SALE). Closes the surface and REVOKES the ACTIVE code (ACCESS_CODE_REVOKED), then
 * moves the listing (LISTING_STATUS_CHANGED). Returns no plaintext. Buyer sessions do not exist
 * in this slice, so the UX-109 confirmation about live conversations is not here.
 */
export function cancelListing(
  trx: TenantTransaction,
  ctx: CommandContext,
  input: { listingId: string; expectedRowVersion: number },
): Promise<CloseListingResult> {
  return closeListing(trx, ctx, input, 'listing.cancel', 'CANCELLED', 'REVOKED');
}

/**
 * STATE_MACHINES §1: LISTED → EXPIRED, the optional expiry. An internal domain command with no
 * schedule: nothing in this slice decides when a listing expires, and no caller-supplied time is
 * trusted. The closing time is the database clock (closed_at). The ACTIVE code becomes EXPIRED
 * ("expiry reached", STATE_MACHINES §2); the catalogue has no code-expiry event, so the listing's
 * LISTING_STATUS_CHANGED event records the code's terminal status and version.
 */
export function expireListing(
  trx: TenantTransaction,
  ctx: CommandContext,
  input: { listingId: string; expectedRowVersion: number },
): Promise<CloseListingResult> {
  return closeListing(trx, ctx, input, 'listing.expire', 'EXPIRED', 'EXPIRED');
}

/**
 * OPS-224, STATE_MACHINES §1: CANCELLED → ARCHIVED (and SOLD → ARCHIVED once a sale can exist;
 * never from PENDING_SALE, OPS-228). The surface was closed on cancellation and the data layer
 * requires it still closed. Audited as LISTING_STATUS_CHANGED (OPS-310).
 */
export function archiveListing(
  trx: TenantTransaction,
  ctx: CommandContext,
  input: { listingId: string; expectedRowVersion: number },
): Promise<CloseListingResult> {
  return closeListing(trx, ctx, input, 'listing.archive', 'ARCHIVED', 'REVOKED');
}

/**
 * STATE_MACHINES §1, SM-L-06: EXPIRED → LISTED on the same listing. The SM-L-01 prerequisites are
 * revalidated in full (approved copy current, asking price, policy version, currency match, facts
 * backing every detail); the same public access is re-enabled, so the buyer URL is preserved
 * (BUYER-003, DM-09); a fresh code version is issued and audited as ACCESS_CODE_CREATED, and no
 * earlier code returns to ACTIVE. Relisting from CANCELLED is not drawn: per OPS-215 it is a new
 * listing on the same item through the ordinary DRAFT → READY → LISTED path. The plaintext code
 * and the copy block are present only on the first successful execution.
 */
export async function relistListing(
  trx: TenantTransaction,
  ctx: CommandContext,
  input: { listingId: string; expectedRowVersion: number; buyerOrigin?: string },
): Promise<MarkListedResult> {
  const buyerOrigin = normaliseBuyerOrigin(input.buyerOrigin);
  const outcome = await audit.runIdempotent<MarkListedResult>(trx, ctx, {
    command: 'listing.relist',
    payload: { listingId: input.listingId, expectedRowVersion: input.expectedRowVersion, buyerOrigin },
    eventType: 'LISTING_STATUS_CHANGED',
    subjectType: 'listing',
    run: async () => {
      const listing = await getListingForUpdate(trx, input.listingId);
      requireStatus(listing, 'EXPIRED', 'be relisted');
      if (listing.rowVersion !== input.expectedRowVersion) throw new ConcurrentModificationError('listing');
      const gaps = await readinessGaps(trx, listing);
      if (gaps.length > 0) throw new ListingNotReadyError(gaps);
      const { access, code } = await openAccessAndIssue(trx, ctx, listing);
      const updated = await updateListingRow(trx, ctx, listing.id, input.expectedRowVersion, {
        status: 'LISTED',
      });
      const copyBlock = await composeCopyBlock(trx, ctx, updated, access, code, buyerOrigin);
      const policyVersionId = listing.currentPolicyVersionId ?? undefined;
      return {
        value: { listing: updated, access, code, copyBlock },
        subjectId: updated.id,
        ...(policyVersionId !== undefined ? { policyVersionId } : {}),
        summary: {
          from: 'EXPIRED',
          to: 'LISTED',
          row_version: updated.rowVersion,
          public_access_id: access.id,
          access_version_number: code.versionNumber,
        },
      };
    },
    serialize: storePublished,
    revive: revivePublished,
  });
  return outcome.value;
}
