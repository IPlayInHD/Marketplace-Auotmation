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

// Slice 1e: the first authenticated seller listing routes over withSellerSession. Every account,
// item and amount is synthetic (D-18, DATA-110). Proofs: authentication and CSRF on every route,
// read-only GET, create and asking-price with exact replay and conflicts, the same-price no-op,
// refusals without mutation, tenant isolation indistinguishable from absence (AUTH-221), no
// client-supplied identity (AUTH-220), no tenant context on a pooled connection, and no secret or
// internal field in responses or logs.

const DOMAIN = 'synthetic.invalid';
const address = (local: string) => [local, DOMAIN].join('@');
const PASSWORD = 'synthetic passphrase for listings';
const LISTINGS = `${ROUTE_PREFIXES.seller}/listings`;
const PRICE: Money = { amountMinor: 12_500, currency: 'CAD' };
const OTHER_PRICE: Money = { amountMinor: 13_000, currency: 'CAD' };
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

describe('Seller listing routes (Slice 1e)', () => {
  let env: TestDatabase;
  let harness: AuthApp;
  let sellerA: SyntheticAccount;
  let sellerB: SyntheticAccount;
  let sessionA: Session;
  let sessionB: Session;
  const secrets: string[] = [PASSWORD];
  const responses: string[] = [];
  const remember = (s: Session): Session => {
    secrets.push(s.token, s.antiForgery);
    return s;
  };
  const withKey = (key: string, extra: Record<string, string> = {}) => ({
    headers: { origin: TEST_ORIGIN, [IDEMPOTENCY_KEY_HEADER]: key, ...extra },
  });
  const record = (res: LightMyRequestResponse) => {
    responses.push(res.body);
    return res;
  };
  const newItem = (sellerId: string) =>
    withTenant(harness.runtime.db, sellerId, (trx) =>
      listings.createInventoryItem(trx, { sellerId, requestId: `req-item-${randomUUID()}` }),
    );
  const create = (
    session: Session | undefined,
    key: string | undefined,
    payload: unknown,
    extra: Record<string, string> = {},
  ) =>
    harness.app
      .inject({
        method: 'POST',
        url: LISTINGS,
        headers: key === undefined ? { origin: TEST_ORIGIN, ...extra } : withKey(key, extra).headers,
        ...(session ? { cookies: { [harness.cookieName]: session.token } } : {}),
        ...(session
          ? {
              headers: {
                ...(key === undefined ? { origin: TEST_ORIGIN } : withKey(key).headers),
                ...extra,
                [auth.ANTI_FORGERY_HEADER]: session.antiForgery,
              },
            }
          : {}),
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
  ) =>
    harness.app
      .inject({
        method: 'PATCH',
        url: `${LISTINGS}/${listingId}/asking-price`,
        headers: {
          ...(key === undefined ? { origin: TEST_ORIGIN } : withKey(key).headers),
          ...extra,
          ...(session ? { [auth.ANTI_FORGERY_HEADER]: session.antiForgery } : {}),
        },
        ...(session ? { cookies: { [harness.cookieName]: session.token } } : {}),
        payload: payload as Record<string, unknown>,
      })
      .then(record);
  const listingRows = (sellerId: string) =>
    query<{
      id: string;
      seller_id: string;
      status: string;
      asking_price_minor: number | null;
      currency: string | null;
      row_version: number;
      xmin: string;
    }>(
      env.superuserUrl,
      `SELECT id, seller_id, status, asking_price_minor, currency, row_version, xmin::text AS xmin FROM app.listing WHERE seller_id = $1 ORDER BY created_at`,
      [sellerId],
    );
  const events = (sellerId: string) =>
    query<{
      event_type: string;
      subject_id: string;
      idempotency_key: string | null;
      summary: Record<string, unknown>;
    }>(
      env.superuserUrl,
      `SELECT event_type::text, subject_id, idempotency_key, summary FROM app.audit_event WHERE seller_id = $1 AND event_type::text LIKE 'LISTING_%' ORDER BY seq`,
      [sellerId],
    );
  const receipts = (sellerId: string) =>
    query<{ idempotency_key: string; command: string; subject_id: string; outcome: Record<string, unknown> }>(
      env.superuserUrl,
      `SELECT idempotency_key, command, subject_id, outcome FROM app.idempotency_receipt WHERE seller_id = $1 ORDER BY created_at`,
      [sellerId],
    );

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
    harness = await startAuthApp(env, { poolMax: 4 });
    sessionA = remember(await signIn(harness, sellerA));
    sessionB = remember(await signIn(harness, sellerB));
  });
  afterAll(async () => {
    await harness?.close();
    await env?.stop();
  });

  it('requires a live session on every route: missing, malformed, unknown, revoked and expired sessions answer 401 and never reach tenant context', async () => {
    const item = await newItem(sellerA.sellerId);
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
    const rowsBefore = await listingRows(sellerA.sellerId);
    tenantContextCalls.mockClear();
    for (const [label, session] of cases) {
      const created = await create(session, randomUUID(), { inventoryItemId: item.id });
      expect(created.statusCode, `create ${label}`).toBe(401);
      expect(created.json(), `create ${label}`).toEqual({ error: 'unauthenticated' });
      expect(cookieOf(created, harness.cookieName)?.value, `create ${label}`).toBe('');
      const got = await read(session?.token, randomUUID());
      expect(got.statusCode, `read ${label}`).toBe(401);
      const priced = await setPrice(session, randomUUID(), randomUUID(), {
        expectedRowVersion: 1,
        price: PRICE,
      });
      expect(priced.statusCode, `price ${label}`).toBe(401);
    }
    expect(tenantContextCalls).not.toHaveBeenCalled();
    expect(await listingRows(sellerA.sellerId)).toEqual(rowsBefore);
  });

  it('refuses cross-site and anti-forgery-less create and asking-price requests before any mutation, and reads need neither', async () => {
    const item = await newItem(sellerA.sellerId);
    const rowsBefore = await listingRows(sellerA.sellerId);
    const eventsBefore = await events(sellerA.sellerId);
    const receiptsBefore = await receipts(sellerA.sellerId);
    for (const [label, res] of [
      [
        'create cross-site',
        await create(
          sessionA,
          randomUUID(),
          { inventoryItemId: item.id },
          { origin: 'https://evil.example' },
        ),
      ],
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
      ['create forged', await create(forged, randomUUID(), { inventoryItemId: item.id })],
      [
        'price forged',
        await setPrice(forged, randomUUID(), randomUUID(), { expectedRowVersion: 1, price: PRICE }),
      ],
    ] as const) {
      expect(res.statusCode, label).toBe(403);
      expect(res.json(), label).toEqual({ error: 'forbidden_anti_forgery' });
    }
    expect(await listingRows(sellerA.sellerId)).toEqual(rowsBefore);
    expect(await events(sellerA.sellerId)).toEqual(eventsBefore);
    expect(await receipts(sellerA.sellerId)).toEqual(receiptsBefore);
    // GET carries no state change: no origin, no anti-forgery, no key, and a key is ignored.
    const created = await create(sessionA, randomUUID(), { inventoryItemId: item.id });
    expect(created.statusCode).toBe(201);
    const id = created.json<{ listing: { id: string } }>().listing.id;
    const plain = await read(sessionA.token, id);
    const keyed = await read(sessionA.token, id, {
      [IDEMPOTENCY_KEY_HEADER]: randomUUID(),
      origin: 'https://evil.example',
    });
    expect(plain.statusCode).toBe(200);
    expect(keyed.statusCode).toBe(200);
    expect(keyed.body).toBe(plain.body);
    const receiptsAfter = await receipts(sellerA.sellerId);
    expect(receiptsAfter).toHaveLength(receiptsBefore.length + 1);
    expect(receiptsAfter.at(-1)?.command).toBe('listing.create');
    expect((await events(sellerA.sellerId)).map((e) => e.event_type)).toEqual([
      ...eventsBefore.map((e) => e.event_type),
      'LISTING_CREATED',
    ]);
  });

  it('creates a DRAFT listing with 201, one LISTING_CREATED event and one receipt, replays it exactly, and conflicts on another payload or command', async () => {
    const item = await newItem(sellerA.sellerId);
    const key = randomUUID();
    const rowsBefore = (await listingRows(sellerA.sellerId)).length;
    const first = await create(sessionA, key, { inventoryItemId: item.id });
    expect(first.statusCode).toBe(201);
    const listing = first.json<{ listing: Record<string, unknown> }>().listing;
    expect(Object.keys(listing).sort()).toEqual(VIEW_KEYS);
    expect(listing).toMatchObject({
      inventoryItemId: item.id,
      status: 'DRAFT',
      askingPrice: null,
      rowVersion: 1,
      listedAt: null,
      closedAt: null,
    });
    const rows = await listingRows(sellerA.sellerId);
    expect(rows).toHaveLength(rowsBefore + 1);
    expect(rows.at(-1)).toMatchObject({
      id: listing['id'],
      seller_id: sellerA.sellerId,
      status: 'DRAFT',
      row_version: 1,
    });
    const created = (await events(sellerA.sellerId)).filter(
      (e) => e.event_type === 'LISTING_CREATED' && e.subject_id === listing['id'],
    );
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ idempotency_key: key, summary: { status: 'DRAFT' } });
    const stored = (await receipts(sellerA.sellerId)).filter((r) => r.idempotency_key === key);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ command: 'listing.create', subject_id: listing['id'] });

    // Exact replay: the same body and status, and no second row, event or receipt.
    const replay = await create(sessionA, key, { inventoryItemId: item.id });
    expect(replay.statusCode).toBe(201);
    expect(replay.body).toBe(first.body);
    expect(await listingRows(sellerA.sellerId)).toEqual(rows);
    expect((await events(sellerA.sellerId)).filter((e) => e.subject_id === listing['id'])).toHaveLength(1);
    expect((await receipts(sellerA.sellerId)).filter((r) => r.idempotency_key === key)).toHaveLength(1);

    // The key with another payload, or for another command, conflicts and changes nothing.
    const otherItem = await newItem(sellerA.sellerId);
    const otherPayload = await create(sessionA, key, { inventoryItemId: otherItem.id });
    expect(otherPayload.statusCode).toBe(409);
    expect(otherPayload.json()).toEqual({ error: 'idempotency_conflict' });
    const otherCommand = await setPrice(sessionA, key, String(listing['id']), {
      expectedRowVersion: 1,
      price: PRICE,
    });
    expect(otherCommand.statusCode).toBe(409);
    expect(otherCommand.json()).toEqual({ error: 'idempotency_conflict' });
    expect(await listingRows(sellerA.sellerId)).toEqual(rows);
    // A second listing for an item that already carries a live one is a state conflict.
    const duplicate = await create(sessionA, randomUUID(), { inventoryItemId: item.id });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json()).toEqual({ error: 'invalid_state' });
    expect(await listingRows(sellerA.sellerId)).toEqual(rows);
  });

  it('sets the asking price with the expected version, replays the outcome exactly, and treats the same price as a no-op that consumes its key', async () => {
    const item = await newItem(sellerA.sellerId);
    const created = await create(sessionA, randomUUID(), { inventoryItemId: item.id });
    const id = created.json<{ listing: { id: string } }>().listing.id;
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
    const noOpReceipt = (await receipts(sellerA.sellerId)).filter((r) => r.idempotency_key === noOpKey);
    expect(noOpReceipt).toHaveLength(1);
    expect((await setPrice(sessionA, noOpKey, id, { expectedRowVersion: 2, price: PRICE })).body).toBe(
      noOp.body,
    );
    // A later change under yet another key advances the version once more.
    const later = await setPrice(sessionA, randomUUID(), id, { expectedRowVersion: 2, price: OTHER_PRICE });
    expect(later.statusCode).toBe(200);
    expect(later.json<{ listing: { rowVersion: number; askingPrice: Money } }>().listing).toMatchObject({
      rowVersion: 3,
      askingPrice: OTHER_PRICE,
    });
  });

  it('fails without mutation or success event on a stale version, a non-DRAFT state, an invalid currency, a fractional or negative amount, an unknown field or a malformed identifier', async () => {
    const item = await newItem(sellerA.sellerId);
    const id = (await create(sessionA, randomUUID(), { inventoryItemId: item.id })).json<{
      listing: { id: string };
    }>().listing.id;
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
    const rowsBefore = await listingRows(sellerA.sellerId);
    const eventsBefore = await events(sellerA.sellerId);
    const receiptsBefore = await receipts(sellerA.sellerId);
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
        'unknown field',
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
      [
        'create without key',
        create(sessionA, undefined, { inventoryItemId: item.id }),
        400,
        'idempotency_key_required',
      ],
      [
        'create malformed body',
        create(sessionA, randomUUID(), { inventoryItemId: 'nope' }),
        400,
        'bad_request',
      ],
      ['read malformed id', read(sessionA.token, 'not-a-uuid'), 400, 'bad_request'],
    ];
    for (const [label, pending, status, error] of attempts) {
      const res = await pending;
      expect(res.statusCode, label).toBe(status);
      expect(res.json(), label).toEqual({ error });
    }
    expect(await listingRows(sellerA.sellerId)).toEqual(rowsBefore);
    expect(await events(sellerA.sellerId)).toEqual(eventsBefore);
    expect(await receipts(sellerA.sellerId)).toEqual(receiptsBefore);
  });

  it('keeps tenants apart: seller B gets not_found for seller A’s listing and item exactly as for nothing, and leaves no trace of A in B’s events, receipts or rows', async () => {
    const itemA = await newItem(sellerA.sellerId);
    const idA = (await create(sessionA, randomUUID(), { inventoryItemId: itemA.id })).json<{
      listing: { id: string };
    }>().listing.id;
    const rowsA = await listingRows(sellerA.sellerId);
    const eventsA = await events(sellerA.sellerId);
    const absent = randomUUID();
    const shape = (res: LightMyRequestResponse) =>
      `${res.statusCode}|${res.body}|${String(res.headers['content-type'])}|${String(res.headers['content-length'])}`;
    // Read.
    const readA = await read(sessionB.token, idA);
    const readAbsent = await read(sessionB.token, absent);
    expect(readA.statusCode).toBe(404);
    expect(shape(readA)).toBe(shape(readAbsent));
    // Price.
    const priceA = await setPrice(sessionB, randomUUID(), idA, { expectedRowVersion: 1, price: PRICE });
    const priceAbsent = await setPrice(sessionB, randomUUID(), absent, {
      expectedRowVersion: 1,
      price: PRICE,
    });
    expect(priceA.statusCode).toBe(404);
    expect(shape(priceA)).toBe(shape(priceAbsent));
    // Create against A's item, and against no item.
    const createA = await create(sessionB, randomUUID(), { inventoryItemId: itemA.id });
    const createAbsent = await create(sessionB, randomUUID(), { inventoryItemId: absent });
    expect(createA.statusCode).toBe(404);
    expect(shape(createA)).toBe(shape(createAbsent));
    // Nothing of A moved, and nothing of A appears on B's side.
    expect(await listingRows(sellerA.sellerId)).toEqual(rowsA);
    expect(await events(sellerA.sellerId)).toEqual(eventsA);
    expect(await listingRows(sellerB.sellerId)).toEqual([]);
    expect(await receipts(sellerB.sellerId)).toEqual([]);
    expect(JSON.stringify(await events(sellerB.sellerId))).not.toContain(idA);
    // A still reads and mutates its own listing.
    expect((await read(sessionA.token, idA)).statusCode).toBe(200);
    expect(
      (await setPrice(sessionA, randomUUID(), idA, { expectedRowVersion: 1, price: PRICE })).statusCode,
    ).toBe(200);
  });

  it('rejects client-supplied seller, tenant, account and session identifiers and ignores identity headers', async () => {
    const item = await newItem(sellerA.sellerId);
    const rowsBefore = await listingRows(sellerA.sellerId);
    for (const [label, payload] of [
      ['sellerId', { inventoryItemId: item.id, sellerId: sellerB.sellerId }],
      ['seller_id', { inventoryItemId: item.id, seller_id: sellerB.sellerId }],
      ['tenantId', { inventoryItemId: item.id, tenantId: sellerB.sellerId }],
      ['accountId', { inventoryItemId: item.id, accountId: sellerB.accountId }],
      ['sessionId', { inventoryItemId: item.id, sessionId: randomUUID() }],
      ['status', { inventoryItemId: item.id, status: 'LISTED' }],
      ['rowVersion', { inventoryItemId: item.id, rowVersion: 7 }],
    ] as const) {
      const res = await create(sessionA, randomUUID(), payload);
      expect(res.statusCode, label).toBe(400);
      expect(res.json(), label).toEqual({ error: 'bad_request' });
    }
    expect(await listingRows(sellerA.sellerId)).toEqual(rowsBefore);
    // Identity headers change nothing: the tenant is the session's.
    const spoofed = await create(
      sessionA,
      randomUUID(),
      { inventoryItemId: item.id },
      { 'x-seller-id': sellerB.sellerId, 'x-tenant-id': sellerB.sellerId },
    );
    expect(spoofed.statusCode).toBe(201);
    const id = spoofed.json<{ listing: { id: string } }>().listing.id;
    expect((await listingRows(sellerA.sellerId)).find((r) => r.id === id)?.seller_id).toBe(sellerA.sellerId);
    expect(await listingRows(sellerB.sellerId)).toEqual([]);
  });

  it('leaves no tenant context on a reused pooled connection after create, read and asking-price requests', async () => {
    const one = await startAuthApp(env, { poolMax: 1 });
    try {
      const s = remember(await signIn(one, sellerA));
      const item = await withTenant(one.runtime.db, sellerA.sellerId, (trx) =>
        listings.createInventoryItem(trx, {
          sellerId: sellerA.sellerId,
          requestId: `req-item-${randomUUID()}`,
        }),
      );
      const connectionState = () =>
        one.runtime.db.transaction().execute(async (trx) => {
          const value = await sql<{ setting: string | null; seller: string | null }>`
            select current_setting(${TENANT_SETTING}, true) as setting, app.current_seller_id()::text as seller`.execute(
            trx,
          );
          const visible = await sql<{ n: string }>`select count(*)::text as n from app.listing`.execute(trx);
          return {
            setting: value.rows[0]?.setting ?? '',
            seller: value.rows[0]?.seller ?? null,
            visible: Number(visible.rows[0]?.n),
          };
        });
      const created = await one.app.inject({
        method: 'POST',
        url: LISTINGS,
        headers: { ...withKey(randomUUID()).headers, [auth.ANTI_FORGERY_HEADER]: s.antiForgery },
        cookies: { [one.cookieName]: s.token },
        payload: { inventoryItemId: item.id },
      });
      expect(created.statusCode).toBe(201);
      expect(await connectionState()).toEqual({ setting: '', seller: null, visible: 0 });
      const id = created.json<{ listing: { id: string } }>().listing.id;
      expect((await get(one, `${LISTINGS}/${id}`, s.token)).statusCode).toBe(200);
      expect(await connectionState()).toEqual({ setting: '', seller: null, visible: 0 });
      const priced = await one.app.inject({
        method: 'PATCH',
        url: `${LISTINGS}/${id}/asking-price`,
        headers: { ...withKey(randomUUID()).headers, [auth.ANTI_FORGERY_HEADER]: s.antiForgery },
        cookies: { [one.cookieName]: s.token },
        payload: { expectedRowVersion: 1, price: PRICE },
      });
      expect(priced.statusCode).toBe(200);
      expect(await connectionState()).toEqual({ setting: '', seller: null, visible: 0 });
    } finally {
      await one.close();
    }
  });

  it('exposes no seller, account, session, policy, receipt, audit or secret field in any response, and logs no cookie, token, anti-forgery value, price floor or body', () => {
    const forbidden =
      /seller_?id|tenant|account_?id|session_?id|minimum|target|policy|receipt|fingerprint|audit|token|hash|code|secret|cookie/i;
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
    expect(log).not.toContain('inventoryItemId');
  });
});
