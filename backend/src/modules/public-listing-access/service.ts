import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import type { TenantTransaction } from '../../db/kysely.ts';
import type { WriteContext } from '../../shared/command.ts';
import {
  ConcurrentModificationError,
  InvalidStateError,
  mapDatabaseError,
  NotFoundError,
} from '../../shared/errors.ts';
import { SQLSTATE } from '../../db/constants.ts';

// Module 6 — Public Listing Access (ARCH §3): the PublicListingAccess record of DOMAIN_MODEL.md.
// It owns the opaque public id and the surface's enabled state. It never reads a protected field
// and never imports Seller Policy or Audit (enforced by dependency-cruiser); the commands that
// audit and consume idempotency keys live in Modules 3 and 7.

/**
 * SEC-003, OPS-711, BUYER-002: the public id is the unguessable component of the buyer URL.
 * Sixteen lowercase base32 characters (RFC 4648 alphabet, no padding) carry 80 CSPRNG bits.
 */
export const PUBLIC_ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
export const PUBLIC_ID_LENGTH = 16;
export const PUBLIC_ID_ENTROPY_BITS = PUBLIC_ID_LENGTH * 5;
export const PublicIdSchema = z.string().regex(/^[a-z2-7]{16}$/);

/**
 * Generates an opaque public id from ten bytes of the CSPRNG. It embeds nothing: no time, no
 * counter, no seller or listing identifier, so consecutive ids are unrelated under any ordering.
 */
export function generatePublicId(): string {
  const bytes = randomBytes((PUBLIC_ID_LENGTH * 5) / 8);
  let buffer = 0;
  let bitCount = 0;
  let out = '';
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bitCount += 8;
    while (bitCount >= 5) {
      bitCount -= 5;
      out += PUBLIC_ID_ALPHABET.charAt((buffer >>> bitCount) & 31);
      buffer &= (1 << bitCount) - 1;
    }
  }
  return PublicIdSchema.parse(out);
}

export interface PublicAccessRecord {
  id: string;
  sellerId: string;
  listingId: string;
  /** The URL component. Not a secret (it is published), never an internal identifier (BUYER-002). */
  publicId: string;
  enabled: boolean;
  rowVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

interface AccessRow {
  id: string;
  seller_id: string;
  listing_id: string;
  public_id: string;
  enabled: boolean;
  row_version: number;
  created_at: Date;
  updated_at: Date;
}

function toAccess(row: AccessRow): PublicAccessRecord {
  return {
    id: row.id,
    sellerId: row.seller_id,
    listingId: row.listing_id,
    publicId: row.public_id,
    enabled: row.enabled,
    rowVersion: row.row_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** The record as an idempotency receipt stores it and a replay rebuilds it (OPS-731). */
const StoredPublicAccess = z.object({
  id: z.uuid(),
  sellerId: z.uuid(),
  listingId: z.uuid(),
  publicId: PublicIdSchema,
  enabled: z.boolean(),
  rowVersion: z.number().int(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
});

export function revivePublicAccess(stored: unknown): PublicAccessRecord {
  return StoredPublicAccess.parse(stored);
}

/**
 * Creates the public access for a listing with a fresh public id. DM-09 allows one per listing;
 * a second creation is refused by the unique constraint and reported as an invalid state.
 */
export async function createPublicAccess(
  trx: TenantTransaction,
  ctx: WriteContext,
  input: { listingId: string },
): Promise<PublicAccessRecord> {
  try {
    const row = await trx
      .insertInto('public_listing_access')
      .values({
        seller_id: ctx.sellerId,
        listing_id: z.uuid().parse(input.listingId),
        public_id: generatePublicId(),
        request_id: ctx.requestId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toAccess(row);
  } catch (err) {
    const mapped = mapDatabaseError(err, 'public_listing_access');
    const code = (mapped as { code?: unknown }).code;
    if (code === SQLSTATE.uniqueViolation) {
      throw new InvalidStateError(
        'public_listing_access',
        'present',
        'be created twice for one listing (DM-09)',
      );
    }
    throw mapped;
  }
}

export async function findPublicAccessByListing(
  trx: TenantTransaction,
  listingId: string,
): Promise<PublicAccessRecord | undefined> {
  const row = await trx
    .selectFrom('public_listing_access')
    .selectAll()
    .where('listing_id', '=', listingId)
    .executeTakeFirst();
  return row ? toAccess(row) : undefined;
}

/** AUTH-221: another tenant's access is indistinguishable from one that does not exist. */
export async function getPublicAccess(trx: TenantTransaction, accessId: string): Promise<PublicAccessRecord> {
  const row = await trx
    .selectFrom('public_listing_access')
    .selectAll()
    .where('id', '=', accessId)
    .executeTakeFirst();
  if (!row) throw new NotFoundError('public_listing_access');
  return toAccess(row);
}

export async function findPublicAccessByPublicId(
  trx: TenantTransaction,
  publicId: string,
): Promise<PublicAccessRecord | undefined> {
  if (!PublicIdSchema.safeParse(publicId).success) return undefined;
  const row = await trx
    .selectFrom('public_listing_access')
    .selectAll()
    .where('public_id', '=', publicId)
    .executeTakeFirst();
  return row ? toAccess(row) : undefined;
}

/**
 * The only write path to a public access row. Optimistic concurrency on row_version (OPS-738):
 * the update applies only if the row still carries the version the caller read, and the guard
 * independently requires the increment. The update takes the row lock, so concurrent commands on
 * one access serialise here and the loser sees the version mismatch (OPS-737).
 */
export async function updatePublicAccess(
  trx: TenantTransaction,
  ctx: WriteContext,
  accessId: string,
  expectedRowVersion: number,
  patch: { enabled?: boolean },
): Promise<PublicAccessRecord> {
  let row: AccessRow | undefined;
  try {
    row = await trx
      .updateTable('public_listing_access')
      .set({ ...patch, row_version: expectedRowVersion + 1, request_id: ctx.requestId })
      .where('id', '=', accessId)
      .where('row_version', '=', expectedRowVersion)
      .returningAll()
      .executeTakeFirst();
  } catch (err) {
    throw mapDatabaseError(err, 'public_listing_access');
  }
  if (row) return toAccess(row);
  await getPublicAccess(trx, accessId);
  throw new ConcurrentModificationError('public_listing_access');
}
