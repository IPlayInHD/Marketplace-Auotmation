import { z } from 'zod';

// Untrusted-boundary validation policy for buyer input (ARCH-003, AUTH-223, TM-14).
//
// Policy, tested in test/projection.test.ts:
//   * every buyer-supplied object is validated with a strict schema;
//   * unknown keys are REJECTED, not stripped, so a client cannot probe for accepted fields;
//   * keys that name tenant, price policy or status are never part of any buyer schema, so
//     they are rejected as unknown keys by construction.

export const BuyerQuestionInputSchema = z.strictObject({
  listingPublicId: z.string().regex(/^[A-Za-z0-9_-]{16,32}$/),
  question: z.string().trim().min(1).max(500),
});
export type BuyerQuestionInput = z.infer<typeof BuyerQuestionInputSchema>;

export type ValidationOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'unknown_keys' | 'invalid_fields'; issues: string[] };

export function validateBuyerQuestion(untrusted: unknown): ValidationOutcome<BuyerQuestionInput> {
  const result = BuyerQuestionInputSchema.safeParse(untrusted);
  if (result.success) return { ok: true, value: result.data };
  const issues = result.error.issues.map((i) => `${i.code}:${i.path.join('.') || '<root>'}`);
  const reason = result.error.issues.some((i) => i.code === 'unrecognized_keys') ? 'unknown_keys' : 'invalid_fields';
  return { ok: false, reason, issues };
}
