import { randomUUID } from 'node:crypto';
import { sql } from 'kysely';
import type { LightMyRequestResponse } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { TENANT_SETTING } from '../../src/db/constants.ts';
import { establishTenantContext, withTenant } from '../../src/db/kysely.ts';
import type * as KyselyModule from '../../src/db/kysely.ts';
import * as auth from '../../src/modules/identity-auth/index.ts';
import { PRODUCT_FACT_KEYS } from '../../src/modules/listing-content/index.ts';
import * as listings from '../../src/modules/listings/index.ts';
import { IDEMPOTENCY_KEY_HEADER } from '../../src/shared/command.ts';
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
import { buildListing, command, FIXTURE, publishListing } from '../helpers/fixtures.ts';
import { query } from '../helpers/inspect.ts';

// The single tenant-context construction site is wrapped, unchanged in behaviour, so the tests
// can prove that no revoked, expired, unknown or malformed session ever reaches it.
vi.mock('../../src/db/kysely.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof KyselyModule>();
  return { ...actual, establishTenantContext: vi.fn(actual.establishTenantContext) };
});
const tenantContextCalls = vi.mocked(establishTenantContext);

// Slice 1f under D-21: the seller replaces the seller-provided facts of a listing in full, saves
// a seller-authored draft as a new immutable content version citing its predecessor, and reads the
// workspace both produce. Every account, item, fact and word below is synthetic (D-18, DATA-110).
// Proofs: full replacement with absence as the unknown state, blank values never stored, provenance
// fixed, no-ops that consume their key, exact replay, conflicts and stale versions without mutation,
// predecessor lineage, D-10 coverage, seller text returned verbatim, DRAFT and EXPIRED allowed and
// every other state refused, tenant isolation indistinguishable from absence (AUTH-221), refusals
// without tenant context, rollback of every write together, no tenant context on a pooled
// connection, and no value, word, identity or secret in events, receipts, responses or logs.

const DOMAIN = 'synthetic.invalid';
const address = (local: string) => [local, DOMAIN].join('@');
const PASSWORD = 'synthetic passphrase for the workspace';
const LISTINGS = `${ROUTE_PREFIXES.seller}/listings`;
const FULL_FACTS: Record<(typeof PRODUCT_FACT_KEYS)[number], string> = {
  name: 'Synthetic road bicycle',
  brand: 'Fictional Cycles',
  model: 'FC-1000 fixture',
  size: '56 cm fixture frame',
  colour: 'matte fixture teal',
  condition: 'used, rideable',
  included_items: 'frame, wheels, one fictional bell',
  defects: 'rear brake pads worn',
  age: 'about three fixture years',
  usage_history: 'ridden on synthetic roads only',
  specifications: 'fixture spec: eleven fictional speeds',
};
const SORTED_KEYS = [...PRODUCT_FACT_KEYS].sort();
const COPY = {
  title: FIXTURE.copy.title,
  summary: FIXTURE.copy.summary,
  description: FIXTURE.copy.description,
};
const REVISED_DESCRIPTION =
  'Revised fixture description.\n\nStill  two  spaces and a line break, kept as typed: é.';
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
const DRAFT_KEYS = [
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

interface FactRow {
  listing_id: string;
  key: string;
  value: string;
  provenance: string;
  supplied_at: Date;
  xmin: string;
}
interface VersionRow {
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
  xmin: string;
}
interface DraftBody {
  listing: { id: string; rowVersion: number; status: string };
  draft: {
    id: string;
    versionNumber: number;
    status: string;
    provenance: string;
    title: string;
    summary: string | null;
    description: string | null;
    structuredDetails: Record<string, string>;
    sourceVersionId: string | null;
  };
}
interface FactsBody {
  listing: { id: string; rowVersion: number; status: string };
  facts: Record<string, { value: string; provenance: string; suppliedAt: string }>;
}
interface WorkspaceBody extends FactsBody {
  draft: DraftBody['draft'] | null;
}

describe('Seller workspace routes (Slice 1f, D-21)', () => {
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
  const mutate = (
    method: 'POST' | 'PUT',
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
      .then(record);
  const create = async (session: Session, app: AuthApp = harness) => {
    const res = await mutate('POST', LISTINGS, session, randomUUID(), {}, {}, app);
    expect(res.statusCode).toBe(201);
    return res.json<{ listing: { id: string; rowVersion: number } }>().listing;
  };
  const read = (token: string | undefined, listingId: string, headers: Record<string, string> = {}) =>
    get(harness, `${LISTINGS}/${listingId}`, token, headers).then(record);
  const putFacts = (
    session: Session | undefined,
    key: string | undefined,
    listingId: string,
    payload: unknown,
    extra: Record<string, string> = {},
    app: AuthApp = harness,
  ) => mutate('PUT', `${LISTINGS}/${listingId}/facts`, session, key, payload, extra, app);
  const putDraft = (
    session: Session | undefined,
    key: string | undefined,
    listingId: string,
    payload: unknown,
    extra: Record<string, string> = {},
    app: AuthApp = harness,
  ) => mutate('PUT', `${LISTINGS}/${listingId}/draft`, session, key, payload, extra, app);
  const factsOf = (facts: Record<string, string>, expectedRowVersion: number) => ({
    expectedRowVersion,
    facts,
  });
  const draftOf = (
    expectedRowVersion: number,
    sourceVersionId: string | null,
    copy: Record<string, unknown> = COPY,
  ) => ({ expectedRowVersion, sourceVersionId, ...copy });

  const listingRows = (sellerId: string) =>
    query<{ id: string; status: string; row_version: number; xmin: string }>(
      env.superuserUrl,
      `SELECT id, status::text, row_version, xmin::text AS xmin FROM app.listing WHERE seller_id = $1 ORDER BY created_at, id`,
      [sellerId],
    );
  const factRows = (sellerId: string) =>
    query<FactRow>(
      env.superuserUrl,
      `SELECT listing_id, key, value, provenance::text, supplied_at, xmin::text AS xmin FROM app.product_fact
        WHERE seller_id = $1 ORDER BY listing_id, key`,
      [sellerId],
    );
  const versionRows = (sellerId: string) =>
    query<VersionRow>(
      env.superuserUrl,
      `SELECT id, listing_id, version_number, status::text, provenance::text, title, summary, description,
              structured_details, source_version_id, xmin::text AS xmin
         FROM app.listing_content_version WHERE seller_id = $1 ORDER BY listing_id, version_number`,
      [sellerId],
    );
  const events = (sellerId: string) =>
    query<{
      event_type: string;
      subject_type: string;
      subject_id: string;
      idempotency_key: string | null;
      request_id: string;
      summary: Record<string, unknown>;
    }>(
      env.superuserUrl,
      `SELECT event_type::text, subject_type, subject_id, idempotency_key, request_id, summary FROM app.audit_event
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
      audit_event_id: string | null;
    }>(
      env.superuserUrl,
      `SELECT idempotency_key, command, subject_id, request_id, outcome, audit_event_id FROM app.idempotency_receipt
        WHERE seller_id = $1 ORDER BY created_at, idempotency_key`,
      [sellerId],
    );
  const snapshot = async (sellerId: string) => ({
    listings: await listingRows(sellerId),
    facts: await factRows(sellerId),
    versions: await versionRows(sellerId),
    events: await events(sellerId),
    receipts: await receipts(sellerId),
  });
  const eventsOf = async (sellerId: string, listingId: string, type: string) =>
    (await events(sellerId)).filter((e) => e.subject_id === listingId && e.event_type === type);
  const factValues = Object.values(FULL_FACTS);
  const copyWords = [COPY.title, COPY.summary, COPY.description, REVISED_DESCRIPTION];
  const expectNoValues = (text: string, label: string) => {
    for (const v of [...factValues, ...copyWords]) expect(text, `${label} carries ${v}`).not.toContain(v);
  };

  beforeAll(async () => {
    env = await startDatabase();
    sellerA = await provisionAccount(env, {
      displayName: 'Synthetic Seller WA',
      email: address('seller-wa'),
      password: PASSWORD,
    });
    sellerB = await provisionAccount(env, {
      displayName: 'Synthetic Seller WB',
      email: address('seller-wb'),
      password: PASSWORD,
    });
    faulty = await provisionAccount(env, {
      displayName: 'Synthetic Seller WF',
      email: address('seller-wf'),
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

  it('requires a live session on every route: missing, malformed, unknown, revoked and expired sessions answer 401, mutate nothing and never reach tenant context', async () => {
    const made = await create(sessionA);
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
      for (const [route, res] of [
        ['facts', await putFacts(session, randomUUID(), made.id, factsOf(FULL_FACTS, 1))],
        ['draft', await putDraft(session, randomUUID(), made.id, draftOf(1, null))],
        ['read', await read(session?.token, made.id)],
      ] as const) {
        expect(res.statusCode, `${route} ${label}`).toBe(401);
        expect(res.json(), `${route} ${label}`).toEqual({ error: 'unauthenticated' });
        expect(cookieOf(res, harness.cookieName)?.value, `${route} ${label}`).toBe('');
      }
    }
    expect(tenantContextCalls).not.toHaveBeenCalled();
    expect(await snapshot(sellerA.sellerId)).toEqual(before);
  });

  it('refuses cross-site and anti-forgery-less fact and draft requests before any mutation, and the workspace read needs neither', async () => {
    const made = await create(sessionA);
    const before = await snapshot(sellerA.sellerId);
    const evil = { origin: 'https://evil.example' };
    for (const [label, res] of [
      ['facts cross-site', await putFacts(sessionA, randomUUID(), made.id, factsOf(FULL_FACTS, 1), evil)],
      ['draft cross-site', await putDraft(sessionA, randomUUID(), made.id, draftOf(1, null), evil)],
    ] as const) {
      expect(res.statusCode, label).toBe(403);
      expect(res.json(), label).toEqual({ error: 'forbidden_origin' });
    }
    const forged: Session = { token: sessionA.token, antiForgery: 'not-the-value' };
    for (const [label, res] of [
      ['facts forged', await putFacts(forged, randomUUID(), made.id, factsOf(FULL_FACTS, 1))],
      ['draft forged', await putDraft(forged, randomUUID(), made.id, draftOf(1, null))],
    ] as const) {
      expect(res.statusCode, label).toBe(403);
      expect(res.json(), label).toEqual({ error: 'forbidden_anti_forgery' });
    }
    expect(await snapshot(sellerA.sellerId)).toEqual(before);
    const plain = await read(sessionA.token, made.id);
    const keyed = await read(sessionA.token, made.id, { [IDEMPOTENCY_KEY_HEADER]: randomUUID(), ...evil });
    expect(plain.statusCode).toBe(200);
    expect(keyed.statusCode).toBe(200);
    expect(keyed.body).toBe(plain.body);
    expect(plain.json<WorkspaceBody>()).toMatchObject({ facts: {}, draft: null });
    expect(await snapshot(sellerA.sellerId)).toEqual(before);
  });

  it('replaces the complete fact set with SELLER_PROVIDED_FACT provenance, increments the row version once, audits keys and counts only, replays exactly, and treats an identical statement as a consumed-key no-op', async () => {
    const made = await create(sessionA);
    const key = randomUUID();
    const first = await putFacts(sessionA, key, made.id, factsOf(FULL_FACTS, 1));
    expect(first.statusCode).toBe(200);
    const body = first.json<FactsBody>();
    expect(Object.keys(body).sort()).toEqual(['facts', 'listing']);
    expect(Object.keys(body.listing).sort()).toEqual(LISTING_KEYS);
    expect(body.listing).toMatchObject({ id: made.id, rowVersion: 2, status: 'DRAFT' });
    expect(Object.keys(body.facts).sort()).toEqual(SORTED_KEYS);
    for (const k of PRODUCT_FACT_KEYS) {
      expect(body.facts[k]).toMatchObject({ value: FULL_FACTS[k], provenance: 'SELLER_PROVIDED_FACT' });
      expect(body.facts[k]?.suppliedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    }
    const rows = (await factRows(sellerA.sellerId)).filter((r) => r.listing_id === made.id);
    expect(rows.map((r) => [r.key, r.value, r.provenance])).toEqual(
      SORTED_KEYS.map((k) => [k, FULL_FACTS[k], 'SELLER_PROVIDED_FACT']),
    );
    const changed = await eventsOf(sellerA.sellerId, made.id, 'LISTING_FACTS_CHANGED');
    expect(changed).toHaveLength(1);
    expect(changed[0]).toMatchObject({ subject_type: 'listing', idempotency_key: key });
    expect(changed[0]?.summary).toEqual({
      set_keys: SORTED_KEYS,
      cleared_keys: [],
      set_count: 11,
      cleared_count: 0,
      previous_row_version: 1,
      row_version: 2,
    });
    const receipt = (await receipts(sellerA.sellerId)).find((r) => r.idempotency_key === key);
    expect(receipt).toMatchObject({ command: 'listing.replace_facts', subject_id: made.id });
    expect(receipt?.request_id).toBe(changed[0]?.request_id);
    expect(receipt?.outcome).toMatchObject({ factKeys: SORTED_KEYS });
    expectNoValues(JSON.stringify(receipt?.outcome), 'receipt');
    expectNoValues(JSON.stringify(changed[0]?.summary), 'event');
    const state = await snapshot(sellerA.sellerId);

    // Exact replay: identical body, no write of any kind.
    const replay = await putFacts(sessionA, key, made.id, factsOf(FULL_FACTS, 1));
    expect(replay.statusCode).toBe(200);
    expect(replay.body).toBe(first.body);
    expect(await snapshot(sellerA.sellerId)).toEqual(state);

    // The same statement under a new key, padded with whitespace and a blank key: a no-op that
    // consumes the key and stores a stable outcome (D-21 rule 9), with no write and no event.
    const noOpKey = randomUUID();
    const padded = { ...FULL_FACTS, name: `  ${FULL_FACTS.name}  `, colour: `${FULL_FACTS.colour}\n` };
    const noOp = await putFacts(sessionA, noOpKey, made.id, factsOf(padded, 2));
    expect(noOp.statusCode).toBe(200);
    expect(noOp.json<FactsBody>().listing.rowVersion).toBe(2);
    expect(noOp.json<FactsBody>().facts['name']?.value).toBe(FULL_FACTS.name);
    const afterNoOp = await snapshot(sellerA.sellerId);
    expect(afterNoOp.facts).toEqual(state.facts);
    expect(afterNoOp.listings).toEqual(state.listings);
    expect(afterNoOp.events).toEqual(state.events);
    expect(afterNoOp.receipts.map((r) => r.idempotency_key)).toEqual([
      ...state.receipts.map((r) => r.idempotency_key),
      noOpKey,
    ]);
    expect(afterNoOp.receipts.at(-1)?.audit_event_id).toBeNull();
    expect((await putFacts(sessionA, noOpKey, made.id, factsOf(padded, 2))).body).toBe(noOp.body);
    expect(await snapshot(sellerA.sellerId)).toEqual(afterNoOp);
  });

  it('clears omitted facts on a partial replacement, stores no blank value, restores every fact to unknown on an empty statement, and detects a changed value', async () => {
    const made = await create(sessionA);
    expect((await putFacts(sessionA, randomUUID(), made.id, factsOf(FULL_FACTS, 1))).statusCode).toBe(200);
    const fullRows = (await factRows(sellerA.sellerId)).filter((r) => r.listing_id === made.id);

    // Partial: three keys kept, eight cleared; the kept rows are not rewritten.
    const kept = { name: FULL_FACTS.name, brand: FULL_FACTS.brand, condition: FULL_FACTS.condition };
    const partial = await putFacts(sessionA, randomUUID(), made.id, factsOf(kept, 2));
    expect(partial.statusCode).toBe(200);
    expect(partial.json<FactsBody>().listing.rowVersion).toBe(3);
    expect(Object.keys(partial.json<FactsBody>().facts).sort()).toEqual(['brand', 'condition', 'name']);
    const partialRows = (await factRows(sellerA.sellerId)).filter((r) => r.listing_id === made.id);
    expect(partialRows).toEqual(fullRows.filter((r) => r.key in kept));
    const cleared = (await eventsOf(sellerA.sellerId, made.id, 'LISTING_FACTS_CHANGED')).at(-1);
    expect(cleared?.summary).toEqual({
      set_keys: [],
      cleared_keys: SORTED_KEYS.filter((k) => !(k in kept)),
      set_count: 0,
      cleared_count: 8,
      previous_row_version: 2,
      row_version: 3,
    });
    expectNoValues(JSON.stringify(cleared?.summary), 'clearing event');

    // Blank strings: never stored as a fact; a blank for a stated key clears it (D-21 rule 7).
    const blanks = {
      name: '   ',
      brand: FULL_FACTS.brand,
      condition: FULL_FACTS.condition,
      size: '',
      age: '\n\t',
    };
    const blank = await putFacts(sessionA, randomUUID(), made.id, factsOf(blanks, 3));
    expect(blank.statusCode).toBe(200);
    expect(blank.json<FactsBody>().listing.rowVersion).toBe(4);
    expect(Object.keys(blank.json<FactsBody>().facts).sort()).toEqual(['brand', 'condition']);
    expect(
      (await factRows(sellerA.sellerId)).filter((r) => r.listing_id === made.id).map((r) => r.key),
    ).toEqual(['brand', 'condition']);
    expect((await eventsOf(sellerA.sellerId, made.id, 'LISTING_FACTS_CHANGED')).at(-1)?.summary).toEqual({
      set_keys: [],
      cleared_keys: ['name'],
      set_count: 0,
      cleared_count: 1,
      previous_row_version: 3,
      row_version: 4,
    });
    // A blank statement of an already-absent key changes nothing: a no-op, key consumed.
    const stillBlank = await putFacts(sessionA, randomUUID(), made.id, factsOf({ ...blanks, name: '' }, 4));
    expect(stillBlank.statusCode).toBe(200);
    expect(stillBlank.json<FactsBody>().listing.rowVersion).toBe(4);

    // Empty: every seller-provided fact is unknown again; the deleted values are retained nowhere.
    const empty = await putFacts(sessionA, randomUUID(), made.id, factsOf({}, 4));
    expect(empty.statusCode).toBe(200);
    expect(empty.json<FactsBody>()).toMatchObject({ listing: { rowVersion: 5 }, facts: {} });
    expect((await factRows(sellerA.sellerId)).filter((r) => r.listing_id === made.id)).toEqual([]);
    expect((await eventsOf(sellerA.sellerId, made.id, 'LISTING_FACTS_CHANGED')).at(-1)?.summary).toEqual({
      set_keys: [],
      cleared_keys: ['brand', 'condition'],
      set_count: 0,
      cleared_count: 2,
      previous_row_version: 4,
      row_version: 5,
    });
    expect((await read(sessionA.token, made.id)).json<WorkspaceBody>().facts).toEqual({});
    expect(
      (
        await query<{ n: string }>(
          env.superuserUrl,
          `SELECT count(*)::text AS n FROM app.product_fact WHERE listing_id = $1`,
          [made.id],
        )
      )[0]?.n,
    ).toBe('0');

    // A changed value for a stated key is set, not cleared.
    expect(
      (await putFacts(sessionA, randomUUID(), made.id, factsOf({ brand: 'Fixture Brand A' }, 5))).statusCode,
    ).toBe(200);
    const revalued = await putFacts(
      sessionA,
      randomUUID(),
      made.id,
      factsOf({ brand: 'Fixture Brand B' }, 6),
    );
    expect(revalued.statusCode).toBe(200);
    expect(revalued.json<FactsBody>().facts['brand']?.value).toBe('Fixture Brand B');
    expect((await eventsOf(sellerA.sellerId, made.id, 'LISTING_FACTS_CHANGED')).at(-1)?.summary).toEqual({
      set_keys: ['brand'],
      cleared_keys: [],
      set_count: 1,
      cleared_count: 0,
      previous_row_version: 6,
      row_version: 7,
    });
  });

  it('fails without mutation or success event on a stale version, a reused key with other facts or another command, unknown or non-canonical fields, identity fields, over-long values, malformed identifiers or a missing key', async () => {
    const made = await create(sessionA);
    const key = randomUUID();
    expect((await putFacts(sessionA, key, made.id, factsOf({ name: FULL_FACTS.name }, 1))).statusCode).toBe(
      200,
    );
    const before = await snapshot(sellerA.sellerId);
    const attempts: [string, Promise<LightMyRequestResponse>, number, string][] = [
      [
        'stale version',
        putFacts(sessionA, randomUUID(), made.id, factsOf(FULL_FACTS, 1)),
        409,
        'stale_row_version',
      ],
      [
        'future version',
        putFacts(sessionA, randomUUID(), made.id, factsOf(FULL_FACTS, 3)),
        409,
        'stale_row_version',
      ],
      [
        'key with other facts',
        putFacts(sessionA, key, made.id, factsOf(FULL_FACTS, 1)),
        409,
        'idempotency_conflict',
      ],
      [
        'key with other version',
        putFacts(sessionA, key, made.id, factsOf({ name: FULL_FACTS.name }, 2)),
        409,
        'idempotency_conflict',
      ],
      [
        'key for the draft command',
        putDraft(sessionA, key, made.id, draftOf(2, null)),
        409,
        'idempotency_conflict',
      ],
      [
        'unknown fact key',
        putFacts(sessionA, randomUUID(), made.id, factsOf({ estimated_value: '1000' }, 2)),
        400,
        'bad_request',
      ],
      [
        'title as a fact',
        putFacts(sessionA, randomUUID(), made.id, factsOf({ title: 'copy is not a fact' }, 2)),
        400,
        'bad_request',
      ],
      [
        'minimum price as a fact',
        putFacts(sessionA, randomUUID(), made.id, factsOf({ minimum_price: '1' }, 2)),
        400,
        'bad_request',
      ],
      [
        'acquisition cost as a fact',
        putFacts(sessionA, randomUUID(), made.id, factsOf({ acquisition_cost: '1' }, 2)),
        400,
        'bad_request',
      ],
      [
        'null value',
        putFacts(sessionA, randomUUID(), made.id, { expectedRowVersion: 2, facts: { name: null } }),
        400,
        'bad_request',
      ],
      [
        'numeric value',
        putFacts(sessionA, randomUUID(), made.id, { expectedRowVersion: 2, facts: { age: 3 } }),
        400,
        'bad_request',
      ],
      [
        'over-long value',
        putFacts(sessionA, randomUUID(), made.id, factsOf({ name: 'x'.repeat(2001) }, 2)),
        400,
        'bad_request',
      ],
      [
        'facts as an array',
        putFacts(sessionA, randomUUID(), made.id, { expectedRowVersion: 2, facts: ['name'] }),
        400,
        'bad_request',
      ],
      [
        'missing facts',
        putFacts(sessionA, randomUUID(), made.id, { expectedRowVersion: 2 }),
        400,
        'bad_request',
      ],
      ['missing version', putFacts(sessionA, randomUUID(), made.id, { facts: {} }), 400, 'bad_request'],
      [
        'sellerId in body',
        putFacts(sessionA, randomUUID(), made.id, { ...factsOf({}, 2), sellerId: sellerB.sellerId }),
        400,
        'bad_request',
      ],
      [
        'listingId in body',
        putFacts(sessionA, randomUUID(), made.id, { ...factsOf({}, 2), listingId: made.id }),
        400,
        'bad_request',
      ],
      [
        'provenance in body',
        putFacts(sessionA, randomUUID(), made.id, { ...factsOf({}, 2), provenance: 'AI_ENHANCED_COPY' }),
        400,
        'bad_request',
      ],
      [
        'status in body',
        putFacts(sessionA, randomUUID(), made.id, { ...factsOf({}, 2), status: 'READY' }),
        400,
        'bad_request',
      ],
      ['malformed id', putFacts(sessionA, randomUUID(), 'not-a-uuid', factsOf({}, 2)), 400, 'bad_request'],
      [
        'missing key',
        putFacts(sessionA, undefined, made.id, factsOf({}, 2)),
        400,
        'idempotency_key_required',
      ],
      [
        'malformed key',
        putFacts(sessionA, 'not-a-uuid', made.id, factsOf({}, 2)),
        400,
        'idempotency_key_required',
      ],
      ['read malformed id', read(sessionA.token, 'not-a-uuid'), 400, 'bad_request'],
    ];
    for (const [label, pending, status, error] of attempts) {
      const res = await pending;
      expect(res.statusCode, label).toBe(status);
      expect(res.json(), label).toEqual({ error });
    }
    expect(await snapshot(sellerA.sellerId)).toEqual(before);
  });

  it('saves a first seller draft with no predecessor, replays it exactly, treats identical copy as a no-op, creates one immutable revised version citing its predecessor, and refuses stale, null and unrelated predecessors', async () => {
    const made = await create(sessionA);
    expect((await putFacts(sessionA, randomUUID(), made.id, factsOf(FULL_FACTS, 1))).statusCode).toBe(200);
    const details = { name: FULL_FACTS.name, brand: FULL_FACTS.brand };
    const key = randomUUID();
    const first = await putDraft(
      sessionA,
      key,
      made.id,
      draftOf(2, null, { ...COPY, structuredDetails: details }),
    );
    expect(first.statusCode).toBe(200);
    const v1 = first.json<DraftBody>();
    expect(Object.keys(v1).sort()).toEqual(['draft', 'listing']);
    expect(Object.keys(v1.draft).sort()).toEqual(DRAFT_KEYS);
    expect(v1.listing).toMatchObject({ id: made.id, rowVersion: 3, status: 'DRAFT' });
    expect(v1.draft).toMatchObject({
      versionNumber: 1,
      status: 'SELLER_DRAFT',
      provenance: 'SELLER_PROVIDED_FACT',
      title: COPY.title,
      summary: COPY.summary,
      description: COPY.description,
      structuredDetails: details,
      sourceVersionId: null,
    });
    const rows = (await versionRows(sellerA.sellerId)).filter((r) => r.listing_id === made.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: v1.draft.id,
      version_number: 1,
      status: 'SELLER_DRAFT',
      provenance: 'SELLER_PROVIDED_FACT',
      title: COPY.title,
      source_version_id: null,
    });
    const drafted = await eventsOf(sellerA.sellerId, made.id, 'LISTING_CONTENT_DRAFTED');
    expect(drafted).toHaveLength(1);
    expect(drafted[0]).toMatchObject({ subject_type: 'listing', idempotency_key: key });
    expect(drafted[0]?.summary).toEqual({
      content_version_id: v1.draft.id,
      version_number: 1,
      previous_row_version: 2,
      row_version: 3,
    });
    const receipt = (await receipts(sellerA.sellerId)).find((r) => r.idempotency_key === key);
    expect(receipt).toMatchObject({ command: 'listing.save_seller_draft', subject_id: made.id });
    expect(receipt?.outcome).toMatchObject({ versionId: v1.draft.id });
    expectNoValues(JSON.stringify(receipt?.outcome), 'draft receipt');
    expectNoValues(JSON.stringify(drafted[0]?.summary), 'draft event');
    const state = await snapshot(sellerA.sellerId);

    // Exact replay.
    const replay = await putDraft(
      sessionA,
      key,
      made.id,
      draftOf(2, null, { ...COPY, structuredDetails: details }),
    );
    expect(replay.statusCode).toBe(200);
    expect(replay.body).toBe(first.body);
    expect(await snapshot(sellerA.sellerId)).toEqual(state);

    // Identical copy against the current predecessor, padded and with the details reordered: a
    // no-op that consumes its key (D-21 rule 14).
    const noOpKey = randomUUID();
    const noOp = await putDraft(
      sessionA,
      noOpKey,
      made.id,
      draftOf(3, v1.draft.id, {
        title: `  ${COPY.title} `,
        summary: COPY.summary,
        description: `${COPY.description}\n`,
        structuredDetails: { brand: FULL_FACTS.brand, name: FULL_FACTS.name },
      }),
    );
    expect(noOp.statusCode).toBe(200);
    expect(noOp.json<DraftBody>().listing.rowVersion).toBe(3);
    expect(noOp.json<DraftBody>().draft.id).toBe(v1.draft.id);
    const afterNoOp = await snapshot(sellerA.sellerId);
    expect(afterNoOp.versions).toEqual(state.versions);
    expect(afterNoOp.listings).toEqual(state.listings);
    expect(afterNoOp.events).toEqual(state.events);
    expect(afterNoOp.receipts.map((r) => r.idempotency_key)).toEqual([
      ...state.receipts.map((r) => r.idempotency_key),
      noOpKey,
    ]);
    expect(
      (
        await putDraft(
          sessionA,
          noOpKey,
          made.id,
          draftOf(3, v1.draft.id, { ...COPY, structuredDetails: details }),
        )
      ).body,
    ).toBe(noOp.body);

    // A revision: exactly one new immutable version, citing v1, one row-version increment.
    const revised = await putDraft(
      sessionA,
      randomUUID(),
      made.id,
      draftOf(3, v1.draft.id, { ...COPY, description: REVISED_DESCRIPTION, structuredDetails: details }),
    );
    expect(revised.statusCode).toBe(200);
    const v2 = revised.json<DraftBody>();
    expect(v2.listing.rowVersion).toBe(4);
    expect(v2.draft).toMatchObject({
      versionNumber: 2,
      status: 'SELLER_DRAFT',
      provenance: 'SELLER_PROVIDED_FACT',
      description: REVISED_DESCRIPTION,
      sourceVersionId: v1.draft.id,
    });
    expect(v2.draft.id).not.toBe(v1.draft.id);
    const both = (await versionRows(sellerA.sellerId)).filter((r) => r.listing_id === made.id);
    expect(both.map((r) => [r.version_number, r.source_version_id, r.description])).toEqual([
      [1, null, COPY.description],
      [2, v1.draft.id, REVISED_DESCRIPTION],
    ]);
    expect(both[0]).toEqual(rows[0]);
    expect((await eventsOf(sellerA.sellerId, made.id, 'LISTING_CONTENT_DRAFTED')).at(-1)?.summary).toEqual({
      content_version_id: v2.draft.id,
      version_number: 2,
      source_version_id: v1.draft.id,
      previous_row_version: 3,
      row_version: 4,
    });
    // The seller's words come back exactly as stored, on the save and on the read.
    const workspace = (await read(sessionA.token, made.id)).json<WorkspaceBody>();
    expect(workspace.draft).toEqual(v2.draft);
    expect(workspace.draft?.description).toBe(REVISED_DESCRIPTION);
    expect(workspace.listing.rowVersion).toBe(4);

    // Stale, null and unrelated predecessors, and a stale row version, mutate nothing.
    const stable = await snapshot(sellerA.sellerId);
    const foreign = await create(sessionB);
    const foreignDraft = await putDraft(sessionB, randomUUID(), foreign.id, draftOf(1, null));
    expect(foreignDraft.statusCode).toBe(200);
    const foreignVersionId = foreignDraft.json<DraftBody>().draft.id;
    const stateB = await snapshot(sellerB.sellerId);
    for (const [label, pending] of [
      ['stale predecessor', putDraft(sessionA, randomUUID(), made.id, draftOf(4, v1.draft.id))],
      ['null predecessor after the first', putDraft(sessionA, randomUUID(), made.id, draftOf(4, null))],
      ['unrelated predecessor', putDraft(sessionA, randomUUID(), made.id, draftOf(4, randomUUID()))],
      [
        'another tenant’s version as predecessor',
        putDraft(sessionA, randomUUID(), made.id, draftOf(4, foreignVersionId)),
      ],
      ['stale row version', putDraft(sessionA, randomUUID(), made.id, draftOf(3, v2.draft.id))],
    ] as const) {
      const res = await pending;
      expect(res.statusCode, label).toBe(409);
      expect(res.json(), label).toEqual({ error: 'stale_row_version' });
    }
    expect(await snapshot(sellerA.sellerId)).toEqual(stable);
    expect(await snapshot(sellerB.sellerId)).toEqual(stateB);
  });

  it('refuses a draft whose structured details cite a fact the seller did not state (D-10), a blank title, non-canonical fields and identity fields, without mutation', async () => {
    const made = await create(sessionA);
    expect(
      (await putFacts(sessionA, randomUUID(), made.id, factsOf({ name: FULL_FACTS.name }, 1))).statusCode,
    ).toBe(200);
    const before = await snapshot(sellerA.sellerId);
    const attempts: [string, Record<string, unknown>][] = [
      ['unstated detail', draftOf(2, null, { ...COPY, structuredDetails: { model: 'not a stated fact' } })],
      [
        'stated and unstated detail',
        draftOf(2, null, { ...COPY, structuredDetails: { name: FULL_FACTS.name, brand: 'x' } }),
      ],
      ['unknown detail key', draftOf(2, null, { ...COPY, structuredDetails: { estimated_value: '1' } })],
      ['blank title', draftOf(2, null, { ...COPY, title: '   ' })],
      ['missing title', draftOf(2, null, { summary: COPY.summary })],
      ['over-long title', draftOf(2, null, { ...COPY, title: 'x'.repeat(201) })],
      ['over-long summary', draftOf(2, null, { ...COPY, summary: 'x'.repeat(1001) })],
      ['over-long description', draftOf(2, null, { ...COPY, description: 'x'.repeat(10_001) })],
      ['missing predecessor field', { expectedRowVersion: 2, ...COPY }],
      ['malformed predecessor', draftOf(2, 'not-a-uuid')],
      ['status in body', draftOf(2, null, { ...COPY, status: 'APPROVED' })],
      ['provenance in body', draftOf(2, null, { ...COPY, provenance: 'SELLER_APPROVED_COPY' })],
      ['approvedBy in body', draftOf(2, null, { ...COPY, approvedBy: sellerA.sellerId })],
      ['versionNumber in body', draftOf(2, null, { ...COPY, versionNumber: 9 })],
      ['sellerId in body', draftOf(2, null, { ...COPY, sellerId: sellerB.sellerId })],
      [
        'askingPrice in body',
        draftOf(2, null, { ...COPY, askingPrice: { amountMinor: 1, currency: 'CAD' } }),
      ],
    ];
    for (const [label, payload] of attempts) {
      const res = await putDraft(sessionA, randomUUID(), made.id, payload);
      expect(res.statusCode, label).toBe(400);
      expect(res.json(), label).toEqual({ error: 'bad_request' });
    }
    expect((await putDraft(sessionA, undefined, made.id, draftOf(2, null))).json()).toEqual({
      error: 'idempotency_key_required',
    });
    expect(await snapshot(sellerA.sellerId)).toEqual(before);
    // A detail the seller later un-states cannot be cited by the next draft either.
    const ok = await putDraft(
      sessionA,
      randomUUID(),
      made.id,
      draftOf(2, null, { ...COPY, structuredDetails: { name: FULL_FACTS.name } }),
    );
    expect(ok.statusCode).toBe(200);
    expect((await putFacts(sessionA, randomUUID(), made.id, factsOf({}, 3))).statusCode).toBe(200);
    const orphan = await putDraft(
      sessionA,
      randomUUID(),
      made.id,
      draftOf(4, ok.json<DraftBody>().draft.id, {
        ...COPY,
        description: REVISED_DESCRIPTION,
        structuredDetails: { name: FULL_FACTS.name },
      }),
    );
    expect(orphan.statusCode).toBe(400);
    expect((await versionRows(sellerA.sellerId)).filter((r) => r.listing_id === made.id)).toHaveLength(1);
  });

  it('reads the workspace with the listing, the facts keyed by canonical key with absence as unknown, and the latest version, creating no event and no receipt', async () => {
    const made = await create(sessionA);
    const fresh = (await read(sessionA.token, made.id)).json<WorkspaceBody>();
    expect(Object.keys(fresh).sort()).toEqual(['draft', 'facts', 'listing']);
    expect(fresh).toMatchObject({ listing: { id: made.id, rowVersion: 1 }, facts: {}, draft: null });
    const some = { name: FULL_FACTS.name, defects: FULL_FACTS.defects };
    expect((await putFacts(sessionA, randomUUID(), made.id, factsOf(some, 1))).statusCode).toBe(200);
    const draft = await putDraft(
      sessionA,
      randomUUID(),
      made.id,
      draftOf(2, null, { ...COPY, structuredDetails: { defects: FULL_FACTS.defects } }),
    );
    expect(draft.statusCode).toBe(200);
    const before = await snapshot(sellerA.sellerId);
    const res = await read(sessionA.token, made.id);
    expect(res.statusCode).toBe(200);
    const workspace = res.json<WorkspaceBody>();
    expect(Object.keys(workspace.facts).sort()).toEqual(['defects', 'name']);
    expect(workspace.facts['name']).toMatchObject({
      value: FULL_FACTS.name,
      provenance: 'SELLER_PROVIDED_FACT',
    });
    expect(workspace.facts).not.toHaveProperty('brand');
    expect(workspace.listing.rowVersion).toBe(3);
    expect(workspace.draft).toEqual(draft.json<DraftBody>().draft);
    expect(workspace.draft?.structuredDetails).toEqual({ defects: FULL_FACTS.defects });
    // Approval (an internal command here) makes the approved version the latest, still the predecessor.
    const approved = await withTenant(harness.runtime.db, sellerA.sellerId, (trx) =>
      listings.approveContent(trx, command(sellerA.sellerId, 'approve'), {
        listingId: made.id,
        versionId: workspace.draft?.id ?? '',
        expectedRowVersion: 3,
      }),
    );
    const after = (await read(sessionA.token, made.id)).json<WorkspaceBody>();
    expect(after.draft).toMatchObject({
      id: approved.version.id,
      status: 'APPROVED',
      provenance: 'SELLER_APPROVED_COPY',
    });
    expect(after.draft).not.toHaveProperty('approvedBy');
    expect(after.listing.rowVersion).toBe(4);
    const revised = await putDraft(
      sessionA,
      randomUUID(),
      made.id,
      draftOf(4, approved.version.id, { ...COPY, title: 'Revised fixture title' }),
    );
    expect(revised.statusCode).toBe(200);
    expect(revised.json<DraftBody>().draft).toMatchObject({
      versionNumber: 2,
      sourceVersionId: approved.version.id,
      status: 'SELLER_DRAFT',
    });
    const state = await snapshot(sellerA.sellerId);
    expect(state.events.length).toBe(before.events.length + 2);
    expect(state.receipts.length).toBe(before.receipts.length + 2);
    for (let i = 0; i < 3; i += 1) expect((await read(sessionA.token, made.id)).statusCode).toBe(200);
    expect(await snapshot(sellerA.sellerId)).toEqual(state);
  });

  it('allows fact and draft changes in DRAFT and EXPIRED and refuses them in READY, LISTED, CANCELLED and ARCHIVED without mutation', async () => {
    const db = harness.runtime.db;
    const tenant = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(db, sellerA.sellerId, fn);
    const ready = await buildListing(db, sellerA.sellerId);
    await tenant((trx) =>
      listings.markReady(trx, command(sellerA.sellerId, 'ready'), {
        listingId: ready.listingId,
        expectedRowVersion: ready.rowVersion,
      }),
    );
    const listed = await publishListing(db, sellerA.sellerId);
    const cancelled = await publishListing(db, sellerA.sellerId);
    await tenant((trx) =>
      listings.cancelListing(trx, command(sellerA.sellerId, 'cancel'), {
        listingId: cancelled.listed.listing.id,
        expectedRowVersion: cancelled.listed.listing.rowVersion,
      }),
    );
    const archived = await publishListing(db, sellerA.sellerId);
    const cancelledForArchive = await tenant((trx) =>
      listings.cancelListing(trx, command(sellerA.sellerId, 'cancel'), {
        listingId: archived.listed.listing.id,
        expectedRowVersion: archived.listed.listing.rowVersion,
      }),
    );
    await tenant((trx) =>
      listings.archiveListing(trx, command(sellerA.sellerId, 'archive'), {
        listingId: archived.listed.listing.id,
        expectedRowVersion: cancelledForArchive.listing.rowVersion,
      }),
    );
    const expired = await publishListing(db, sellerA.sellerId);
    await tenant((trx) =>
      listings.expireListing(trx, command(sellerA.sellerId, 'expire'), {
        listingId: expired.listed.listing.id,
        expectedRowVersion: expired.listed.listing.rowVersion,
      }),
    );
    const current = async (id: string) => (await read(sessionA.token, id)).json<WorkspaceBody>();

    const before = await snapshot(sellerA.sellerId);
    for (const [status, id] of [
      ['READY', ready.listingId],
      ['LISTED', listed.listed.listing.id],
      ['CANCELLED', cancelled.listed.listing.id],
      ['ARCHIVED', archived.listed.listing.id],
    ] as const) {
      const ws = await current(id);
      expect(ws.listing.status, status).toBe(status);
      const facts = await putFacts(
        sessionA,
        randomUUID(),
        id,
        factsOf({ ...FIXTURE.facts, size: 'new' }, ws.listing.rowVersion),
      );
      const draft = await putDraft(
        sessionA,
        randomUUID(),
        id,
        draftOf(ws.listing.rowVersion, ws.draft?.id ?? null, { ...COPY, title: 'Edited' }),
      );
      for (const [label, res] of [
        [`facts in ${status}`, facts],
        [`draft in ${status}`, draft],
      ] as const) {
        expect(res.statusCode, label).toBe(409);
        expect(res.json(), label).toEqual({ error: 'invalid_state' });
      }
    }
    expect(await snapshot(sellerA.sellerId)).toEqual(before);

    // EXPIRED: both succeed, so the seller can prepare the new version SM-L-06 requires.
    const ws = await current(expired.listed.listing.id);
    expect(ws.listing.status).toBe('EXPIRED');
    const statusEvents = async () =>
      (await events(sellerA.sellerId)).filter(
        (e) => e.subject_id === ws.listing.id && e.event_type === 'LISTING_STATUS_CHANGED',
      );
    const transitionsBefore = await statusEvents();
    expect(transitionsBefore.at(-1)?.summary).toMatchObject({ to: 'EXPIRED' });
    const facts = await putFacts(
      sessionA,
      randomUUID(),
      ws.listing.id,
      factsOf({ ...FIXTURE.facts, size: '56 cm' }, ws.listing.rowVersion),
    );
    expect(facts.statusCode).toBe(200);
    expect(facts.json<FactsBody>().listing).toMatchObject({
      status: 'EXPIRED',
      rowVersion: ws.listing.rowVersion + 1,
    });
    expect(facts.json<FactsBody>().facts['size']?.value).toBe('56 cm');
    const draft = await putDraft(
      sessionA,
      randomUUID(),
      ws.listing.id,
      draftOf(ws.listing.rowVersion + 1, ws.draft?.id ?? null, {
        ...COPY,
        description: REVISED_DESCRIPTION,
        structuredDetails: { size: '56 cm' },
      }),
    );
    expect(draft.statusCode).toBe(200);
    expect(draft.json<DraftBody>().draft).toMatchObject({
      versionNumber: 2,
      status: 'SELLER_DRAFT',
      sourceVersionId: ws.draft?.id,
    });
    expect(draft.json<DraftBody>().listing).toMatchObject({
      status: 'EXPIRED',
      rowVersion: ws.listing.rowVersion + 2,
    });
    // No listing-state transition was performed by either save.
    expect((await listingRows(sellerA.sellerId)).find((r) => r.id === ws.listing.id)?.status).toBe('EXPIRED');
    expect(await statusEvents()).toEqual(transitionsBefore);
  });

  it('keeps tenants apart: seller B reads or mutates seller A’s workspace exactly as nothing, and leaves no trace on either side', async () => {
    const made = await create(sessionA);
    expect((await putFacts(sessionA, randomUUID(), made.id, factsOf(FULL_FACTS, 1))).statusCode).toBe(200);
    const drafted = await putDraft(sessionA, randomUUID(), made.id, draftOf(2, null));
    expect(drafted.statusCode).toBe(200);
    const stateA = await snapshot(sellerA.sellerId);
    const stateB = await snapshot(sellerB.sellerId);
    const absent = randomUUID();
    const shape = (res: LightMyRequestResponse) =>
      `${res.statusCode}|${res.body}|${String(res.headers['content-type'])}|${String(res.headers['content-length'])}`;
    const pairs: [string, LightMyRequestResponse, LightMyRequestResponse][] = [
      ['read', await read(sessionB.token, made.id), await read(sessionB.token, absent)],
      [
        'facts',
        await putFacts(sessionB, randomUUID(), made.id, factsOf({ name: 'B says' }, 3)),
        await putFacts(sessionB, randomUUID(), absent, factsOf({ name: 'B says' }, 3)),
      ],
      [
        'draft',
        await putDraft(sessionB, randomUUID(), made.id, draftOf(3, drafted.json<DraftBody>().draft.id)),
        await putDraft(sessionB, randomUUID(), absent, draftOf(3, drafted.json<DraftBody>().draft.id)),
      ],
    ];
    for (const [label, own, nothing] of pairs) {
      expect(own.statusCode, label).toBe(404);
      expect(shape(own), label).toBe(shape(nothing));
    }
    // Under B's own tenant context A's facts and versions do not exist.
    const seenByB = await withTenant(harness.runtime.db, sellerB.sellerId, async (trx) => ({
      facts: await trx.selectFrom('product_fact').select('key').where('listing_id', '=', made.id).execute(),
      versions: await trx
        .selectFrom('listing_content_version')
        .select('id')
        .where('listing_id', '=', made.id)
        .execute(),
    }));
    expect(seenByB).toEqual({ facts: [], versions: [] });
    expect(await snapshot(sellerA.sellerId)).toEqual(stateA);
    expect(await snapshot(sellerB.sellerId)).toEqual(stateB);
    expect(JSON.stringify(stateB)).not.toContain(made.id);
    // Identity headers change nothing: the tenant is the session's.
    const spoofed = await putFacts(
      sessionA,
      randomUUID(),
      made.id,
      factsOf({ ...FULL_FACTS, size: 'spoof test' }, 3),
      {
        'x-seller-id': sellerB.sellerId,
        'x-tenant-id': sellerB.sellerId,
      },
    );
    expect(spoofed.statusCode).toBe(200);
    expect(await snapshot(sellerB.sellerId)).toEqual(stateB);
  });

  it('rolls back the facts, the version, the listing row, the event and the receipt together when any write fails', async () => {
    const session = remember(await signIn(harness, faulty));
    const made = await create(session);
    const inject = async (table: string, timing: 'INSERT' | 'UPDATE' | 'DELETE', condition: string) => {
      await query(
        env.superuserUrl,
        `CREATE FUNCTION public.fail_workspace_for_test() RETURNS trigger LANGUAGE plpgsql AS $$
           BEGIN RAISE EXCEPTION 'injected failure'; END $$;
         CREATE TRIGGER fail_workspace_for_test BEFORE ${timing} ON ${table}
           FOR EACH ROW WHEN (${condition}) EXECUTE FUNCTION public.fail_workspace_for_test();`,
      );
      return async () => {
        await query(
          env.superuserUrl,
          `DROP TRIGGER fail_workspace_for_test ON ${table}; DROP FUNCTION public.fail_workspace_for_test();`,
        );
      };
    };
    const mine = `'${faulty.sellerId}'`;
    const factsKey = randomUUID();
    const draftKey = randomUUID();
    const clearKey = randomUUID();
    const drafted = (id: string | null) =>
      draftOf(2, id, { ...COPY, structuredDetails: { name: FULL_FACTS.name } });
    const faults: [
      string,
      string,
      'INSERT' | 'UPDATE' | 'DELETE',
      string,
      () => Promise<LightMyRequestResponse>,
    ][] = [
      [
        'fact insert',
        'app.product_fact',
        'INSERT',
        `NEW.seller_id = ${mine}`,
        () => putFacts(session, factsKey, made.id, factsOf(FULL_FACTS, 1)),
      ],
      [
        'listing row after the facts',
        'app.listing',
        'UPDATE',
        `NEW.seller_id = ${mine}`,
        () => putFacts(session, factsKey, made.id, factsOf(FULL_FACTS, 1)),
      ],
      [
        'facts event after the rows',
        'app.audit_event',
        'INSERT',
        `NEW.seller_id = ${mine} AND NEW.event_type = 'LISTING_FACTS_CHANGED'`,
        () => putFacts(session, factsKey, made.id, factsOf(FULL_FACTS, 1)),
      ],
      [
        'facts receipt after the event',
        'app.idempotency_receipt',
        'INSERT',
        `NEW.seller_id = ${mine}`,
        () => putFacts(session, factsKey, made.id, factsOf(FULL_FACTS, 1)),
      ],
    ];
    const empty = await snapshot(faulty.sellerId);
    for (const [label, table, timing, condition, attempt] of faults) {
      const remove = await inject(table, timing, condition);
      try {
        const res = await attempt();
        expect(res.statusCode, label).toBe(500);
        expect(res.json(), label).toEqual({ error: 'internal' });
      } finally {
        await remove();
      }
      expect(await snapshot(faulty.sellerId), label).toEqual(empty);
    }
    // With the faults gone the same key sets the facts once and then replays.
    const okFacts = await putFacts(session, factsKey, made.id, factsOf(FULL_FACTS, 1));
    expect(okFacts.statusCode).toBe(200);
    expect((await putFacts(session, factsKey, made.id, factsOf(FULL_FACTS, 1))).body).toBe(okFacts.body);
    const withFacts = await snapshot(faulty.sellerId);
    expect(withFacts.facts).toHaveLength(11);
    expect(withFacts.events.map((e) => e.event_type)).toEqual(['LISTING_CREATED', 'LISTING_FACTS_CHANGED']);
    expect(withFacts.receipts).toHaveLength(2);

    const draftFaults: [
      string,
      string,
      'INSERT' | 'UPDATE' | 'DELETE',
      string,
      () => Promise<LightMyRequestResponse>,
    ][] = [
      [
        'version insert',
        'app.listing_content_version',
        'INSERT',
        `NEW.seller_id = ${mine}`,
        () => putDraft(session, draftKey, made.id, drafted(null)),
      ],
      [
        'listing row after the version',
        'app.listing',
        'UPDATE',
        `NEW.seller_id = ${mine}`,
        () => putDraft(session, draftKey, made.id, drafted(null)),
      ],
      [
        'draft event after the rows',
        'app.audit_event',
        'INSERT',
        `NEW.seller_id = ${mine} AND NEW.event_type = 'LISTING_CONTENT_DRAFTED'`,
        () => putDraft(session, draftKey, made.id, drafted(null)),
      ],
      [
        'draft receipt after the event',
        'app.idempotency_receipt',
        'INSERT',
        `NEW.seller_id = ${mine}`,
        () => putDraft(session, draftKey, made.id, drafted(null)),
      ],
      [
        'fact delete on clearing',
        'app.product_fact',
        'DELETE',
        `OLD.seller_id = ${mine}`,
        () => putFacts(session, clearKey, made.id, factsOf({}, 2)),
      ],
    ];
    for (const [label, table, timing, condition, attempt] of draftFaults) {
      const remove = await inject(table, timing, condition);
      try {
        const res = await attempt();
        expect(res.statusCode, label).toBe(500);
        expect(res.json(), label).toEqual({ error: 'internal' });
      } finally {
        await remove();
      }
      expect(await snapshot(faulty.sellerId), label).toEqual(withFacts);
    }
    const okDraft = await putDraft(session, draftKey, made.id, drafted(null));
    expect(okDraft.statusCode).toBe(200);
    expect((await putDraft(session, draftKey, made.id, drafted(null))).body).toBe(okDraft.body);
    const okClear = await putFacts(session, clearKey, made.id, factsOf({}, 3));
    expect(okClear.statusCode).toBe(200);
    const final = await snapshot(faulty.sellerId);
    expect(final.versions).toHaveLength(1);
    expect(final.facts).toHaveLength(0);
    expect(final.events.map((e) => e.event_type)).toEqual([
      'LISTING_CREATED',
      'LISTING_FACTS_CHANGED',
      'LISTING_CONTENT_DRAFTED',
      'LISTING_FACTS_CHANGED',
    ]);
    expect(final.receipts).toHaveLength(4);
    expect(final.listings[0]?.row_version).toBe(4);
    expect(harness.logText()).toMatch(/"error_type":/);
  });

  it('leaves no tenant context on a reused pooled connection after fact, draft and workspace requests', async () => {
    const one = await startAuthApp(env, { poolMax: 1 });
    try {
      const s = remember(await signIn(one, sellerA));
      const connectionState = () =>
        one.runtime.db.transaction().execute(async (trx) => {
          const value = await sql<{ setting: string | null; seller: string | null }>`
            select current_setting(${TENANT_SETTING}, true) as setting, app.current_seller_id()::text as seller`.execute(
            trx,
          );
          const facts = await sql<{ n: string }>`select count(*)::text as n from app.product_fact`.execute(
            trx,
          );
          const versions = await sql<{
            n: string;
          }>`select count(*)::text as n from app.listing_content_version`.execute(trx);
          return {
            setting: value.rows[0]?.setting ?? '',
            seller: value.rows[0]?.seller ?? null,
            visible: Number(facts.rows[0]?.n) + Number(versions.rows[0]?.n),
          };
        });
      const made = await create(s, one);
      expect(await connectionState()).toEqual({ setting: '', seller: null, visible: 0 });
      expect((await putFacts(s, randomUUID(), made.id, factsOf(FULL_FACTS, 1), {}, one)).statusCode).toBe(
        200,
      );
      expect(await connectionState()).toEqual({ setting: '', seller: null, visible: 0 });
      expect((await putDraft(s, randomUUID(), made.id, draftOf(2, null), {}, one)).statusCode).toBe(200);
      expect(await connectionState()).toEqual({ setting: '', seller: null, visible: 0 });
      expect((await get(one, `${LISTINGS}/${made.id}`, s.token)).statusCode).toBe(200);
      expect(await connectionState()).toEqual({ setting: '', seller: null, visible: 0 });
      // A refused request leaves nothing behind either.
      expect((await putFacts(s, randomUUID(), made.id, factsOf(FULL_FACTS, 1), {}, one)).statusCode).toBe(
        409,
      );
      expect(await connectionState()).toEqual({ setting: '', seller: null, visible: 0 });
    } finally {
      await one.close();
    }
  });

  it('exposes no seller, account, session, policy, receipt, audit, approver or secret field in any response, and neither events, receipts nor logs carry a fact value, a word of copy, a cookie, a token, an anti-forgery value or an amount', async () => {
    const forbidden =
      /seller_?id|tenant|account_?id|session_?id|minimum|target|policy|receipt|fingerprint|audit|token|hash|code|secret|cookie|acquisition|approved_?by|request_?id/i;
    expect(responses.length).toBeGreaterThan(50);
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
      expect(body).not.toContain(faulty.sellerId);
    }
    for (const sellerId of [sellerA.sellerId, sellerB.sellerId, faulty.sellerId]) {
      for (const e of await events(sellerId))
        expectNoValues(JSON.stringify(e.summary), `event ${e.event_type}`);
      for (const r of await receipts(sellerId))
        expectNoValues(JSON.stringify(r.outcome), `receipt ${r.command}`);
    }
    const log = harness.logText();
    for (const s of secrets) expect(log).not.toContain(s);
    expectNoValues(log, 'log');
    expect(log).not.toMatch(/"cookie":"(?!\[REDACTED\])/);
    expect(log).not.toContain('"amountMinor"');
    expect(log).not.toMatch(/minimum_?price/i);
    expect(log).not.toContain('acquisitionDate');
    expect(log).not.toContain('expectedRowVersion');
  });
});
