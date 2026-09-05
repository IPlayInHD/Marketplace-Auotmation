import type { FastifyPluginCallback, FastifyReply } from 'fastify';
import { z } from 'zod';
import type * as auth from '../../modules/identity-auth/index.ts';
import type * as content from '../../modules/listing-content/index.ts';
import * as listings from '../../modules/listings/index.ts';
import type * as policy from '../../modules/seller-policy/index.ts';
import { commandContext } from '../../shared/command.ts';
import { ValidationError } from '../../shared/errors.ts';
import { MoneySchema, type Money } from '../../shared/money.ts';
import { decodeCursor, encodeCursor, pageSizeSchema } from '../../shared/pagination.ts';
import type { RouteDeclaration } from '../authorization.ts';
import { provenToken, requiredIdempotencyKey } from './seller-request.ts';

// The authenticated seller listing surface: Slice 1e (create a listing, read it, set its asking
// price), Slice 1f under D-21 (replace its seller-provided facts, save a seller-authored draft,
// and read the workspace those two produce), Slice 1g (approve one seller draft as the single
// approved version, LIST-105 and LIST-108) and Slice 1h (state the private minimum price and the
// negotiation rules, LIST-131 and LIST-132, and move between DRAFT and READY, LIST-134) and Slice 1i
// (three read-only dashboard reads: enumerate the seller's listings, read the current private
// policy, read the immutable version history). Creation is the seller's one action of LIST-100 AC1,
// the composite command `listing.create_with_item` that creates the inventory item and its DRAFT
// listing in one transaction under one receipt; every other mutation is the HTTP form of one
// domain command each, and none of the routes changes a command's semantics. Identity comes from
// the session only (AUTH-220): every handler runs its command inside withSellerSession, the single
// route-to-tenant construction site, under forced row-level security. Another tenant's listing is
// exactly as absent as one that does not exist (AUTH-221). Nothing here lists, searches, deletes,
// publishes, uploads, enhances or exposes anything to a buyer; nothing approves on the seller's
// behalf, nothing rewrites a seller's words (LIST-006, D-12), and nothing computes, suggests or
// recommends any price: every amount is typed by the seller (D-09, LIST-130, LIST-131).

export interface SellerListingRoutesOptions {
  auth: auth.AuthService;
  cookieName: string;
}

const ListingParams = z.strictObject({ listingId: z.uuid() });
const ContentVersionParams = z.strictObject({ listingId: z.uuid(), contentVersionId: z.uuid() });

/**
 * Exactly the domain representation of `listing.approve_content` beyond the two identifiers in
 * the path: the row version the seller read. The seller submits no words, no facts, no status,
 * no provenance and no identity; the authenticated request is the approval (LIST-105).
 */
const ApproveContentBody = z.strictObject({ expectedRowVersion: z.number().int().min(1) });

/** Exactly the domain representation of a lifecycle transition the seller requests: the row version read. */
const TransitionBody = z.strictObject({ expectedRowVersion: z.number().int().min(1) });

/**
 * Exactly the domain representation of `listing.set_policy`: the row version read and the seller's
 * complete rule set, the private minimum acceptable price included. Every value is the seller's;
 * a target, suggested or asking price is refused here, as is any identity or status field.
 */
const SetPolicyBody = listings.SetPolicyInputSchema;

/**
 * The page-size contract of every list read (OPS-721): a plain decimal, default 20, clamped to
 * 100 rather than refused. Cursors are opaque, bounded and strictly validated before any query.
 */
const PageSize = pageSizeSchema(listings.LISTING_PAGE_DEFAULT, listings.LISTING_PAGE_MAX);
const CursorText = z.string().min(1).max(512);
/** Enumeration: an optional exact canonical status, the page size and the cursor. Nothing else. */
const ListListingsQuery = z.strictObject({
  status: z.enum(listings.LISTING_STATUSES).optional(),
  limit: PageSize,
  cursor: CursorText.optional(),
});
/** History: the page size and the cursor. Nothing else. */
const ContentHistoryQuery = z.strictObject({ limit: PageSize, cursor: CursorText.optional() });
/** The policy read takes no query at all; any parameter is refused. */
const NoQuery = z.strictObject({});
/**
 * A listing-page cursor binds the filter it was issued under, so a page cannot continue a
 * different enumeration; the tenant is never inside it, since the session bounds every page.
 */
const ListingCursor = z.strictObject({
  v: z.literal(1),
  kind: z.literal('listings'),
  status: z.enum(listings.LISTING_STATUSES).nullable(),
  position: listings.ListingPositionSchema,
});
/** A history cursor binds the listing it pages, and the version number it continues below. */
const ContentCursor = z.strictObject({
  v: z.literal(1),
  kind: z.literal('content_versions'),
  listingId: z.uuid(),
  below: z.number().int().min(1),
});

/**
 * Exactly the seller-supplied inventory facts the composite creation command accepts (LIST-100
 * AC1): optional acquisition cost and date, both blank when unknown. The inventory item's
 * identifier is generated by the server and is never accepted from the client.
 */
const CreateListingBody = listings.CreateListingWithItemInputSchema;

/** Exactly the domain representation of `listing.set_asking_price`: optimistic version and Money. */
const AskingPriceBody = z.strictObject({
  expectedRowVersion: z.number().int().min(1),
  price: MoneySchema,
});

/** Exactly the domain representation of `listing.replace_facts`: optimistic version and the complete fact statement. */
const ReplaceFactsBody = listings.ReplaceFactsInputSchema;

/** Exactly the domain representation of `listing.save_seller_draft`: optimistic version, predecessor and the seller's copy. */
const SaveDraftBody = listings.SaveSellerDraftInputSchema;

/**
 * The canonical maxima of one statement (eleven facts of up to 2000 characters) or one draft (a
 * title, a summary of 1000, a description of 10 000 and the details) exceed the process-wide
 * 16 KiB body limit once encoded, so the two consequential routes carry their own bound. It is
 * still a fixed bound (OPS-798): the schemas above refuse anything beyond the canonical lengths.
 */
const COPY_BODY_LIMIT = 256 * 1024;

/** The seller-safe view of a listing: no seller, account, session, policy, receipt or audit identifier. */
export interface SellerListingView {
  id: string;
  inventoryItemId: string;
  status: listings.ListingRecord['status'];
  askingPrice: Money | null;
  rowVersion: number;
  createdAt: Date;
  updatedAt: Date;
  listedAt: Date | null;
  closedAt: Date | null;
}

export function presentListing(listing: listings.ListingRecord): SellerListingView {
  return {
    id: listing.id,
    inventoryItemId: listing.inventoryItemId,
    status: listing.status,
    askingPrice: listing.askingPrice,
    rowVersion: listing.rowVersion,
    createdAt: listing.createdAt,
    updatedAt: listing.updatedAt,
    listedAt: listing.listedAt,
    closedAt: listing.closedAt,
  };
}

/** One seller-provided fact as the seller reads it back: the value, its provenance and when it was stated. */
export interface SellerFactView {
  value: string;
  provenance: content.ProductFactRecord['provenance'];
  suppliedAt: Date;
}

/**
 * The seller-provided facts keyed by canonical fact key. A key the seller has not stated is absent,
 * which is the canonical unknown state (LIST-033, D-10): never null, zero, false or placeholder text.
 */
export type SellerFactsView = Partial<Record<content.ProductFactKey, SellerFactView>>;

export function presentFacts(facts: readonly content.ProductFactRecord[]): SellerFactsView {
  const view: SellerFactsView = {};
  for (const fact of facts) {
    view[fact.key] = { value: fact.value, provenance: fact.provenance, suppliedAt: fact.suppliedAt };
  }
  return view;
}

/**
 * The seller's view of a content version: its words exactly as stored, its number, status and
 * provenance, and the predecessor it revises. No approver identifier: that is the seller id.
 */
export interface SellerDraftView {
  id: string;
  versionNumber: number;
  status: content.ContentVersionRecord['status'];
  provenance: content.ContentVersionRecord['provenance'];
  title: string;
  summary: string | null;
  description: string | null;
  structuredDetails: Record<string, string>;
  sourceVersionId: string | null;
  createdAt: Date;
  approvedAt: Date | null;
}

export function presentDraft(version: content.ContentVersionRecord): SellerDraftView {
  return {
    id: version.id,
    versionNumber: version.versionNumber,
    status: version.status,
    provenance: version.provenance,
    title: version.title,
    summary: version.summary,
    description: version.description,
    structuredDetails: version.structuredDetails,
    sourceVersionId: version.sourceVersionId,
    createdAt: version.createdAt,
    approvedAt: version.approvedAt,
  };
}

/**
 * The approved version as the seller reads it back from an approval: identifiers, number, status,
 * provenance, lineage and the approval time. No words (the workspace carries them) and no approver
 * identifier (that is the seller id).
 */
export interface ApprovedContentVersionView {
  id: string;
  versionNumber: number;
  status: content.ContentVersionRecord['status'];
  provenance: content.ContentVersionRecord['provenance'];
  sourceVersionId: string | null;
  approvedAt: Date | null;
}

export function presentApprovedVersion(version: content.ContentVersionRecord): ApprovedContentVersionView {
  return {
    id: version.id,
    versionNumber: version.versionNumber,
    status: version.status,
    provenance: version.provenance,
    sourceVersionId: version.sourceVersionId,
    approvedAt: version.approvedAt,
  };
}

/**
 * The seller's own policy version as the seller reads it back from the policy route, and only
 * there (LIST-133 AC3: shown to the seller, labelled as never shared with buyers). The minimum
 * price is protected (P3, D-04): it is never part of the listing view, the workspace, a buyer
 * projection, a log or an audit payload.
 */
export interface SellerPolicyView {
  id: string;
  versionNumber: number;
  minimumPrice: Money;
  negotiationEnabled: boolean;
  maxAutonomousConcession: Money | null;
  tradesAllowed: boolean;
  deliveryAllowed: boolean;
  pickupAllowed: boolean;
  locationDisclosureMode: policy.PolicyVersionRecord['locationDisclosureMode'];
  holdWindowSeconds: number | null;
  createdAt: Date;
}

export function presentPolicy(version: policy.PolicyVersionRecord): SellerPolicyView {
  return {
    id: version.id,
    versionNumber: version.versionNumber,
    minimumPrice: version.minimumPrice,
    negotiationEnabled: version.negotiationEnabled,
    maxAutonomousConcession: version.maxAutonomousConcession,
    tradesAllowed: version.tradesAllowed,
    deliveryAllowed: version.deliveryAllowed,
    pickupAllowed: version.pickupAllowed,
    locationDisclosureMode: version.locationDisclosureMode,
    holdWindowSeconds: version.holdWindowSeconds,
    createdAt: version.createdAt,
  };
}

/** The canonical AUTH-222 declarations of the listing routes, mirrored in the README inventory. */
export const SELLER_LISTING_DECLARATIONS = {
  create: {
    actor: 'seller',
    resource: 'listing',
    action: 'create',
    authentication: 'seller-session',
    authorization:
      'the live session names the tenant; the inventory item and its DRAFT listing are created for that tenant in one transaction, the item identifier generated by the server and never accepted from the client',
    tenantSource: 'session',
    classification: 'consequential',
    idempotency:
      'Idempotency-Key required (client UUID); one command and one receipt for both records; exact replay returns the same listing and inventory item identifiers without a second row, event or receipt',
    audit: 'LISTING_CREATED with the generated inventory item identifier, in the same transaction',
    failure:
      '401 unauthenticated; 403 forbidden_origin or forbidden_anti_forgery; 400 bad_request or idempotency_key_required; 409 idempotency_conflict',
  },
  read: {
    actor: 'seller',
    resource: 'listing',
    action: 'read_workspace',
    authentication: 'seller-session',
    authorization:
      'the live session names the tenant; row-level security hides every other tenant, so their listings, facts and versions are not found',
    tenantSource: 'session',
    classification: 'read-only',
    idempotency: 'none; no Idempotency-Key',
    audit: 'none',
    failure: '401 unauthenticated; 400 bad_request for a malformed identifier; 404 not_found',
  },
  setAskingPrice: {
    actor: 'seller',
    resource: 'listing',
    action: 'set_asking_price',
    authentication: 'seller-session',
    authorization:
      'the live session names the tenant; the listing must be DRAFT and carry the expected row version',
    tenantSource: 'session',
    classification: 'consequential',
    idempotency:
      'Idempotency-Key required (client UUID); exact replay returns the stored outcome; the current price resubmitted is a no-op that still consumes the key',
    audit: 'LISTING_ASKING_PRICE_CHANGED on change, in the same transaction; none for the no-op',
    failure:
      '401 unauthenticated; 403 forbidden_origin or forbidden_anti_forgery; 400 bad_request or idempotency_key_required; 404 not_found; 409 invalid_state, stale_row_version or idempotency_conflict',
  },
  replaceFacts: {
    actor: 'seller',
    resource: 'listing',
    action: 'replace_facts',
    authentication: 'seller-session',
    authorization:
      'the live session names the tenant; the listing must be DRAFT or EXPIRED and carry the expected row version; the statement replaces the seller-provided facts in full, omitted keys returning to unknown (D-21)',
    tenantSource: 'session',
    classification: 'consequential',
    idempotency:
      'Idempotency-Key required (client UUID); exact replay returns the stored listing byte for byte and never reads the current facts; an identical statement is a no-op that still consumes the key',
    audit:
      'LISTING_FACTS_CHANGED on change with the sorted keys set and cleared, their counts and both row versions, never a value, in the same transaction; none for the no-op',
    failure:
      '401 unauthenticated; 403 forbidden_origin or forbidden_anti_forgery; 400 bad_request or idempotency_key_required; 404 not_found; 409 invalid_state, stale_row_version or idempotency_conflict',
  },
  saveDraft: {
    actor: 'seller',
    resource: 'listing',
    action: 'save_seller_draft',
    authentication: 'seller-session',
    authorization:
      'the live session names the tenant; the listing must be DRAFT or EXPIRED and carry the expected row version; the cited predecessor must be the latest content version, or null before the first; every structured detail must be a recorded seller fact (D-21, INV-12)',
    tenantSource: 'session',
    classification: 'consequential',
    idempotency:
      'Idempotency-Key required (client UUID); exact replay returns the stored listing and re-reads the exact immutable version it names, never the latest; in DRAFT copy identical to the predecessor is a no-op that still consumes the key; in EXPIRED every valid save creates a version (SM-L-06)',
    audit:
      'LISTING_CONTENT_DRAFTED on change with the new version identifier and number, the predecessor identifier when present and both row versions, never a word of copy, in the same transaction; none for the no-op',
    failure:
      '401 unauthenticated; 403 forbidden_origin or forbidden_anti_forgery; 400 bad_request or idempotency_key_required; 404 not_found; 409 invalid_state, stale_row_version or idempotency_conflict',
  },
  approveContent: {
    actor: 'seller',
    resource: 'listing_content_version',
    action: 'approve',
    authentication: 'seller-session',
    authorization:
      'the live session names the tenant; the listing and the version must both belong to it, the listing DRAFT or EXPIRED and carrying the expected row version, the version a SELLER_DRAFT of that listing; the authenticated request is the seller’s explicit approval and nothing is approved on their behalf (LIST-105, LIST-108, AUTH-INV-04)',
    tenantSource: 'session',
    classification: 'consequential',
    idempotency:
      'Idempotency-Key required (client UUID); exact replay returns the stored listing and the stored approval marks of the exact version the receipt names, reading only its immutable words, never the latest version; a version already approved or superseded is refused under a new key',
    audit:
      'LISTING_CONTENT_APPROVED with the version number and the superseded version identifier, in the same transaction as the supersession, the approval marks and the listing update; no status event, because approval performs no listing transition',
    failure:
      '401 unauthenticated; 403 forbidden_origin or forbidden_anti_forgery; 400 bad_request or idempotency_key_required; 404 not_found; 409 invalid_state, stale_row_version or idempotency_conflict',
  },
  setPolicy: {
    actor: 'seller',
    resource: 'seller_policy_version',
    action: 'set_policy',
    authentication: 'seller-session',
    authorization:
      'the live session names the tenant; the listing must be DRAFT and carry the expected row version; the body is the seller-entered private minimum acceptable price and the negotiation rules, appended as a new immutable policy version and bound as the listing’s current one; nothing estimates, suggests or recommends a price (D-09, LIST-131, LIST-132)',
    tenantSource: 'session',
    classification: 'consequential',
    idempotency:
      'Idempotency-Key required (client UUID); exact replay returns the stored listing and re-reads the immutable policy version the receipt names; every valid statement appends a version',
    audit:
      'SELLER_POLICY_CHANGED with the policy version number, plus MINIMUM_PRICE_CHANGED when the minimum differs from the previous version, in the same transaction; neither carries an amount (D-04, OPS-569)',
    failure:
      '401 unauthenticated; 403 forbidden_origin or forbidden_anti_forgery; 400 bad_request or idempotency_key_required; 404 not_found; 409 invalid_state, stale_row_version or idempotency_conflict',
  },
  markReady: {
    actor: 'seller',
    resource: 'listing',
    action: 'mark_ready',
    authentication: 'seller-session',
    authorization:
      'the live session names the tenant; the listing must be DRAFT, carry the expected row version and satisfy every SM-L-01 prerequisite re-checked under the row lock: approved seller copy backed by seller facts, an asking price, and a current policy version carrying the seller’s minimum price in the same currency; the policy version bound is the listing’s current one, never chosen by the client',
    tenantSource: 'session',
    classification: 'consequential',
    idempotency:
      'Idempotency-Key required (client UUID); exact replay returns the stored listing as it was when READY was entered, whatever the listing has become since; a failed attempt consumes nothing',
    audit:
      'LISTING_STATUS_CHANGED from DRAFT to READY with the row version and the policy version in force, in the same transaction; no access code, publication or buyer record',
    failure:
      '401 unauthenticated; 403 forbidden_origin or forbidden_anti_forgery; 400 bad_request or idempotency_key_required; 404 not_found; 409 invalid_state naming the missing SM-L-01 prerequisites by fixed gap name, stale_row_version or idempotency_conflict',
  },
  revertToDraft: {
    actor: 'seller',
    resource: 'listing',
    action: 'revert_to_draft',
    authentication: 'seller-session',
    authorization:
      'the live session names the tenant; the listing must be READY and carry the expected row version; only the status moves, and the approved content, prices, policy version and facts all stand',
    tenantSource: 'session',
    classification: 'consequential',
    idempotency:
      'Idempotency-Key required (client UUID); exact replay returns the stored listing as it was when DRAFT was re-entered, whatever the listing has become since',
    audit:
      'LISTING_STATUS_CHANGED from READY to DRAFT with the row version and the policy version in force, in the same transaction',
    failure:
      '401 unauthenticated; 403 forbidden_origin or forbidden_anti_forgery; 400 bad_request or idempotency_key_required; 404 not_found; 409 invalid_state, stale_row_version or idempotency_conflict',
  },
  listListings: {
    actor: 'seller',
    resource: 'listing',
    action: 'list',
    authentication: 'seller-session',
    authorization:
      'the live session names the tenant; row-level security bounds every page to that tenant, whatever cursor or filter is presented, so no other seller’s listing is ever enumerated',
    tenantSource: 'session',
    classification: 'read-only',
    idempotency: 'none; no Idempotency-Key',
    audit: 'none',
    failure:
      '401 unauthenticated; 400 bad_request for an unknown query parameter, a malformed status, page size or cursor, or a cursor issued under another filter',
  },
  readPolicy: {
    actor: 'seller',
    resource: 'seller_policy_version',
    action: 'read_current_policy',
    authentication: 'seller-session',
    authorization:
      'the live session names the tenant; the listing must be the tenant’s own, or it is not found; the answer is the bound immutable policy version the seller entered, the private minimum included (LIST-133 AC3), or null when none is bound; nothing is computed, suggested or recommended',
    tenantSource: 'session',
    classification: 'read-only',
    idempotency: 'none; no Idempotency-Key',
    audit: 'none',
    failure: '401 unauthenticated; 400 bad_request for a malformed identifier; 404 not_found',
  },
  readContentHistory: {
    actor: 'seller',
    resource: 'listing_content_version',
    action: 'read_history',
    authentication: 'seller-session',
    authorization:
      'the live session names the tenant; the listing must be the tenant’s own, or it is not found; every immutable version is returned with its words, status, provenance and lineage, and no approver, tenant, audit, receipt or policy datum; reading moves nothing',
    tenantSource: 'session',
    classification: 'read-only',
    idempotency: 'none; no Idempotency-Key',
    audit: 'none',
    failure:
      '401 unauthenticated; 400 bad_request for a malformed identifier, page size or cursor, or a cursor issued for another listing; 404 not_found',
  },
} as const satisfies Record<string, RouteDeclaration>;

export function registerSellerListingRoutes(
  app: Parameters<FastifyPluginCallback>[0],
  options: SellerListingRoutesOptions,
): void {
  const { cookieName } = options;

  app.post(
    '/listings',
    { config: { authorization: 'seller-session', declaration: SELLER_LISTING_DECLARATIONS.create } },
    async (request, reply) => {
      const token = provenToken(request, cookieName);
      const key = requiredIdempotencyKey(request);
      const body = CreateListingBody.parse(request.body);
      const listing = await options.auth.withSellerSession(token, (trx, principal) =>
        listings.createListingWithItem(
          trx,
          commandContext({ sellerId: principal.sellerId, requestId: request.id, idempotencyKey: key }),
          body,
        ),
      );
      return reply.code(201).send({ listing: presentListing(listing) });
    },
  );

  // The seller workspace (LIST-100 AC3): the listing, its seller-provided facts and its latest
  // content version, read under the session's tenant with no key, no event and no receipt.
  app.get(
    '/listings/:listingId',
    { config: { authorization: 'seller-session', declaration: SELLER_LISTING_DECLARATIONS.read } },
    async (request, reply) => {
      const token = provenToken(request, cookieName);
      const params = ListingParams.parse(request.params);
      const workspace = await options.auth.withSellerSession(token, (trx) =>
        listings.getListingWorkspace(trx, params.listingId),
      );
      return reply.code(200).send({
        listing: presentListing(workspace.listing),
        facts: presentFacts(workspace.facts),
        draft: workspace.draft === null ? null : presentDraft(workspace.draft),
      });
    },
  );

  app.patch(
    '/listings/:listingId/asking-price',
    {
      config: { authorization: 'seller-session', declaration: SELLER_LISTING_DECLARATIONS.setAskingPrice },
    },
    async (request, reply) => {
      const token = provenToken(request, cookieName);
      const key = requiredIdempotencyKey(request);
      const params = ListingParams.parse(request.params);
      const body = AskingPriceBody.parse(request.body);
      const listing = await options.auth.withSellerSession(token, (trx, principal) =>
        listings.setAskingPrice(
          trx,
          commandContext({ sellerId: principal.sellerId, requestId: request.id, idempotencyKey: key }),
          { listingId: params.listingId, price: body.price, expectedRowVersion: body.expectedRowVersion },
        ),
      );
      return reply.code(200).send({ listing: presentListing(listing) });
    },
  );

  // PUT: the body is the seller's complete statement of the facts (D-21 rule 7), so the resource
  // after the request is exactly the body, whatever it held before. The answer is the listing.
  app.put(
    '/listings/:listingId/facts',
    {
      bodyLimit: COPY_BODY_LIMIT,
      config: { authorization: 'seller-session', declaration: SELLER_LISTING_DECLARATIONS.replaceFacts },
    },
    async (request, reply) => {
      const token = provenToken(request, cookieName);
      const key = requiredIdempotencyKey(request);
      const params = ListingParams.parse(request.params);
      const body = ReplaceFactsBody.parse(request.body);
      const listing = await options.auth.withSellerSession(token, (trx, principal) =>
        listings.replaceFacts(
          trx,
          commandContext({ sellerId: principal.sellerId, requestId: request.id, idempotencyKey: key }),
          { listingId: params.listingId, expectedRowVersion: body.expectedRowVersion, facts: body.facts },
        ),
      );
      // The stable listing outcome only (D-21 correction): facts are mutable, so the response, the
      // receipt and every replay carry none; the workspace GET is where the current facts are read.
      return reply.code(200).send({ listing: presentListing(listing) });
    },
  );

  // PUT: the body is the seller's complete current copy; the domain appends an immutable version
  // for it (DM-06) rather than editing one, and answers with the version that now carries it.
  app.put(
    '/listings/:listingId/draft',
    {
      bodyLimit: COPY_BODY_LIMIT,
      config: { authorization: 'seller-session', declaration: SELLER_LISTING_DECLARATIONS.saveDraft },
    },
    async (request, reply) => {
      const token = provenToken(request, cookieName);
      const key = requiredIdempotencyKey(request);
      const params = ListingParams.parse(request.params);
      const body = SaveDraftBody.parse(request.body);
      const result = await options.auth.withSellerSession(token, (trx, principal) =>
        listings.saveSellerDraft(
          trx,
          commandContext({ sellerId: principal.sellerId, requestId: request.id, idempotencyKey: key }),
          { listingId: params.listingId, ...body },
        ),
      );
      return reply
        .code(200)
        .send({ listing: presentListing(result.listing), draft: presentDraft(result.version) });
    },
  );

  // POST: the seller's explicit approval of one immutable version (LIST-105, LIST-108). The
  // version comes from the path and must be a SELLER_DRAFT of this tenant's listing; the domain
  // supersedes the previous approved version, marks this one approved and advances the listing row
  // in one transaction, and performs no listing transition, publication or relist.
  app.post(
    '/listings/:listingId/content/:contentVersionId/approve',
    {
      config: { authorization: 'seller-session', declaration: SELLER_LISTING_DECLARATIONS.approveContent },
    },
    async (request, reply) => {
      const token = provenToken(request, cookieName);
      const key = requiredIdempotencyKey(request);
      const params = ContentVersionParams.parse(request.params);
      const body = ApproveContentBody.parse(request.body);
      const result = await options.auth.withSellerSession(token, (trx, principal) =>
        listings.approveContent(
          trx,
          commandContext({ sellerId: principal.sellerId, requestId: request.id, idempotencyKey: key }),
          {
            listingId: params.listingId,
            versionId: params.contentVersionId,
            expectedRowVersion: body.expectedRowVersion,
          },
        ),
      );
      return reply.code(200).send({
        listing: presentListing(result.listing),
        approvedContentVersion: presentApprovedVersion(result.version),
      });
    },
  );

  // PUT: the body is the seller's complete rule set (LIST-131, LIST-132); the domain appends an
  // immutable policy version (DM-06) and binds it as the listing's current one. The minimum price
  // in the answer is the seller's own read-back (LIST-133 AC3) and travels nowhere else.
  app.put(
    '/listings/:listingId/policy',
    { config: { authorization: 'seller-session', declaration: SELLER_LISTING_DECLARATIONS.setPolicy } },
    async (request, reply) => {
      const token = provenToken(request, cookieName);
      const key = requiredIdempotencyKey(request);
      const params = ListingParams.parse(request.params);
      const { expectedRowVersion, ...rules } = SetPolicyBody.parse(request.body);
      const result = await options.auth.withSellerSession(token, (trx, principal) =>
        listings.setPolicy(
          trx,
          commandContext({ sellerId: principal.sellerId, requestId: request.id, idempotencyKey: key }),
          { listingId: params.listingId, expectedRowVersion, policy: rules },
        ),
      );
      return reply.code(200).send({
        listing: presentListing(result.listing),
        policyVersion: presentPolicy(result.policyVersion),
      });
    },
  );

  // POST: the seller declares the listing finished (LIST-134). The domain re-checks SM-L-01 under
  // the row lock and refuses with the missing prerequisites named; success issues no access code.
  app.post(
    '/listings/:listingId/ready',
    { config: { authorization: 'seller-session', declaration: SELLER_LISTING_DECLARATIONS.markReady } },
    async (request, reply) => {
      const token = provenToken(request, cookieName);
      const key = requiredIdempotencyKey(request);
      const params = ListingParams.parse(request.params);
      const body = TransitionBody.parse(request.body);
      const listing = await options.auth.withSellerSession(token, (trx, principal) =>
        listings.markReady(
          trx,
          commandContext({ sellerId: principal.sellerId, requestId: request.id, idempotencyKey: key }),
          { listingId: params.listingId, expectedRowVersion: body.expectedRowVersion },
        ),
      );
      return reply.code(200).send({ listing: presentListing(listing) });
    },
  );

  // POST: the seller reopens a READY listing for editing (LIST-134 AC3, STATE_MACHINES §1).
  app.post(
    '/listings/:listingId/revert-to-draft',
    {
      config: { authorization: 'seller-session', declaration: SELLER_LISTING_DECLARATIONS.revertToDraft },
    },
    async (request, reply) => {
      const token = provenToken(request, cookieName);
      const key = requiredIdempotencyKey(request);
      const params = ListingParams.parse(request.params);
      const body = TransitionBody.parse(request.body);
      const listing = await options.auth.withSellerSession(token, (trx, principal) =>
        listings.revertToDraft(
          trx,
          commandContext({ sellerId: principal.sellerId, requestId: request.id, idempotencyKey: key }),
          { listingId: params.listingId, expectedRowVersion: body.expectedRowVersion },
        ),
      );
      return reply.code(200).send({ listing: presentListing(listing) });
    },
  );
  // Slice 1i: three read-only dashboard reads. No key, no receipt, no event, no state change; a
  // private answer that no shared cache may store (`Cache-Control: no-store`). Each runs inside
  // withSellerSession under forced row-level security, so a foreign listing is not found.
  const privateRead = (reply: FastifyReply) => reply.code(200).header('cache-control', 'no-store');

  // GET: the seller's own listings, newest first, in fixed pages (OPS-721). The seller-safe
  // listing view only: no minimum, no words, no facts, no policy, no cost.
  app.get(
    '/listings',
    { config: { authorization: 'seller-session', declaration: SELLER_LISTING_DECLARATIONS.listListings } },
    async (request, reply) => {
      const token = provenToken(request, cookieName);
      const query = ListListingsQuery.parse(request.query);
      const status = query.status ?? null;
      let after: listings.ListingPosition | undefined;
      if (query.cursor !== undefined) {
        const cursor = decodeCursor(ListingCursor, query.cursor);
        if (cursor.status !== status) throw new ValidationError('cursor');
        after = cursor.position;
      }
      const page = await options.auth.withSellerSession(token, (trx) =>
        listings.listListings(trx, {
          limit: query.limit,
          ...(status === null ? {} : { status }),
          ...(after === undefined ? {} : { after }),
        }),
      );
      return privateRead(reply).send({
        listings: page.listings.map(presentListing),
        nextCursor:
          page.next === null ? null : encodeCursor({ v: 1, kind: 'listings', status, position: page.next }),
      });
    },
  );

  // GET: the current private policy, to its owner only (LIST-133 AC3), in exactly the shape the
  // PUT answers; null while no version is bound. Never a computed or suggested value.
  app.get(
    '/listings/:listingId/policy',
    { config: { authorization: 'seller-session', declaration: SELLER_LISTING_DECLARATIONS.readPolicy } },
    async (request, reply) => {
      const token = provenToken(request, cookieName);
      const params = ListingParams.parse(request.params);
      NoQuery.parse(request.query);
      const current = await options.auth.withSellerSession(token, (trx) =>
        listings.getCurrentPolicy(trx, params.listingId),
      );
      return privateRead(reply).send({
        listing: presentListing(current.listing),
        policyVersion: current.policyVersion === null ? null : presentPolicy(current.policyVersion),
      });
    },
  );

  // GET: the immutable version history, newest first, in fixed pages; each entry is the seller's
  // view of a content version (words, status, provenance, lineage, times; no approver identifier).
  app.get(
    '/listings/:listingId/content-versions',
    {
      config: {
        authorization: 'seller-session',
        declaration: SELLER_LISTING_DECLARATIONS.readContentHistory,
      },
    },
    async (request, reply) => {
      const token = provenToken(request, cookieName);
      const params = ListingParams.parse(request.params);
      const query = ContentHistoryQuery.parse(request.query);
      let below: number | undefined;
      if (query.cursor !== undefined) {
        const cursor = decodeCursor(ContentCursor, query.cursor);
        if (cursor.listingId !== params.listingId) throw new ValidationError('cursor');
        below = cursor.below;
      }
      const history = await options.auth.withSellerSession(token, (trx) =>
        listings.getContentHistory(trx, {
          listingId: params.listingId,
          limit: query.limit,
          ...(below === undefined ? {} : { belowVersionNumber: below }),
        }),
      );
      return privateRead(reply).send({
        versions: history.versions.map(presentDraft),
        nextCursor:
          history.nextBelow === null
            ? null
            : encodeCursor({
                v: 1,
                kind: 'content_versions',
                listingId: params.listingId,
                below: history.nextBelow,
              }),
      });
    },
  );
}
