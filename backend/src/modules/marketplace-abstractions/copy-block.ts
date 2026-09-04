import type { z } from 'zod';
import { buyerListingUrl } from '../../shared/buyer-url.ts';
import { ValidationError } from '../../shared/errors.ts';
import { BuyerSafeListingProjectionSchema, PublicIdSchema } from '../public-listing-access/index.ts';

// Module 22 — Marketplace Abstractions (ARCH §3, ARCH-005, INT-002): copy formatting only. This
// function performs no I/O and nothing here is ever stored: the block exists in memory and in the
// first successful command response (ACCESS-013, SEC-040).
//
// The block is built from the buyer-safe projection, a type that cannot hold a protected field
// (SEC-021, OPS-724), so the minimum price, policy internals and internal identifiers cannot enter
// it (ACCESS-103 AC2). The item facts are the approved copy and its seller-backed details only.

/** BUYER-024 and INT-022: rules vary and compliance is the seller's; it says no more than that. */
export const MARKETPLACE_LINK_NOTICE =
  'Marketplace rules on external links vary. Complying with the rules of the marketplace you choose is your responsibility.';

export interface MarketplaceCopyBlock {
  /** <origin>/l/<opaque-public-id> (D-02). */
  buyerUrl: string;
  /** The pasteable text: title, description, details, price, buyer URL, code and the notice. */
  text: string;
}

const CODE = /^[0-9]{6}$/;

function fractionDigits(currency: string): number {
  try {
    return (
      new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ??
      2
    );
  } catch {
    throw new ValidationError('currency is not a recognised code');
  }
}

/** Integer minor units to a display amount with the currency's own fraction digits, without floats (DM-07). */
export function formatMoney(amountMinor: number, currency: string): string {
  if (!Number.isSafeInteger(amountMinor) || amountMinor < 0) {
    throw new ValidationError('amount must be a non-negative integer');
  }
  const digits = fractionDigits(currency);
  const scale = 10 ** digits;
  const major = Math.floor(amountMinor / scale);
  const minor = amountMinor % scale;
  const fraction = digits === 0 ? '' : `.${String(minor).padStart(digits, '0')}`;
  return `${currency} ${major.toLocaleString('en')}${fraction}`;
}

export interface CopyBlockInput {
  /** The buyer-safe projection of the approved content (SM-CT-03) and the asking price. */
  listing: z.input<typeof BuyerSafeListingProjectionSchema>;
  publicId: string;
  /** The code as issued, or null when it is no longer available (replay). */
  plaintextCode: string | null;
  /** A validated private-alpha or production origin. Never a hard-coded hostname. */
  buyerOrigin: string;
}

/**
 * ACCESS-103 AC1, BUYER-023, LIST-010: the pasteable block, or null when the plaintext code is not
 * available, because a block without its code is not the block the seller needs and the code is
 * never reconstructed from its hash (ACCESS-013).
 */
export function buildMarketplaceCopyBlock(input: CopyBlockInput): MarketplaceCopyBlock | null {
  if (input.plaintextCode === null) return null;
  if (typeof input.plaintextCode !== 'string' || !CODE.test(input.plaintextCode)) {
    throw new ValidationError('access code must be six digits');
  }
  const listing = BuyerSafeListingProjectionSchema.parse(input.listing);
  const publicId = PublicIdSchema.parse(input.publicId);
  const buyerUrl = buyerListingUrl(input.buyerOrigin, publicId);

  const lines: string[] = [listing.title, ''];
  if (listing.description !== null && listing.description.trim() !== '') {
    lines.push(listing.description.trim(), '');
  }
  const details = Object.entries(listing.structuredDetails).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (details.length > 0) {
    lines.push('Details:');
    for (const [key, value] of details) lines.push(`- ${key}: ${value}`);
    lines.push('');
  }
  lines.push(`Price: ${formatMoney(listing.askingPriceMinor, listing.currency)}`, '');
  lines.push(`Ask questions or make an offer here: ${buyerUrl}`);
  lines.push(`Access code: ${input.plaintextCode}`, '');
  lines.push(MARKETPLACE_LINK_NOTICE);
  return { buyerUrl, text: lines.join('\n') };
}
