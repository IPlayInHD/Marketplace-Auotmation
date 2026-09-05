import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TENANT_SETTING } from '../../src/db/constants.ts';
import { establishTenantContext, withTenant } from '../../src/db/kysely.ts';
import type * as KyselyModule from '../../src/db/kysely.ts';
import * as auth from '../../src/modules/identity-auth/index.ts';
import * as content from '../../src/modules/listing-content/index.ts';
import * as listings from '../../src/modules/listings/index.ts';
import * as publicAccess from '../../src/modules/public-listing-access/index.ts';
import { IDEMPOTENCY_KEY_HEADER } from '../../src/shared/command.ts';
import type { Money } from '../../src/shared/money.ts';
import { encodeCursor } from '../../src/shared/pagination.ts';
import { ROUTE_PREFIXES } from '../../src/web/app.ts';
import {
  AUTH_PREFIX,
  cookieOf,
  post,
  provisionAccount,
  signIn,
  signInRequest,
  startAuthApp,
  TEST_ORIGIN,
  type AuthApp,
  type Session,
  type SyntheticAccount,
} from '../helpers/auth.ts';
import { startDatabase, type TestDatabase } from '../helpers/database.ts';
import { command, FIXTURE, publishListing } from '../helpers/fixtures.ts';
import { query } from '../helpers/inspect.ts';

// The single tenant-context construction site is wrapped, unchanged in behaviour, so the tests
// can prove that no revoked, expired, unknown or malformed session ever reaches it.
vi.mock('../../src/db/kysely.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof KyselyModule>();
  return { ...actual, establishTenantContext: vi.fn(actual.establishTenantContext) };
});
const tenantContextCalls = vi.mocked(establishTenantContext);

// Slice 1i: three read-only dashboard reads over existing state. Every account, listing, word and
// amount is synthetic (D-18, DATA-110). Proofs: only the caller's listings are enumerated, newest
// first with the id as tie-breaker, in fixed clamped pages under a statement timeout (OPS-721),
// every cursor walk returning every listing exactly once even when all share one timestamp; the
// exact status filter; malformed sizes, cursors and unknown parameters refused with a fixed body;
// a cursor bounded by row-level security whoever presents it; the current private policy answered
// to its owner in the PUT shape, null when none, and found in no other response, event, receipt,
// log, workspace, enumeration or buyer-safe projection; the immutable history complete, ordered,
// exact and paged, an older eligible draft approvable from it, and unchanged by being read; foreign
// and nonexistent listings indistinguishable; refusals without tenant context; no key, receipt or
// event for any read; and no tenant context or timeout on a pooled connection.

const DOMAIN = 'synthetic.invalid';
const address = (local: string) => [local, DOMAIN].join('@');
const PASSWORD = 'synthetic passphrase for dashboard reads';
const LISTINGS = `${ROUTE_PREFIXES.seller}/listings`;
const FACTS = { name: 'Synthetic gravel bicycle', brand: 'Fictional Cycles', defects: 'saddle scuffed' };
const COPY: { title: string; summary: string | null; description: string | null } = {
  title: FIXTURE.copy.title,
  summary: FIXTURE.copy.summary,
  description: FIXTURE.copy.description,
};
const ASKING: Money = { amountMinor: 31_000, currency: 'CAD' };
const MINIMUM: Money = { amountMinor: 20_449, currency: 'CAD' };
const OTHER_MINIMUM: Money = { amountMinor: 19_883, currency: 'CAD' };
const RULES = {
  negotiationEnabled: true,
  tradesAllowed: false,
  deliveryAllowed: true,
  pickupAllowed: true,
  locationDisclosureMode: 'AREA' as const,
};
const BULK = 105;
const LISTING_KEYS = [
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
const POLICY_KEYS = [
  'createdAt',
  'deliveryAllowed',
  'holdWindowSeconds',
  'id',
  'locationDisclosureMode',
  'maxAutonomousConcession',
  'minimumPrice',
  'negotiationEnabled',
  'pickupAllowed',
  'tradesAllowed',
  'versionNumber',
];
const VERSION_KEYS = [
  'approvedAt',
  'createdAt',
  'description',
  'id',
  'provenance',
  'sourceVersionId',
  'status',
  'structuredDetails',
  'summary',
  'title',
  'versionNumber',
];

interface ListingView {
  id: string;
  status: string;
  rowVersion: number;
  askingPrice: Money | null;
  createdAt: string;
}
interface ListingBody {
  listing: ListingView;
}
interface ListBody {
  listings: ListingView[];
  nextCursor: string | null;
}
interface PolicyView {
  id: string;
  versionNumber: number;
  minimumPrice: Money;
  maxAutonomousConcession: Money | null;
  negotiationEnabled: boolean;
}
interface PolicyBody extends ListingBody {
  policyVersion: PolicyView | null;
}
interface VersionView {
  id: string;
  versionNumber: number;
  status: string;
  provenance: string;
  title: string;
  summary: string | null;
  description: string | null;
  structuredDetails: Record<string, string>;
  sourceVersionId: string | null;
  createdAt: string;
  approvedAt: string | null;
}
interface HistoryBody {
  versions: VersionView[];
  nextCursor: string | null;
}
interface DraftBody extends ListingBody {
  draft: { id: string; versionNumber: number };
}
interface WorkspaceBody extends ListingBody {
  facts: Record<string, { value: string }>;
  draft: { id: string; status: string } | null;
}
type Query = Record<string, string | string[]>;

describe('Seller dashboard reads (Slice 1i)', () => {
  let env: TestDatabase;
  let harness: AuthApp;
  let sellerA: SyntheticAccount;
  let sellerB: SyntheticAccount;
  let bulk: SyntheticAccount;
  let sessionA: Session;
  let sessionB: Session;
  let sessionBulk: Session;
  let bulkIds: string[] = [];
  const secrets: string[] = [PASSWORD];
  const responses: { url: string; body: string }[] = [];
  const remember = (s: Session): Session => {
    secrets.push(s.token, s.antiForgery);
    return s;
  };
  const record = (url: string) => (res: LightMyRequestResponse) => {
    responses.push({ url, body: res.body });
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
  const mutate = (
    method: 'POST' | 'PUT' | 'PATCH',
    url: string,
    session: Session | undefined,
    key: string | undefined,
    payload: unknown,
    extra: Record<string, string> = {},
    app: AuthApp = harness,
  ) =>
    app.app
      .inject({
        method,
        url,
        headers: headersFor(session, key, extra),
        ...(session ? { cookies: { [app.cookieName]: session.token } } : {}),
        payload: payload as Record<string, unknown>,
      })
      .then(record(url));
  /** A GET with a query string and optional extra headers; no origin, anti-forgery value or key. */
  const getRead = (
    url: string,
    token: string | undefined,
    q: Query = {},
    headers: Record<string, string> = {},
    app: AuthApp = harness,
  ) => {
    const search = new URLSearchParams();
    for (const [k, v] of Object.entries(q))
      for (const item of Array.isArray(v) ? v : [v]) search.append(k, item);
    const full = search.size > 0 ? `${url}?${search.toString()}` : url;
    return app.app
      .inject({
        method: 'GET',
        url: full,
        headers,
        ...(token === undefined ? {} : { cookies: { [app.cookieName]: token } }),
      })
      .then(record(url));
  };
  const list = (
    token: string | undefined,
    q: Query = {},
    headers: Record<string, string> = {},
    app = harness,
  ) => getRead(LISTINGS, token, q, headers, app);
  const getPolicy = (
    token: string | undefined,
    id: string,
    headers: Record<string, string> = {},
    app = harness,
  ) => getRead(`${LISTINGS}/${id}/policy`, token, {}, headers, app);
  const getHistory = (
    token: string | undefined,
    id: string,
    q: Query = {},
    headers: Record<string, string> = {},
    app = harness,
  ) => getRead(`${LISTINGS}/${id}/content-versions`, token, q, headers, app);
  const read = (token: string | undefined, id: string, app: AuthApp = harness) =>
    getRead(`${LISTINGS}/${id}`, token, {}, {}, app);
  const create = async (session: Session, app: AuthApp = harness) => {
    const res = await mutate('POST', LISTINGS, session, randomUUID(), {}, {}, app);
    expect(res.statusCode).toBe(201);
    return res.json<ListingBody>().listing;
  };
  const putFacts = (session: Session, id: string, facts: Record<string, string>, rv: number, app = harness) =>
    mutate(
      'PUT',
      `${LISTINGS}/${id}/facts`,
      session,
      randomUUID(),
      { expectedRowVersion: rv, facts },
      {},
      app,
    );
  const putDraft = (
    session: Session,
    id: string,
    rv: number,
    source: string | null,
    copy: Partial<typeof COPY> = {},
    app = harness,
  ) =>
    mutate(
      'PUT',
      `${LISTINGS}/${id}/draft`,
      session,
      randomUUID(),
      { expectedRowVersion: rv, sourceVersionId: source, ...COPY, ...copy, structuredDetails: FACTS },
      {},
      app,
    );
  const approveVersion = (session: Session, id: string, versionId: string, rv: number, app = harness) =>
    mutate(
      'POST',
      `${LISTINGS}/${id}/content/${versionId}/approve`,
      session,
      randomUUID(),
      { expectedRowVersion: rv },
      {},
      app,
    );
  const setPrice = (session: Session, id: string, price: Money, rv: number, app = harness) =>
    mutate(
      'PATCH',
      `${LISTINGS}/${id}/asking-price`,
      session,
      randomUUID(),
      { expectedRowVersion: rv, price },
      {},
      app,
    );
  const policyOf = (rv: number, minimumPrice: Money = MINIMUM, more: Record<string, unknown> = {}) => ({
    expectedRowVersion: rv,
    minimumPrice,
    ...RULES,
    ...more,
  });
  const putPolicy = (session: Session, id: string, payload: unknown, app = harness) =>
    mutate('PUT', `${LISTINGS}/${id}/policy`, session, randomUUID(), payload, {}, app);
  const ready = (session: Session, id: string, rv: number, app = harness) =>
    mutate('POST', `${LISTINGS}/${id}/ready`, session, randomUUID(), { expectedRowVersion: rv }, {}, app);
  /** A DRAFT listing with facts, an approved seller version and an asking price, over the API only. */
  const prepared = async (session: Session, app: AuthApp = harness) => {
    const made = await create(session, app);
    expect((await putFacts(session, made.id, FACTS, 1, app)).statusCode).toBe(200);
    const draft = await putDraft(session, made.id, 2, null, {}, app);
    expect(draft.statusCode).toBe(200);
    expect(
      (await approveVersion(session, made.id, draft.json<DraftBody>().draft.id, 3, app)).statusCode,
    ).toBe(200);
    expect((await setPrice(session, made.id, ASKING, 4, app)).statusCode).toBe(200);
    return { id: made.id, rowVersion: 5, versionId: draft.json<DraftBody>().draft.id };
  };
  /** Walks every page of an enumeration and returns the pages of ids, refusing to loop forever. */
  const walk = async (token: string, q: Query, limit: number, app: AuthApp = harness) => {
    const pages: string[][] = [];
    let cursor: string | null = null;
    for (let guard = 0; ; guard += 1) {
      expect(guard).toBeLessThan(200);
      const res = await list(
        token,
        { ...q, limit: String(limit), ...(cursor === null ? {} : { cursor }) },
        {},
        app,
      );
      expect(res.statusCode, `page ${guard}`).toBe(200);
      const body = res.json<ListBody>();
      pages.push(body.listings.map((l) => l.id));
      cursor = body.nextCursor;
      if (cursor === null) return pages;
    }
  };

  const listingRows = (sellerId: string, status?: string) =>
    query<{
      id: string;
      status: string;
      row_version: number;
      current_content_version_id: string | null;
      current_policy_version_id: string | null;
      created_at: string;
      xmin: string;
    }>(
      env.superuserUrl,
      `SELECT id, status::text, row_version, current_content_version_id, current_policy_version_id,
              created_at::text AS created_at, xmin::text AS xmin
         FROM app.listing WHERE seller_id = $1 AND ($2::text IS NULL OR status::text = $2)
        ORDER BY created_at DESC, id DESC`,
      [sellerId, status ?? null],
    );
  const policyRows = (sellerId: string) =>
    query<{
      id: string;
      listing_id: string;
      version_number: number;
      minimum_price_minor: number;
      xmin: string;
    }>(
      env.superuserUrl,
      `SELECT id, listing_id, version_number, minimum_price_minor, xmin::text AS xmin
         FROM app.seller_policy_version WHERE seller_id = $1 ORDER BY listing_id, version_number`,
      [sellerId],
    );
  const versionRows = (sellerId: string, listingId?: string) =>
    query<{
      id: string;
      listing_id: string;
      version_number: number;
      status: string;
      provenance: string;
      title: string;
      summary: string | null;
      description: string | null;
      structured_details: Record<string, string>;
      source_version_id: string | null;
      created_at: Date;
      approved_at: Date | null;
      approved_by: string | null;
      xmin: string;
    }>(
      env.superuserUrl,
      `SELECT id, listing_id, version_number, status::text, provenance::text, title, summary, description,
              structured_details, source_version_id, created_at, approved_at, approved_by, xmin::text AS xmin
         FROM app.listing_content_version WHERE seller_id = $1 AND ($2::uuid IS NULL OR listing_id = $2)
        ORDER BY listing_id, version_number DESC`,
      [sellerId, listingId ?? null],
    );
  const events = (sellerId: string) =>
    query<{ event_type: string; subject_id: string; summary: Record<string, unknown> }>(
      env.superuserUrl,
      `SELECT event_type::text, subject_id, summary FROM app.audit_event
        WHERE seller_id = $1 AND event_type::text NOT LIKE 'SELLER_S%' ORDER BY seq`,
      [sellerId],
    );
  const receipts = (sellerId: string) =>
    query<{ idempotency_key: string; command: string; outcome: Record<string, unknown> }>(
      env.superuserUrl,
      `SELECT idempotency_key, command, outcome FROM app.idempotency_receipt WHERE seller_id = $1
        ORDER BY created_at, idempotency_key`,
      [sellerId],
    );
  const snapshot = async (sellerId: string) => ({
    listings: await listingRows(sellerId),
    policies: await policyRows(sellerId),
    versions: await versionRows(sellerId),
    events: await events(sellerId),
    receipts: await receipts(sellerId),
  });
  // The amount as a JSON number or a string value, never as a run of digits inside a hex identifier
  // or a timestamp: the boundaries exclude hex digits and the hyphen (a deterministic check).
  const PROTECTED = [MINIMUM.amountMinor, OTHER_MINIMUM.amountMinor].map(
    (v) => new RegExp(`(?<![0-9a-fA-F-])${String(v)}(?![0-9a-fA-F-])`),
  );
  const expectNoMinimum = (text: string, label: string) => {
    for (const v of PROTECTED) expect(text, `${label} carries the minimum ${v.source}`).not.toMatch(v);
  };
  const keysOf = (value: unknown): string[] => {
    const keys: string[] = [];
    const walkKeys = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(walkKeys);
      else if (typeof v === 'object' && v !== null)
        for (const [k, inner] of Object.entries(v)) {
          keys.push(k);
          walkKeys(inner);
        }
    };
    walkKeys(value);
    return keys;
  };

  beforeAll(async () => {
    env = await startDatabase();
    sellerA = await provisionAccount(env, {
      displayName: 'Synthetic Seller DA',
      email: address('seller-da'),
      password: PASSWORD,
    });
    sellerB = await provisionAccount(env, {
      displayName: 'Synthetic Seller DB',
      email: address('seller-db'),
      password: PASSWORD,
    });
    bulk = await provisionAccount(env, {
      displayName: 'Synthetic Seller DK',
      email: address('seller-dk'),
      password: PASSWORD,
    });
    harness = await startAuthApp(env, { poolMax: 4 });
    sessionA = remember(await signIn(harness, sellerA));
    sessionB = remember(await signIn(harness, sellerB));
    sessionBulk = remember(await signIn(harness, bulk));
    // One transaction, so every bulk listing shares one created_at (now() is transaction-stable).
    bulkIds = await withTenant(harness.runtime.db, bulk.sellerId, async (trx) => {
      const ids: string[] = [];
      for (let i = 0; i < BULK; i += 1) {
        ids.push((await listings.createListingWithItem(trx, command(bulk.sellerId, `bulk-${i}`))).id);
      }
      return ids;
    });
  });
  afterAll(async () => {
    await harness?.close();
    await env?.stop();
  });

  it('requires a live session on every read: missing, malformed, unknown, revoked and expired sessions answer 401, read nothing and never reach tenant context', async () => {
    const target = await prepared(sessionA);
    const revoked = remember(await signIn(harness, sellerA));
    expect((await post(harness, `${AUTH_PREFIX}/sign-out`, revoked)).statusCode).toBe(204);
    const expired = remember(await signIn(harness, sellerA));
    await query(
      env.superuserUrl,
      `UPDATE auth.seller_session SET last_seen_at = now() - make_interval(secs => $2) WHERE token_hash = $1`,
      [auth.hashSessionToken(expired.token), harness.config.sessionIdleSeconds + 1],
    );
    const unknownToken = auth.generateSessionToken();
    const cases: [string, string | undefined][] = [
      ['missing', undefined],
      ['malformed', 'not-a-token'],
      ['unknown', unknownToken],
      ['revoked', revoked.token],
      ['expired', expired.token],
    ];
    const before = await snapshot(sellerA.sellerId);
    tenantContextCalls.mockClear();
    for (const [label, token] of cases) {
      for (const [route, res] of [
        ['list', await list(token)],
        ['policy', await getPolicy(token, target.id)],
        ['history', await getHistory(token, target.id)],
      ] as const) {
        expect(res.statusCode, `${route} ${label}`).toBe(401);
        expect(res.json(), `${route} ${label}`).toEqual({ error: 'unauthenticated' });
        expect(cookieOf(res, harness.cookieName)?.value, `${route} ${label}`).toBe('');
        expect(res.body, `${route} ${label}`).not.toContain(target.id);
      }
    }
    expect(tenantContextCalls).not.toHaveBeenCalled();
    expect(await snapshot(sellerA.sellerId)).toEqual(before);
  });

  it('needs no origin, anti-forgery value or Idempotency-Key, ignores identity headers, consumes no key, and answers no-store', async () => {
    const target = await prepared(sessionA);
    expect((await putPolicy(sessionA, target.id, policyOf(target.rowVersion))).statusCode).toBe(200);
    const before = await snapshot(sellerA.sellerId);
    const spoof = {
      'x-seller-id': sellerB.sellerId,
      'x-tenant-id': sellerB.sellerId,
      origin: 'https://evil.example',
      [IDEMPOTENCY_KEY_HEADER]: randomUUID(),
    };
    for (const [label, res] of [
      ['list', await list(sessionA.token, {}, spoof)],
      ['policy', await getPolicy(sessionA.token, target.id, spoof)],
      ['history', await getHistory(sessionA.token, target.id, {}, spoof)],
      ['workspace', await read(sessionA.token, target.id)],
    ] as const) {
      expect(res.statusCode, label).toBe(200);
      expect(res.body, label).not.toContain(sellerB.sellerId);
      expect(res.body, label).not.toContain(sellerA.sellerId);
      if (label !== 'workspace') expect(res.headers['cache-control'], label).toBe('no-store');
    }
    // A's enumeration under B's spoofed identity is still A's; B's own enumeration holds none of A's.
    const seenByA = (await list(sessionA.token, {}, spoof)).json<ListBody>().listings.map((l) => l.id);
    expect(seenByA).toContain(target.id);
    const seenByB = (await list(sessionB.token, {}, spoof)).json<ListBody>().listings.map((l) => l.id);
    expect(seenByB).not.toContain(target.id);
    // No receipt was written for the presented key, and nothing else changed.
    expect(
      (await receipts(sellerA.sellerId)).find((r) => r.idempotency_key === spoof[IDEMPOTENCY_KEY_HEADER]),
    ).toBe(undefined);
    expect(await snapshot(sellerA.sellerId)).toEqual(before);
  });

  it('enumerates only the caller’s listings, newest first with the id as tie-breaker, in the seller-safe view, with fixed clamped pages', async () => {
    const mineBefore = (await listingRows(sellerA.sellerId)).map((l) => l.id);
    const created: string[] = [];
    for (let i = 0; i < 5; i += 1) created.push((await create(sessionA)).id);
    const theirs = (await create(sessionB)).id;
    const res = await list(sessionA.token);
    expect(res.statusCode).toBe(200);
    const body = res.json<ListBody>();
    expect(Object.keys(body).sort()).toEqual(['listings', 'nextCursor']);
    const expected = (await listingRows(sellerA.sellerId)).map((l) => l.id);
    expect(expected.slice(0, 5)).toEqual([...created].reverse());
    expect(body.listings.map((l) => l.id)).toEqual(expected.slice(0, listings.LISTING_PAGE_DEFAULT));
    expect(body.nextCursor).toBe(expected.length > listings.LISTING_PAGE_DEFAULT ? expect.any(String) : null);
    for (const listing of body.listings) {
      expect(Object.keys(listing).sort()).toEqual(LISTING_KEYS);
      expect(mineBefore.concat(created)).toContain(listing.id);
    }
    expect(body.listings.map((l) => l.id)).not.toContain(theirs);
    // B sees exactly B's own.
    const bIds = (await list(sessionB.token)).json<ListBody>().listings.map((l) => l.id);
    expect(bIds).toContain(theirs);
    for (const id of created) expect(bIds).not.toContain(id);
    // Page sizes: default 20, an explicit 1, the maximum 100, and an oversized request clamped to 100.
    const sizes: [Query, number][] = [
      [{}, listings.LISTING_PAGE_DEFAULT],
      [{ limit: '1' }, 1],
      [{ limit: '100' }, listings.LISTING_PAGE_MAX],
      [{ limit: '1000' }, listings.LISTING_PAGE_MAX],
      [{ limit: '999999999' }, listings.LISTING_PAGE_MAX],
    ];
    for (const [q, size] of sizes) {
      const page = await list(sessionBulk.token, q);
      expect(page.statusCode, JSON.stringify(q)).toBe(200);
      const got = page.json<ListBody>();
      expect(got.listings, JSON.stringify(q)).toHaveLength(size);
      expect(got.nextCursor, JSON.stringify(q)).toEqual(expect.any(String));
    }
  });

  it('walks every cursor: listings sharing one creation time are returned exactly once, in the same order on every walk, with no duplicate or omission', async () => {
    const rows = await listingRows(bulk.sellerId);
    expect(rows).toHaveLength(BULK);
    expect(new Set(rows.map((r) => r.created_at)).size).toBe(1);
    const expected = rows.map((r) => r.id);
    expect(new Set(expected).size).toBe(BULK);
    expect(new Set(bulkIds)).toEqual(new Set(expected));
    for (const limit of [7, 1, 100, 104, 105]) {
      const first = await walk(sessionBulk.token, {}, limit);
      const flat = first.flat();
      expect(flat, `limit ${limit}`).toEqual(expected);
      expect(new Set(flat).size, `limit ${limit}`).toBe(BULK);
      expect(first.length, `limit ${limit}`).toBe(
        Math.ceil(BULK / Math.min(limit, listings.LISTING_PAGE_MAX)),
      );
      for (const page of first.slice(0, -1))
        expect(page, `limit ${limit}`).toHaveLength(Math.min(limit, 100));
      expect(await walk(sessionBulk.token, {}, limit), `limit ${limit} again`).toEqual(first);
    }
    // The same walk under the exact status filter that every bulk listing carries, and none under another.
    expect((await walk(sessionBulk.token, { status: 'DRAFT' }, 50)).flat()).toEqual(expected);
    expect(await walk(sessionBulk.token, { status: 'READY' }, 50)).toEqual([[]]);
  });

  it('filters by exact canonical status only', async () => {
    const draft = await prepared(sessionA);
    const readied = await prepared(sessionA);
    expect((await putPolicy(sessionA, readied.id, policyOf(readied.rowVersion))).statusCode).toBe(200);
    expect((await ready(sessionA, readied.id, readied.rowVersion + 1)).statusCode).toBe(200);
    const db = harness.runtime.db;
    const listed = await publishListing(db, sellerA.sellerId, { policy: MINIMUM });
    const cancelled = await publishListing(db, sellerA.sellerId, { policy: MINIMUM });
    await withTenant(db, sellerA.sellerId, (trx) =>
      listings.cancelListing(trx, command(sellerA.sellerId, 'cancel'), {
        listingId: cancelled.listed.listing.id,
        expectedRowVersion: cancelled.listed.listing.rowVersion,
      }),
    );
    for (const [status, id] of [
      ['DRAFT', draft.id],
      ['READY', readied.id],
      ['LISTED', listed.listed.listing.id],
      ['CANCELLED', cancelled.listed.listing.id],
    ] as const) {
      const ids = (await walk(sessionA.token, { status }, 10)).flat();
      const expected = (await listingRows(sellerA.sellerId, status)).map((l) => l.id);
      expect(ids, status).toEqual(expected);
      expect(ids, status).toContain(id);
      const other = (await listingRows(sellerA.sellerId)).filter((l) => l.status !== status).map((l) => l.id);
      for (const o of other) expect(ids, status).not.toContain(o);
    }
    for (const status of ['SOLD', 'ARCHIVED', 'EXPIRED'] as const) {
      const res = await list(sessionA.token, { status });
      expect(res.statusCode, status).toBe(200);
      expect(res.json<ListBody>(), status).toEqual({ listings: [], nextCursor: null });
    }
    // Statuses that are not the canonical enum, and a repeated status, are refused.
    for (const status of ['draft', 'Draft', 'DRAFT ', '', 'ALL', 'DRAFT,READY', ['DRAFT', 'READY']]) {
      const res = await list(sessionA.token, { status });
      expect(res.statusCode, JSON.stringify(status)).toBe(400);
      expect(res.json(), JSON.stringify(status)).toEqual({ error: 'bad_request' });
    }
  });

  it('refuses malformed page sizes, cursors, unknown and repeated parameters with a fixed body, on enumeration and history alike', async () => {
    const target = await prepared(sessionA);
    expect(
      (
        await putDraft(sessionA, target.id, target.rowVersion, target.versionId, {
          title: 'Synthetic gravel bicycle, second wording',
        })
      ).statusCode,
    ).toBe(200);
    const other = await prepared(sessionA);
    const before = await snapshot(sellerA.sellerId);
    const valid = (await list(sessionA.token, { limit: '2' })).json<ListBody>().nextCursor;
    expect(valid).toEqual(expect.any(String));
    const validHistory = (await getHistory(sessionA.token, target.id, { limit: '1' })).json<HistoryBody>()
      .nextCursor;
    expect(validHistory).toEqual(expect.any(String));
    const position = { createdAt: '2026-09-05 12:00:00.000001+00', id: randomUUID() };
    const badLimits: (string | string[])[] = [
      '0',
      '-1',
      '1.5',
      'abc',
      '',
      '1e2',
      ' 5',
      '+5',
      '0x10',
      ['1', '2'],
    ];
    const badListingCursors: string[] = [
      'garbage!',
      '%%%',
      'a'.repeat(600),
      Buffer.from('null').toString('base64url'),
      Buffer.from('"text"').toString('base64url'),
      Buffer.from('[]').toString('base64url'),
      encodeCursor({}),
      encodeCursor({ v: 2, kind: 'listings', status: null, position }),
      encodeCursor({ v: 1, kind: 'content_versions', listingId: target.id, below: 1 }),
      encodeCursor({ v: 1, kind: 'listings', status: null, position, extra: true }),
      encodeCursor({ v: 1, kind: 'listings', status: null, position: { ...position, id: 'not-a-uuid' } }),
      encodeCursor({
        v: 1,
        kind: 'listings',
        status: null,
        position: { ...position, createdAt: 'yesterday' },
      }),
      encodeCursor({ v: 1, kind: 'listings', status: null, position: { ...position, createdAt: "x'; --" } }),
      encodeCursor({ v: 1, kind: 'listings', status: 'draft', position }),
      encodeCursor({ v: 1, kind: 'listings', status: 'DRAFT', position }), // issued under a filter
      encodeCursor({ v: 1, kind: 'listings', status: null, position, sellerId: sellerB.sellerId }),
    ];
    const badHistoryCursors: string[] = [
      'garbage!',
      encodeCursor({}),
      valid ?? '',
      encodeCursor({ v: 1, kind: 'content_versions', listingId: other.id, below: 1 }), // another listing
      encodeCursor({ v: 1, kind: 'content_versions', listingId: target.id, below: 0 }),
      encodeCursor({ v: 1, kind: 'content_versions', listingId: target.id, below: 1.5 }),
      encodeCursor({ v: 1, kind: 'content_versions', listingId: target.id, below: '1' }),
      encodeCursor({ v: 1, kind: 'content_versions', listingId: 'x', below: 1 }),
    ];
    const cases: [string, Promise<LightMyRequestResponse>][] = [];
    for (const limit of badLimits) {
      cases.push([`list limit ${JSON.stringify(limit)}`, list(sessionA.token, { limit })]);
      cases.push([
        `history limit ${JSON.stringify(limit)}`,
        getHistory(sessionA.token, target.id, { limit }),
      ]);
    }
    for (const cursor of badListingCursors)
      cases.push([`list cursor ${cursor.slice(0, 40)}`, list(sessionA.token, { cursor })]);
    for (const cursor of badHistoryCursors)
      cases.push([
        `history cursor ${cursor.slice(0, 40)}`,
        getHistory(sessionA.token, target.id, { cursor }),
      ]);
    cases.push(['list filter mismatch', list(sessionA.token, { cursor: valid ?? '', status: 'DRAFT' })]);
    cases.push(['list repeated cursor', list(sessionA.token, { cursor: [valid ?? '', valid ?? ''] })]);
    for (const [k, v] of [
      ['sort', 'asc'],
      ['offset', '10'],
      ['page', '2'],
      ['search', 'bicycle'],
      ['sellerId', sellerB.sellerId],
      ['seller_id', sellerB.sellerId],
      ['include', 'policy'],
      ['fields', 'all'],
    ]) {
      cases.push([`list ${k}`, list(sessionA.token, { [k ?? '']: v ?? '' })]);
      cases.push([`history ${k}`, getHistory(sessionA.token, target.id, { [k ?? '']: v ?? '' })]);
    }
    cases.push([
      'policy with a query',
      getRead(`${LISTINGS}/${target.id}/policy`, sessionA.token, { include: 'all' }),
    ]);
    cases.push(['history malformed id', getHistory(sessionA.token, 'not-a-uuid')]);
    cases.push(['policy malformed id', getPolicy(sessionA.token, 'not-a-uuid')]);
    for (const [label, pending] of cases) {
      const res = await pending;
      expect(res.statusCode, label).toBe(400);
      expect(res.json(), label).toEqual({ error: 'bad_request' });
      expect(res.body, label).not.toMatch(/cursor|base64|json|zod|schema|regex|expected/i);
    }
    // The policy route takes no query at all; the valid cursors still work where they were issued.
    expect((await list(sessionA.token, { cursor: valid ?? '' })).statusCode).toBe(200);
    expect((await getHistory(sessionA.token, target.id, { cursor: validHistory ?? '' })).statusCode).toBe(
      200,
    );
    expect(await snapshot(sellerA.sellerId)).toEqual(before);
  });

  it('bounds a cursor by the session, not by its contents: seller B presenting A’s cursor sees only B’s listings', async () => {
    for (let i = 0; i < 3; i += 1) await create(sessionA);
    for (let i = 0; i < 3; i += 1) await create(sessionB);
    const aIds = (await listingRows(sellerA.sellerId)).map((l) => l.id);
    const bIds = (await listingRows(sellerB.sellerId)).map((l) => l.id);
    const first = (await list(sessionA.token, { limit: '2' })).json<ListBody>();
    expect(first.nextCursor).toEqual(expect.any(String));
    const borrowed = await list(sessionB.token, { limit: '100', cursor: first.nextCursor ?? '' });
    expect(borrowed.statusCode).toBe(200);
    const seen = borrowed.json<ListBody>().listings.map((l) => l.id);
    for (const id of seen) expect(bIds).toContain(id);
    for (const id of aIds) expect(seen).not.toContain(id);
    // A crafted position far in the future or past changes only where B's own enumeration starts.
    for (const createdAt of ['2099-01-01 00:00:00+00', '2000-01-01 00:00:00+00']) {
      const crafted = encodeCursor({
        v: 1,
        kind: 'listings',
        status: null,
        position: { createdAt, id: aIds[0] },
      });
      const res = await list(sessionB.token, { limit: '100', cursor: crafted });
      expect(res.statusCode, createdAt).toBe(200);
      for (const id of res.json<ListBody>().listings.map((l) => l.id)) expect(bIds, createdAt).toContain(id);
    }
  });

  it('answers the current private policy to its owner in the PUT shape, reflecting the latest immutable version, null when none, and never a zero', async () => {
    const target = await prepared(sessionA);
    const none = await getPolicy(sessionA.token, target.id);
    expect(none.statusCode).toBe(200);
    expect(Object.keys(none.json<PolicyBody>()).sort()).toEqual(['listing', 'policyVersion']);
    expect(none.json<PolicyBody>().policyVersion).toBeNull();
    expect(none.json<PolicyBody>().listing).toMatchObject({ id: target.id, rowVersion: target.rowVersion });
    expect(none.body).not.toMatch(/minimum|policy(?!Version":null)|concession|hold/i);
    expect(none.body).toContain('"policyVersion":null');
    const put1 = await putPolicy(sessionA, target.id, policyOf(target.rowVersion));
    expect(put1.statusCode).toBe(200);
    const got1 = await getPolicy(sessionA.token, target.id);
    expect(got1.statusCode).toBe(200);
    expect(got1.json<PolicyBody>()).toEqual(put1.json<PolicyBody>());
    expect(got1.body).toBe(put1.body);
    expect(Object.keys(got1.json<PolicyBody>().policyVersion ?? {}).sort()).toEqual(POLICY_KEYS);
    expect(got1.json<PolicyBody>().policyVersion).toMatchObject({ versionNumber: 1, minimumPrice: MINIMUM });
    const put2 = await putPolicy(sessionA, target.id, policyOf(target.rowVersion + 1, OTHER_MINIMUM));
    expect(put2.statusCode).toBe(200);
    const got2 = await getPolicy(sessionA.token, target.id);
    expect(got2.body).toBe(put2.body);
    expect(got2.json<PolicyBody>().policyVersion).toMatchObject({
      versionNumber: 2,
      minimumPrice: OTHER_MINIMUM,
    });
    expect(got2.json<PolicyBody>().listing.rowVersion).toBe(target.rowVersion + 2);
    const rows = (await policyRows(sellerA.sellerId)).filter((p) => p.listing_id === target.id);
    expect(rows.map((p) => [p.version_number, p.minimum_price_minor])).toEqual([
      [1, MINIMUM.amountMinor],
      [2, OTHER_MINIMUM.amountMinor],
    ]);
    expect(got2.json<PolicyBody>().policyVersion?.id).toBe(rows[1]?.id);
    // Reading the policy needs no particular state: READY answers the same bound version.
    expect((await ready(sessionA, target.id, target.rowVersion + 2)).statusCode).toBe(200);
    const inReady = await getPolicy(sessionA.token, target.id);
    expect(inReady.statusCode).toBe(200);
    expect(inReady.json<PolicyBody>().policyVersion).toEqual(got2.json<PolicyBody>().policyVersion);
    expect(inReady.json<PolicyBody>().listing).toMatchObject({
      status: 'READY',
      rowVersion: target.rowVersion + 3,
    });
    // The workspace and the enumeration carry none of it.
    expectNoMinimum((await read(sessionA.token, target.id)).body, 'workspace');
    expectNoMinimum((await list(sessionA.token, { limit: '100' })).body, 'enumeration');
  });

  it('keeps tenants apart on policy and history: seller B gets the nonexistent shape for A’s listing and learns nothing', async () => {
    const target = await prepared(sessionA);
    expect((await putPolicy(sessionA, target.id, policyOf(target.rowVersion))).statusCode).toBe(200);
    const stateA = await snapshot(sellerA.sellerId);
    const stateB = await snapshot(sellerB.sellerId);
    const shape = (res: LightMyRequestResponse) =>
      `${res.statusCode}|${res.body}|${String(res.headers['content-type'])}|${String(res.headers['content-length'])}`;
    const absent = randomUUID();
    for (const [label, own, nothing] of [
      ['policy', await getPolicy(sessionB.token, target.id), await getPolicy(sessionB.token, absent)],
      ['history', await getHistory(sessionB.token, target.id), await getHistory(sessionB.token, absent)],
      [
        'history with a page',
        await getHistory(sessionB.token, target.id, { limit: '1' }),
        await getHistory(sessionB.token, absent, { limit: '1' }),
      ],
      ['workspace', await read(sessionB.token, target.id), await read(sessionB.token, absent)],
    ] as const) {
      expect(own.statusCode, label).toBe(404);
      expect(own.json(), label).toEqual({ error: 'not_found' });
      expect(shape(own), label).toBe(shape(nothing));
      expectNoMinimum(own.body, label);
    }
    // The owner's own reads are unaffected, and under B's context A's rows do not exist.
    expect((await getPolicy(sessionA.token, target.id)).statusCode).toBe(200);
    expect((await getHistory(sessionA.token, target.id)).json<HistoryBody>().versions).toHaveLength(1);
    const seenByB = await withTenant(harness.runtime.db, sellerB.sellerId, async (trx) => ({
      policies: await trx
        .selectFrom('seller_policy_version')
        .select('id')
        .where('listing_id', '=', target.id)
        .execute(),
      versions: await trx
        .selectFrom('listing_content_version')
        .select('id')
        .where('listing_id', '=', target.id)
        .execute(),
    }));
    expect(seenByB).toEqual({ policies: [], versions: [] });
    expect(await snapshot(sellerA.sellerId)).toEqual(stateA);
    expect(await snapshot(sellerB.sellerId)).toEqual(stateB);
  });

  it('returns the complete immutable history newest first with exact words, provenance, status and lineage, pages deterministically, changes nothing, and lets an older eligible draft be approved', async () => {
    const made = await create(sessionA);
    expect((await putFacts(sessionA, made.id, FACTS, 1)).statusCode).toBe(200);
    const empty = await getHistory(sessionA.token, made.id);
    expect(empty.statusCode).toBe(200);
    expect(empty.json<HistoryBody>()).toEqual({ versions: [], nextCursor: null });
    const v1 = (await putDraft(sessionA, made.id, 2, null)).json<DraftBody>().draft;
    expect((await approveVersion(sessionA, made.id, v1.id, 3)).statusCode).toBe(200);
    const v2 = (
      await putDraft(sessionA, made.id, 4, v1.id, { title: 'Synthetic gravel bicycle, revised' })
    ).json<DraftBody>().draft;
    expect((await approveVersion(sessionA, made.id, v2.id, 5)).statusCode).toBe(200);
    const v3 = (
      await putDraft(sessionA, made.id, 6, v2.id, { title: 'Synthetic gravel bicycle, third wording' })
    ).json<DraftBody>().draft;
    const v4 = (
      await putDraft(sessionA, made.id, 7, v3.id, { title: 'Synthetic gravel bicycle, fourth wording' })
    ).json<DraftBody>().draft;
    expect([v1, v2, v3, v4].map((v) => v.versionNumber)).toEqual([1, 2, 3, 4]);
    const before = await snapshot(sellerA.sellerId);
    const rows = await versionRows(sellerA.sellerId, made.id);
    expect(rows.map((r) => [r.version_number, r.status])).toEqual([
      [4, 'SELLER_DRAFT'],
      [3, 'SELLER_DRAFT'],
      [2, 'APPROVED'],
      [1, 'SUPERSEDED'],
    ]);
    const full = await getHistory(sessionA.token, made.id);
    expect(full.statusCode).toBe(200);
    const history = full.json<HistoryBody>();
    expect(Object.keys(history).sort()).toEqual(['nextCursor', 'versions']);
    expect(history.nextCursor).toBeNull();
    expect(history.versions).toHaveLength(4);
    for (const [i, row] of rows.entries()) {
      const shown = history.versions[i];
      expect(shown, `version ${row.version_number}`).toBeDefined();
      expect(Object.keys(shown ?? {}).sort(), `version ${row.version_number}`).toEqual(VERSION_KEYS);
      expect(shown, `version ${row.version_number}`).toEqual({
        id: row.id,
        versionNumber: row.version_number,
        status: row.status,
        provenance: row.provenance,
        title: row.title,
        summary: row.summary,
        description: row.description,
        structuredDetails: row.structured_details,
        sourceVersionId: row.source_version_id,
        createdAt: row.created_at.toISOString(),
        approvedAt: row.approved_at === null ? null : row.approved_at.toISOString(),
      });
      expect(JSON.stringify(shown), `version ${row.version_number}`).not.toContain(
        row.approved_by ?? 'nothing',
      );
    }
    expect(history.versions.map((v) => v.sourceVersionId)).toEqual([v3.id, v2.id, v1.id, null]);
    expect(history.versions.map((v) => v.provenance)).toEqual([
      'SELLER_PROVIDED_FACT',
      'SELLER_PROVIDED_FACT',
      'SELLER_APPROVED_COPY',
      'SELLER_APPROVED_COPY',
    ]);
    // Paged, deterministic, exactly once.
    const pageA = (await getHistory(sessionA.token, made.id, { limit: '3' })).json<HistoryBody>();
    expect(pageA.versions.map((v) => v.versionNumber)).toEqual([4, 3, 2]);
    expect(pageA.nextCursor).toEqual(expect.any(String));
    const pageB = (
      await getHistory(sessionA.token, made.id, { limit: '3', cursor: pageA.nextCursor ?? '' })
    ).json<HistoryBody>();
    expect(pageB).toEqual({ versions: [history.versions[3]], nextCursor: null });
    const again = (await getHistory(sessionA.token, made.id, { limit: '3' })).json<HistoryBody>();
    expect(again).toEqual(pageA);
    const single = (await getHistory(sessionA.token, made.id, { limit: '1' })).json<HistoryBody>();
    expect(single.versions.map((v) => v.versionNumber)).toEqual([4]);
    expect((await getHistory(sessionA.token, made.id, { limit: '1000' })).json<HistoryBody>()).toEqual(
      history,
    );
    // Reading moved nothing: pointer, statuses and approval marks are as they were.
    expect(await snapshot(sellerA.sellerId)).toEqual(before);
    expect((await read(sessionA.token, made.id)).json<WorkspaceBody>().draft).toMatchObject({ id: v4.id });
    // An older SELLER_DRAFT read from the history is eligible for the existing approval route.
    const approvedOlder = await approveVersion(sessionA, made.id, v3.id, 8);
    expect(approvedOlder.statusCode).toBe(200);
    const after = (await getHistory(sessionA.token, made.id)).json<HistoryBody>();
    expect(after.versions.map((v) => [v.versionNumber, v.status])).toEqual([
      [4, 'SELLER_DRAFT'],
      [3, 'APPROVED'],
      [2, 'SUPERSEDED'],
      [1, 'SUPERSEDED'],
    ]);
    expect(after.versions[1]?.approvedAt).toEqual(expect.any(String));
    // Versions in every other status are refused by the approval route, whatever the history shows.
    for (const stale of [v1.id, v2.id]) {
      const res = await approveVersion(sessionA, made.id, stale, 9);
      expect(res.statusCode, stale).toBe(409);
      expect(res.json(), stale).toEqual({ error: 'invalid_state' });
    }
  });

  it('runs every list query under a server-side statement timeout and leaves no tenant context or timeout on a reused pooled connection', async () => {
    const db = harness.runtime.db;
    await withTenant(db, sellerA.sellerId, async (trx) => {
      const setting = () => sql<{ v: string }>`select current_setting('statement_timeout') as v`.execute(trx);
      expect((await setting()).rows[0]?.v).toBe('0');
      await listings.listListings(trx, { limit: 3 });
      expect((await setting()).rows[0]?.v).toMatch(/^(5s|5000ms)$/);
    });
    const one = await startAuthApp(env, { poolMax: 1 });
    try {
      const s = remember(await signIn(one, sellerA));
      const target = await prepared(s, one);
      expect((await putPolicy(s, target.id, policyOf(target.rowVersion), one)).statusCode).toBe(200);
      const connectionState = () =>
        one.runtime.db.transaction().execute(async (trx) => {
          const value = await sql<{ setting: string | null; seller: string | null; timeout: string }>`
            select current_setting(${TENANT_SETTING}, true) as setting, app.current_seller_id()::text as seller,
                   current_setting('statement_timeout') as timeout`.execute(trx);
          const visible = await sql<{ n: string }>`select count(*)::text as n from app.listing`.execute(trx);
          return {
            setting: value.rows[0]?.setting ?? '',
            seller: value.rows[0]?.seller ?? null,
            timeout: value.rows[0]?.timeout,
            visible: Number(visible.rows[0]?.n),
          };
        });
      const clean = { setting: '', seller: null, timeout: '0', visible: 0 };
      expect(await connectionState()).toEqual(clean);
      expect((await list(s.token, { limit: '5' }, {}, one)).statusCode).toBe(200);
      expect(await connectionState()).toEqual(clean);
      expect((await getPolicy(s.token, target.id, {}, one)).statusCode).toBe(200);
      expect(await connectionState()).toEqual(clean);
      expect((await getHistory(s.token, target.id, { limit: '1' }, {}, one)).statusCode).toBe(200);
      expect(await connectionState()).toEqual(clean);
      expect((await getHistory(s.token, randomUUID(), {}, {}, one)).statusCode).toBe(404);
      expect(await connectionState()).toEqual(clean);
      expect((await list(s.token, { limit: 'abc' }, {}, one)).statusCode).toBe(400);
      expect(await connectionState()).toEqual(clean);
    } finally {
      await one.close();
    }
  });

  it('answers Cache-Control: no-store on every seller-tree response, keeps cookies set and cleared, and leaves the health route alone', async () => {
    const target = await prepared(sessionA);
    const noStore = (res: LightMyRequestResponse, label: string) =>
      expect(res.headers['cache-control'], label).toBe('no-store');
    // Authentication: sign-in sets the cookie, rotation replaces it, sign-out clears it; all no-store.
    const signedIn = await signInRequest(harness, sellerA.email, sellerA.password);
    expect(signedIn.statusCode).toBe(200);
    noStore(signedIn, 'sign-in');
    const first: Session = {
      token: cookieOf(signedIn, harness.cookieName)?.value ?? '',
      antiForgery: signedIn.json<{ antiForgery: string }>().antiForgery,
    };
    remember(first);
    expect(first.token).toMatch(/\S/);
    noStore(await getRead(`${AUTH_PREFIX}/me`, first.token), 'me');
    noStore(await getRead(`${AUTH_PREFIX}/sessions`, first.token), 'sessions');
    const rotated = await post(harness, `${AUTH_PREFIX}/sessions/rotate`, first);
    expect(rotated.statusCode).toBe(200);
    noStore(rotated, 'rotate');
    const next: Session = {
      token: cookieOf(rotated, harness.cookieName)?.value ?? '',
      antiForgery: rotated.json<{ antiForgery: string }>().antiForgery,
    };
    remember(next);
    expect(next.token).toMatch(/\S/);
    expect(next.token).not.toBe(first.token);
    const badPassword = await signInRequest(harness, sellerA.email, 'not the synthetic passphrase');
    expect(badPassword.statusCode).toBe(401);
    noStore(badPassword, 'sign-in refused');
    // Reads.
    for (const [label, res] of [
      ['workspace', await read(sessionA.token, target.id)],
      ['list', await list(sessionA.token, { limit: '2' })],
      ['policy', await getPolicy(sessionA.token, target.id)],
      ['history', await getHistory(sessionA.token, target.id)],
    ] as const) {
      expect(res.statusCode, label).toBe(200);
      noStore(res, label);
    }
    // Mutations and their ordinary refusals, including one refused before its handler.
    const created = await mutate('POST', LISTINGS, sessionA, randomUUID(), {});
    expect(created.statusCode).toBe(201);
    noStore(created, 'create');
    const facts = await putFacts(sessionA, created.json<ListingBody>().listing.id, FACTS, 1);
    expect(facts.statusCode).toBe(200);
    noStore(facts, 'facts');
    for (const [label, res, status] of [
      ['unauthenticated', await list(undefined), 401],
      ['malformed id', await getPolicy(sessionA.token, 'not-a-uuid'), 400],
      ['not found', await getPolicy(sessionA.token, randomUUID()), 404],
      [
        'origin refused',
        await mutate('POST', LISTINGS, sessionA, randomUUID(), {}, { origin: 'https://evil.example' }),
        403,
      ],
      ['invalid state', await ready(sessionA, target.id, target.rowVersion), 409],
      ['no key', await mutate('POST', LISTINGS, sessionA, undefined, {}), 400],
    ] as const) {
      expect(res.statusCode, label).toBe(status);
      noStore(res, label);
    }
    const signedOut = await post(harness, `${AUTH_PREFIX}/sign-out`, next);
    expect(signedOut.statusCode).toBe(204);
    noStore(signedOut, 'sign-out');
    expect(cookieOf(signedOut, harness.cookieName)?.value).toBe('');
    // The health route is outside the seller tree and keeps its behaviour.
    const health = await harness.app.inject({ method: 'GET', url: '/health' });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: 'ok', database: 'reachable' });
    expect(health.headers['cache-control']).toBeUndefined();
  });

  it('refuses any query on the workspace read with the fixed body and answers the same body without one', async () => {
    const target = await prepared(sessionA);
    const url = `${LISTINGS}/${target.id}`;
    const baseline = await read(sessionA.token, target.id);
    expect(baseline.statusCode).toBe(200);
    expect(Object.keys(baseline.json<WorkspaceBody>()).sort()).toEqual(['draft', 'facts', 'listing']);
    const before = await snapshot(sellerA.sellerId);
    for (const [label, res] of [
      ['unknown', await getRead(url, sessionA.token, { include: 'facts' })],
      ['identity', await getRead(url, sessionA.token, { listingId: target.id })],
      ['sellerId', await getRead(url, sessionA.token, { sellerId: sellerB.sellerId })],
      ['limit', await getRead(url, sessionA.token, { limit: '1' })],
      ['repeated', await getRead(url, sessionA.token, { a: ['1', '2'] })],
      [
        'empty key',
        await harness.app.inject({
          method: 'GET',
          url: `${url}?=1`,
          cookies: { [harness.cookieName]: sessionA.token },
        }),
      ],
      [
        'malformed encoding',
        await harness.app.inject({
          method: 'GET',
          url: `${url}?%E0%A4%A=1&%zz`,
          cookies: { [harness.cookieName]: sessionA.token },
        }),
      ],
    ] as const) {
      expect(res.statusCode, label).toBe(400);
      expect(res.json(), label).toEqual({ error: 'bad_request' });
      expect(res.body, label).not.toMatch(/query|schema|zod|expected|unrecognized/i);
    }
    // A bare separator is an empty query, and the body is exactly the query-free one.
    const bare = await harness.app.inject({
      method: 'GET',
      url: `${url}?`,
      cookies: { [harness.cookieName]: sessionA.token },
    });
    expect(bare.statusCode).toBe(200);
    expect(bare.body).toBe(baseline.body);
    expect((await read(sessionA.token, target.id)).body).toBe(baseline.body);
    expect(await snapshot(sellerA.sellerId)).toEqual(before);
  });

  it('logs every request as its method, query-free path and route template: no query string, cursor, status, limit, cookie or token reaches the log', async () => {
    const target = await prepared(sessionA);
    for (let i = 0; i < 2; i += 1) await create(sessionA);
    expect(
      (
        await putDraft(sessionA, target.id, target.rowVersion, target.versionId, {
          title: 'Synthetic gravel bicycle, logged wording',
        })
      ).statusCode,
    ).toBe(200);
    const cursor = (await list(sessionA.token, { limit: '1' })).json<ListBody>().nextCursor ?? '';
    const historyCursor =
      (await getHistory(sessionA.token, target.id, { limit: '1' })).json<HistoryBody>().nextCursor ?? '';
    expect(cursor).toMatch(/\S/);
    expect(historyCursor).toMatch(/\S/);
    const from = harness.logs.length;
    const cookies = { [harness.cookieName]: sessionA.token };
    const attempts: [string, LightMyRequestResponse, number][] = [
      ['list with cursor', await list(sessionA.token, { limit: '1', cursor }), 200],
      ['list with status', await list(sessionA.token, { status: 'DRAFT', limit: '3' }), 200],
      [
        'history with cursor',
        await getHistory(sessionA.token, target.id, { limit: '1', cursor: historyCursor }),
        200,
      ],
      [
        'workspace with a query',
        await getRead(`${LISTINGS}/${target.id}`, sessionA.token, { include: 'facts' }),
        400,
      ],
      [
        'repeated and malformed',
        await harness.app.inject({
          method: 'GET',
          url: `${LISTINGS}?limit=1&limit=2&%zz=1&cursor=${cursor}`,
          cookies,
        }),
        400,
      ],
      [
        'refused before its handler',
        await mutate(
          'POST',
          `${LISTINGS}?cursor=${cursor}`,
          sessionA,
          randomUUID(),
          {},
          { origin: 'https://evil.example' },
        ),
        403,
      ],
      [
        'unknown route',
        await harness.app.inject({ method: 'GET', url: `/seller/nothing?cursor=${cursor}&limit=9` }),
        404,
      ],
      [
        'unknown root route',
        await harness.app.inject({ method: 'GET', url: `/nothing?cursor=${cursor}` }),
        404,
      ],
      [
        'unauthenticated with a query',
        await harness.app.inject({ method: 'GET', url: `${LISTINGS}?cursor=${cursor}` }),
        401,
      ],
      [
        'fragment and encoding',
        await harness.app.inject({ method: 'GET', url: `${LISTINGS}%3F?cursor=${cursor}#frag`, cookies }),
        404,
      ],
      [
        'absolute form',
        await harness.app.inject({
          method: 'GET',
          url: `${TEST_ORIGIN}${LISTINGS}?cursor=${cursor}&limit=1`,
          cookies,
        }),
        200,
      ],
    ];
    for (const [label, res, status] of attempts) expect(res.statusCode, label).toBe(status);
    const fresh = harness.logs.slice(from);
    const text = fresh.join('');
    expect(fresh.length).toBeGreaterThan(attempts.length);
    expect(text).not.toContain(cursor);
    expect(text).not.toContain(historyCursor);
    expect(text).not.toMatch(/limit=|status=|cursor=|include=|%zz|DRAFT/);
    for (const s of secrets) expect(text).not.toContain(s);
    expect(text).not.toMatch(/"cookie"|"set-cookie"|"authorization"/);
    const requests = fresh
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as { req?: Record<string, unknown>; request_id?: string; msg?: string })
      .filter((r) => r.req !== undefined);
    expect(requests.length).toBeGreaterThanOrEqual(attempts.length);
    for (const r of requests) {
      const req = r.req ?? {};
      expect(typeof req['url'], JSON.stringify(req)).toBe('string');
      expect(req['url'] as string, JSON.stringify(req)).not.toMatch(/[?&=#]/);
      expect(req['url'] as string, JSON.stringify(req)).toMatch(/^\//);
      expect(req['method'], JSON.stringify(req)).toMatch(/^(GET|POST)$/);
      expect(r.request_id).toMatch(/^[0-9a-f-]{36}$/);
      for (const k of ['headers', 'query', 'querystring', 'remoteAddress', 'host', 'ip'])
        expect(req, k).not.toHaveProperty(k);
    }
    const urls = requests.map((r) => r.req?.['url']);
    const routes = requests.map((r) => r.req?.['route']);
    expect(urls).toContain(LISTINGS);
    expect(urls).toContain(`${LISTINGS}/${target.id}`);
    expect(urls).toContain(`${LISTINGS}/${target.id}/content-versions`);
    expect(urls).toContain('/seller/nothing');
    expect(urls).toContain('/nothing');
    expect(routes).toContain(LISTINGS);
    expect(routes).toContain(`${LISTINGS}/:listingId`);
    expect(routes).toContain(`${LISTINGS}/:listingId/content-versions`);
    // The completed-request lines keep status and timing for diagnostics.
    expect(text).toMatch(/"statusCode":200/);
    expect(text).toMatch(/"statusCode":403/);
    expect(text).toMatch(/"responseTime":/);
  });

  it('answers the minimum price to the owner on the policy route only, and never in another response, an event, a receipt, a log, the workspace, the enumeration or a buyer-safe projection', async () => {
    // A published listing with the private minimum: its buyer-safe projection carries nothing protected.
    const db = harness.runtime.db;
    const published = await publishListing(db, sellerA.sellerId, { policy: MINIMUM });
    const projection = await withTenant(db, sellerA.sellerId, async (trx) => {
      const approved = await content.getApprovedVersion(trx, published.built.listingId);
      const listing = await listings.getListing(trx, published.built.listingId);
      expect(approved).toBeDefined();
      expect(listing.askingPrice).not.toBeNull();
      return publicAccess.serializeBuyerSafeProjection(
        publicAccess.buildBuyerSafeProjection({
          content: approved as content.ApprovedContent,
          askingPrice: listing.askingPrice as Money,
          sellerDisplayName: 'Synthetic Seller DA',
        }),
      );
    });
    expectNoMinimum(projection, 'buyer-safe projection');
    for (const k of publicAccess.PROTECTED_LISTING_KEYS) expect(projection).not.toContain(`"${k}"`);
    expect(projection).not.toMatch(/minimum|policy|concession|hold|seller_?id|acquisition/i);
    // Every response captured by this suite.
    const forbidden =
      /seller_?id|tenant|account_?id|session_?id|target|receipt|fingerprint|audit|token|hash|code|secret|cookie|acquisition|approved_?by|request_?id|suggest|recommend|estimate|xmin|transaction/i;
    const forbiddenOutsidePolicy = /minimum|policy|concession|hold/i;
    expect(responses.length).toBeGreaterThan(200);
    let policyAnswers = 0;
    for (const { url, body } of responses) {
      if (!body) continue;
      // The authentication contract answers the seller's own identifiers by design; the listing
      // surface is what this scan polices, and the minimum stays out of both.
      if (url.startsWith(AUTH_PREFIX)) {
        expectNoMinimum(body, url);
        continue;
      }
      const parsed = JSON.parse(body) as Record<string, unknown>;
      const keys = keysOf(parsed);
      for (const k of keys) expect(k, `${url} ${body.slice(0, 120)}`).not.toMatch(forbidden);
      for (const s of [sellerA.sellerId, sellerB.sellerId, bulk.sellerId]) expect(body, url).not.toContain(s);
      if (url.endsWith('/policy') && 'policyVersion' in parsed) {
        policyAnswers += 1;
      } else {
        for (const k of keys) expect(k, `${url} ${body.slice(0, 120)}`).not.toMatch(forbiddenOutsidePolicy);
        expectNoMinimum(body, url);
      }
      if (url === LISTINGS && 'listings' in parsed) {
        expect(body, 'enumeration').not.toContain(COPY.title);
        expect(body, 'enumeration').not.toContain(FACTS.brand);
        expect(body, 'enumeration').not.toMatch(/title|summary|description|structuredDetails|facts|draft/);
      }
    }
    expect(policyAnswers).toBeGreaterThan(5);
    // Events and receipts of every seller, and the whole log.
    for (const sellerId of [sellerA.sellerId, sellerB.sellerId, bulk.sellerId]) {
      for (const e of await events(sellerId)) {
        expectNoMinimum(JSON.stringify(e.summary), `event ${e.event_type}`);
        expect(JSON.stringify(e.summary)).not.toMatch(/minimum_price_minor|amountMinor/);
      }
      for (const r of await receipts(sellerId)) {
        expectNoMinimum(JSON.stringify(r.outcome), `receipt ${r.command}`);
        expect(r.command, 'no read command holds a receipt').not.toMatch(
          /\.(list|read|get|history|enumerate)\w*$/,
        );
      }
    }
    const log = harness.logText();
    for (const s of secrets) expect(log).not.toContain(s);
    expectNoMinimum(log, 'log');
    expect(log).not.toMatch(/"cookie":"(?!\[REDACTED\])/);
    expect(log).not.toContain('"amountMinor"');
    expect(log).not.toMatch(/minimum_?price/i);
    // Response bodies are never logged: no listing words, cursors or version fields reach the log.
    expect(log).not.toContain(COPY.title);
    expect(log).not.toContain('nextCursor');
    expect(log).not.toContain('structuredDetails');
    expect(log).not.toContain(FACTS.brand);
  });
});
