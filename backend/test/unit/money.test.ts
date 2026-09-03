import { describe, expect, it } from 'vitest';
import { compareMoney, CurrencyMismatchError, money, MoneySchema } from '../../src/shared/money.ts';

describe('Money: integer minor units with an explicit currency (DM-07, OPS-703, OPS-704)', () => {
  it('holds integer minor units with an ISO 4217 code', () => {
    expect(money(25_000, 'CAD')).toEqual({ amountMinor: 25_000, currency: 'CAD' });
    expect(money(0, 'EUR')).toEqual({ amountMinor: 0, currency: 'EUR' });
  });

  it('rejects fractional, negative, unsafe and non-numeric amounts instead of rounding', () => {
    for (const bad of [12.34, 0.1, -1, Number.MAX_SAFE_INTEGER + 1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => money(bad, 'CAD'), String(bad)).toThrow();
    }
    expect(MoneySchema.safeParse({ amountMinor: '100', currency: 'CAD' }).success).toBe(false);
    expect(MoneySchema.safeParse({ amountMinor: 100, currency: 'CAD', extra: 1 }).success).toBe(false);
  });

  it('rejects a currency that is not a three-letter uppercase code', () => {
    for (const bad of ['cad', 'CA', 'CAD ', '$', '']) expect(() => money(1, bad), bad).toThrow();
  });

  it('compares amounts of one currency and raises on a currency mismatch rather than coercing', () => {
    expect(compareMoney(money(1, 'CAD'), money(2, 'CAD'))).toBe(-1);
    expect(compareMoney(money(2, 'CAD'), money(2, 'CAD'))).toBe(0);
    expect(compareMoney(money(3, 'CAD'), money(2, 'CAD'))).toBe(1);
    expect(() => compareMoney(money(1, 'CAD'), money(1, 'USD'))).toThrow(CurrencyMismatchError);
  });
});
