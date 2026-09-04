import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_SCHEMA } from '../../src/db/constants.ts';
import { createDb, withTenant, type DbHandle } from '../../src/db/kysely.ts';
import * as audit from '../../src/modules/audit/index.ts';
import * as listings from '../../src/modules/listings/index.ts';
import type { CommandContext } from '../../src/shared/command.ts';
import { IdempotencyConflictError, InvalidStateError, NotFoundError } from '../../src/shared/errors.ts';
import type { Money } from '../../src/shared/money.ts';
import { startDatabase, type TestDatabase } from '../helpers/database.ts';
import { buildListing, command, FIXTURE, seedSeller } from '../helpers/fixtures.ts';
import { query } from '../helpers/inspect.ts';

// OPS-730 to OPS-733: an asking-price command that repeats the current price is a successful
// no-op. It changes nothing and emits no LISTING_ASKING_PRICE_CHANGED, but it consumes its key
// and stores its outcome, so a retry returns that outcome however the listing moves on.

const MINIMUM = String(FIXTURE.minimumPrice.amountMinor);
const OTHER_PRICE: Money = { amountMinor: 30_000, currency: 'CAD' };

describe('Same-price asking-price replay', () => {
  let env: TestDatabase;
  let runtime: DbHandle;
  let sellerA: string;
  let sellerB: string;

  beforeAll(async () => {
    env = await startDatabase();
    runtime = createDb(env.runtimeUrl, { max: 3, applicationName: 'asking-price-replay-test' });
    sellerA = await seedSeller(runtime.db, FIXTURE.sellers.a);
    sellerB = await seedSeller(runtime.db, FIXTURE.sellers.b);
  });
  afterAll(async () => {
    await runtime?.close();
    await env?.stop();
  });

  const setPrice = (ctx: CommandContext, listingId: string, price: Money, expectedRowVersion: number) =>
    withTenant(runtime.db, ctx.sellerId, (trx) =>
      listings.setAskingPrice(trx, ctx, { listingId, price, expectedRowVersion }),
    );
  const samePrice = (ctx: CommandContext, listingId: string, expectedRowVersion: number) =>
    setPrice(ctx, listingId, { ...FIXTURE.askingPrice }, expectedRowVersion);
  const current = (sellerId: string, listingId: string) =>
    withTenant(runtime.db, sellerId, (trx) => listings.getListing(trx, listingId));
  const receiptFor = (sellerId: string, key: string) =>
    withTenant(runtime.db, sellerId, (trx) => audit.findIdempotencyReceipt(trx, sellerId, key));
  const eventsFor = (sellerId: string, listingId: string) =>
    withTenant(runtime.db, sellerId, (trx) =>
      audit.listAuditEventsForSubject(trx, sellerId, 'listing', listingId),
    );
  const priceEvents = async (sellerId: string, listingId: string) =>
    (await eventsFor(sellerId, listingId)).filter((e) => e.eventType === 'LISTING_ASKING_PRICE_CHANGED');

  it('stores a successful receipt for a same-price command, changes nothing, emits no event and replays the same outcome', async () => {
    const built = await buildListing(runtime.db, sellerA, { policy: false });
    const before = await current(sellerA, built.listingId);
    const ctx = command(sellerA, 'same');
    const first = await samePrice(ctx, built.listingId, before.rowVersion);
    expect(first).toEqual(before);

    // The key is consumed by a receipt that records a successful no-op: no event behind it.
    const receipt = await receiptFor(sellerA, ctx.idempotencyKey);
    expect(receipt).toMatchObject({
      sellerId: sellerA,
      idempotencyKey: ctx.idempotencyKey,
      command: 'listing.set_asking_price',
      subjectType: 'listing',
      subjectId: built.listingId,
      auditEventId: null,
      requestId: ctx.requestId,
    });
    expect(receipt?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(receipt?.outcome).toEqual({ listing: JSON.parse(JSON.stringify(before)) as unknown });

    // Neither the listing nor its row_version moved.
    const after = await current(sellerA, built.listingId);
    expect(after).toEqual(before);
    expect(after.rowVersion).toBe(before.rowVersion);

    // The only asking-price event is the one buildListing caused; none carries this key.
    const events = await priceEvents(sellerA, built.listingId);
    expect(events).toHaveLength(1);
    expect(events.filter((e) => e.idempotencyKey === ctx.idempotencyKey)).toEqual([]);

    // An immediate identical retry returns the original outcome from the receipt.
    const replay = await samePrice(ctx, built.listingId, before.rowVersion);
    expect(replay).toEqual(first);
    expect(await priceEvents(sellerA, built.listingId)).toHaveLength(1);
    const stored = await query<{ n: string }>(
      env.superuserUrl,
      `SELECT count(*)::text AS n FROM ${APP_SCHEMA}.idempotency_receipt WHERE idempotency_key = $1`,
      [ctx.idempotencyKey],
    );
    expect(stored[0]?.n).toBe('1');
  });

  it('replays the original outcome after another command changed the price, and leaves the new price in place', async () => {
    const built = await buildListing(runtime.db, sellerA, { policy: false });
    const before = await current(sellerA, built.listingId);
    const ctx = command(sellerA, 'same');
    const first = await samePrice(ctx, built.listingId, before.rowVersion);

    const changed = await setPrice(
      command(sellerA, 'change'),
      built.listingId,
      OTHER_PRICE,
      before.rowVersion,
    );
    expect(changed.askingPrice).toEqual(OTHER_PRICE);
    expect(changed.rowVersion).toBe(before.rowVersion + 1);

    const replay = await samePrice(ctx, built.listingId, before.rowVersion);
    expect(replay).toEqual(first);
    expect(replay.askingPrice).toEqual(FIXTURE.askingPrice);
    expect(replay.rowVersion).toBe(before.rowVersion);

    expect(await current(sellerA, built.listingId)).toEqual(changed);
    expect(await priceEvents(sellerA, built.listingId)).toHaveLength(2);
  });

  it('replays the original outcome after the listing became READY instead of failing state validation', async () => {
    const built = await buildListing(runtime.db, sellerA);
    const before = await current(sellerA, built.listingId);
    const ctx = command(sellerA, 'same');
    const first = await samePrice(ctx, built.listingId, before.rowVersion);
    expect(first.status).toBe('DRAFT');

    const ready = await withTenant(runtime.db, sellerA, (trx) =>
      listings.markReady(trx, command(sellerA, 'ready'), {
        listingId: built.listingId,
        expectedRowVersion: before.rowVersion,
      }),
    );
    expect(ready.status).toBe('READY');

    const replay = await samePrice(ctx, built.listingId, before.rowVersion);
    expect(replay).toEqual(first);
    expect(replay.status).toBe('DRAFT');
    expect((await current(sellerA, built.listingId)).status).toBe('READY');

    // A new same-price command is still validated against current state and leaves no receipt.
    const fresh = command(sellerA, 'same-on-ready');
    await expect(samePrice(fresh, built.listingId, ready.rowVersion)).rejects.toBeInstanceOf(
      InvalidStateError,
    );
    expect(await receiptFor(sellerA, fresh.idempotencyKey)).toBeUndefined();
    expect(await priceEvents(sellerA, built.listingId)).toHaveLength(1);
  });

  it('conflicts when the key is reused with a different price or currency, or for a different command', async () => {
    const built = await buildListing(runtime.db, sellerA);
    const before = await current(sellerA, built.listingId);
    const ctx = command(sellerA, 'same');
    await samePrice(ctx, built.listingId, before.rowVersion);

    await expect(setPrice(ctx, built.listingId, OTHER_PRICE, before.rowVersion)).rejects.toBeInstanceOf(
      IdempotencyConflictError,
    );
    await expect(
      setPrice(
        ctx,
        built.listingId,
        { amountMinor: FIXTURE.askingPrice.amountMinor, currency: 'EUR' },
        before.rowVersion,
      ),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
    const reused = { ...command(sellerA, 'ready'), idempotencyKey: ctx.idempotencyKey };
    await expect(
      withTenant(runtime.db, sellerA, (trx) =>
        listings.markReady(trx, reused, {
          listingId: built.listingId,
          expectedRowVersion: before.rowVersion,
        }),
      ),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);

    expect(await current(sellerA, built.listingId)).toEqual(before);
    const events = await eventsFor(sellerA, built.listingId);
    expect(events.filter((e) => e.eventType === 'LISTING_STATUS_CHANGED')).toEqual([]);
    expect(events.filter((e) => e.eventType === 'LISTING_ASKING_PRICE_CHANGED')).toHaveLength(1);

    // The same contract holds for a key first used by a real change.
    const change = command(sellerA, 'change');
    const changed = await setPrice(change, built.listingId, OTHER_PRICE, before.rowVersion);
    await expect(
      setPrice(change, built.listingId, { amountMinor: 31_000, currency: 'CAD' }, before.rowVersion),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect(await setPrice(change, built.listingId, OTHER_PRICE, before.rowVersion)).toEqual(changed);
    expect(await priceEvents(sellerA, built.listingId)).toHaveLength(2);
  });

  it('lets another tenant neither replay nor inspect the receipt', async () => {
    const built = await buildListing(runtime.db, sellerA, { policy: false });
    const before = await current(sellerA, built.listingId);
    const ctx = command(sellerA, 'same');
    await samePrice(ctx, built.listingId, before.rowVersion);

    const asB: CommandContext = { ...ctx, sellerId: sellerB };
    await expect(samePrice(asB, built.listingId, before.rowVersion)).rejects.toBeInstanceOf(NotFoundError);
    expect(await receiptFor(sellerB, ctx.idempotencyKey)).toBeUndefined();
    const asBForA = await withTenant(runtime.db, sellerB, (trx) =>
      audit.findIdempotencyReceipt(trx, sellerA, ctx.idempotencyKey),
    );
    expect(asBForA).toBeUndefined();
    const visibleToB = await withTenant(runtime.db, sellerB, (trx) =>
      trx
        .selectFrom('idempotency_receipt')
        .select('seller_id')
        .where('idempotency_key', '=', ctx.idempotencyKey)
        .execute(),
    );
    expect(visibleToB).toEqual([]);
    const rows = await query<{ seller_id: string }>(
      env.superuserUrl,
      `SELECT seller_id FROM ${APP_SCHEMA}.idempotency_receipt WHERE idempotency_key = $1`,
      [ctx.idempotencyKey],
    );
    expect(rows).toEqual([{ seller_id: sellerA }]);
    expect(await current(sellerA, built.listingId)).toEqual(before);
  });

  it('keeps the minimum price out of every receipt and out of the replayed representation', async () => {
    const built = await buildListing(runtime.db, sellerA);
    const before = await current(sellerA, built.listingId);
    const ctx = command(sellerA, 'same');
    const first = await samePrice(ctx, built.listingId, before.rowVersion);
    const replay = await samePrice(ctx, built.listingId, before.rowVersion);
    for (const value of [first, replay]) {
      const json = JSON.stringify(value);
      expect(json).not.toContain(MINIMUM);
      expect(json).not.toMatch(/minimum/i);
    }
    // Every receipt on this listing, including the policy command's, whose payload holds the minimum.
    const receipts = await withTenant(runtime.db, sellerA, (trx) =>
      trx.selectFrom('idempotency_receipt').selectAll().where('subject_id', '=', built.listingId).execute(),
    );
    expect(receipts.map((r) => r.command)).toContain('listing.set_policy');
    expect(receipts.map((r) => r.command)).toContain('listing.set_asking_price');
    for (const r of receipts) {
      const { fingerprint, ...rest } = r;
      expect(fingerprint, r.command).toMatch(/^[0-9a-f]{64}$/);
      const json = JSON.stringify(rest);
      expect(json, r.command).not.toContain(MINIMUM);
      expect(json, r.command).not.toMatch(/minimum/i);
    }
  });
});
