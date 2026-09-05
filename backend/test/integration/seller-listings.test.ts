import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TENANT_SETTING } from '../../src/db/constants.ts';
import { establishTenantContext, withTenant } from '../../src/db/kysely.ts';
import type * as KyselyModule from '../../src/db/kysely.ts';
import * as auth from '../../src/modules/identity-auth/index.ts';
import * as listings from '../../src/modules/listings/index.ts';
import { IDEMPOTENCY_KEY_HEADER } from '../../src/shared/command.ts';
import type { Money } from '../../src/shared/money.ts';
import { ROUTE_PREFIXES } from '../../src/web/app.ts';
import {
  AUTH_PREFIX,
  cookieOf,
  get,
  post,
  provisionAccount,
  signIn,
  startAuthApp,
  TEST_ORIGIN,
  type AuthApp,
  type Session,
  type SyntheticAccount,
} from '../helpers/auth.ts';
import { startDatabase, type TestDatabase } from '../helpers/database.ts';
import { buildListing, command, FIXTURE } from '../helpers/fixtures.ts';
import { query } from '../helpers/inspect.ts';

// The single tenant-context construction site is wrapped, unchanged in behaviour, so the tests
// can prove that no revoked, expired, unknown or malformed session ever reaches it.
vi.mock('../../src/db/kysely.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof KyselyModule>();
  return { ...actual, establishTenantContext: vi.fn(actual.establishTenantContext) };
});
const tenantContextCalls = vi.mocked(establishTenantContext);

// Slice 1e: the first authenticated seller listing routes over withSellerSession. Creation is the
// seller's one action of LIST-100 AC1: the inventory item and its DRAFT listing in one transaction
// under one receipt. Every account, item and amount is synthetic (D-18, DATA-110). Proofs:
// authentication and CSRF on every route, read-only GET, atomic creation with exact replay,
// conflicts and rollback, asking price with replay and the canonical same-price no-op, refusals
// without mutation, tenant isolation indistinguishable from absence (AUTH-221), no client-supplied
// identity (AUTH-220), no tenant context on a pooled connection, and no secret or internal field
// in responses or logs.

const DOMAIN = 'synthetic.invalid';
const address = (local: string) => [local, DOMAIN].join('@');
const PASSWORD = 'synthetic passphrase for listings';
const LISTINGS = `${ROUTE_PREFIXES.seller}/listings`;
const PRICE: Money = { amountMinor: 12_500, currency: 'CAD' };
const OTHER_PRICE: Money = { amountMinor: 13_000, currency: 'CAD' };
const FACTS = { acquisitionCost: { amountMinor: 4_000, currency: 'CAD' }, acquisitionDate: '2026-01-15' };
const VIEW_KEYS = [
  'askingPrice',
  'closedAt',
  'createdAt',
  'id',
  'inventoryItemId',
  'listedAt',
  'rowVersion',
  'status',
  'updatedAt',
];

interface ItemRow {
  id: string;
  seller_id: string;
  acquisition_cost_minor: number | null;
  acquisition_currency: string | null;
  acquisition_date: string | null;
}

describe('Seller listing routes (Slice 1e)', () => {
  let env: TestDatabase;
  let harness: AuthApp;
  let sellerA: SyntheticAccount;
  let sellerB: SyntheticAccount;
  let faulty: SyntheticAccount;
  let sessionA: Session;
  let sessionB: Session;
  const secrets: string[] = [PASSWORD];
  const responses: string[] = [];
  const remember = (s: Session): Session => {
    secrets.push(s.token, s.antiForgery);
    return s;
  };
  const record = (res: LightMyRequestResponse) => {
    responses.push(res.body);
    return res;
  };
  const headersFor = (
    session: Session | undefined,
    key: string | undefined,
    extra: Record<string, string>,
  ) => ({
    origin: TEST_ORIGIN,
    ...(key === undefined ? {} : { [IDEMPOTENCY_KEY_HEADER]: key }),
    ...extra,
    ...(session ? { [auth.ANTI_FORGERY_HEADER]: session.antiForgery } : {}),
  });
  const create = (
    session: Session | undefined,
    key: string | undefined,
    payload: unknown = {},
    extra: Record<string, string> = {},
    app: AuthApp = harness,
  ) =>
    app.app
      .inject({
        method: 'POST',
        url: LISTINGS,
        headers: headersFor(session, key, extra),
        ...(session ? { cookies: { [app.cookieName]: session.token } } : {}),
        payload: payload as Record<string, unknown>,
      })
      .then(record);
  const read = (token: string | undefined, listingId: string, headers: Record<string, string> = {}) =>
    get(harness, `${LISTINGS}/${listingId}`, token, headers).then(record);
  const setPrice = (
    session: Session | undefined,
    key: string | undefined,
    listingId: string,
    payload: unknown,
    extra: Record<string, string> = {},
    app: AuthApp = harness,
  ) =>
    app.app
      .inject({
        method: 'PATCH',
        url: `${LISTINGS}/${listingId}/asking-price`,
        headers: headersFor(session, key, extra),
        ...(session ? { cookies: { [app.cookieName]: session.token } } : {}),
        payload: payload as Record<string, unknown>,
      })
      .then(record);
  const created = (res: LightMyRequestResponse) =>
    res.json<{ listing: { id: string; inventoryItemId: string } }>().listing;
  const listingRows = (sellerId: string) =>
    query<{
      id: string;
      seller_id: string;
      inventory_item_id: string;
      status: string;
      asking_price_minor: number | null;
      currency: string | null;
      row_version: number;
      xmin: string;
    }>(
      env.superuserUrl,
      `SELECT id, seller_id, inventory_item_id, status, asking_price_minor, currency, row_version, xmin::text AS xmin
         FROM app.listing WHERE seller_id = $1 ORDER BY created_at, id`,
      [sellerId],
    );
  const itemRows = (sellerId: string) =>
    query<ItemRow>(
      env.superuserUrl,
      `SELECT id, seller_id, acquisition_cost_minor, acquisition_currency, acquisition_date::text AS acquisition_date
         FROM app.inventory_item WHERE seller_id = $1 ORDER BY created_at, id`,
      [sellerId],
    );
  const events = (sellerId: string) =>
    query<{
      event_type: string;
      subject_id: string;
      idempotency_key: string | null;
      request_id: string;
      summary: Record<string, unknown>;
    }>(
      env.superuserUrl,
      `SELECT event_type::text, subject_id, idempotency_key, request_id, summary FROM app.audit_event
        WHERE seller_id = $1 AND event_type::text LIKE 'LISTING_%' ORDER BY seq`,
      [sellerId],
    );
  const receipts = (sellerId: string) =>
    query<{
      idempotency_key: string;
      command: string;
      subject_id: string;
      request_id: string;
      outcome: Record<string, unknown>;
    }>(
      env.superuserUrl,
      `SELECT idempotency_key, command, subject_id, request_id, outcome FROM app.idempotency_receipt
        WHERE seller_id = $1 ORDER BY created_at`,
      [sellerId],
    );
  const snapshot = async (sellerId: string) => ({
    listings: await listingRows(sellerId),
    items: await itemRows(sellerId),
    events: await events(sellerId),
    receipts: await receipts(sellerId),
  });

  beforeAll(async () => {
    env = await startDatabase();
    sellerA = await provisionAccount(env, {
      displayName: 'Synthetic Seller LA',
      email: address('seller-la'),
      password: PASSWORD,
    });
    sellerB = await provisionAccount(env, {
      displayName: 'Synthetic Seller LB',
      email: address('seller-lb'),
      password: PASSWORD,
    });
    faulty = await provisionAccount(env, {
      displayName: 'Synthetic Seller LF',
      email: address('seller-lf'),
      password: PASSWORD,
    });
    harness = await startAuthApp(env, { poolMax: 4 });
    sessionA = remember(await signIn(harness, sellerA));
    sessionB = remember(await signIn(harness, sellerB));
  });
  afterAll(async () => {
    await harness?.close();
    await env?.stop();
  });

  it('requires a live session on every route: missing, malformed, unknown, revoked and expired sessions answer 401, create nothing and never reach tenant context', async () => {
    const revoked = remember(await signIn(harness, sellerA));
    expect((await post(harness, `${AUTH_PREFIX}/sign-out`, revoked)).statusCode).toBe(204);
    const expired = remember(await signIn(harness, sellerA));
    await query(
      env.superuserUrl,
      `UPDATE auth.seller_session SET last_seen_at = now() - make_interval(secs => $2) WHERE token_hash = $1`,
      [auth.hashSessionToken(expired.token), harness.config.sessionIdleSeconds + 1],
    );
    const unknownToken = auth.generateSessionToken();
    const cases: [string, Session | undefined][] = [
      ['missing', undefined],
      ['malformed', { token: 'not-a-token', antiForgery: 'irrelevant' }],
      ['unknown', { token: unknownToken, antiForgery: auth.antiForgeryTokenFor(unknownToken) }],
      ['revoked', revoked],
      ['expired', expired],
    ];
    const before = await snapshot(sellerA.sellerId);
    tenantContextCalls.mockClear();
    for (const [label, session] of cases) {
      const res = await create(session, randomUUID(), FACTS);
      expect(res.statusCode, `create ${label}`).toBe(401);
      expect(res.json(), `create ${label}`).toEqual({ error: 'unauthenticated' });
      expect(cookieOf(res, harness.cookieName)?.value, `create ${label}`).toBe('');
      expect((await read(session?.token, randomUUID())).statusCode, `read ${label}`).toBe(401);
      expect(
        (await setPrice(session, randomUUID(), randomUUID(), { expectedRowVersion: 1, price: PRICE }))
          .statusCode,
        `price ${label}`,
      ).toBe(401);
    }
    expect(tenantContextCalls).not.toHaveBeenCalled();
    expect(await snapshot(sellerA.sellerId)).toEqual(before);
  });

  it('refuses cross-site and anti-forgery-less create and asking-price requests before any mutation, and reads need neither', async () => {
    const before = await snapshot(sellerA.sellerId);
    for (const [label, res] of [
      ['create cross-site', await create(sessionA, randomUUID(), FACTS, { origin: 'https://evil.example' })],
      [
        'price cross-site',
        await setPrice(
          sessionA,
          randomUUID(),
          randomUUID(),
          { expectedRowVersion: 1, price: PRICE },
          { origin: 'https://evil.example' },
        ),
      ],
    ] as const) {
      expect(res.statusCode, label).toBe(403);
      expect(res.json(), label).toEqual({ error: 'forbidden_origin' });
    }
    const forged: Session = { token: sessionA.token, antiForgery: 'not-the-value' };
    for (const [label, res] of [
      ['create forged', await create(forged, randomUUID(), FACTS)],
      [
        'price forged',
        await setPrice(forged, randomUUID(), randomUUID(), { expectedRowVersion: 1, price: PRICE }),
      ],
    ] as const) {
      expect(res.statusCode, label).toBe(403);
      expect(res.json(), label).toEqual({ error: 'forbidden_anti_forgery' });
    }
    expect(await snapshot(sellerA.sellerId)).toEqual(before);
    // GET carries no state change: no origin, no anti-forgery, no key, and a key is ignored.
    const made = created(await create(sessionA, randomUUID()));
    const plain = await read(sessionA.token, made.id);
    const keyed = await read(sessionA.token, made.id, {
      [IDEMPOTENCY_KEY_HEADER]: randomUUID(),
      origin: 'https://evil.example',
    });
    expect(plain.statusCode).toBe(200);
    expect(keyed.statusCode).toBe(200);
    expect(keyed.body).toBe(plain.body);
    const after = await snapshot(sellerA.sellerId);
    expect(after.receipts).toHaveLength(before.receipts.length + 1);
    expect(after.events.map((e) => e.event_type)).toEqual([
      ...before.events.map((e) => e.event_type),
      'LISTING_CREATED',
    ]);
  });

  it('creates the inventory item and its DRAFT listing for a seller with no pre-seeded item, in one transaction with one event and one receipt, replays exactly, and conflicts on changed facts or another command', async () => {
    const fresh = await provisionAccount(env, {
      displayName: 'Synthetic Seller LN',
      email: address('seller-ln'),
      password: PASSWORD,
    });
    const session = remember(await signIn(harness, fresh));
    expect(await snapshot(fresh.sellerId)).toEqual({ listings: [], items: [], events: [], receipts: [] });
    const key = randomUUID();
    const first = await create(session, key, FACTS);
    expect(first.statusCode).toBe(201);
    const listing = first.json<{ listing: Record<string, unknown> }>().listing;
    expect(Object.keys(listing).sort()).toEqual(VIEW_KEYS);
    expect(listing).toMatchObject({
      status: 'DRAFT',
      askingPrice: null,
      rowVersion: 1,
      listedAt: null,
      closedAt: null,
    });
    expect(String(listing['inventoryItemId'])).toMatch(/^[0-9a-f-]{36}$/);
    const state = await snapshot(fresh.sellerId);
    expect(state.items).toEqual([
      {
        id: listing['inventoryItemId'],
        seller_id: fresh.sellerId,
        acquisition_cost_minor: FACTS.acquisitionCost.amountMinor,
        acquisition_currency: 'CAD',
        acquisition_date: FACTS.acquisitionDate,
      },
    ]);
    expect(state.listings).toHaveLength(1);
    expect(state.listings[0]).toMatchObject({
      id: listing['id'],
      seller_id: fresh.sellerId,
      inventory_item_id: listing['inventoryItemId'],
      status: 'DRAFT',
      row_version: 1,
    });
    expect(state.events).toHaveLength(1);
    expect(state.events[0]).toMatchObject({
      event_type: 'LISTING_CREATED',
      subject_id: listing['id'],
      idempotency_key: key,
      summary: { status: 'DRAFT', inventory_item_id: listing['inventoryItemId'] },
    });
    expect(state.receipts).toHaveLength(1);
    expect(state.receipts[0]).toMatchObject({
      idempotency_key: key,
      command: 'listing.create_with_item',
      subject_id: listing['id'],
    });
    expect(state.receipts[0]?.request_id).toBe(state.events[0]?.request_id);
    expect(JSON.stringify(state.receipts[0]?.outcome)).not.toMatch(/acquisition|minimum|password|token/i);

    // Exact replay: identical body and status, the same identifiers, no second record of any kind.
    const replay = await create(session, key, FACTS);
    expect(replay.statusCode).toBe(201);
    expect(replay.body).toBe(first.body);
    expect(await snapshot(fresh.sellerId)).toEqual(state);

    // The key with changed facts, with the facts reordered but equal, and for another command.
    const changed = await create(session, key, { ...FACTS, acquisitionDate: '2026-01-16' });
    expect(changed.statusCode).toBe(409);
    expect(changed.json()).toEqual({ error: 'idempotency_conflict' });
    const reordered = await create(session, key, {
      acquisitionDate: FACTS.acquisitionDate,
      acquisitionCost: { currency: 'CAD', amountMinor: FACTS.acquisitionCost.amountMinor },
    });
    expect(reordered.statusCode).toBe(201);
    expect(reordered.body).toBe(first.body);
    const otherCommand = await setPrice(session, key, String(listing['id']), {
      expectedRowVersion: 1,
      price: PRICE,
    });
    expect(otherCommand.statusCode).toBe(409);
    expect(await snapshot(fresh.sellerId)).toEqual(state);

    // Blank facts are allowed: unknown, never zero, never imputed.
    const blank = created(await create(session, randomUUID(), {}));
    expect((await itemRows(fresh.sellerId)).find((r) => r.id === blank.inventoryItemId)).toMatchObject({
      acquisition_cost_minor: null,
      acquisition_currency: null,
      acquisition_date: null,
    });
    expect(await listingRows(fresh.sellerId)).toHaveLength(2);
  });

  it('rolls back the inventory item, the listing, the event and the receipt together when any of the four writes fails', async () => {
    const session = remember(await signIn(harness, faulty));
    const inject = async (table: string, condition: string) => {
      await query(
        env.superuserUrl,
        `CREATE FUNCTION public.fail_listing_for_test() RETURNS trigger LANGUAGE plpgsql AS $$
           BEGIN RAISE EXCEPTION 'injected failure'; END $$;
         CREATE TRIGGER fail_listing_for_test BEFORE INSERT ON ${table}
           FOR EACH ROW WHEN (${condition}) EXECUTE FUNCTION public.fail_listing_for_test();`,
      );
      return async () => {
        await query(
          env.superuserUrl,
          `DROP TRIGGER fail_listing_for_test ON ${table}; DROP FUNCTION public.fail_listing_for_test();`,
        );
      };
    };
    const empty = { listings: [], items: [], events: [], receipts: [] };
    const faults: [string, string, string][] = [
      ['inventory insert', 'app.inventory_item', `NEW.seller_id = '${faulty.sellerId}'`],
      ['listing insert after the item', 'app.listing', `NEW.seller_id = '${faulty.sellerId}'`],
      [
        'audit event after both records',
        'app.audit_event',
        `NEW.seller_id = '${faulty.sellerId}' AND NEW.event_type = 'LISTING_CREATED'`,
      ],
      ['receipt after records and event', 'app.idempotency_receipt', `NEW.seller_id = '${faulty.sellerId}'`],
    ];
    const key = randomUUID();
    for (const [label, table, condition] of faults) {
      const remove = await inject(table, condition);
      try {
        const res = await create(session, key, FACTS);
        expect(res.statusCode, label).toBe(500);
        expect(res.json(), label).toEqual({ error: 'internal' });
      } finally {
        await remove();
      }
      expect(await snapshot(faulty.sellerId), label).toEqual(empty);
    }
    // With the faults gone the same key creates once and then replays.
    const ok = await create(session, key, FACTS);
    expect(ok.statusCode).toBe(201);
    expect((await create(session, key, FACTS)).body).toBe(ok.body);
    const state = await snapshot(faulty.sellerId);
    expect(state.items).toHaveLength(1);
    expect(state.listings).toHaveLength(1);
    expect(state.events).toHaveLength(1);
    expect(state.receipts).toHaveLength(1);
    expect(harness.logText()).toMatch(/"error_type":/);
  });

  it('sets the asking price with the expected version, replays the outcome exactly, and treats the same price as a no-op that consumes its key', async () => {
    const id = created(await create(sessionA, randomUUID())).id;
    const key = randomUUID();
    const first = await setPrice(sessionA, key, id, { expectedRowVersion: 1, price: PRICE });
    expect(first.statusCode).toBe(200);
    const listing = first.json<{ listing: Record<string, unknown> }>().listing;
    expect(Object.keys(listing).sort()).toEqual(VIEW_KEYS);
    expect(listing).toMatchObject({ id, askingPrice: PRICE, rowVersion: 2, status: 'DRAFT' });
    const rowAfter = (await listingRows(sellerA.sellerId)).find((r) => r.id === id);
    expect(rowAfter).toMatchObject({
      asking_price_minor: PRICE.amountMinor,
      currency: 'CAD',
      row_version: 2,
    });
    const changed = (await events(sellerA.sellerId)).filter(
      (e) => e.event_type === 'LISTING_ASKING_PRICE_CHANGED' && e.subject_id === id,
    );
    expect(changed).toHaveLength(1);
    expect(changed[0]?.summary).toEqual({
      previous_asking_price_minor: null,
      previous_currency: null,
      asking_price_minor: PRICE.amountMinor,
      currency: 'CAD',
      row_version: 2,
    });
    // Exact replay: identical body, no write, no version increment, no event.
    const replay = await setPrice(sessionA, key, id, { expectedRowVersion: 1, price: PRICE });
    expect(replay.statusCode).toBe(200);
    expect(replay.body).toBe(first.body);
    expect((await listingRows(sellerA.sellerId)).find((r) => r.id === id)).toEqual(rowAfter);
    expect(
      (await events(sellerA.sellerId)).filter(
        (e) => e.subject_id === id && e.event_type === 'LISTING_ASKING_PRICE_CHANGED',
      ),
    ).toHaveLength(1);
    // The same price under a new key: the domain's no-op, 200 with the unchanged listing, no
    // write, no event, and (canonical rule of migration 0003) a consumed key with a stored outcome.
    const noOpKey = randomUUID();
    const noOp = await setPrice(sessionA, noOpKey, id, { expectedRowVersion: 2, price: PRICE });
    expect(noOp.statusCode).toBe(200);
    expect(noOp.json<{ listing: { rowVersion: number } }>().listing.rowVersion).toBe(2);
    expect((await listingRows(sellerA.sellerId)).find((r) => r.id === id)).toEqual(rowAfter);
    expect(
      (await events(sellerA.sellerId)).filter(
        (e) => e.subject_id === id && e.event_type === 'LISTING_ASKING_PRICE_CHANGED',
      ),
    ).toHaveLength(1);
    expect((await receipts(sellerA.sellerId)).filter((r) => r.idempotency_key === noOpKey)).toHaveLength(1);
    expect((await setPrice(sessionA, noOpKey, id, { expectedRowVersion: 2, price: PRICE })).body).toBe(
      noOp.body,
    );
    const later = await setPrice(sessionA, randomUUID(), id, { expectedRowVersion: 2, price: OTHER_PRICE });
    expect(later.statusCode).toBe(200);
    expect(later.json<{ listing: { rowVersion: number; askingPrice: Money } }>().listing).toMatchObject({
      rowVersion: 3,
      askingPrice: OTHER_PRICE,
    });
  });

  it('fails without mutation or success event on a stale version, a non-DRAFT state, invalid facts or prices, unknown fields, malformed identifiers or a missing key', async () => {
    const id = created(await create(sessionA, randomUUID())).id;
    expect(
      (await setPrice(sessionA, randomUUID(), id, { expectedRowVersion: 1, price: PRICE })).statusCode,
    ).toBe(200);
    const ready = await buildListing(harness.runtime.db, sellerA.sellerId);
    await withTenant(harness.runtime.db, sellerA.sellerId, (trx) =>
      listings.markReady(trx, command(sellerA.sellerId, 'ready'), {
        listingId: ready.listingId,
        expectedRowVersion: ready.rowVersion,
      }),
    );
    const before = await snapshot(sellerA.sellerId);
    const attempts: [string, Promise<LightMyRequestResponse>, number, string][] = [
      [
        'stale version',
        setPrice(sessionA, randomUUID(), id, { expectedRowVersion: 1, price: OTHER_PRICE }),
        409,
        'stale_row_version',
      ],
      [
        'READY listing',
        setPrice(sessionA, randomUUID(), ready.listingId, { expectedRowVersion: 99, price: OTHER_PRICE }),
        409,
        'invalid_state',
      ],
      [
        'lowercase currency',
        setPrice(sessionA, randomUUID(), id, {
          expectedRowVersion: 2,
          price: { amountMinor: 100, currency: 'cad' },
        }),
        400,
        'bad_request',
      ],
      [
        'fractional amount',
        setPrice(sessionA, randomUUID(), id, {
          expectedRowVersion: 2,
          price: { amountMinor: 100.5, currency: 'CAD' },
        }),
        400,
        'bad_request',
      ],
      [
        'negative amount',
        setPrice(sessionA, randomUUID(), id, {
          expectedRowVersion: 2,
          price: { amountMinor: -1, currency: 'CAD' },
        }),
        400,
        'bad_request',
      ],
      [
        'unknown price field',
        setPrice(sessionA, randomUUID(), id, { expectedRowVersion: 2, price: PRICE, minimumPrice: PRICE }),
        400,
        'bad_request',
      ],
      [
        'malformed id',
        setPrice(sessionA, randomUUID(), 'not-a-uuid', { expectedRowVersion: 2, price: PRICE }),
        400,
        'bad_request',
      ],
      [
        'missing key',
        setPrice(sessionA, undefined, id, { expectedRowVersion: 2, price: PRICE }),
        400,
        'idempotency_key_required',
      ],
      [
        'malformed key',
        setPrice(sessionA, 'not-a-uuid', id, { expectedRowVersion: 2, price: PRICE }),
        400,
        'idempotency_key_required',
      ],
      ['create without key', create(sessionA, undefined, FACTS), 400, 'idempotency_key_required'],
      [
        'create malformed date',
        create(sessionA, randomUUID(), { acquisitionDate: '15/01/2026' }),
        400,
        'bad_request',
      ],
      [
        'create fractional cost',
        create(sessionA, randomUUID(), { acquisitionCost: { amountMinor: 10.5, currency: 'CAD' } }),
        400,
        'bad_request',
      ],
      [
        'create cost without currency',
        create(sessionA, randomUUID(), { acquisitionCost: { amountMinor: 10 } }),
        400,
        'bad_request',
      ],
      [
        'create unknown fact',
        create(sessionA, randomUUID(), { acquisitionNote: 'from a fictional auction' }),
        400,
        'bad_request',
      ],
      ['create asking price', create(sessionA, randomUUID(), { askingPrice: PRICE }), 400, 'bad_request'],
      ['create minimum price', create(sessionA, randomUUID(), { minimumPrice: PRICE }), 400, 'bad_request'],
      ['read malformed id', read(sessionA.token, 'not-a-uuid'), 400, 'bad_request'],
    ];
    for (const [label, pending, status, error] of attempts) {
      const res = await pending;
      expect(res.statusCode, label).toBe(status);
      expect(res.json(), label).toEqual({ error });
    }
    expect(await snapshot(sellerA.sellerId)).toEqual(before);
  });

  it('keeps tenants apart: seller B gets not_found for seller A’s listing exactly as for nothing, cannot see A’s item under its own context, and leaves no trace of A on its side', async () => {
    const made = created(await create(sessionA, randomUUID(), FACTS));
    const stateA = await snapshot(sellerA.sellerId);
    const absent = randomUUID();
    const shape = (res: LightMyRequestResponse) =>
      `${res.statusCode}|${res.body}|${String(res.headers['content-type'])}|${String(res.headers['content-length'])}`;
    const readA = await read(sessionB.token, made.id);
    const readAbsent = await read(sessionB.token, absent);
    expect(readA.statusCode).toBe(404);
    expect(shape(readA)).toBe(shape(readAbsent));
    const priceA = await setPrice(sessionB, randomUUID(), made.id, { expectedRowVersion: 1, price: PRICE });
    const priceAbsent = await setPrice(sessionB, randomUUID(), absent, {
      expectedRowVersion: 1,
      price: PRICE,
    });
    expect(priceA.statusCode).toBe(404);
    expect(shape(priceA)).toBe(shape(priceAbsent));
    // No existing item of any seller can be attached through the route.
    expect((await create(sessionB, randomUUID(), { inventoryItemId: made.inventoryItemId })).statusCode).toBe(
      400,
    );
    expect((await create(sessionA, randomUUID(), { inventoryItemId: made.inventoryItemId })).statusCode).toBe(
      400,
    );
    // Under B's own tenant context A's item and listing do not exist.
    const seenByB = await withTenant(harness.runtime.db, sellerB.sellerId, async (trx) => ({
      item: await trx
        .selectFrom('inventory_item')
        .select('id')
        .where('id', '=', made.inventoryItemId)
        .executeTakeFirst(),
      listing: await trx.selectFrom('listing').select('id').where('id', '=', made.id).executeTakeFirst(),
    }));
    expect(seenByB).toEqual({ item: undefined, listing: undefined });
    expect(await snapshot(sellerA.sellerId)).toEqual(stateA);
    const stateB = await snapshot(sellerB.sellerId);
    expect(stateB.listings).toEqual([]);
    expect(stateB.items).toEqual([]);
    expect(stateB.receipts).toEqual([]);
    expect(JSON.stringify(stateB.events)).not.toContain(made.id);
    expect(JSON.stringify(stateB.events)).not.toContain(made.inventoryItemId);
    // A still reads and mutates its own listing.
    expect((await read(sessionA.token, made.id)).statusCode).toBe(200);
    expect(
      (await setPrice(sessionA, randomUUID(), made.id, { expectedRowVersion: 1, price: PRICE })).statusCode,
    ).toBe(200);
  });

  it('rejects client-supplied inventory, seller, tenant, account, session and listing fields and ignores identity headers', async () => {
    const before = await snapshot(sellerA.sellerId);
    for (const [label, payload] of [
      ['inventoryItemId', { inventoryItemId: randomUUID() }],
      ['sellerId', { sellerId: sellerB.sellerId }],
      ['seller_id', { seller_id: sellerB.sellerId }],
      ['tenantId', { tenantId: sellerB.sellerId }],
      ['accountId', { accountId: sellerB.accountId }],
      ['sessionId', { sessionId: randomUUID() }],
      ['status', { status: 'LISTED' }],
      ['publicId', { publicId: 'abcdefghijklmnop' }],
      ['accessCode', { accessCode: '123456' }],
      ['rowVersion', { rowVersion: 7 }],
      ['policyVersionId', { policyVersionId: randomUUID() }],
    ] as const) {
      const res = await create(sessionA, randomUUID(), payload);
      expect(res.statusCode, label).toBe(400);
      expect(res.json(), label).toEqual({ error: 'bad_request' });
    }
    expect(await snapshot(sellerA.sellerId)).toEqual(before);
    // Identity headers change nothing: both records belong to the session's tenant.
    const spoofed = await create(sessionA, randomUUID(), FACTS, {
      'x-seller-id': sellerB.sellerId,
      'x-tenant-id': sellerB.sellerId,
    });
    expect(spoofed.statusCode).toBe(201);
    const made = created(spoofed);
    expect((await listingRows(sellerA.sellerId)).find((r) => r.id === made.id)?.seller_id).toBe(
      sellerA.sellerId,
    );
    expect((await itemRows(sellerA.sellerId)).find((r) => r.id === made.inventoryItemId)?.seller_id).toBe(
      sellerA.sellerId,
    );
    expect(await listingRows(sellerB.sellerId)).toEqual([]);
    expect(await itemRows(sellerB.sellerId)).toEqual([]);
  });

  it('leaves no tenant context on a reused pooled connection after create, read and asking-price requests', async () => {
    const one = await startAuthApp(env, { poolMax: 1 });
    try {
      const s = remember(await signIn(one, sellerA));
      const connectionState = () =>
        one.runtime.db.transaction().execute(async (trx) => {
          const value = await sql<{ setting: string | null; seller: string | null }>`
            select current_setting(${TENANT_SETTING}, true) as setting, app.current_seller_id()::text as seller`.execute(
            trx,
          );
          const visible = await sql<{ n: string }>`select count(*)::text as n from app.listing`.execute(trx);
          const items = await sql<{ n: string }>`select count(*)::text as n from app.inventory_item`.execute(
            trx,
          );
          return {
            setting: value.rows[0]?.setting ?? '',
            seller: value.rows[0]?.seller ?? null,
            visible: Number(visible.rows[0]?.n) + Number(items.rows[0]?.n),
          };
        });
      const made = await create(s, randomUUID(), FACTS, {}, one);
      expect(made.statusCode).toBe(201);
      expect(await connectionState()).toEqual({ setting: '', seller: null, visible: 0 });
      const id = created(made).id;
      expect((await get(one, `${LISTINGS}/${id}`, s.token)).statusCode).toBe(200);
      expect(await connectionState()).toEqual({ setting: '', seller: null, visible: 0 });
      expect(
        (await setPrice(s, randomUUID(), id, { expectedRowVersion: 1, price: PRICE }, {}, one)).statusCode,
      ).toBe(200);
      expect(await connectionState()).toEqual({ setting: '', seller: null, visible: 0 });
    } finally {
      await one.close();
    }
  });

  it('exposes no seller, account, session, policy, receipt, audit or secret field in any response, and logs no cookie, token, anti-forgery value, price floor or body', () => {
    const forbidden =
      /seller_?id|tenant|account_?id|session_?id|minimum|target|policy|receipt|fingerprint|audit|token|hash|code|secret|cookie|acquisition/i;
    for (const body of responses) {
      if (!body) continue;
      const parsed = JSON.parse(body) as Record<string, unknown>;
      const keys: string[] = [];
      const walk = (value: unknown) => {
        if (Array.isArray(value)) value.forEach(walk);
        else if (typeof value === 'object' && value !== null)
          for (const [k, v] of Object.entries(value)) {
            keys.push(k);
            walk(v);
          }
      };
      walk(parsed);
      for (const k of keys) expect(k, body).not.toMatch(forbidden);
      expect(body).not.toContain(sellerA.sellerId);
      expect(body).not.toContain(sellerB.sellerId);
    }
    const log = harness.logText();
    for (const s of secrets) expect(log).not.toContain(s);
    expect(log).not.toMatch(/"cookie":"(?!\[REDACTED\])/);
    expect(log).not.toContain('"amountMinor"');
    expect(log).not.toContain(`"amountMinor":${FIXTURE.minimumPrice.amountMinor}`);
    expect(log).not.toMatch(/minimum_?price/i);
    expect(log).not.toContain('acquisitionDate');
  });
});
