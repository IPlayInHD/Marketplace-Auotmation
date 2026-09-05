import { z } from 'zod';
import { ValidationError } from './errors.ts';

// Opaque keyset cursors for list endpoints (OPS-721, TM-84). A cursor is the base64url encoding
// of a small JSON document that names the position after which the next page starts, plus the
// filter it was issued under, so a page can never continue a different query. It carries no
// tenant identifier: the tenant is the session, and row-level security bounds every page the
// cursor can reach. A cursor is validated against its strict schema before any query is built;
// anything else is a bad request and discloses nothing about the encoding.

/** Encodes a cursor document; the document must already be the exact shape its schema accepts. */
export function encodeCursor(document: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(document), 'utf8').toString('base64url');
}

/** Decodes and strictly validates a presented cursor, refusing every malformed or foreign shape. */
export function decodeCursor<Schema extends z.ZodType>(schema: Schema, cursor: string): z.output<Schema> {
  if (!/^[A-Za-z0-9_-]{1,512}$/.test(cursor)) throw new ValidationError('cursor');
  let document: unknown;
  try {
    document = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new ValidationError('cursor');
  }
  const parsed = schema.safeParse(document);
  if (!parsed.success) throw new ValidationError('cursor');
  return parsed.data;
}

/**
 * A page size as a list endpoint accepts it: a plain decimal string from the query, at least one,
 * clamped to the endpoint's hard maximum rather than refused (OPS-721: an oversized page request
 * is clamped, not honoured). Blank, signed, fractional, exponent or non-numeric input is refused.
 */
export function pageSizeSchema(defaultSize: number, maximum: number) {
  return z
    .string()
    .regex(/^\d{1,9}$/)
    .transform(Number)
    .pipe(z.number().int().min(1))
    .transform((n) => Math.min(n, maximum))
    .optional()
    .transform((n) => n ?? defaultSize);
}
