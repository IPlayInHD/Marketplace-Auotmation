import { describe, expect, it } from 'vitest';
import { canonicalJson, fingerprintCommand } from '../../src/modules/audit/index.ts';

// OPS-732: a key reused with a different payload is a conflict. The fingerprint is what makes
// "different payload" decidable without storing the payload.

const price = { amountMinor: 1, currency: 'CAD' };

describe('Command fingerprint', () => {
  it('is a SHA-256 hex digest independent of key order and of undefined fields', () => {
    const a = fingerprintCommand('listing.set_asking_price', {
      listingId: 'x',
      price,
      expectedRowVersion: 2,
    });
    const b = fingerprintCommand('listing.set_asking_price', {
      expectedRowVersion: 2,
      price: { currency: 'CAD', amountMinor: 1 },
      listingId: 'x',
      extra: undefined,
    });
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(b).toBe(a);
  });

  it('differs for a different command, value, type or currency', () => {
    const base = fingerprintCommand('listing.set_asking_price', { listingId: 'x', price });
    expect(fingerprintCommand('listing.mark_ready', { listingId: 'x', price })).not.toBe(base);
    expect(fingerprintCommand('listing.set_asking_price', { listingId: 'y', price })).not.toBe(base);
    expect(
      fingerprintCommand('listing.set_asking_price', { listingId: 'x', price: { ...price, amountMinor: 2 } }),
    ).not.toBe(base);
    expect(
      fingerprintCommand('listing.set_asking_price', {
        listingId: 'x',
        price: { ...price, currency: 'EUR' },
      }),
    ).not.toBe(base);
    expect(
      fingerprintCommand('listing.set_asking_price', {
        listingId: 'x',
        price: { ...price, amountMinor: '1' },
      }),
    ).not.toBe(base);
  });

  it('serialises canonically: sorted keys at every depth, dates as ISO strings, arrays in order', () => {
    expect(canonicalJson({ b: [{ z: 1, y: new Date('2026-09-04T00:00:00Z') }, 2], a: null })).toBe(
      '{"a":null,"b":[{"y":"2026-09-04T00:00:00.000Z","z":1},2]}',
    );
  });
});
