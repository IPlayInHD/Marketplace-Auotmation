import { sql } from 'kysely';
import { z } from 'zod';
import type { TenantTransaction } from '../../db/kysely.ts';
import type { ContentProvenance, ContentVersionStatus } from '../../db/schema.ts';
import type { WriteContext } from '../../shared/command.ts';
import { mapDatabaseError, NotFoundError, ValidationError } from '../../shared/errors.ts';

/**
 * The factual fields a seller may state about an item (LIST-002), as fact keys. Title, summary and
 * description are copy, not facts, and live on the content version. No valuation-shaped key exists
 * or can be added without a change here (D-09, OPS-725).
 */
export const PRODUCT_FACT_KEYS = [
  'name',
  'brand',
  'model',
  'size',
  'colour',
  'condition',
  'included_items',
  'defects',
  'age',
  'usage_history',
  'specifications',
] as const;
export type ProductFactKey = (typeof PRODUCT_FACT_KEYS)[number];

const FactKey = z.enum(PRODUCT_FACT_KEYS);
const FactValue = z.string().trim().min(1).max(2000);
const FactsInput = z.partialRecord(FactKey, FactValue);

/**
 * The seller's complete statement of the LIST-002 facts (D-21 rule 7), for the domain and for
 * HTTP alike: each canonical key maps to the seller's text, trimmed, at most 2000 characters. A
 * blank value is not a fact and is dropped, so `{ name: '' }` and `{}` are the same statement and
 * fingerprint identically; an unknown key, a non-string or an over-long value is refused. No key
 * is ever defaulted: what the seller did not state stays absent (LIST-033, D-10).
 */
export const SellerFactsSchema = z.partialRecord(FactKey, z.string().trim().max(2000)).transform((facts) => {
  const stated: Partial<Record<ProductFactKey, string>> = {};
  for (const key of PRODUCT_FACT_KEYS) {
    const value = facts[key];
    if (value !== undefined && value.length > 0) stated[key] = value;
  }
  return stated;
});
export type SellerFacts = z.output<typeof SellerFactsSchema>;

const OptionalCopy = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((value) => (value.length === 0 ? undefined : value))
    .optional();

/**
 * The seller's own copy for one draft (LIST-002 title, summary, description) and the structured
 * details it shows, each of which must be a recorded fact (INV-12). Only the title is required;
 * a blank summary, description or detail is absent, never stored as empty text. Nothing here is
 * rewritten, expanded or generated (LIST-006, D-12).
 */
export const SellerDraftContentSchema = z.strictObject({
  title: z.string().trim().min(1).max(200),
  summary: OptionalCopy(1000),
  description: OptionalCopy(10_000),
  structuredDetails: SellerFactsSchema.optional(),
});
export type SellerDraftContent = z.output<typeof SellerDraftContentSchema>;

export interface ProductFactRecord {
  key: ProductFactKey;
  value: string;
  provenance: ContentProvenance;
  suppliedAt: Date;
}

export interface ContentVersionRecord {
  id: string;
  listingId: string;
  versionNumber: number;
  status: ContentVersionStatus;
  provenance: ContentProvenance;
  title: string;
  summary: string | null;
  description: string | null;
  structuredDetails: Record<string, string>;
  sourceVersionId: string | null;
  createdAt: Date;
  approvedAt: Date | null;
  approvedBy: string | null;
}

/** A version that is APPROVED and buyer-visible (SM-CT-03). The only content shape a projection may be built from. */
export interface ApprovedContent {
  versionId: string;
  listingId: string;
  title: string;
  summary: string | null;
  description: string | null;
  structuredDetails: Record<string, string>;
  approvedAt: Date;
}

function toVersion(row: {
  id: string;
  listing_id: string;
  version_number: number;
  status: ContentVersionStatus;
  provenance: ContentProvenance;
  title: string;
  summary: string | null;
  description: string | null;
  structured_details: Record<string, string>;
  source_version_id: string | null;
  created_at: Date;
  approved_at: Date | null;
  approved_by: string | null;
}): ContentVersionRecord {
  return {
    id: row.id,
    listingId: row.listing_id,
    versionNumber: row.version_number,
    status: row.status,
    provenance: row.provenance,
    title: row.title,
    summary: row.summary,
    description: row.description,
    structuredDetails: row.structured_details,
    sourceVersionId: row.source_version_id,
    createdAt: row.created_at,
    approvedAt: row.approved_at,
    approvedBy: row.approved_by,
  };
}

/**
 * Records seller-stated facts for a listing (LIST-101). Provenance is always SELLER_PROVIDED_FACT:
 * there is no other source of a product fact (D-10). Restating a key replaces its value.
 */
export async function recordFacts(
  trx: TenantTransaction,
  ctx: WriteContext,
  input: { listingId: string; facts: Record<string, string> },
): Promise<ProductFactRecord[]> {
  const facts = FactsInput.parse(input.facts);
  const entries = Object.entries(facts) as [ProductFactKey, string][];
  if (entries.length === 0) throw new ValidationError('at least one fact is required');
  const rows = await trx
    .insertInto('product_fact')
    .values(
      entries.map(([key, value]) => ({
        seller_id: ctx.sellerId,
        listing_id: input.listingId,
        key,
        value,
        provenance: 'SELLER_PROVIDED_FACT' as const,
        request_id: ctx.requestId,
      })),
    )
    .onConflict((oc) =>
      oc.columns(['listing_id', 'key']).doUpdateSet({
        value: (eb) => eb.ref('excluded.value'),
        supplied_at: sql`now()`,
        request_id: ctx.requestId,
      }),
    )
    .returning(['key', 'value', 'provenance', 'supplied_at'])
    .execute();
  return rows.map((r) => ({
    key: FactKey.parse(r.key),
    value: r.value,
    provenance: r.provenance,
    suppliedAt: r.supplied_at,
  }));
}

/** The seller-provided facts of a listing, by key. No other provenance is read as a fact (D-10, D-21 rule 7). */
export async function listFacts(trx: TenantTransaction, listingId: string): Promise<ProductFactRecord[]> {
  const rows = await trx
    .selectFrom('product_fact')
    .select(['key', 'value', 'provenance', 'supplied_at'])
    .where('listing_id', '=', listingId)
    .where('provenance', '=', 'SELLER_PROVIDED_FACT')
    .orderBy('key')
    .execute();
  return rows.map((r) => ({
    key: FactKey.parse(r.key),
    value: r.value,
    provenance: r.provenance,
    suppliedAt: r.supplied_at,
  }));
}

export interface FactReplacement {
  /** The seller-provided fact set after the replacement, sorted by key. */
  facts: ProductFactRecord[];
  /** Keys whose value is new or changed, sorted. */
  setKeys: ProductFactKey[];
  /** Keys that were seller-provided and are now unknown, sorted. */
  clearedKeys: ProductFactKey[];
}

function sortedKeys(keys: ProductFactKey[]): ProductFactKey[] {
  return [...keys].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * D-21 rule 7: full replacement of the seller-provided facts of one listing. The desired set is
 * compared with the current SELLER_PROVIDED_FACT rows: a key whose value is new or different is
 * upserted with a fresh supplied_at, a key absent from the desired set is deleted (rule 19: the
 * unknown state is the absence of a row, and the value is retained nowhere), and a key whose
 * value is equal is left untouched, its supplied_at standing. A fact of any other provenance,
 * should one ever exist, is neither read as current nor removed. When nothing differs no
 * statement runs, so the caller can treat the replacement as a no-op (rule 9).
 */
export async function replaceSellerFacts(
  trx: TenantTransaction,
  ctx: WriteContext,
  input: { listingId: string; facts: SellerFacts },
): Promise<FactReplacement> {
  const desired = SellerFactsSchema.parse(input.facts);
  const current = await listFacts(trx, input.listingId);
  const currentValue = new Map(current.map((f) => [f.key, f.value]));
  const setKeys = sortedKeys(
    PRODUCT_FACT_KEYS.filter((key) => desired[key] !== undefined && desired[key] !== currentValue.get(key)),
  );
  const clearedKeys = sortedKeys(
    PRODUCT_FACT_KEYS.filter((key) => desired[key] === undefined && currentValue.has(key)),
  );
  if (setKeys.length === 0 && clearedKeys.length === 0) return { facts: current, setKeys, clearedKeys };
  if (setKeys.length > 0) {
    await trx
      .insertInto('product_fact')
      .values(
        setKeys.map((key) => ({
          seller_id: ctx.sellerId,
          listing_id: input.listingId,
          key,
          value: desired[key] ?? '',
          provenance: 'SELLER_PROVIDED_FACT' as const,
          request_id: ctx.requestId,
        })),
      )
      .onConflict((oc) =>
        oc.columns(['listing_id', 'key']).doUpdateSet({
          value: (eb) => eb.ref('excluded.value'),
          supplied_at: sql`now()`,
          request_id: ctx.requestId,
        }),
      )
      .execute();
  }
  if (clearedKeys.length > 0) {
    await trx
      .deleteFrom('product_fact')
      .where('listing_id', '=', input.listingId)
      .where('provenance', '=', 'SELLER_PROVIDED_FACT')
      .where('key', 'in', clearedKeys)
      .execute();
  }
  return { facts: await listFacts(trx, input.listingId), setKeys, clearedKeys };
}

const DraftInput = z.strictObject({
  listingId: z.uuid(),
  title: z.string().trim().min(1).max(200),
  summary: z.string().trim().min(1).max(1000).optional(),
  description: z.string().trim().min(1).max(10_000).optional(),
  structuredDetails: z.partialRecord(FactKey, FactValue).optional(),
  /** The version this draft revises (D-21 rule 11), or null for a first draft (rule 12). Validated by the caller. */
  sourceVersionId: z.uuid().nullable().optional(),
});

/**
 * Creates a SELLER_DRAFT content version from the seller's own words (LIST-108 path). Every
 * structured detail must already be a recorded seller fact for this listing: the draft cannot
 * carry a detail the seller did not state (INV-12). The predecessor, when given, is recorded as
 * source_version_id (LIST-042); the data layer requires it to be a version of the same listing.
 */
export async function createSellerDraft(
  trx: TenantTransaction,
  ctx: WriteContext,
  input: z.input<typeof DraftInput>,
): Promise<ContentVersionRecord> {
  const valid = DraftInput.parse(input);
  const details = valid.structuredDetails ?? {};
  const uncovered = await uncoveredKeys(trx, valid.listingId, Object.keys(details));
  if (uncovered.length > 0) {
    throw new ValidationError('structured details must be backed by seller-provided facts', uncovered);
  }
  const next = await trx
    .selectFrom('listing_content_version')
    .select((eb) => eb.fn.coalesce(eb.fn.max('version_number'), sql<number>`0`).as('max'))
    .where('listing_id', '=', valid.listingId)
    .executeTakeFirstOrThrow();
  try {
    const row = await trx
      .insertInto('listing_content_version')
      .values({
        seller_id: ctx.sellerId,
        listing_id: valid.listingId,
        version_number: Number(next.max) + 1,
        status: 'SELLER_DRAFT',
        provenance: 'SELLER_PROVIDED_FACT',
        title: valid.title,
        summary: valid.summary ?? null,
        description: valid.description ?? null,
        structured_details: JSON.stringify(details),
        source_version_id: valid.sourceVersionId ?? null,
        request_id: ctx.requestId,
        approved_at: null,
        approved_by: null,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
    return toVersion(row);
  } catch (err) {
    throw mapDatabaseError(err, 'content_version');
  }
}

export async function getVersion(
  trx: TenantTransaction,
  listingId: string,
  versionId: string,
): Promise<ContentVersionRecord> {
  const row = await trx
    .selectFrom('listing_content_version')
    .selectAll()
    .where('listing_id', '=', listingId)
    .where('id', '=', versionId)
    .executeTakeFirst();
  if (!row) throw new NotFoundError('content_version');
  return toVersion(row);
}

/**
 * The listing's latest content version by version number, whatever its lifecycle status: the
 * text the seller is currently working from and the predecessor a revised draft must cite
 * (D-21 rule 11). Undefined when the listing has no version yet.
 */
export async function getLatestVersion(
  trx: TenantTransaction,
  listingId: string,
): Promise<ContentVersionRecord | undefined> {
  const row = await trx
    .selectFrom('listing_content_version')
    .selectAll()
    .where('listing_id', '=', listingId)
    .orderBy('version_number', 'desc')
    .limit(1)
    .executeTakeFirst();
  return row ? toVersion(row) : undefined;
}

/** The copy a seller draft would carry, in the normalised form the domain stores. */
export interface DraftCopy {
  title: string;
  summary: string | null;
  description: string | null;
  structuredDetails: Record<string, string>;
}

function sortedEntries(details: Record<string, string>): string {
  return JSON.stringify(Object.entries(details).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** True when a version already carries exactly this copy, detail for detail (D-21 rule 14). */
export function carriesSameCopy(version: ContentVersionRecord, copy: DraftCopy): boolean {
  return (
    version.title === copy.title &&
    version.summary === copy.summary &&
    version.description === copy.description &&
    sortedEntries(version.structuredDetails) === sortedEntries(copy.structuredDetails)
  );
}

/** The single APPROVED version of a listing, if any (SM-CT-01). */
export async function getApprovedVersion(
  trx: TenantTransaction,
  listingId: string,
): Promise<ApprovedContent | undefined> {
  const row = await trx
    .selectFrom('listing_content_version')
    .selectAll()
    .where('listing_id', '=', listingId)
    .where('status', '=', 'APPROVED')
    .executeTakeFirst();
  if (!row || row.approved_at === null) return undefined;
  return {
    versionId: row.id,
    listingId: row.listing_id,
    title: row.title,
    summary: row.summary,
    description: row.description,
    structuredDetails: row.structured_details,
    approvedAt: row.approved_at,
  };
}

async function uncoveredKeys(trx: TenantTransaction, listingId: string, keys: string[]): Promise<string[]> {
  if (keys.length === 0) return [];
  const rows = await trx
    .selectFrom('product_fact')
    .select('key')
    .where('listing_id', '=', listingId)
    .where('provenance', '=', 'SELLER_PROVIDED_FACT')
    .where('key', 'in', keys)
    .execute();
  const covered = new Set(rows.map((r) => r.key));
  return keys.filter((k) => !covered.has(k)).sort();
}

/** Structured-detail keys of a version that no seller-provided fact backs (D-10 coverage rule). */
export async function uncoveredDetailKeys(
  trx: TenantTransaction,
  listingId: string,
  versionId: string,
): Promise<string[]> {
  const version = await getVersion(trx, listingId, versionId);
  return uncoveredKeys(trx, listingId, Object.keys(version.structuredDetails));
}

/** APPROVED → SUPERSEDED for the current approved version, if one exists (SM-CT-01). Returns its id. */
export async function supersedeApprovedVersion(
  trx: TenantTransaction,
  listingId: string,
): Promise<string | undefined> {
  const row = await trx
    .updateTable('listing_content_version')
    .set({ status: 'SUPERSEDED' })
    .where('listing_id', '=', listingId)
    .where('status', '=', 'APPROVED')
    .returning('id')
    .executeTakeFirst();
  return row?.id;
}

/**
 * Marks a version APPROVED with SELLER_APPROVED_COPY provenance and the approving seller
 * (LIST-105, LIST-108, AUTH-INV-04). The words are untouched; the guard rejects anything else.
 */
export async function markApproved(
  trx: TenantTransaction,
  ctx: WriteContext,
  input: { listingId: string; versionId: string },
): Promise<ContentVersionRecord> {
  try {
    const row = await trx
      .updateTable('listing_content_version')
      .set({
        status: 'APPROVED',
        provenance: 'SELLER_APPROVED_COPY',
        approved_at: sql<Date>`now()`,
        approved_by: ctx.sellerId,
      })
      .where('listing_id', '=', input.listingId)
      .where('id', '=', input.versionId)
      .returningAll()
      .executeTakeFirst();
    if (!row) throw new NotFoundError('content_version');
    return toVersion(row);
  } catch (err) {
    throw mapDatabaseError(err, 'content_version');
  }
}
