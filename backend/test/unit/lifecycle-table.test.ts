import { describe, expect, it } from 'vitest';
import {
  isListingTransitionAllowed,
  LISTING_STATUSES,
  LISTING_TRANSITIONS,
} from '../../src/modules/listings/index.ts';

// architecture/STATE_MACHINES.md §1 as a table (unit). The database holds the same table; the
// integration suite proves the two agree on every pair.

describe('Listing lifecycle table', () => {
  it('has the sixteen drawn edges and no self-loops', () => {
    expect(LISTING_TRANSITIONS).toHaveLength(16);
    for (const [from, to] of LISTING_TRANSITIONS) expect(from).not.toBe(to);
    expect(new Set(LISTING_TRANSITIONS.map((e) => e.join('->'))).size).toBe(16);
  });

  it('starts in DRAFT and reaches every status from there', () => {
    const reached = new Set<string>(['DRAFT']);
    const queue = ['DRAFT'];
    while (queue.length > 0) {
      const from = queue.shift();
      for (const [f, t] of LISTING_TRANSITIONS) {
        if (f === from && !reached.has(t)) {
          reached.add(t);
          queue.push(t);
        }
      }
    }
    expect([...reached].sort()).toEqual([...LISTING_STATUSES].sort());
  });

  it('enters DRAFT only from READY (seller edits) and never from a live state', () => {
    const intoDraft = LISTING_TRANSITIONS.filter(([, to]) => to === 'DRAFT').map(([from]) => from);
    expect(intoDraft).toEqual(['READY']);
  });

  it('makes SOLD and ARCHIVED terminal for negotiation (SM-L-05)', () => {
    expect(LISTING_TRANSITIONS.filter(([from]) => from === 'SOLD').map(([, to]) => to)).toEqual(['ARCHIVED']);
    expect(LISTING_TRANSITIONS.filter(([from]) => from === 'ARCHIVED')).toEqual([]);
  });

  it('answers the predicate consistently with the table', () => {
    expect(isListingTransitionAllowed('DRAFT', 'READY')).toBe(true);
    expect(isListingTransitionAllowed('DRAFT', 'LISTED')).toBe(false);
    expect(isListingTransitionAllowed('DRAFT', 'SOLD')).toBe(false);
    expect(isListingTransitionAllowed('READY', 'READY')).toBe(false);
    for (const from of LISTING_STATUSES) {
      for (const to of LISTING_STATUSES) {
        const inTable = LISTING_TRANSITIONS.some(([f, t]) => f === from && t === to);
        expect(isListingTransitionAllowed(from, to), `${from}->${to}`).toBe(inTable);
      }
    }
  });
});
