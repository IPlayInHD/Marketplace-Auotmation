import { describe, expect, it } from 'vitest';
import {
  buildMarketplaceCopyBlock,
  formatMoney,
  MARKETPLACE_LINK_NOTICE,
} from '../../src/modules/marketplace-abstractions/index.ts';
import { BUYER_LISTING_PATH_PREFIX, buyerListingUrl, parseBuyerOrigin } from '../../src/shared/buyer-url.ts';
import { ValidationError } from '../../src/shared/errors.ts';
import { ROUTE_PREFIXES } from '../../src/web/app.ts';

// ACCESS-103, BUYER-023, BUYER-024, INT-022, D-02 (unit): the pasteable block is built from the
// buyer-safe projection only, carries the buyer URL and the code once, and holds nothing protected.

const projection = {
  title: 'Synthetic road bicycle by Fictional Cycles',
  summary: 'A fictional bicycle that exists only in automated tests.',
  description: 'Fixture description. Nothing here describes a real item.',
  structuredDetails: { name: 'Synthetic road bicycle', brand: 'Fictional Cycles' },
  askingPriceMinor: 25_000,
  currency: 'CAD',
  sellerDisplayName: 'Fixture Seller A',
};
const PUBLIC_ID = 'abcdefghijklmnop';
const ORIGIN = 'https://alpha.example';

describe('Buyer origin and URL', () => {
  it('uses the same path prefix as the buyer route tree (D-02)', () => {
    expect(BUYER_LISTING_PATH_PREFIX).toBe('/l');
    expect(ROUTE_PREFIXES.buyer).toBe(BUYER_LISTING_PATH_PREFIX);
    expect(buyerListingUrl(ORIGIN, PUBLIC_ID)).toBe('https://alpha.example/l/abcdefghijklmnop');
  });

  it('accepts an https origin, or http on a loopback host only, and normalises it', () => {
    expect(parseBuyerOrigin('https://alpha.example')).toBe('https://alpha.example');
    expect(parseBuyerOrigin('https://alpha.example/')).toBe('https://alpha.example');
    expect(parseBuyerOrigin('https://Alpha.Example:8443/')).toBe('https://alpha.example:8443');
    expect(parseBuyerOrigin('http://127.0.0.1:3000')).toBe('http://127.0.0.1:3000');
    expect(parseBuyerOrigin('http://localhost:3000/')).toBe('http://localhost:3000');
  });

  it('rejects anything that is not a bare origin', () => {
    const withCredentials = new URL('https://alpha.example');
    withCredentials.username = 'user';
    withCredentials.password = 'pw';
    for (const bad of [
      'http://alpha.example',
      withCredentials.href,
      'https://alpha.example/path',
      'https://alpha.example?x=1',
      'https://alpha.example#frag',
      'ftp://alpha.example',
      'alpha.example',
      'https://alpha_example.test',
      '',
      42,
      null,
    ]) {
      expect(() => parseBuyerOrigin(bad), String(bad)).toThrow(ValidationError);
    }
  });
});

describe('Money formatting for the copy block', () => {
  it('formats integer minor units with the currency’s own fraction digits, never a float', () => {
    expect(formatMoney(25_000, 'CAD')).toBe('CAD 250.00');
    expect(formatMoney(1_234_567, 'USD')).toBe('USD 12,345.67');
    expect(formatMoney(5, 'JPY')).toBe('JPY 5');
    expect(formatMoney(1, 'EUR')).toBe('EUR 0.01');
    expect(() => formatMoney(-1, 'CAD')).toThrow(ValidationError);
    expect(() => formatMoney(12.5, 'CAD')).toThrow(ValidationError);
  });
});

describe('Marketplace copy block', () => {
  it('contains the approved copy, details, price, buyer URL, code and the link notice, and nothing else', () => {
    const block = buildMarketplaceCopyBlock({
      listing: projection,
      publicId: PUBLIC_ID,
      plaintextCode: '042917',
      buyerOrigin: ORIGIN,
    });
    expect(block).not.toBeNull();
    expect(block?.buyerUrl).toBe('https://alpha.example/l/abcdefghijklmnop');
    expect(block?.text).toBe(
      [
        'Synthetic road bicycle by Fictional Cycles',
        '',
        'Fixture description. Nothing here describes a real item.',
        '',
        'Details:',
        '- brand: Fictional Cycles',
        '- name: Synthetic road bicycle',
        '',
        'Price: CAD 250.00',
        '',
        'Ask questions or make an offer here: https://alpha.example/l/abcdefghijklmnop',
        'Access code: 042917',
        '',
        MARKETPLACE_LINK_NOTICE,
      ].join('\n'),
    );
    expect(block?.text).not.toMatch(/minimum|policy|concession|Fixture Seller/i);
    expect(MARKETPLACE_LINK_NOTICE).not.toMatch(/permit|allow|forbid|prohibit/i);
  });

  it('is unavailable without the plaintext code and never accepts a malformed one', () => {
    expect(
      buildMarketplaceCopyBlock({
        listing: projection,
        publicId: PUBLIC_ID,
        plaintextCode: null,
        buyerOrigin: ORIGIN,
      }),
    ).toBeNull();
    for (const bad of ['12345', 'abcdef', '', '1234567']) {
      expect(() =>
        buildMarketplaceCopyBlock({
          listing: projection,
          publicId: PUBLIC_ID,
          plaintextCode: bad,
          buyerOrigin: ORIGIN,
        }),
      ).toThrow(ValidationError);
    }
  });

  it('refuses a projection carrying a protected field, an internal id in place of the public id, or a bad origin', () => {
    const withMinimum = { ...projection, minimumPriceMinor: 20_000 } as typeof projection;
    expect(() =>
      buildMarketplaceCopyBlock({
        listing: withMinimum,
        publicId: PUBLIC_ID,
        plaintextCode: '042917',
        buyerOrigin: ORIGIN,
      }),
    ).toThrow();
    expect(() =>
      buildMarketplaceCopyBlock({
        listing: projection,
        publicId: '2f1c5d6e-3b4a-4c5d-8e9f-0a1b2c3d4e5f',
        plaintextCode: '042917',
        buyerOrigin: ORIGIN,
      }),
    ).toThrow();
    expect(() =>
      buildMarketplaceCopyBlock({
        listing: projection,
        publicId: PUBLIC_ID,
        plaintextCode: '042917',
        buyerOrigin: 'http://alpha.example',
      }),
    ).toThrow(ValidationError);
  });
});
