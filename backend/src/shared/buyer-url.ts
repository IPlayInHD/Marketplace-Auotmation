import { z } from 'zod';
import { ValidationError } from './errors.ts';

// The buyer URL shape of D-02 and BUYER_ACCESS_FLOW.md §3: <origin>/l/<opaque-public-id>. The
// path prefix is fixed here; the origin is not. Hosting and the production domain are undecided
// (Q-09), so no hostname is written into source: a caller injects a buyer origin, and it is
// accepted only in the shape a private-alpha or production origin can take.

/** The buyer route tree's prefix; src/web/app.ts registers the same value. */
export const BUYER_LISTING_PATH_PREFIX = '/l';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]', 'localhost']);
const HOSTNAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

/**
 * Validates and normalises a buyer origin: an absolute https origin, or http on a loopback host
 * for founder-operated demonstrations (D-18), with no credentials, path, query or fragment.
 * Returns the origin with no trailing slash.
 */
export function parseBuyerOrigin(value: unknown): string {
  const raw = z.string().min(1).max(260).safeParse(value);
  if (!raw.success) throw new ValidationError('buyer origin must be a string');
  let url: URL;
  try {
    url = new URL(raw.data);
  } catch {
    throw new ValidationError('buyer origin must be an absolute URL');
  }
  const loopback = LOOPBACK_HOSTS.has(url.hostname);
  if (!(url.protocol === 'https:' || (url.protocol === 'http:' && loopback))) {
    throw new ValidationError('buyer origin must use https, or http on a loopback host only');
  }
  if (url.username !== '' || url.password !== '')
    throw new ValidationError('buyer origin carries credentials');
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
    throw new ValidationError('buyer origin must not carry a path, query or fragment');
  }
  if (!loopback && !HOSTNAME.test(url.hostname))
    throw new ValidationError('buyer origin hostname is malformed');
  return url.origin;
}

/** The buyer URL for one public listing id under a validated origin. */
export function buyerListingUrl(buyerOrigin: string, publicId: string): string {
  return `${parseBuyerOrigin(buyerOrigin)}${BUYER_LISTING_PATH_PREFIX}/${publicId}`;
}
