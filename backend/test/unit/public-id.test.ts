import { describe, expect, it } from 'vitest';
import {
  generatePublicId,
  PUBLIC_ID_ALPHABET,
  PUBLIC_ID_ENTROPY_BITS,
  PUBLIC_ID_LENGTH,
  PublicIdSchema,
} from '../../src/modules/public-listing-access/index.ts';

// OPS-711, SEC-003, BUYER-002 (unit): entropy, alphabet, shape and non-sequentiality of the
// opaque public listing id.

function base32Value(id: string): bigint {
  let value = 0n;
  for (const ch of id) value = value * 32n + BigInt(PUBLIC_ID_ALPHABET.indexOf(ch));
  return value;
}

function hamming(a: string, b: string): number {
  let d = 0;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) d += 1;
  return d;
}

describe('Opaque public listing id', () => {
  it('carries at least 64 CSPRNG bits in a URL-safe lowercase base32 alphabet', () => {
    expect(PUBLIC_ID_ALPHABET).toHaveLength(32);
    expect(new Set(PUBLIC_ID_ALPHABET).size).toBe(32);
    expect(PUBLIC_ID_ALPHABET).toMatch(/^[a-z2-7]+$/);
    expect(PUBLIC_ID_LENGTH).toBe(16);
    expect(PUBLIC_ID_ENTROPY_BITS).toBeGreaterThanOrEqual(64);
    expect(PUBLIC_ID_ENTROPY_BITS).toBe(80);
  });

  it('produces well-formed, unique ids that use the whole alphabet', () => {
    const ids = Array.from({ length: 2000 }, () => generatePublicId());
    const seen = new Set<string>();
    for (const id of ids) {
      expect(id).toMatch(/^[a-z2-7]{16}$/);
      expect(PublicIdSchema.safeParse(id).success).toBe(true);
      for (const ch of id) seen.add(ch);
    }
    expect(new Set(ids).size).toBe(ids.length);
    expect([...seen].sort().join('')).toBe([...PUBLIC_ID_ALPHABET].sort().join(''));
  });

  it('is non-sequential: consecutive ids are not adjacent under numeric ordering and differ in most positions', () => {
    let previous = generatePublicId();
    for (let i = 0; i < 200; i += 1) {
      const next = generatePublicId();
      const gap = base32Value(next) - base32Value(previous);
      expect(gap === 1n || gap === -1n || gap === 0n).toBe(false);
      expect(hamming(previous, next)).toBeGreaterThanOrEqual(3);
      previous = next;
    }
  });

  it('rejects the shapes an internal or sequential identifier would take', () => {
    for (const bad of [
      'ABCDEFGHIJKLMNOP',
      'abcdefghijklmno',
      'abcdefghijklmnopq',
      'abcdefgh01ijklmn',
      '0123456789abcdef',
      '00000000-0000-4000-8000-000000000000',
      '',
    ]) {
      expect(PublicIdSchema.safeParse(bad).success, bad).toBe(false);
    }
  });
});
