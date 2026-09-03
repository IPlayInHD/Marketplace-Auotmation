import { describe, expect, it } from 'vitest';
import type { ApprovedContent, ContentVersionRecord } from '../../src/modules/listing-content/index.ts';
import {
  buildBuyerSafeProjection,
  buyerSafeTypeHoldsNoProtectedKey,
  BuyerSafeListingProjectionSchema,
  PROTECTED_LISTING_KEYS,
  serializeBuyerSafeProjection,
  type BuyerSafeListingProjection,
} from '../../src/modules/public-listing-access/index.ts';

// SEC-020, SEC-021, OPS-724, OPS-726, D-04: the buyer-safe projection (unit, no database).

const LISTING_ID = '6d2f0a51-4d4b-4d63-8a0f-6d5f1c9f5c11';
const VERSION_ID = '8a3c2b1d-1111-4e2f-9a6b-7c8d9e0f1a2b';
const SELLER_ID = 'c1b1f2a2-2d3e-4f50-9a6b-7c8d9e0f1a2b';

const approved: ApprovedContent = {
  versionId: VERSION_ID,
  listingId: LISTING_ID,
  title: 'Synthetic road bicycle by Fictional Cycles',
  summary: null,
  description: 'Fixture description.',
  structuredDetails: { brand: 'Fictional Cycles', condition: 'used, rideable' },
  approvedAt: new Date('2000-01-01T00:00:00Z'),
};

/** What an internal seller-side record looks like: everything the buyer must never see. */
const internalRecord = {
  id: LISTING_ID,
  sellerId: SELLER_ID,
  inventoryItemId: '5f6a7b8c-2222-4d3e-8f90-a1b2c3d4e5f6',
  minimumPriceMinor: 20_000,
  currentPolicyVersionId: '9e8d7c6b-3333-4a5b-8c9d-0e1f2a3b4c5d',
  rowVersion: 4,
  requestId: 'req-fixture-1',
};

describe('Buyer-safe listing projection', () => {
  it('contains exactly the allowlisted fields', () => {
    const safe = buildBuyerSafeProjection({
      content: approved,
      askingPrice: { amountMinor: 25_000, currency: 'CAD' },
      sellerDisplayName: 'Fixture Seller A',
    });
    expect(Object.keys(safe).sort()).toEqual(
      [
        'askingPriceMinor',
        'currency',
        'description',
        'sellerDisplayName',
        'structuredDetails',
        'summary',
        'title',
      ].sort(),
    );
    expect(safe.askingPriceMinor).toBe(25_000);
    expect(safe.sellerDisplayName).toBe('Fixture Seller A');
  });

  it('never carries the minimum price, a tenant id or an internal id through serialisation', () => {
    const json = serializeBuyerSafeProjection(
      buildBuyerSafeProjection({
        content: approved,
        askingPrice: { amountMinor: 25_000, currency: 'CAD' },
        sellerDisplayName: 'Fixture Seller A',
      }),
    );
    for (const key of PROTECTED_LISTING_KEYS) expect(json).not.toContain(`"${key}"`);
    expect(json).not.toContain('20000');
    expect(json).not.toContain('minimum');
    expect(json).not.toContain(SELLER_ID);
    expect(json).not.toContain(LISTING_ID);
    expect(json).not.toContain(VERSION_ID);
  });

  it('rejects an object assembled by spreading an internal record, even if it also has every safe field', () => {
    const safe = buildBuyerSafeProjection({
      content: approved,
      askingPrice: { amountMinor: 25_000, currency: 'CAD' },
      sellerDisplayName: 'Fixture Seller A',
    });
    const smuggled = { ...internalRecord, ...safe };
    expect(() => serializeBuyerSafeProjection(smuggled)).toThrow(/unrecognized/i);
    const parsed = BuyerSafeListingProjectionSchema.safeParse(smuggled);
    expect(parsed.success).toBe(false);
  });

  it('cannot structurally hold a protected field (type-level, SEC-021)', () => {
    expect(buyerSafeTypeHoldsNoProtectedKey).toBe(true);
    const safe = buildBuyerSafeProjection({
      content: approved,
      askingPrice: { amountMinor: 25_000, currency: 'CAD' },
      sellerDisplayName: 'Fixture Seller A',
    });
    // @ts-expect-error minimumPriceMinor is not a property of BuyerSafeListingProjection
    const attempt: BuyerSafeListingProjection = { ...safe, minimumPriceMinor: 1 };
    expect(BuyerSafeListingProjectionSchema.safeParse(attempt).success).toBe(false);
  });

  it('is built from APPROVED content only: an unapproved version record is not accepted (SM-CT-03)', () => {
    const draft: ContentVersionRecord = {
      id: VERSION_ID,
      listingId: LISTING_ID,
      versionNumber: 1,
      status: 'SELLER_DRAFT',
      provenance: 'SELLER_PROVIDED_FACT',
      title: 'Draft title',
      summary: null,
      description: null,
      structuredDetails: {},
      sourceVersionId: null,
      createdAt: new Date('2000-01-01T00:00:00Z'),
      approvedAt: null,
      approvedBy: null,
    };
    expect(() =>
      buildBuyerSafeProjection({
        // @ts-expect-error a ContentVersionRecord is not ApprovedContent
        content: draft,
        askingPrice: { amountMinor: 25_000, currency: 'CAD' },
        sellerDisplayName: 'Fixture Seller A',
      }),
    ).toThrow();
  });

  it('copies structured details rather than aliasing the approved content', () => {
    const safe = buildBuyerSafeProjection({
      content: approved,
      askingPrice: { amountMinor: 25_000, currency: 'CAD' },
      sellerDisplayName: 'Fixture Seller A',
    });
    expect(safe.structuredDetails).toEqual(approved.structuredDetails);
    expect(safe.structuredDetails).not.toBe(approved.structuredDetails);
  });
});
