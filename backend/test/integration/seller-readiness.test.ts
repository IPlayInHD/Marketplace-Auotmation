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
import { command, FIXTURE, publishListing } from '../helpers/fixtures.ts';
import { query } from '../helpers/inspect.ts';

// The single tenant-context construction site is wrapped, unchanged in behaviour, so the tests
// can prove that no revoked, expired, unknown or malformed session ever reaches it.
vi.mock('../../src/db/kysely.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof KyselyModule>();
  return { ...actual, establishTenantContext: vi.fn(actual.establishTenantContext) };
});
const tenantContextCalls = vi.mocked(establishTenantContext);

// Slice 1h: the seller states the private minimum price and the negotiation rules (LIST-131,
// LIST-132), marks the listing READY (LIST-134, SM-L-01) and reopens it (LIST-134 AC3), over the
// existing listing.set_policy, listing.mark_ready and listing.revert_to_draft commands. Every
// account, item, word and amount is synthetic (D-18, DATA-110) and every amount is typed by the
// seller. Proofs: the readiness matrix end to end through the API with each gap named until met,
// the policy version appended, bound and audited by number only, the minimum price answered to
// the seller alone and found in no other response, event, receipt or log, READY once with one
// event and no access code, revert once, exact replay from the stored record even after the
// opposite transition, conflicts and stale versions without mutation, tenant isolation with no
// gap disclosure, refusals without tenant context, rollback of every write, and no tenant context
// on a pooled connection.

const DOMAIN = 'synthetic.invalid';
const address = (local: string) => [local, DOMAIN].join('@');
const PASSWORD = 'synthetic passphrase for readiness';
const LISTINGS = `${ROUTE_PREFIXES.seller}/listings`;
const FACTS = { name: 'Synthetic road bicycle', brand: 'Fictional Cycles', defects: 'rear brake pads worn' };
const COPY = {
  title: FIXTURE.copy.title,
  summary: FIXTURE.copy.summary,
  description: FIXTURE.copy.description,
};
const ASKING: Money = { amountMinor: 25_000, currency: 'CAD' };
const MINIMUM: Money = { amountMinor: 20_331, currency: 'CAD' };
const OTHER_MINIMUM: Money = { amountMinor: 19_777, currency: 'CAD' };
const RULES = {
  negotiationEnabled: true,
  tradesAllowed: false,
  deliveryAllowed: false,
  pickupAllowed: true,
  locationDisclosureMode: 'AREA' as const,
};
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
const ALL_GAPS = ['asking_price', 'approved_content', 'policy_version', 'minimum_price'];

interface ListingView {
  id: string;
  rowVersion: number;
  status: string;
  askingPrice: Money | null;
}
interface ListingBody {
  listing: ListingView;
}
interface PolicyBody extends ListingBody {
  policyVersion: {
    id: string;
    versionNumber: number;
    minimumPrice: Money;
    maxAutonomousConcession: Money | null;
    negotiationEnabled: boolean;
  };
}
interface DraftBody extends ListingBody {
  draft: { id: string };
}
interface WorkspaceBody extends ListingBody {
  facts: Record<string, { value: string }>;
  draft: { id: string; status: string } | null;
}
interface GapBody {
  error: string;
  missing?: string[];
}

describe('Seller readiness routes (Slice 1h)', () => {
  let env: TestDatabase;
  let harness: AuthApp;
  let sellerA: SyntheticAccount;
  let sellerB: SyntheticAccount;
  let faulty: SyntheticAccount;
  let sessionA: Session;
  let sessionB: Session;
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
  const read = (token: string | undefined, listingId: string, app: AuthApp = harness) =>
    get(app, `${LISTINGS}/${listingId}`, token).then(record(`${LISTINGS}/${listingId}`));
  const create = async (session: Session, app: AuthApp = harness) => {
    const res = await mutate('POST', LISTINGS, session, randomUUID(), {}, {}, app);
    expect(res.statusCode).toBe(201);
    return res.json<ListingBody>().listing;
  };
  const rowVersionOf = async (session: Session, id: string, app: AuthApp = harness) =>
    (await read(session.token, id, app)).json<WorkspaceBody>().listing.rowVersion;
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
  const putDraft = (session: Session, id: string, rv: number, source: string | null, app = harness) =>
    mutate(
      'PUT',
      `${LISTINGS}/${id}/draft`,
      session,
      randomUUID(),
      { expectedRowVersion: rv, sourceVersionId: source, ...COPY, structuredDetails: FACTS },
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
  const putPolicy = (
    session: Session | undefined,
    key: string | undefined,
    id: string,
    payload: unknown,
    extra: Record<string, string> = {},
    app: AuthApp = harness,
  ) => mutate('PUT', `${LISTINGS}/${id}/policy`, session, key, payload, extra, app);
  const policyOf = (rv: number, minimumPrice: Money = MINIMUM, more: Record<string, unknown> = {}) => ({
    expectedRowVersion: rv,
    minimumPrice,
    ...RULES,
    ...more,
  });
  const ready = (
    session: Session | undefined,
    key: string | undefined,
    id: string,
    rv: number,
    extra: Record<string, string> = {},
    app: AuthApp = harness,
  ) => mutate('POST', `${LISTINGS}/${id}/ready`, session, key, { expectedRowVersion: rv }, extra, app);
  const revert = (
    session: Session | undefined,
    key: string | undefined,
    id: string,
    rv: number,
    extra: Record<string, string> = {},
    app: AuthApp = harness,
  ) =>
    mutate('POST', `${LISTINGS}/${id}/revert-to-draft`, session, key, { expectedRowVersion: rv }, extra, app);

  /** A DRAFT listing driven through every prerequisite but the policy, over the API only. */
  const prepared = async (session: Session, app: AuthApp = harness) => {
    const made = await create(session, app);
    expect((await putFacts(session, made.id, FACTS, 1, app)).statusCode).toBe(200);
    const draft = await putDraft(session, made.id, 2, null, app);
    expect(draft.statusCode).toBe(200);
    expect(
      (await approveVersion(session, made.id, draft.json<DraftBody>().draft.id, 3, app)).statusCode,
    ).toBe(200);
    expect((await setPrice(session, made.id, ASKING, 4, app)).statusCode).toBe(200);
    return { id: made.id, rowVersion: 5, versionId: draft.json<DraftBody>().draft.id };
  };
  /** A DRAFT listing satisfying every SM-L-01 prerequisite, over the API only. */
  const complete = async (session: Session, app: AuthApp = harness) => {
    const p = await prepared(session, app);
    const policy = await putPolicy(session, randomUUID(), p.id, policyOf(p.rowVersion), {}, app);
    expect(policy.statusCode).toBe(200);
    return { ...p, rowVersion: 6, policyVersionId: policy.json<PolicyBody>().policyVersion.id };
  };

  const listingRows = (sellerId: string) =>
    query<{
      id: string;
      status: string;
      row_version: number;
      current_content_version_id: string | null;
      current_policy_version_id: string | null;
      asking_price_minor: number | null;
      xmin: string;
    }>(
      env.superuserUrl,
      `SELECT id, status::text, row_version, current_content_version_id, current_policy_version_id, asking_price_minor,
              xmin::text AS xmin FROM app.listing WHERE seller_id = $1 ORDER BY created_at, id`,
      [sellerId],
    );
  const policyRows = (sellerId: string) =>
    query<{
      id: string;
      listing_id: string;
      version_number: number;
      minimum_price_minor: number;
      currency: string;
      negotiation_enabled: boolean;
      max_autonomous_concession_minor: number | null;
    }>(
      env.superuserUrl,
      `SELECT id, listing_id, version_number, minimum_price_minor, currency, negotiation_enabled, max_autonomous_concession_minor
         FROM app.seller_policy_version WHERE seller_id = $1 ORDER BY listing_id, version_number`,
      [sellerId],
    );
  const factRows = (sellerId: string) =>
    query<{ listing_id: string; key: string; value: string; xmin: string }>(
      env.superuserUrl,
      `SELECT listing_id, key, value, xmin::text AS xmin FROM app.product_fact WHERE seller_id = $1 ORDER BY listing_id, key`,
      [sellerId],
    );
  const versionRows = (sellerId: string) =>
    query<{ id: string; listing_id: string; status: string; xmin: string }>(
      env.superuserUrl,
      `SELECT id, listing_id, status::text, xmin::text AS xmin FROM app.listing_content_version WHERE seller_id = $1 ORDER BY listing_id, version_number`,
      [sellerId],
    );
  const events = (sellerId: string) =>
    query<{
      event_type: string;
      subject_type: string;
      subject_id: string;
      policy_version_id: string | null;
      idempotency_key: string | null;
      request_id: string;
      summary: Record<string, unknown>;
    }>(
      env.superuserUrl,
      `SELECT event_type::text, subject_type, subject_id, policy_version_id, idempotency_key, request_id, summary
         FROM app.audit_event WHERE seller_id = $1 AND event_type::text NOT LIKE 'SELLER_S%' ORDER BY seq`,
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
  const accessRows = (sellerId: string) =>
    query<{ listing_id: string }>(
      env.superuserUrl,
      `SELECT listing_id FROM app.public_listing_access WHERE seller_id = $1`,
      [sellerId],
    );
  const codeRows = (sellerId: string) =>
    query<{ id: string }>(env.superuserUrl, `SELECT id FROM app.listing_access_code WHERE seller_id = $1`, [
      sellerId,
    ]);
  const snapshot = async (sellerId: string) => ({
    listings: await listingRows(sellerId),
    policies: await policyRows(sellerId),
    facts: await factRows(sellerId),
    versions: await versionRows(sellerId),
    events: await events(sellerId),
    receipts: await receipts(sellerId),
    access: await accessRows(sellerId),
    codes: await codeRows(sellerId),
  });
  const statusEvents = async (sellerId: string, listingId: string) =>
    (await events(sellerId)).filter(
      (e) => e.subject_id === listingId && e.event_type === 'LISTING_STATUS_CHANGED',
    );
  const priceEvents = async (sellerId: string, listingId: string) =>
    (await events(sellerId)).filter(
      (e) =>
        e.subject_id === listingId &&
        ['SELLER_POLICY_CHANGED', 'MINIMUM_PRICE_CHANGED'].includes(e.event_type),
    );
  const PROTECTED = [String(MINIMUM.amountMinor), String(OTHER_MINIMUM.amountMinor)];
  const expectNoMinimum = (text: string, label: string) => {
    for (const v of PROTECTED) expect(text, `${label} carries the minimum ${v}`).not.toContain(v);
  };

  beforeAll(async () => {
    env = await startDatabase();
    sellerA = await provisionAccount(env, {
      displayName: 'Synthetic Seller RA',
      email: address('seller-ra'),
      password: PASSWORD,
    });
    sellerB = await provisionAccount(env, {
      displayName: 'Synthetic Seller RB',
      email: address('seller-rb'),
      password: PASSWORD,
    });
    faulty = await provisionAccount(env, {
      displayName: 'Synthetic Seller RF',
      email: address('seller-rf'),
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
    const target = await complete(sessionA);
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
        ['policy', await putPolicy(session, randomUUID(), target.id, policyOf(target.rowVersion))],
        ['ready', await ready(session, randomUUID(), target.id, target.rowVersion)],
        ['revert', await revert(session, randomUUID(), target.id, target.rowVersion)],
      ] as const) {
        expect(res.statusCode, `${route} ${label}`).toBe(401);
        expect(res.json(), `${route} ${label}`).toEqual({ error: 'unauthenticated' });
        expect(cookieOf(res, harness.cookieName)?.value, `${route} ${label}`).toBe('');
      }
    }
    expect(tenantContextCalls).not.toHaveBeenCalled();
    expect(await snapshot(sellerA.sellerId)).toEqual(before);
  });

  it('refuses cross-site and anti-forgery-less requests on every route before any mutation', async () => {
    const target = await complete(sessionA);
    const before = await snapshot(sellerA.sellerId);
    const evil = { origin: 'https://evil.example' };
    const forged: Session = { token: sessionA.token, antiForgery: 'not-the-value' };
    for (const [label, res, error] of [
      [
        'policy cross-site',
        await putPolicy(sessionA, randomUUID(), target.id, policyOf(target.rowVersion), evil),
        'forbidden_origin',
      ],
      [
        'ready cross-site',
        await ready(sessionA, randomUUID(), target.id, target.rowVersion, evil),
        'forbidden_origin',
      ],
      [
        'revert cross-site',
        await revert(sessionA, randomUUID(), target.id, target.rowVersion, evil),
        'forbidden_origin',
      ],
      [
        'policy forged',
        await putPolicy(forged, randomUUID(), target.id, policyOf(target.rowVersion)),
        'forbidden_anti_forgery',
      ],
      [
        'ready forged',
        await ready(forged, randomUUID(), target.id, target.rowVersion),
        'forbidden_anti_forgery',
      ],
      [
        'revert forged',
        await revert(forged, randomUUID(), target.id, target.rowVersion),
        'forbidden_anti_forgery',
      ],
    ] as const) {
      expect(res.statusCode, label).toBe(403);
      expect(res.json(), label).toEqual({ error });
    }
    expect(await snapshot(sellerA.sellerId)).toEqual(before);
  });

  it('walks the readiness matrix through the API alone: READY names every missing prerequisite by gap name until each is met, a refusal consumes nothing, and the same key then succeeds', async () => {
    const made = await create(sessionA);
    const key = randomUUID();
    const attempt = async (rv: number, expected: string[]) => {
      const before = await snapshot(sellerA.sellerId);
      const res = await ready(sessionA, key, made.id, rv);
      expect(res.statusCode, expected.join(',')).toBe(409);
      expect(res.json<GapBody>(), expected.join(',')).toEqual({ error: 'invalid_state', missing: expected });
      expect(await snapshot(sellerA.sellerId), expected.join(',')).toEqual(before);
      expect((await statusEvents(sellerA.sellerId, made.id)).length).toBe(0);
      expect((await receipts(sellerA.sellerId)).filter((r) => r.idempotency_key === key)).toHaveLength(0);
    };
    // Nothing yet: every prerequisite is missing.
    await attempt(1, ALL_GAPS);
    // Facts and an approved seller version close approved_content.
    expect((await putFacts(sessionA, made.id, FACTS, 1)).statusCode).toBe(200);
    const draft = await putDraft(sessionA, made.id, 2, null);
    expect(draft.statusCode).toBe(200);
    await attempt(3, ALL_GAPS);
    expect((await approveVersion(sessionA, made.id, draft.json<DraftBody>().draft.id, 3)).statusCode).toBe(
      200,
    );
    await attempt(4, ['asking_price', 'policy_version', 'minimum_price']);
    // The asking price, typed by the seller, closes asking_price.
    expect((await setPrice(sessionA, made.id, ASKING, 4)).statusCode).toBe(200);
    await attempt(5, ['policy_version', 'minimum_price']);
    // A cleared backing fact reopens seller_provided_facts; restating it closes it again.
    expect((await putFacts(sessionA, made.id, { name: FACTS.name }, 5)).statusCode).toBe(200);
    await attempt(6, ['seller_provided_facts', 'policy_version', 'minimum_price']);
    expect((await putFacts(sessionA, made.id, FACTS, 6)).statusCode).toBe(200);
    // A policy in another currency closes policy_version and minimum_price but opens currency_match.
    const euro = await putPolicy(
      sessionA,
      randomUUID(),
      made.id,
      policyOf(7, { amountMinor: 20_331, currency: 'EUR' }),
    );
    expect(euro.statusCode).toBe(200);
    await attempt(8, ['currency_match']);
    // The seller's minimum in the asking currency closes the last gap.
    const policy = await putPolicy(sessionA, randomUUID(), made.id, policyOf(8));
    expect(policy.statusCode).toBe(200);
    expect(policy.json<PolicyBody>().policyVersion.versionNumber).toBe(2);
    const done = await ready(sessionA, key, made.id, 9);
    expect(done.statusCode).toBe(200);
    expect(done.json<ListingBody>().listing).toMatchObject({ id: made.id, status: 'READY', rowVersion: 10 });
    expect((await listingRows(sellerA.sellerId)).find((l) => l.id === made.id)).toMatchObject({
      status: 'READY',
      row_version: 10,
      current_policy_version_id: policy.json<PolicyBody>().policyVersion.id,
    });
  });

  it('records the seller-entered policy: an immutable version appended and bound, audited by version number only, the minimum answered to the seller alone, replayed from the immutable version, and every malformed or foreign value refused', async () => {
    const target = await prepared(sessionA);
    const key = randomUUID();
    const first = await putPolicy(
      sessionA,
      key,
      target.id,
      policyOf(target.rowVersion, MINIMUM, {
        maxAutonomousConcession: { amountMinor: 1_000, currency: 'CAD' },
        holdWindowSeconds: 3600,
      }),
    );
    expect(first.statusCode).toBe(200);
    const body = first.json<PolicyBody>();
    expect(Object.keys(body).sort()).toEqual(['listing', 'policyVersion']);
    expect(Object.keys(body.listing).sort()).toEqual(LISTING_KEYS);
    expect(Object.keys(body.policyVersion).sort()).toEqual(POLICY_KEYS);
    expect(body.listing).toMatchObject({
      id: target.id,
      status: 'DRAFT',
      rowVersion: target.rowVersion + 1,
      askingPrice: ASKING,
    });
    expect(body.policyVersion).toMatchObject({
      versionNumber: 1,
      minimumPrice: MINIMUM,
      maxAutonomousConcession: { amountMinor: 1_000, currency: 'CAD' },
      negotiationEnabled: true,
    });
    const rows = (await policyRows(sellerA.sellerId)).filter((p) => p.listing_id === target.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: body.policyVersion.id,
      version_number: 1,
      minimum_price_minor: MINIMUM.amountMinor,
      currency: 'CAD',
      max_autonomous_concession_minor: 1_000,
    });
    expect(
      (await listingRows(sellerA.sellerId)).find((l) => l.id === target.id)?.current_policy_version_id,
    ).toBe(body.policyVersion.id);
    // Two events, both carrying the version number and never the amount.
    const changes = await priceEvents(sellerA.sellerId, target.id);
    expect(changes.map((e) => e.event_type)).toEqual(['SELLER_POLICY_CHANGED', 'MINIMUM_PRICE_CHANGED']);
    for (const e of changes) {
      expect(e.summary).toEqual({ policy_version_number: 1 });
      expect(e.policy_version_id).toBe(body.policyVersion.id);
      expectNoMinimum(JSON.stringify(e.summary), e.event_type);
    }
    const receipt = (await receipts(sellerA.sellerId)).find((r) => r.idempotency_key === key);
    expect(receipt).toMatchObject({ command: 'listing.set_policy', subject_id: target.id });
    expect(Object.keys(receipt?.outcome ?? {}).sort()).toEqual(['listing', 'policyVersionId']);
    expectNoMinimum(JSON.stringify(receipt?.outcome), 'policy receipt');
    const state = await snapshot(sellerA.sellerId);
    // Exact replay.
    const replay = await putPolicy(
      sessionA,
      key,
      target.id,
      policyOf(target.rowVersion, MINIMUM, {
        maxAutonomousConcession: { amountMinor: 1_000, currency: 'CAD' },
        holdWindowSeconds: 3600,
      }),
    );
    expect(replay.statusCode).toBe(200);
    expect(replay.body).toBe(first.body);
    expect(await snapshot(sellerA.sellerId)).toEqual(state);
    // The workspace never carries the minimum or the policy.
    const workspace = await read(sessionA.token, target.id);
    expect(Object.keys(workspace.json<Record<string, unknown>>()).sort()).toEqual([
      'draft',
      'facts',
      'listing',
    ]);
    expectNoMinimum(workspace.body, 'workspace');
    // The same minimum restated: a new version and SELLER_POLICY_CHANGED only.
    const same = await putPolicy(sessionA, randomUUID(), target.id, policyOf(target.rowVersion + 1));
    expect(same.statusCode).toBe(200);
    expect(same.json<PolicyBody>().policyVersion.versionNumber).toBe(2);
    expect((await priceEvents(sellerA.sellerId, target.id)).map((e) => e.event_type)).toEqual([
      'SELLER_POLICY_CHANGED',
      'MINIMUM_PRICE_CHANGED',
      'SELLER_POLICY_CHANGED',
    ]);
    // A different minimum: both events again, and the listing binds the newest version.
    const other = await putPolicy(
      sessionA,
      randomUUID(),
      target.id,
      policyOf(target.rowVersion + 2, OTHER_MINIMUM),
    );
    expect(other.statusCode).toBe(200);
    expect((await priceEvents(sellerA.sellerId, target.id)).map((e) => e.event_type)).toEqual([
      'SELLER_POLICY_CHANGED',
      'MINIMUM_PRICE_CHANGED',
      'SELLER_POLICY_CHANGED',
      'SELLER_POLICY_CHANGED',
      'MINIMUM_PRICE_CHANGED',
    ]);
    expect(
      (await listingRows(sellerA.sellerId)).find((l) => l.id === target.id)?.current_policy_version_id,
    ).toBe(other.json<PolicyBody>().policyVersion.id);
    // Conflicts and refusals, none of which writes.
    const rv = target.rowVersion + 3;
    const before = await snapshot(sellerA.sellerId);
    const attempts: [string, Promise<LightMyRequestResponse>, number, string][] = [
      [
        'key with another minimum',
        putPolicy(sessionA, key, target.id, policyOf(target.rowVersion, OTHER_MINIMUM)),
        409,
        'idempotency_conflict',
      ],
      ['key for another command', ready(sessionA, key, target.id, rv), 409, 'idempotency_conflict'],
      [
        'stale row version',
        putPolicy(sessionA, randomUUID(), target.id, policyOf(rv - 1)),
        409,
        'stale_row_version',
      ],
      [
        'missing minimum',
        putPolicy(sessionA, randomUUID(), target.id, { expectedRowVersion: rv, ...RULES }),
        400,
        'bad_request',
      ],
      [
        'negative minimum',
        putPolicy(sessionA, randomUUID(), target.id, policyOf(rv, { amountMinor: -1, currency: 'CAD' })),
        400,
        'bad_request',
      ],
      [
        'fractional minimum',
        putPolicy(sessionA, randomUUID(), target.id, policyOf(rv, { amountMinor: 10.5, currency: 'CAD' })),
        400,
        'bad_request',
      ],
      [
        'lowercase currency',
        putPolicy(sessionA, randomUUID(), target.id, policyOf(rv, { amountMinor: 10, currency: 'cad' })),
        400,
        'bad_request',
      ],
      [
        'concession in another currency',
        putPolicy(
          sessionA,
          randomUUID(),
          target.id,
          policyOf(rv, MINIMUM, { maxAutonomousConcession: { amountMinor: 1, currency: 'EUR' } }),
        ),
        400,
        'bad_request',
      ],
      [
        'unknown disclosure mode',
        putPolicy(
          sessionA,
          randomUUID(),
          target.id,
          policyOf(rv, MINIMUM, { locationDisclosureMode: 'EXACT' }),
        ),
        400,
        'bad_request',
      ],
      [
        'zero hold window',
        putPolicy(sessionA, randomUUID(), target.id, policyOf(rv, MINIMUM, { holdWindowSeconds: 0 })),
        400,
        'bad_request',
      ],
      [
        'missing flag',
        putPolicy(sessionA, randomUUID(), target.id, {
          expectedRowVersion: rv,
          minimumPrice: MINIMUM,
          negotiationEnabled: true,
          tradesAllowed: false,
          deliveryAllowed: false,
          locationDisclosureMode: 'AREA',
        }),
        400,
        'bad_request',
      ],
      [
        'asking price in body',
        putPolicy(sessionA, randomUUID(), target.id, policyOf(rv, MINIMUM, { askingPrice: ASKING })),
        400,
        'bad_request',
      ],
      [
        'target price in body',
        putPolicy(sessionA, randomUUID(), target.id, policyOf(rv, MINIMUM, { targetPrice: ASKING })),
        400,
        'bad_request',
      ],
      [
        'suggested price in body',
        putPolicy(sessionA, randomUUID(), target.id, policyOf(rv, MINIMUM, { suggestedPrice: ASKING })),
        400,
        'bad_request',
      ],
      [
        'sellerId in body',
        putPolicy(sessionA, randomUUID(), target.id, policyOf(rv, MINIMUM, { sellerId: sellerB.sellerId })),
        400,
        'bad_request',
      ],
      [
        'status in body',
        putPolicy(sessionA, randomUUID(), target.id, policyOf(rv, MINIMUM, { status: 'READY' })),
        400,
        'bad_request',
      ],
      [
        'policyVersionId in body',
        putPolicy(
          sessionA,
          randomUUID(),
          target.id,
          policyOf(rv, MINIMUM, { policyVersionId: randomUUID() }),
        ),
        400,
        'bad_request',
      ],
      ['malformed id', putPolicy(sessionA, randomUUID(), 'not-a-uuid', policyOf(rv)), 400, 'bad_request'],
      [
        'missing key',
        putPolicy(sessionA, undefined, target.id, policyOf(rv)),
        400,
        'idempotency_key_required',
      ],
    ];
    for (const [label, pending, status, error] of attempts) {
      const res = await pending;
      expect(res.statusCode, label).toBe(status);
      expect(res.json(), label).toEqual({ error });
    }
    expect(await snapshot(sellerA.sellerId)).toEqual(before);
    // The policy is a DRAFT action: once READY it is refused.
    expect((await ready(sessionA, randomUUID(), target.id, rv)).statusCode).toBe(200);
    const inReady = await putPolicy(sessionA, randomUUID(), target.id, policyOf(rv + 1));
    expect(inReady.statusCode).toBe(409);
    expect(inReady.json()).toEqual({ error: 'invalid_state' });
  });

  it('marks READY exactly once with one status event and no access, replays exactly, refuses READY again and stale versions, and replays the READY key after a later revert without touching the DRAFT state', async () => {
    const target = await complete(sessionA);
    const before = await snapshot(sellerA.sellerId);
    const key = randomUUID();
    const first = await ready(sessionA, key, target.id, target.rowVersion);
    expect(first.statusCode).toBe(200);
    const body = first.json<ListingBody>();
    expect(Object.keys(body).sort()).toEqual(['listing']);
    expect(Object.keys(body.listing).sort()).toEqual(LISTING_KEYS);
    expect(body.listing).toMatchObject({
      id: target.id,
      status: 'READY',
      rowVersion: target.rowVersion + 1,
      askingPrice: ASKING,
    });
    const row = (await listingRows(sellerA.sellerId)).find((l) => l.id === target.id);
    expect(row).toMatchObject({
      status: 'READY',
      row_version: target.rowVersion + 1,
      current_content_version_id: target.versionId,
      current_policy_version_id: target.policyVersionId,
      asking_price_minor: ASKING.amountMinor,
    });
    const transitions = await statusEvents(sellerA.sellerId, target.id);
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({
      subject_type: 'listing',
      idempotency_key: key,
      policy_version_id: target.policyVersionId,
      summary: { from: 'DRAFT', to: 'READY', row_version: target.rowVersion + 1 },
    });
    const receipt = (await receipts(sellerA.sellerId)).find((r) => r.idempotency_key === key);
    expect(receipt).toMatchObject({ command: 'listing.mark_ready', subject_id: target.id });
    expect(Object.keys(receipt?.outcome ?? {})).toEqual(['listing']);
    expect(receipt?.request_id).toBe(transitions[0]?.request_id);
    // Content, facts and policy stand; no access, no code, no publication.
    const after = await snapshot(sellerA.sellerId);
    expect(after.facts).toEqual(before.facts);
    expect(after.versions).toEqual(before.versions);
    expect(after.policies).toEqual(before.policies);
    expect(after.access.filter((a) => a.listing_id === target.id)).toEqual([]);
    expect(after.codes).toEqual(before.codes);
    expect((await read(sessionA.token, target.id)).json<WorkspaceBody>().listing).toMatchObject({
      status: 'READY',
      rowVersion: target.rowVersion + 1,
    });
    // Exact replay, nothing duplicated.
    const replay = await ready(sessionA, key, target.id, target.rowVersion);
    expect(replay.statusCode).toBe(200);
    expect(replay.body).toBe(first.body);
    expect(await snapshot(sellerA.sellerId)).toEqual(after);
    // READY again under a new key, a stale version, a reused key with another version or listing.
    for (const [label, pending, status, error] of [
      [
        'already READY',
        ready(sessionA, randomUUID(), target.id, target.rowVersion + 1),
        409,
        'invalid_state',
      ],
      ['stale version', ready(sessionA, randomUUID(), target.id, target.rowVersion), 409, 'invalid_state'],
      [
        'key with another version',
        ready(sessionA, key, target.id, target.rowVersion + 1),
        409,
        'idempotency_conflict',
      ],
      [
        'key with another listing',
        ready(sessionA, key, randomUUID(), target.rowVersion),
        409,
        'idempotency_conflict',
      ],
      [
        'key for revert',
        revert(sessionA, key, target.id, target.rowVersion + 1),
        409,
        'idempotency_conflict',
      ],
      [
        'missing key',
        ready(sessionA, undefined, target.id, target.rowVersion + 1),
        400,
        'idempotency_key_required',
      ],
      ['malformed id', ready(sessionA, randomUUID(), 'not-a-uuid', 1), 400, 'bad_request'],
      [
        'status in body',
        mutate('POST', `${LISTINGS}/${target.id}/ready`, sessionA, randomUUID(), {
          expectedRowVersion: target.rowVersion + 1,
          status: 'LISTED',
        }),
        400,
        'bad_request',
      ],
      [
        'policy in body',
        mutate('POST', `${LISTINGS}/${target.id}/ready`, sessionA, randomUUID(), {
          expectedRowVersion: target.rowVersion + 1,
          policyVersionId: target.policyVersionId,
        }),
        400,
        'bad_request',
      ],
    ] as const) {
      const res = await pending;
      expect(res.statusCode, label).toBe(status);
      expect(res.json(), label).toEqual({ error });
    }
    expect(await snapshot(sellerA.sellerId)).toEqual(after);
    // A stale version on a DRAFT listing is the concurrency refusal, checked before readiness.
    const other = await complete(sessionA);
    const stale = await ready(sessionA, randomUUID(), other.id, other.rowVersion - 1);
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toEqual({ error: 'stale_row_version' });
    // Revert, then replay the READY key: the original READY answer, and the listing stays DRAFT.
    const reverted = await revert(sessionA, randomUUID(), target.id, target.rowVersion + 1);
    expect(reverted.statusCode).toBe(200);
    expect(reverted.json<ListingBody>().listing).toMatchObject({
      status: 'DRAFT',
      rowVersion: target.rowVersion + 2,
    });
    const afterRevert = await snapshot(sellerA.sellerId);
    const historical = await ready(sessionA, key, target.id, target.rowVersion);
    expect(historical.statusCode).toBe(200);
    expect(historical.body).toBe(first.body);
    expect(historical.json<ListingBody>().listing.status).toBe('READY');
    expect(await snapshot(sellerA.sellerId)).toEqual(afterRevert);
    expect((await listingRows(sellerA.sellerId)).find((l) => l.id === target.id)?.status).toBe('DRAFT');
  });

  it('reverts READY to DRAFT exactly once, preserving content, prices, policy and facts, replays exactly, refuses DRAFT and every other state under a new key, and replays the revert key after a later READY without touching the READY state', async () => {
    const target = await complete(sessionA);
    expect((await ready(sessionA, randomUUID(), target.id, target.rowVersion)).statusCode).toBe(200);
    const rv = target.rowVersion + 1;
    const before = await snapshot(sellerA.sellerId);
    const key = randomUUID();
    const first = await revert(sessionA, key, target.id, rv);
    expect(first.statusCode).toBe(200);
    expect(Object.keys(first.json<Record<string, unknown>>())).toEqual(['listing']);
    expect(first.json<ListingBody>().listing).toMatchObject({
      id: target.id,
      status: 'DRAFT',
      rowVersion: rv + 1,
      askingPrice: ASKING,
    });
    const row = (await listingRows(sellerA.sellerId)).find((l) => l.id === target.id);
    expect(row).toMatchObject({
      status: 'DRAFT',
      row_version: rv + 1,
      current_content_version_id: target.versionId,
      current_policy_version_id: target.policyVersionId,
      asking_price_minor: ASKING.amountMinor,
    });
    const after = await snapshot(sellerA.sellerId);
    expect(after.facts).toEqual(before.facts);
    expect(after.versions).toEqual(before.versions);
    expect(after.policies).toEqual(before.policies);
    const transitions = await statusEvents(sellerA.sellerId, target.id);
    expect(transitions.map((e) => e.summary)).toEqual([
      { from: 'DRAFT', to: 'READY', row_version: rv },
      { from: 'READY', to: 'DRAFT', row_version: rv + 1 },
    ]);
    expect(transitions[1]).toMatchObject({ idempotency_key: key, policy_version_id: target.policyVersionId });
    expect((await receipts(sellerA.sellerId)).find((r) => r.idempotency_key === key)).toMatchObject({
      command: 'listing.revert_to_draft',
      subject_id: target.id,
    });
    // Exact replay.
    const replay = await revert(sessionA, key, target.id, rv);
    expect(replay.statusCode).toBe(200);
    expect(replay.body).toBe(first.body);
    expect(await snapshot(sellerA.sellerId)).toEqual(after);
    // Already DRAFT under a new key, stale version, conflicts.
    for (const [label, pending, status, error] of [
      ['already DRAFT', revert(sessionA, randomUUID(), target.id, rv + 1), 409, 'invalid_state'],
      ['key with another version', revert(sessionA, key, target.id, rv + 1), 409, 'idempotency_conflict'],
      ['key for ready', ready(sessionA, key, target.id, rv + 1), 409, 'idempotency_conflict'],
    ] as const) {
      const res = await pending;
      expect(res.statusCode, label).toBe(status);
      expect(res.json(), label).toEqual({ error });
    }
    expect(await snapshot(sellerA.sellerId)).toEqual(after);
    // READY again needs nothing new, and a stale revert on a READY listing is the concurrency refusal.
    expect((await ready(sessionA, randomUUID(), target.id, rv + 1)).statusCode).toBe(200);
    const stale = await revert(sessionA, randomUUID(), target.id, rv + 1);
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toEqual({ error: 'stale_row_version' });
    const afterReady = await snapshot(sellerA.sellerId);
    // Replaying the revert key now: the original DRAFT answer, and the listing stays READY.
    const historical = await revert(sessionA, key, target.id, rv);
    expect(historical.statusCode).toBe(200);
    expect(historical.body).toBe(first.body);
    expect((await listingRows(sellerA.sellerId)).find((l) => l.id === target.id)?.status).toBe('READY');
    expect(await snapshot(sellerA.sellerId)).toEqual(afterReady);
    // Neither transition is drawn from LISTED, CANCELLED, ARCHIVED or EXPIRED.
    const db = harness.runtime.db;
    const tenant = <T>(fn: Parameters<typeof withTenant<T>>[2]) => withTenant(db, sellerA.sellerId, fn);
    const listed = await publishListing(db, sellerA.sellerId);
    const cancelled = await publishListing(db, sellerA.sellerId);
    await tenant((trx) =>
      listings.cancelListing(trx, command(sellerA.sellerId, 'cancel'), {
        listingId: cancelled.listed.listing.id,
        expectedRowVersion: cancelled.listed.listing.rowVersion,
      }),
    );
    const archived = await publishListing(db, sellerA.sellerId);
    const closed = await tenant((trx) =>
      listings.cancelListing(trx, command(sellerA.sellerId, 'cancel'), {
        listingId: archived.listed.listing.id,
        expectedRowVersion: archived.listed.listing.rowVersion,
      }),
    );
    await tenant((trx) =>
      listings.archiveListing(trx, command(sellerA.sellerId, 'archive'), {
        listingId: archived.listed.listing.id,
        expectedRowVersion: closed.listing.rowVersion,
      }),
    );
    const expired = await publishListing(db, sellerA.sellerId);
    await tenant((trx) =>
      listings.expireListing(trx, command(sellerA.sellerId, 'expire'), {
        listingId: expired.listed.listing.id,
        expectedRowVersion: expired.listed.listing.rowVersion,
      }),
    );
    const settled = await snapshot(sellerA.sellerId);
    for (const [status, id] of [
      ['LISTED', listed.listed.listing.id],
      ['CANCELLED', cancelled.listed.listing.id],
      ['ARCHIVED', archived.listed.listing.id],
      ['EXPIRED', expired.listed.listing.id],
    ] as const) {
      const current = await rowVersionOf(sessionA, id);
      expect((await read(sessionA.token, id)).json<WorkspaceBody>().listing.status, status).toBe(status);
      for (const [route, res] of [
        ['ready', await ready(sessionA, randomUUID(), id, current)],
        ['revert', await revert(sessionA, randomUUID(), id, current)],
        ['policy', await putPolicy(sessionA, randomUUID(), id, policyOf(current))],
      ] as const) {
        expect(res.statusCode, `${route} in ${status}`).toBe(409);
        expect(res.json(), `${route} in ${status}`).toEqual({ error: 'invalid_state' });
      }
    }
    expect(await snapshot(sellerA.sellerId)).toEqual(settled);
  });

  it('keeps tenants apart: seller B learns no gap, state, policy or existence of seller A’s listing, and foreign and nonexistent identifiers are indistinguishable', async () => {
    const incomplete = await prepared(sessionA);
    const target = await complete(sessionA);
    const stateA = await snapshot(sellerA.sellerId);
    const stateB = await snapshot(sellerB.sellerId);
    const shape = (res: LightMyRequestResponse) =>
      `${res.statusCode}|${res.body}|${String(res.headers['content-type'])}|${String(res.headers['content-length'])}`;
    const absent = randomUUID();
    for (const [label, own, nothing] of [
      [
        'ready on the incomplete listing',
        await ready(sessionB, randomUUID(), incomplete.id, incomplete.rowVersion),
        await ready(sessionB, randomUUID(), absent, incomplete.rowVersion),
      ],
      [
        'ready on the complete listing',
        await ready(sessionB, randomUUID(), target.id, target.rowVersion),
        await ready(sessionB, randomUUID(), absent, target.rowVersion),
      ],
      [
        'revert',
        await revert(sessionB, randomUUID(), target.id, target.rowVersion),
        await revert(sessionB, randomUUID(), absent, target.rowVersion),
      ],
      [
        'policy',
        await putPolicy(sessionB, randomUUID(), target.id, policyOf(target.rowVersion)),
        await putPolicy(sessionB, randomUUID(), absent, policyOf(target.rowVersion)),
      ],
    ] as const) {
      expect(own.statusCode, label).toBe(404);
      expect(own.json(), label).toEqual({ error: 'not_found' });
      expect(shape(own), label).toBe(shape(nothing));
      expect(own.body, label).not.toContain('missing');
    }
    expect(await snapshot(sellerA.sellerId)).toEqual(stateA);
    expect(await snapshot(sellerB.sellerId)).toEqual(stateB);
    expect(stateB.policies).toEqual([]);
    // Under B's context A's policy version does not exist.
    const seenByB = await withTenant(harness.runtime.db, sellerB.sellerId, (trx) =>
      trx.selectFrom('seller_policy_version').select('id').where('listing_id', '=', target.id).execute(),
    );
    expect(seenByB).toEqual([]);
    // Identity headers change nothing: A's transition is A's.
    const spoofed = await ready(sessionA, randomUUID(), target.id, target.rowVersion, {
      'x-seller-id': sellerB.sellerId,
      'x-tenant-id': sellerB.sellerId,
    });
    expect(spoofed.statusCode).toBe(200);
    expect(await snapshot(sellerB.sellerId)).toEqual(stateB);
  });

  it('rolls back the policy version, the listing row, the events and the receipt together, and the READY and revert writes with their event and receipt, when any write fails', async () => {
    const session = remember(await signIn(harness, faulty));
    const target = await prepared(session);
    const inject = async (table: string, timing: 'INSERT' | 'UPDATE', condition: string) => {
      await query(
        env.superuserUrl,
        `CREATE FUNCTION public.fail_readiness_for_test() RETURNS trigger LANGUAGE plpgsql AS $$
           BEGIN RAISE EXCEPTION 'injected failure'; END $$;
         CREATE TRIGGER fail_readiness_for_test BEFORE ${timing} ON ${table}
           FOR EACH ROW WHEN (${condition}) EXECUTE FUNCTION public.fail_readiness_for_test();`,
      );
      return async () => {
        await query(
          env.superuserUrl,
          `DROP TRIGGER fail_readiness_for_test ON ${table}; DROP FUNCTION public.fail_readiness_for_test();`,
        );
      };
    };
    const mine = `'${faulty.sellerId}'`;
    const run = async (
      faults: [string, string, 'INSERT' | 'UPDATE', string][],
      attempt: () => Promise<LightMyRequestResponse>,
    ) => {
      const before = await snapshot(faulty.sellerId);
      for (const [label, table, timing, condition] of faults) {
        const remove = await inject(table, timing, condition);
        try {
          const res = await attempt();
          expect(res.statusCode, label).toBe(500);
          expect(res.json(), label).toEqual({ error: 'internal' });
        } finally {
          await remove();
        }
        expect(await snapshot(faulty.sellerId), label).toEqual(before);
      }
    };
    // Policy: the version insert, the listing row, each of the two events, the receipt.
    const policyKey = randomUUID();
    await run(
      [
        ['policy version insert', 'app.seller_policy_version', 'INSERT', `NEW.seller_id = ${mine}`],
        ['listing row after the version', 'app.listing', 'UPDATE', `NEW.seller_id = ${mine}`],
        [
          'policy event',
          'app.audit_event',
          'INSERT',
          `NEW.seller_id = ${mine} AND NEW.event_type = 'SELLER_POLICY_CHANGED'`,
        ],
        [
          'minimum event',
          'app.audit_event',
          'INSERT',
          `NEW.seller_id = ${mine} AND NEW.event_type = 'MINIMUM_PRICE_CHANGED'`,
        ],
        ['policy receipt', 'app.idempotency_receipt', 'INSERT', `NEW.seller_id = ${mine}`],
      ],
      () => putPolicy(session, policyKey, target.id, policyOf(target.rowVersion)),
    );
    const policy = await putPolicy(session, policyKey, target.id, policyOf(target.rowVersion));
    expect(policy.statusCode).toBe(200);
    expect((await putPolicy(session, policyKey, target.id, policyOf(target.rowVersion))).body).toBe(
      policy.body,
    );
    // READY: the listing row, the status event, the receipt.
    const readyKey = randomUUID();
    const rv = target.rowVersion + 1;
    await run(
      [
        ['listing row on READY', 'app.listing', 'UPDATE', `NEW.seller_id = ${mine}`],
        [
          'status event on READY',
          'app.audit_event',
          'INSERT',
          `NEW.seller_id = ${mine} AND NEW.event_type = 'LISTING_STATUS_CHANGED'`,
        ],
        ['receipt on READY', 'app.idempotency_receipt', 'INSERT', `NEW.seller_id = ${mine}`],
      ],
      () => ready(session, readyKey, target.id, rv),
    );
    const okReady = await ready(session, readyKey, target.id, rv);
    expect(okReady.statusCode).toBe(200);
    expect((await ready(session, readyKey, target.id, rv)).body).toBe(okReady.body);
    // Revert: the same three.
    const revertKey = randomUUID();
    await run(
      [
        ['listing row on revert', 'app.listing', 'UPDATE', `NEW.seller_id = ${mine}`],
        [
          'status event on revert',
          'app.audit_event',
          'INSERT',
          `NEW.seller_id = ${mine} AND NEW.event_type = 'LISTING_STATUS_CHANGED'`,
        ],
        ['receipt on revert', 'app.idempotency_receipt', 'INSERT', `NEW.seller_id = ${mine}`],
      ],
      () => revert(session, revertKey, target.id, rv + 1),
    );
    const okRevert = await revert(session, revertKey, target.id, rv + 1);
    expect(okRevert.statusCode).toBe(200);
    expect((await revert(session, revertKey, target.id, rv + 1)).body).toBe(okRevert.body);
    const final = await snapshot(faulty.sellerId);
    expect(final.listings[0]).toMatchObject({ status: 'DRAFT', row_version: rv + 2 });
    expect(final.policies).toHaveLength(1);
    expect(final.events.map((e) => e.event_type)).toEqual([
      'LISTING_CREATED',
      'LISTING_FACTS_CHANGED',
      'LISTING_CONTENT_DRAFTED',
      'LISTING_CONTENT_APPROVED',
      'LISTING_ASKING_PRICE_CHANGED',
      'SELLER_POLICY_CHANGED',
      'MINIMUM_PRICE_CHANGED',
      'LISTING_STATUS_CHANGED',
      'LISTING_STATUS_CHANGED',
    ]);
    expect(final.receipts).toHaveLength(8);
    expect(harness.logText()).toMatch(/"error_type":/);
  });

  it('leaves no tenant context on a reused pooled connection after policy, READY, revert and workspace requests', async () => {
    const one = await startAuthApp(env, { poolMax: 1 });
    try {
      const s = remember(await signIn(one, sellerA));
      const connectionState = () =>
        one.runtime.db.transaction().execute(async (trx) => {
          const value = await sql<{ setting: string | null; seller: string | null }>`
            select current_setting(${TENANT_SETTING}, true) as setting, app.current_seller_id()::text as seller`.execute(
            trx,
          );
          const policies = await sql<{
            n: string;
          }>`select count(*)::text as n from app.seller_policy_version`.execute(trx);
          return {
            setting: value.rows[0]?.setting ?? '',
            seller: value.rows[0]?.seller ?? null,
            visible: Number(policies.rows[0]?.n),
          };
        });
      const target = await complete(s, one);
      expect(await connectionState()).toEqual({ setting: '', seller: null, visible: 0 });
      expect((await ready(s, randomUUID(), target.id, target.rowVersion, {}, one)).statusCode).toBe(200);
      expect(await connectionState()).toEqual({ setting: '', seller: null, visible: 0 });
      expect((await revert(s, randomUUID(), target.id, target.rowVersion + 1, {}, one)).statusCode).toBe(200);
      expect(await connectionState()).toEqual({ setting: '', seller: null, visible: 0 });
      expect((await ready(s, randomUUID(), target.id, target.rowVersion, {}, one)).statusCode).toBe(409);
      expect(await connectionState()).toEqual({ setting: '', seller: null, visible: 0 });
      expect((await read(s.token, target.id, one)).statusCode).toBe(200);
      expect(await connectionState()).toEqual({ setting: '', seller: null, visible: 0 });
    } finally {
      await one.close();
    }
  });

  it('answers the minimum price to the seller on the policy route only, and never in another response, an event, a receipt or a log; no response carries a seller, account, session, receipt, audit or secret field', () => {
    const forbidden =
      /seller_?id|tenant|account_?id|session_?id|target|receipt|fingerprint|audit|token|hash|code|secret|cookie|acquisition|approved_?by|request_?id|suggest|recommend|estimate/i;
    const forbiddenOutsidePolicy = /minimum|policy|concession|hold/i;
    expect(responses.length).toBeGreaterThan(60);
    let policyAnswers = 0;
    for (const { url, body } of responses) {
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
      for (const k of keys) expect(k, `${url} ${body}`).not.toMatch(forbidden);
      expect(body).not.toContain(sellerA.sellerId);
      expect(body).not.toContain(sellerB.sellerId);
      expect(body).not.toContain(faulty.sellerId);
      if (url.endsWith('/policy') && 'policyVersion' in parsed) {
        policyAnswers += 1;
      } else {
        for (const k of keys) expect(k, `${url} ${body}`).not.toMatch(forbiddenOutsidePolicy);
        expectNoMinimum(body, url);
      }
    }
    expect(policyAnswers).toBeGreaterThan(5);
  });

  it('keeps the minimum out of every event summary, receipt outcome and log line', async () => {
    for (const sellerId of [sellerA.sellerId, sellerB.sellerId, faulty.sellerId]) {
      for (const e of await events(sellerId)) {
        expectNoMinimum(JSON.stringify(e.summary), `event ${e.event_type}`);
        expect(JSON.stringify(e.summary)).not.toMatch(/minimum_price_minor|amountMinor/);
      }
      for (const r of await receipts(sellerId)) {
        expectNoMinimum(JSON.stringify(r.outcome), `receipt ${r.command}`);
        expect(Object.keys(r.outcome)).not.toContain('policyVersion');
        expect(JSON.stringify(r.outcome)).not.toMatch(/minimum/i);
      }
    }
    const log = harness.logText();
    for (const s of secrets) expect(log).not.toContain(s);
    expectNoMinimum(log, 'log');
    expect(log).not.toMatch(/"cookie":"(?!\[REDACTED\])/);
    expect(log).not.toContain('"amountMinor"');
    expect(log).not.toMatch(/minimum_?price/i);
    expect(log).not.toContain('expectedRowVersion');
  });
});
