import type { FastifyPluginCallback } from 'fastify';
import { z } from 'zod';
import type * as auth from '../../modules/identity-auth/index.ts';
import * as listings from '../../modules/listings/index.ts';
import { commandContext } from '../../shared/command.ts';
import { MoneySchema, type Money } from '../../shared/money.ts';
import type { RouteDeclaration } from '../authorization.ts';
import { provenToken, requiredIdempotencyKey } from './seller-request.ts';

// The first authenticated seller listing surface (Slice 1e): create a listing, read one listing,
// set its asking price. Each route is the HTTP form of one existing domain command of Module 3
// and changes none of its semantics. Identity comes from the session only (AUTH-220): every
// handler runs its command inside withSellerSession, the single route-to-tenant construction
// site, under forced row-level security. Another tenant's listing or inventory item is exactly
// as absent as one that does not exist (AUTH-221). Nothing here lists, searches, deletes,
// publishes, transitions, uploads, enhances, prices or exposes anything to a buyer.

export interface SellerListingRoutesOptions {
  auth: auth.AuthService;
  cookieName: string;
}

const ListingParams = z.strictObject({ listingId: z.uuid() });

/** Exactly the field the canonical creation command accepts (LIST-100, `listing.create`). */
const CreateListingBody = z.strictObject({ inventoryItemId: z.uuid() });

/** Exactly the domain representation of `listing.set_asking_price`: optimistic version and Money. */
const AskingPriceBody = z.strictObject({
  expectedRowVersion: z.number().int().min(1),
  price: MoneySchema,
});

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

/** The canonical AUTH-222 declarations of the listing routes, mirrored in the README inventory. */
export const SELLER_LISTING_DECLARATIONS = {
  create: {
    actor: 'seller',
    resource: 'listing',
    action: 'create',
    authentication: 'seller-session',
    authorization:
      'the live session names the tenant; the inventory item must belong to it and carry no live listing',
    tenantSource: 'session',
    classification: 'consequential',
    idempotency:
      'Idempotency-Key required (client UUID); exact replay returns the created listing without a second row, event or receipt',
    audit: 'LISTING_CREATED in the same transaction',
    failure:
      '401 unauthenticated; 403 forbidden_origin or forbidden_anti_forgery; 400 bad_request or idempotency_key_required; 404 not_found for an item not owned or not existing; 409 invalid_state or idempotency_conflict',
  },
  read: {
    actor: 'seller',
    resource: 'listing',
    action: 'read',
    authentication: 'seller-session',
    authorization:
      'the live session names the tenant; row-level security hides every other tenant, so their listings are not found',
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
        listings.createListing(
          trx,
          commandContext({ sellerId: principal.sellerId, requestId: request.id, idempotencyKey: key }),
          { inventoryItemId: body.inventoryItemId },
        ),
      );
      return reply.code(201).send({ listing: presentListing(listing) });
    },
  );

  app.get(
    '/listings/:listingId',
    { config: { authorization: 'seller-session', declaration: SELLER_LISTING_DECLARATIONS.read } },
    async (request, reply) => {
      const token = provenToken(request, cookieName);
      const params = ListingParams.parse(request.params);
      const listing = await options.auth.withSellerSession(token, (trx) =>
        listings.getListing(trx, params.listingId),
      );
      return reply.code(200).send({ listing: presentListing(listing) });
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
}
