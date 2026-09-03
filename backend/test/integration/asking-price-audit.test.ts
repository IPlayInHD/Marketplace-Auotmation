import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_SCHEMA } from '../../src/db/constants.ts';
import { createDb, withTenant, type DbHandle } from '../../src/db/kysely.ts';
import * as audit from '../../src/modules/audit/index.ts';
import * as content from '../../src/modules/listing-content/index.ts';
import * as listings from '../../src/modules/listings/index.ts';
import * as access from '../../src/modules/public-listing-access/index.ts';
import * as sellers from '../../src/modules/sellers/index.ts';
import {
  ConcurrentModificationError,
  IdempotencyConflictError,
  InvalidStateError,
  NotFoundError,
} from '../../src/shared/errors.ts';
import type { Money } from '../../src/shared/money.ts';
import { startDatabase, type TestDatabase } from '../helpers/database.ts';
import { buildListing, command, FIXTURE, seedSeller } from '../helpers/fixtures.ts';
import { query } from '../helpers/inspect.ts';

// LISTING_ASKING_PRICE_CHANGED (ai/POLICY_AND_AUTHORIZATION.md §12; OPS-780, OPS-781, OPS-784,
// OPS-787; OPS-730 to OPS-732) and the minimum-price boundary (AUTH-INV-08, OPS-569, OPS-783).

const MINIMUM = String(FIXTURE.minimumPrice.amountMinor);
const OTHER_PRICE: Money = { amountMinor: 30_000, currency: 'CAD' };

describe('Asking-price audit event', () => {
  let env: TestDatabase;
  let runtime: DbHandle;
  let sellerA: string;
  let sellerB: string;

  beforeAll(async () => {
    env = await startDatabase();
    runtime = createDb(env.runtimeUrl, { max: 3, applicationName: 'asking-price-test' });
    sellerA = await seedSeller(runtime.db, FIXTURE.sellers.a);
    sellerB = await seedSeller(runtime.db, FIXTURE.sellers.b);
  });
  afterAll(async () => {
    await runtime?.close();
    await env?.stop();
  });

  const priceEvents = (sellerId: string, listingId: string) =>
    withTenant(runtime.db, sellerId, async (trx) =>
      (await audit.listAuditEventsForSubject(trx, sellerId, 'listing', listingId)).filter(
        (e) => e.eventType === 'LISTING_ASKING_PRICE_CHANGED',
      ),
    );

  it('emits exactly one event per change, with the previous and new asking price, written by the same transaction as the price', async () => {
    const built = await buildListing(runtime.db, sellerA, { price: false, policy: false });
    const first = command(sellerA, 'price-1');
    const priced = await withTenant(runtime.db, sellerA, (trx) =>
      listings.setAskingPrice(trx, first, {
        listingId: built.listingId,
        price: FIXTURE.askingPrice,
        expectedRowVersion: built.rowVersion,
      }),
    );
    expect(priced.askingPrice).toEqual(FIXTURE.askingPrice);
    expect(priced.rowVersion).toBe(built.rowVersion + 1);

    let events = await priceEvents(sellerA, built.listingId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: 'LISTING_ASKING_PRICE_CHANGED',
      actorType: 'SELLER',
      actorRef: sellerA,
      subjectType: 'listing',
      subjectId: built.listingId,
      policyVersionId: null,
      requestId: first.requestId,
      idempotencyKey: first.idempotencyKey,
      summary: {
        previous_asking_price_minor: null,
        previous_currency: null,
        asking_price_minor: FIXTURE.askingPrice.amountMinor,
        currency: FIXTURE.askingPrice.currency,
        row_version: priced.rowVersion,
      },
    });

    // OPS-787: the listing row and its event were written by one transaction (same xmin).
    const [listingRow] = await query<{ xmin: string }>(
      env.superuserUrl,
      `SELECT xmin::text AS xmin FROM ${APP_SCHEMA}.listing WHERE id = $1`,
      [built.listingId],
    );
    const [eventRow] = await query<{ xmin: string }>(
      env.superuserUrl,
      `SELECT xmin::text AS xmin FROM ${APP_SCHEMA}.audit_event WHERE id = $1`,
      [events[0]?.id ?? ''],
    );
    expect(listingRow?.xmin).toBeDefined();
    expect(eventRow?.xmin).toBe(listingRow?.xmin);

    const second = command(sellerA, 'price-2');
    const repriced = await withTenant(runtime.db, sellerA, (trx) =>
      listings.setAskingPrice(trx, second, {
        listingId: built.listingId,
        price: OTHER_PRICE,
        expectedRowVersion: priced.rowVersion,
      }),
    );
    events = await priceEvents(sellerA, built.listingId);
    expect(events).toHaveLength(2);
    expect(events[1]?.summary).toEqual({
      previous_asking_price_minor: FIXTURE.askingPrice.amountMinor,
      previous_currency: FIXTURE.askingPrice.currency,
      asking_price_minor: OTHER_PRICE.amountMinor,
      currency: OTHER_PRICE.currency,
      row_version: repriced.rowVersion,
    });
  });

  it('is an idempotent no-op when the submitted price equals the current price: no write, no event', async () => {
    const built = await buildListing(runtime.db, sellerA, { policy: false });
    const before = await withTenant(runtime.db, sellerA, (trx) => listings.getListing(trx, built.listingId));
    const same = await withTenant(runtime.db, sellerA, (trx) =>
      listings.setAskingPrice(trx, command(sellerA, 'same'), {
        listingId: built.listingId,
        price: { ...FIXTURE.askingPrice },
        expectedRowVersion: before.rowVersion,
      }),
    );
    expect(same).toEqual(before);
    expect(same.rowVersion).toBe(before.rowVersion);
    const events = await priceEvents(sellerA, built.listingId);
    expect(events).toHaveLength(1); // only the change buildListing made
    expect(events[0]?.summary).toMatchObject({ previous_asking_price_minor: null });
  });

  it('replays the same key without a second event, and conflicts when the key is reused for a different action', async () => {
    const built = await buildListing(runtime.db, sellerA, { price: false });
    const ctx = command(sellerA, 'price');
    const first = await withTenant(runtime.db, sellerA, (trx) =>
      listings.setAskingPrice(trx, ctx, {
        listingId: built.listingId,
        price: FIXTURE.askingPrice,
        expectedRowVersion: built.rowVersion,
      }),
    );
    const replay = await withTenant(runtime.db, sellerA, (trx) =>
      listings.setAskingPrice(trx, ctx, {
        listingId: built.listingId,
        price: FIXTURE.askingPrice,
        expectedRowVersion: built.rowVersion,
      }),
    );
    expect(replay).toEqual(first);
    expect(await priceEvents(sellerA, built.listingId)).toHaveLength(1);

    const reused = { ...command(sellerA, 'ready'), idempotencyKey: ctx.idempotencyKey };
    await expect(
      withTenant(runtime.db, sellerA, (trx) =>
        listings.markReady(trx, reused, { listingId: built.listingId, expectedRowVersion: first.rowVersion }),
      ),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
    const statusEvents = await withTenant(runtime.db, sellerA, async (trx) =>
      (await audit.listAuditEventsForSubject(trx, sellerA, 'listing', built.listingId)).filter(
        (e) => e.eventType === 'LISTING_STATUS_CHANGED',
      ),
    );
    expect(statusEvents).toHaveLength(0);
  });

  it('writes no event when the mutation fails or the transaction rolls back', async () => {
    const built = await buildListing(runtime.db, sellerA, { price: false, policy: false });

    // Invalid money never reaches the database.
    await expect(
      withTenant(runtime.db, sellerA, (trx) =>
        listings.setAskingPrice(trx, command(sellerA, 'fractional'), {
          listingId: built.listingId,
          price: { amountMinor: 12.5, currency: 'CAD' },
          expectedRowVersion: built.rowVersion,
        }),
      ),
    ).rejects.toThrow();

    // A stale read is refused (OPS-738).
    await expect(
      withTenant(runtime.db, sellerA, (trx) =>
        listings.setAskingPrice(trx, command(sellerA, 'stale'), {
          listingId: built.listingId,
          price: FIXTURE.askingPrice,
          expectedRowVersion: built.rowVersion + 7,
        }),
      ),
    ).rejects.toBeInstanceOf(ConcurrentModificationError);

    // A successful write inside a transaction that then rolls back leaves neither price nor event.
    await expect(
      withTenant(runtime.db, sellerA, async (trx) => {
        const changed = await listings.setAskingPrice(trx, command(sellerA, 'rollback'), {
          listingId: built.listingId,
          price: FIXTURE.askingPrice,
          expectedRowVersion: built.rowVersion,
        });
        expect(changed.askingPrice).toEqual(FIXTURE.askingPrice);
        throw new Error('forced rollback');
      }),
    ).rejects.toThrow('forced rollback');

    const after = await withTenant(runtime.db, sellerA, (trx) => listings.getListing(trx, built.listingId));
    expect(after.askingPrice).toBeNull();
    expect(after.rowVersion).toBe(built.rowVersion);
    expect(await priceEvents(sellerA, built.listingId)).toHaveLength(0);

    // A READY listing refuses a price change and records nothing.
    const ready = await buildListing(runtime.db, sellerA);
    const readyListing = await withTenant(runtime.db, sellerA, (trx) =>
      listings.markReady(trx, command(sellerA, 'ready'), {
        listingId: ready.listingId,
        expectedRowVersion: ready.rowVersion,
      }),
    );
    await expect(
      withTenant(runtime.db, sellerA, (trx) =>
        listings.setAskingPrice(trx, command(sellerA, 'price-on-ready'), {
          listingId: ready.listingId,
          price: OTHER_PRICE,
          expectedRowVersion: readyListing.rowVersion,
        }),
      ),
    ).rejects.toBeInstanceOf(InvalidStateError);
    expect(await priceEvents(sellerA, ready.listingId)).toHaveLength(1);
  });

  it('lets another tenant neither change the price nor read the event', async () => {
    const built = await buildListing(runtime.db, sellerA, { policy: false });
    await expect(
      withTenant(runtime.db, sellerB, (trx) =>
        listings.setAskingPrice(trx, command(sellerB, 'hijack'), {
          listingId: built.listingId,
          price: OTHER_PRICE,
          expectedRowVersion: built.rowVersion,
        }),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    const asB = await withTenant(runtime.db, sellerB, (trx) =>
      audit.listAuditEventsForSubject(trx, sellerB, 'listing', built.listingId),
    );
    expect(asB).toEqual([]);
    const asBAnyTenant = await withTenant(runtime.db, sellerB, (trx) =>
      trx.selectFrom('audit_event').select('id').where('subject_id', '=', built.listingId).execute(),
    );
    expect(asBAnyTenant).toEqual([]);
    const unchanged = await withTenant(runtime.db, sellerA, (trx) =>
      listings.getListing(trx, built.listingId),
    );
    expect(unchanged.askingPrice).toEqual(FIXTURE.askingPrice);
    expect(await priceEvents(sellerA, built.listingId)).toHaveLength(1);
  });

  it('never carries the minimum price in any audit payload, error message or buyer-safe projection', async () => {
    const built = await buildListing(runtime.db, sellerA, {
      policy: { amountMinor: FIXTURE.minimumPrice.amountMinor, currency: 'EUR' },
    });
    const listing = await withTenant(runtime.db, sellerA, (trx) =>
      listings.setAskingPrice(trx, command(sellerA, 'price'), {
        listingId: built.listingId,
        price: OTHER_PRICE,
        expectedRowVersion: built.rowVersion,
      }),
    );
    const events = await withTenant(runtime.db, sellerA, (trx) =>
      audit.listAuditEventsForSubject(trx, sellerA, 'listing', built.listingId),
    );
    expect(events.map((e) => e.eventType)).toContain('LISTING_ASKING_PRICE_CHANGED');
    expect(events.map((e) => e.eventType)).toContain('MINIMUM_PRICE_CHANGED');
    for (const e of events) {
      // Every stored value except the canonical event name itself.
      const { eventType, ...values } = e;
      const json = JSON.stringify(values);
      expect(json, eventType).not.toContain(MINIMUM);
      expect(json, eventType).not.toMatch(/minimum/i);
    }

    // Errors name gaps and states, never amounts.
    const refused = await withTenant(runtime.db, sellerA, (trx) =>
      listings
        .markReady(trx, command(sellerA, 'ready'), {
          listingId: listing.id,
          expectedRowVersion: listing.rowVersion,
        })
        .then(
          () => undefined,
          (err: unknown) => err as Error,
        ),
    );
    expect(refused?.message).toContain('currency_match');
    expect(refused?.message).not.toContain(MINIMUM);
    expect(refused?.message).not.toContain(String(OTHER_PRICE.amountMinor));

    const projectionJson = await withTenant(runtime.db, sellerA, async (trx) => {
      const current = await listings.getListing(trx, built.listingId);
      const approved = await content.getApprovedVersion(trx, built.listingId);
      const seller = await sellers.getSeller(trx, sellerA);
      if (!approved || !current.askingPrice) throw new Error('fixture incomplete');
      return access.serializeBuyerSafeProjection(
        access.buildBuyerSafeProjection({
          content: approved,
          askingPrice: current.askingPrice,
          sellerDisplayName: seller.displayName,
        }),
      );
    });
    expect(projectionJson).toContain(`"askingPriceMinor":${OTHER_PRICE.amountMinor}`);
    expect(projectionJson).not.toContain(MINIMUM);
    expect(projectionJson).not.toMatch(/minimum/i);
  });
});
