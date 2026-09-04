import type { IncomingHttpHeaders } from 'node:http';
import { antiForgeryTokenFor, constantTimeEquals } from './session-token.ts';

// SEC-311: every state-changing request proves its origin, and is refused when it cannot.
// SEC-310: every state-changing request on a session also carries that session's anti-forgery
// value in a header a cross-site page cannot set.

export const STATE_CHANGING_METHODS: ReadonlySet<string> = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
export const ANTI_FORGERY_HEADER = 'x-anti-forgery';

export type OriginCheck =
  | { ok: true }
  | { ok: false; reason: 'fetch_site' | 'origin_missing' | 'origin_mismatch' | 'referer_mismatch' };

function single(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function checkStateChangingOrigin(headers: IncomingHttpHeaders, sellerOrigin: string): OriginCheck {
  const site = single(headers['sec-fetch-site']);
  if (site !== undefined && site !== 'same-origin') return { ok: false, reason: 'fetch_site' };
  const origin = single(headers.origin);
  if (origin !== undefined) {
    return origin === sellerOrigin ? { ok: true } : { ok: false, reason: 'origin_mismatch' };
  }
  const referer = single(headers.referer);
  if (referer !== undefined) {
    try {
      return new URL(referer).origin === sellerOrigin
        ? { ok: true }
        : { ok: false, reason: 'referer_mismatch' };
    } catch {
      return { ok: false, reason: 'referer_mismatch' };
    }
  }
  return { ok: false, reason: 'origin_missing' };
}

export function verifyAntiForgery(headers: IncomingHttpHeaders, sessionToken: string): boolean {
  const presented = single(headers[ANTI_FORGERY_HEADER]);
  if (presented === undefined) return false;
  return constantTimeEquals(presented, antiForgeryTokenFor(sessionToken));
}
