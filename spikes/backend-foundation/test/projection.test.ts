import { describe, expect, it } from 'vitest';
import { validateBuyerQuestion } from '../src/domain/input.ts';
import {
  BuyerSafeListingSchema,
  buyerSafeTypeHoldsNoProtectedKey,
  ListingRecordSchema,
  PROTECTED_LISTING_KEYS,
  serializeBuyerSafe,
  toBuyerSafe,
  type BuyerSafeListing,
  type ListingRecord,
} from '../src/domain/projection.ts';
import { renderBuyerPage } from '../src/web/render.ts';

// Proof 8 — boundary validation and buyer-safe output projection (unit, no database).

const record: ListingRecord = ListingRecordSchema.parse({
  id: '6d2f0a51-4d4b-4d63-8a0f-6d5f1c9f5c11',
  sellerId: 'c1b1f2a2-2d3e-4f50-9a6b-7c8d9e0f1a2b',
  title: 'Road bike',
  askingPriceMinor: 25_000,
  currency: 'EUR',
  minimumPriceMinor: 20_000,
  internalNotes: 'PRIVATE: bought at 150',
  sellerDisplayName: 'Demo Seller',
});

describe('Untrusted input validation policy: strict, unknown keys rejected', () => {
  it('accepts a well-formed buyer question', () => {
    const outcome = validateBuyerQuestion({ listingPublicId: 'abcDEF0123456789', question: '  Is it still available?  ' });
    expect(outcome).toEqual({ ok: true, value: { listingPublicId: 'abcDEF0123456789', question: 'Is it still available?' } });
  });

  it('rejects unknown keys instead of stripping them', () => {
    const outcome = validateBuyerQuestion({ listingPublicId: 'abcDEF0123456789', question: 'hi', extra: 1 });
    expect(outcome).toMatchObject({ ok: false, reason: 'unknown_keys' });
    if (!outcome.ok) expect(outcome.issues).toEqual(['unrecognized_keys:<root>']);
  });

  it('rejects tenant, price-policy and status keys a buyer must never set (mass assignment)', () => {
    for (const key of ['sellerId', 'seller_id', 'minimumPriceMinor', 'minimum_price', 'status', 'approved']) {
      const outcome = validateBuyerQuestion({ listingPublicId: 'abcDEF0123456789', question: 'hi', [key]: 'x' });
      expect(outcome, key).toMatchObject({ ok: false, reason: 'unknown_keys' });
    }
  });

  it('rejects malformed fields with a field-level reason', () => {
    const outcome = validateBuyerQuestion({ listingPublicId: '../etc', question: '' });
    expect(outcome).toMatchObject({ ok: false, reason: 'invalid_fields' });
    if (!outcome.ok) expect(outcome.issues.sort()).toEqual(['invalid_format:listingPublicId', 'too_small:question']);
  });

  it('rejects non-object input', () => {
    expect(validateBuyerQuestion('string')).toMatchObject({ ok: false, reason: 'invalid_fields' });
    expect(validateBuyerQuestion(null)).toMatchObject({ ok: false, reason: 'invalid_fields' });
  });
});

describe('Buyer-safe projection', () => {
  it('contains exactly the allowlisted fields', () => {
    const safe = toBuyerSafe(record, 'public-id-1');
    expect(Object.keys(safe).sort()).toEqual(['askingPriceMinor', 'currency', 'publicId', 'sellerDisplayName', 'title']);
    expect(safe).toEqual({ publicId: 'public-id-1', title: 'Road bike', askingPriceMinor: 25_000, currency: 'EUR', sellerDisplayName: 'Demo Seller' });
  });

  it('never carries a protected key through serialisation', () => {
    const json = serializeBuyerSafe(toBuyerSafe(record, 'public-id-1'));
    for (const key of PROTECTED_LISTING_KEYS) expect(json).not.toContain(key);
    expect(json).not.toContain('PRIVATE');
    expect(json).not.toContain('20000');
    expect(json).not.toContain(record.sellerId);
  });

  it('rejects an object assembled by spreading the internal record, even if it also has every safe field', () => {
    const smuggled = { ...record, ...toBuyerSafe(record, 'public-id-1') };
    expect(() => serializeBuyerSafe(smuggled)).toThrow(/unrecognized/i);
    const parsed = BuyerSafeListingSchema.safeParse(smuggled);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const issue = parsed.error.issues.find((i) => i.code === 'unrecognized_keys');
      expect(issue && 'keys' in issue ? [...(issue.keys as string[])].sort() : []).toEqual(['id', 'internalNotes', 'minimumPriceMinor', 'sellerId']);
    }
  });

  it('cannot structurally hold a protected field (type-level, SEC-021)', () => {
    expect(buyerSafeTypeHoldsNoProtectedKey).toBe(true);
    const safe = toBuyerSafe(record, 'public-id-1');
    // @ts-expect-error minimumPriceMinor is not a property of BuyerSafeListing
    const attempt: BuyerSafeListing = { ...safe, minimumPriceMinor: 1 };
    // Runtime backstop for the same attempt.
    expect(BuyerSafeListingSchema.safeParse(attempt).success).toBe(false);
  });

  it('server-rendered HTML escapes seller-supplied text and shows only projected fields', () => {
    const hostile: ListingRecord = { ...record, title: '<script>alert(1)</script>', sellerDisplayName: 'A & "B"' };
    const html = renderBuyerPage(toBuyerSafe(hostile, 'public-id-1'));
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('A &amp; &quot;B&quot;');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('PRIVATE');
    expect(html).not.toContain(record.sellerId);
  });
});
