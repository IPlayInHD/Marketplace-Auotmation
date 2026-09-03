import { z } from 'zod';

// Money is integer minor units with an explicit ISO 4217 currency (DM-07, OPS-703). There is no
// floating-point representation anywhere: fractional input is rejected, never rounded.

export const CurrencyCodeSchema = z.string().regex(/^[A-Z]{3}$/, 'currency must be an ISO 4217 code');
export const MinorUnitsSchema = z
  .number()
  .int('money is integer minor units; fractional amounts are rejected (OPS-703)')
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);

export const MoneySchema = z.strictObject({
  amountMinor: MinorUnitsSchema,
  currency: CurrencyCodeSchema,
});

export interface Money {
  readonly amountMinor: number;
  readonly currency: string;
}

/** Validates and constructs a Money value. Throws a ZodError on fractional or negative input. */
export function money(amountMinor: number, currency: string): Money {
  return MoneySchema.parse({ amountMinor, currency });
}

export class CurrencyMismatchError extends Error {
  override readonly name = 'CurrencyMismatchError';
  readonly left: string;
  readonly right: string;
  constructor(left: string, right: string) {
    super(`cannot operate on ${left} and ${right} amounts together (OPS-704)`);
    this.left = left;
    this.right = right;
  }
}

/** Compares two amounts of the same currency. A different currency raises rather than coerces (OPS-704). */
export function compareMoney(a: Money, b: Money): -1 | 0 | 1 {
  if (a.currency !== b.currency) throw new CurrencyMismatchError(a.currency, b.currency);
  if (a.amountMinor < b.amountMinor) return -1;
  if (a.amountMinor > b.amountMinor) return 1;
  return 0;
}
