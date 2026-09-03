import type { ListingStatus } from '../../db/schema.ts';

// architecture/STATE_MACHINES.md §1, exactly the drawn edges. The database guard holds the same
// table (app.listing_transition_allowed); a test proves the two agree on every pair of statuses.

export const LISTING_STATUSES: readonly ListingStatus[] = [
  'DRAFT',
  'READY',
  'LISTED',
  'ACTIVE_CONVERSATIONS',
  'OFFER_PENDING',
  'PENDING_SALE',
  'SOLD',
  'CANCELLED',
  'ARCHIVED',
  'EXPIRED',
];

export const LISTING_TRANSITIONS: readonly (readonly [ListingStatus, ListingStatus])[] = [
  ['DRAFT', 'READY'],
  ['READY', 'DRAFT'],
  ['READY', 'LISTED'],
  ['LISTED', 'ACTIVE_CONVERSATIONS'],
  ['ACTIVE_CONVERSATIONS', 'OFFER_PENDING'],
  ['OFFER_PENDING', 'ACTIVE_CONVERSATIONS'],
  ['OFFER_PENDING', 'PENDING_SALE'],
  ['PENDING_SALE', 'SOLD'],
  ['PENDING_SALE', 'ACTIVE_CONVERSATIONS'],
  ['LISTED', 'CANCELLED'],
  ['ACTIVE_CONVERSATIONS', 'CANCELLED'],
  ['OFFER_PENDING', 'CANCELLED'],
  ['SOLD', 'ARCHIVED'],
  ['CANCELLED', 'ARCHIVED'],
  ['LISTED', 'EXPIRED'],
  ['EXPIRED', 'LISTED'],
];

const allowed = new Set(LISTING_TRANSITIONS.map(([from, to]) => `${from}->${to}`));

export function isListingTransitionAllowed(from: ListingStatus, to: ListingStatus): boolean {
  return allowed.has(`${from}->${to}`);
}
