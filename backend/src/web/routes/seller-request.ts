import type { FastifyRequest } from 'fastify';
import * as auth from '../../modules/identity-auth/index.ts';
import { IDEMPOTENCY_KEY_HEADER, IdempotencyKeyHeaderSchema } from '../../shared/command.ts';
import {
  AntiForgeryRefusedError,
  IdempotencyKeyRequiredError,
  UnauthenticatedError,
} from '../../shared/errors.ts';

// Request-level checks shared by every authenticated seller route. All of them decide on the
// request alone, before any database work: nothing here resolves a session or a tenant.

/** The session cookie as presented, unverified. */
export function presentedToken(request: FastifyRequest, cookieName: string): unknown {
  return request.cookies[cookieName];
}

/**
 * The presented token, checked for shape and, on a state-changing method, for the session's
 * anti-forgery value (SEC-310) before anything is resolved or mutated.
 */
export function provenToken(request: FastifyRequest, cookieName: string): string {
  const token = presentedToken(request, cookieName);
  if (!auth.isWellFormedToken(token)) throw new UnauthenticatedError();
  if (auth.STATE_CHANGING_METHODS.has(request.method) && !auth.verifyAntiForgery(request.headers, token)) {
    throw new AntiForgeryRefusedError();
  }
  return token;
}

/** OPS-730 (D-20): one well-formed client-generated UUID, or the request is refused before any work. */
export function requiredIdempotencyKey(request: FastifyRequest): string {
  const parsed = IdempotencyKeyHeaderSchema.safeParse(request.headers[IDEMPOTENCY_KEY_HEADER]);
  if (!parsed.success) throw new IdempotencyKeyRequiredError();
  return parsed.data;
}
