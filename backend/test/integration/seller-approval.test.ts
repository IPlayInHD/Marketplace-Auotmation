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
import { ListingNotReadyError } from '../../src/shared/errors.ts';
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

// Slice 1g: the seller's explicit approval of one seller draft over the existing
// listing.approve_content command (LIST-105, LIST-108, SM-CT-01, SM-CT-02). Every account, item
// and word is synthetic (D-18, DATA-110). Proofs: eligibility and ownership under RLS, immutable
// words, supersession with one approved version, no listing transition, exact replay from stored
// approval marks even after a later approval superseded the version, conflicts and stale versions
// without mutation, D-10 enforced at READY, DRAFT and EXPIRED allowed and every other state
// refused, no publication or relist, refusals without tenant context, rollback of every write,
// no tenant context on a pooled connection, and no word, identity or secret in events, receipts,
// responses or logs.

const DOMAIN = 'synthetic.invalid';
const address = (local: string) => [local, DOMAIN].join('@');
const PASSWORD = 'synthetic passphrase for approval';
const LISTINGS = `${ROUTE_PREFIXES.seller}/listings`;
const FACTS = { name: 'Synthetic road bicycle', brand: 'Fictional Cycles', defects: 'rear brake pads worn' };
const COPY = {
  title: FIXTURE.copy.title,
  summary: FIXTURE.copy.summary,
  description: 'Approval fixture description.\n\nTwo  spaces, a line break and an accent: é, kept as typed.',
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
const APPROVED_KEYS = ['approvedAt', 'id', 'provenance', 'sourceVersionId', 'status', 'versionNumber'];

interface ListingView {
  id: string;
  rowVersion: number;
  status: string;
}
interface DraftBody {
  listing: ListingView;
  draft: {
    id: string;
    versionNumber: number;
    status: string;
    title: string;
    summary: string | null;
    description: string | null;
    structuredDetails: Record<string, string>;
    sourceVersionId: string | null;
  };
}
interface ApprovalBody {
  listing: ListingView;
  approvedContentVersion: {
    id: string;
    versionNumber: number;
    status: string;
    provenance: string;
    sourceVersionId: string | null;
    approvedAt: string;
  };
}
interface WorkspaceBody {
  listing: ListingView;
  facts: Record<string, { value: string }>;
  draft: DraftBody['draft'] | null;
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
  approved_at: Date | null;
  approved_by: string | null;
  xmin: string;
}

describe('Seller content approval route (Slice 1g)', () => {
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
    return res.json<{ listing: ListingView }>().listing;
  };
  const read = (token: string | undefined, listingId: string, headers: Record<string, string> = {}) =>
    get(harness, `${LISTINGS}/${listingId}`, token, headers).then(record);
  const putFacts = (
    session: Session,
    listingId: string,
    facts: Record<string, string>,
    rv: number,
    app = harness,
  ) =>
    mutate(
      'PUT',
      `${LISTINGS}/${listingId}/facts`,
      session,
      randomUUID(),
      { expectedRowVersion: rv, facts },
      {},
      app,
    );
  const putDraft = (
    session: Session,
    listingId: string,
    rv: number,
    sourceVersionId: string | null,
    copy: Record<string, unknown> = COPY,
    app = harness,
  ) =>
    mutate(
      'PUT',
      `${LISTINGS}/${listingId}/draft`,
      session,
      randomUUID(),
      { expectedRowVersion: rv, sourceVersionId, ...copy },
      {},
      app,
    );
  const approve = (
    session: Session | undefined,
    key: string | undefined,
    listingId: string,
    versionId: string,
    payload: unknown,
    extra: Record<string, string> = {},
    app: AuthApp = harness,
  ) =>
    mutate(
      'POST',
      `${LISTINGS}/${listingId}/content/${versionId}/approve`,
      session,
      key,
      payload,
      extra,
      app,
    );
  const body = (rv: number) => ({ expectedRowVersion: rv });

  /** A DRAFT listing with facts and one SELLER_DRAFT version citing the given details. */
  const drafted = async (session: Session, details: Record<string, string> = FACTS, app = harness) => {
    const made = await create(session, app);
    expect((await putFacts(session, made.id, FACTS, 1, app)).statusCode).toBe(200);
    const draft = await putDraft(session, made.id, 2, null, { ...COPY, structuredDetails: details }, app);
    expect(draft.statusCode).toBe(200);
    const v = draft.json<DraftBody>();
    return { id: made.id, rowVersion: v.listing.rowVersion, version: v.draft };
  };

  const listingRows = (sellerId: string) =>
    query<{
      id: string;
      status: string;
      row_version: number;
      current_content_version_id: string | null;
      xmin: string;
    }>(
      env.superuserUrl,
      `SELECT id, status::text, row_version, current_content_version_id, xmin::text AS xmin FROM app.listing
        WHERE seller_id = $1 ORDER BY created_at, id`,
      [sellerId],
    );
  const versionRows = (sellerId: string) =>
    query<VersionRow>(
      env.superuserUrl,
      `SELECT id, listing_id, version_number, status::text, provenance::text, title, summary, description,
              structured_details, source_version_id, approved_at, approved_by, xmin::text AS xmin
         FROM app.listing_content_version WHERE seller_id = $1 ORDER BY listing_id, version_number`,
      [sellerId],
    );
  const factRows = (sellerId: string) =>
    query<{ listing_id: string; key: string; value: string; xmin: string }>(
      env.superuserUrl,
      `SELECT listing_id, key, value, xmin::text AS xmin FROM app.product_fact WHERE seller_id = $1 ORDER BY listing_id, key`,
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
        WHERE seller_id = $1 AND event_type::text NOT LIKE 'SELLER_S%' ORDER BY seq`,
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
  const codeRows = (sellerId: string) =>
    query<{ id: string; status: string; version_number: number }>(
      env.superuserUrl,
      `SELECT id, status::text, version_number FROM app.listing_access_code WHERE seller_id = $1 ORDER BY issued_at, id`,
      [sellerId],
    );
  const snapshot = async (sellerId: string) => ({
    listings: await listingRows(sellerId),
    versions: await versionRows(sellerId),
    facts: await factRows(sellerId),
    events: await events(sellerId),
    receipts: await receipts(sellerId),
    codes: await codeRows(sellerId),
  });
  const approvals = async (sellerId: string, versionIds: string[]) =>
    (await events(sellerId)).filter(
      (e) => e.event_type === 'LISTING_CONTENT_APPROVED' && versionIds.includes(e.subject_id),
    );
  const statusEvents = async (sellerId: string, listingId: string) =>
    (await events(sellerId)).filter(
      (e) => e.subject_id === listingId && e.event_type === 'LISTING_STATUS_CHANGED',
    );
  const words = [COPY.title, COPY.summary, COPY.description, ...Object.values(FACTS)];
  const expectNoWords = (text: string, label: string) => {
    for (const w of words) expect(text, `${label} carries ${w}`).not.toContain(w);
  };

  beforeAll(async () => {
    env = await startDatabase();
    sellerA = await provisionAccount(env, {
      displayName: 'Synthetic Seller PA',
      email: address('seller-pa'),
      password: PASSWORD,
    });
    sellerB = await provisionAccount(env, {
      displayName: 'Synthetic Seller PB',
      email: address('seller-pb'),
      password: PASSWORD,
    });
    faulty = await provisionAccount(env, {
      displayName: 'Synthetic Seller PF',
      email: address('seller-pf'),
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

  it('requires a live session: missing, malformed, unknown, revoked and expired sessions answer 401, approve nothing and never reach tenant context', async () => {
    const target = await drafted(sessionA);
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
      const res = await approve(session, randomUUID(), target.id, target.version.id, body(target.rowVersion));
      expect(res.statusCode, label).toBe(401);
      expect(res.json(), label).toEqual({ error: 'unauthenticated' });
      expect(cookieOf(res, harness.cookieName)?.value, label).toBe('');
    }
    expect(tenantContextCalls).not.toHaveBeenCalled();
    expect(await snapshot(sellerA.sellerId)).toEqual(before);
  });

  it('refuses cross-site and anti-forgery-less approvals before any mutation', async () => {
    const target = await drafted(sessionA);
    const before = await snapshot(sellerA.sellerId);
    const crossSite = await approve(
      sessionA,
      randomUUID(),
      target.id,
      target.version.id,
      body(target.rowVersion),
      {
        origin: 'https://evil.example',
      },
    );
    expect(crossSite.statusCode).toBe(403);
    expect(crossSite.json()).toEqual({ error: 'forbidden_origin' });
    const forged = await approve(
      { token: sessionA.token, antiForgery: 'not-the-value' },
      randomUUID(),
      target.id,
      target.version.id,
      body(target.rowVersion),
    );
    expect(forged.statusCode).toBe(403);
    expect(forged.json()).toEqual({ error: 'forbidden_anti_forgery' });
    expect(await snapshot(sellerA.sellerId)).toEqual(before);
  });

  it('approves an eligible seller draft: exact words kept, the single approved version, one event, no listing transition, an exact replay and the workspace reflecting it', async () => {
    const target = await drafted(sessionA);
    const before = await snapshot(sellerA.sellerId);
    const key = randomUUID();
    const first = await approve(sessionA, key, target.id, target.version.id, body(target.rowVersion));
    expect(first.statusCode).toBe(200);
    const result = first.json<ApprovalBody>();
    expect(Object.keys(result).sort()).toEqual(['approvedContentVersion', 'listing']);
    expect(Object.keys(result.listing).sort()).toEqual(LISTING_KEYS);
    expect(Object.keys(result.approvedContentVersion).sort()).toEqual(APPROVED_KEYS);
    expect(result.listing).toMatchObject({
      id: target.id,
      status: 'DRAFT',
      rowVersion: target.rowVersion + 1,
    });
    expect(result.approvedContentVersion).toMatchObject({
      id: target.version.id,
      versionNumber: 1,
      status: 'APPROVED',
      provenance: 'SELLER_APPROVED_COPY',
      sourceVersionId: null,
    });
    expect(result.approvedContentVersion.approvedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expectNoWords(first.body, 'approval response');
    // The words are exactly the seller's, byte for byte, and only the marks changed.
    const row = (await versionRows(sellerA.sellerId)).find((v) => v.id === target.version.id);
    const draftRow = before.versions.find((v) => v.id === target.version.id);
    expect(row).toMatchObject({
      status: 'APPROVED',
      provenance: 'SELLER_APPROVED_COPY',
      approved_by: sellerA.sellerId,
      title: COPY.title,
      summary: COPY.summary,
      description: COPY.description,
      structured_details: FACTS,
      source_version_id: null,
    });
    expect(row?.approved_at).toBeInstanceOf(Date);
    expect([row?.title, row?.summary, row?.description, row?.structured_details]).toEqual([
      draftRow?.title,
      draftRow?.summary,
      draftRow?.description,
      draftRow?.structured_details,
    ]);
    const listingRow = (await listingRows(sellerA.sellerId)).find((l) => l.id === target.id);
    expect(listingRow).toMatchObject({
      status: 'DRAFT',
      row_version: target.rowVersion + 1,
      current_content_version_id: target.version.id,
    });
    const approvedEvents = await approvals(sellerA.sellerId, [target.version.id]);
    expect(approvedEvents).toHaveLength(1);
    expect(approvedEvents[0]).toMatchObject({ subject_type: 'content_version', idempotency_key: key });
    expect(approvedEvents[0]?.summary).toEqual({ version_number: 1, superseded_version_id: null });
    expect(await statusEvents(sellerA.sellerId, target.id)).toEqual([]);
    const receipt = (await receipts(sellerA.sellerId)).find((r) => r.idempotency_key === key);
    expect(receipt).toMatchObject({ command: 'listing.approve_content', subject_id: target.version.id });
    expect(receipt?.request_id).toBe(approvedEvents[0]?.request_id);
    expect(Object.keys(receipt?.outcome ?? {}).sort()).toEqual([
      'approvedAt',
      'approvedBy',
      'createdAt',
      'listing',
      'provenance',
      'sourceVersionId',
      'status',
      'versionId',
      'versionNumber',
    ]);
    expectNoWords(JSON.stringify(receipt?.outcome), 'approval receipt');
    expectNoWords(JSON.stringify(approvedEvents[0]?.summary), 'approval event');
    const state = await snapshot(sellerA.sellerId);
    expect(state.facts).toEqual(before.facts);

    // Exact replay: identical body, nothing written.
    const replay = await approve(sessionA, key, target.id, target.version.id, body(target.rowVersion));
    expect(replay.statusCode).toBe(200);
    expect(replay.body).toBe(first.body);
    expect(await snapshot(sellerA.sellerId)).toEqual(state);

    // The workspace shows the approved version as the latest, with its words, and no approver.
    const workspace = (await read(sessionA.token, target.id)).json<WorkspaceBody>();
    expect(workspace.draft).toMatchObject({
      id: target.version.id,
      status: 'APPROVED',
      title: COPY.title,
      description: COPY.description,
    });
    expect(workspace.draft).not.toHaveProperty('approvedBy');
    expect(workspace.listing.rowVersion).toBe(target.rowVersion + 1);
    expect(await snapshot(sellerA.sellerId)).toEqual(state);

    // Approval alone does not make the listing READY: SM-L-01 still names the other prerequisites.
    await expect(
      withTenant(harness.runtime.db, sellerA.sellerId, (trx) =>
        listings.markReady(trx, command(sellerA.sellerId, 'ready'), {
          listingId: target.id,
          expectedRowVersion: target.rowVersion + 1,
        }),
      ),
    ).rejects.toMatchObject({ missing: ['asking_price', 'policy_version', 'minimum_price'] });
    expect((await listingRows(sellerA.sellerId)).find((l) => l.id === target.id)?.status).toBe('DRAFT');
  });

  it('supersedes the previous approved version, keeps exactly one approved, refuses approved and superseded targets, allows an older draft, and replays an older approval key from its stored marks', async () => {
    const target = await drafted(sessionA);
    const v1 = target.version;
    const key1 = randomUUID();
    const first = await approve(sessionA, key1, target.id, v1.id, body(target.rowVersion));
    expect(first.statusCode).toBe(200);
    let rv = first.json<ApprovalBody>().listing.rowVersion;
    // A revision citing v1, then its approval: v1 SUPERSEDED with its marks retained, v2 APPROVED.
    const second = await putDraft(sessionA, target.id, rv, v1.id, {
      ...COPY,
      description: 'Second fixture wording.',
    });
    expect(second.statusCode).toBe(200);
    const v2 = second.json<DraftBody>().draft;
    rv = second.json<DraftBody>().listing.rowVersion;
    const key2 = randomUUID();
    const approved2 = await approve(sessionA, key2, target.id, v2.id, body(rv));
    expect(approved2.statusCode).toBe(200);
    expect(approved2.json<ApprovalBody>().approvedContentVersion).toMatchObject({
      id: v2.id,
      versionNumber: 2,
      status: 'APPROVED',
      sourceVersionId: v1.id,
    });
    rv = approved2.json<ApprovalBody>().listing.rowVersion;
    const rows = (await versionRows(sellerA.sellerId)).filter((v) => v.listing_id === target.id);
    expect(rows.map((v) => [v.version_number, v.status, v.source_version_id])).toEqual([
      [1, 'SUPERSEDED', null],
      [2, 'APPROVED', v1.id],
    ]);
    expect(rows[0]?.approved_at).toBeInstanceOf(Date);
    expect(rows[0]?.approved_by).toBe(sellerA.sellerId);
    expect(rows[0]?.description).toBe(COPY.description);
    expect(rows.filter((v) => v.status === 'APPROVED')).toHaveLength(1);
    expect(
      (await listingRows(sellerA.sellerId)).find((l) => l.id === target.id)?.current_content_version_id,
    ).toBe(v2.id);
    expect((await approvals(sellerA.sellerId, [v2.id]))[0]?.summary).toEqual({
      version_number: 2,
      superseded_version_id: v1.id,
    });
    const state = await snapshot(sellerA.sellerId);

    // Replaying key1 after v1 was superseded answers the original response, APPROVED and all,
    // from the stored marks, and changes nothing: v1 stays SUPERSEDED, v2 stays current.
    const older = await approve(sessionA, key1, target.id, v1.id, body(target.rowVersion));
    expect(older.statusCode).toBe(200);
    expect(older.body).toBe(first.body);
    expect(older.json<ApprovalBody>().approvedContentVersion.status).toBe('APPROVED');
    expect(await snapshot(sellerA.sellerId)).toEqual(state);
    expect((await read(sessionA.token, target.id)).json<WorkspaceBody>().draft).toMatchObject({
      id: v2.id,
      status: 'APPROVED',
    });

    // Under a new key: a superseded version and an already approved version are both refused.
    for (const [label, versionId] of [
      ['superseded v1', v1.id],
      ['already approved v2', v2.id],
    ] as const) {
      const res = await approve(sessionA, randomUUID(), target.id, versionId, body(rv));
      expect(res.statusCode, label).toBe(409);
      expect(res.json(), label).toEqual({ error: 'invalid_state' });
    }
    // A reused key with another version, row version, listing or command conflicts.
    const conflicts: [string, Promise<LightMyRequestResponse>][] = [
      ['key1 with v2', approve(sessionA, key1, target.id, v2.id, body(target.rowVersion))],
      ['key1 with another row version', approve(sessionA, key1, target.id, v1.id, body(rv))],
      ['key1 with another listing', approve(sessionA, key1, randomUUID(), v1.id, body(target.rowVersion))],
    ];
    for (const [label, pending] of conflicts) {
      const res = await pending;
      expect(res.statusCode, label).toBe(409);
      expect(res.json(), label).toEqual({ error: 'idempotency_conflict' });
    }
    expect(await snapshot(sellerA.sellerId)).toEqual(state);
    const factsWithKey1 = await mutate('PUT', `${LISTINGS}/${target.id}/facts`, sessionA, key1, {
      expectedRowVersion: rv,
      facts: FACTS,
    });
    expect(factsWithKey1.statusCode).toBe(409);
    expect(factsWithKey1.json()).toEqual({ error: 'idempotency_conflict' });
    expect(await snapshot(sellerA.sellerId)).toEqual(state);

    // Two more drafts; approving the older of them is drawn by STATE_MACHINES §8 (SELLER_DRAFT →
    // APPROVED carries no latest-version condition): v2 is superseded, v3 approved, v4 remains the
    // latest SELLER_DRAFT and the workspace's predecessor.
    const third = await putDraft(sessionA, target.id, rv, v2.id, {
      ...COPY,
      description: 'Third fixture wording.',
    });
    expect(third.statusCode).toBe(200);
    const v3 = third.json<DraftBody>().draft;
    const fourth = await putDraft(sessionA, target.id, third.json<DraftBody>().listing.rowVersion, v3.id, {
      ...COPY,
      description: 'Fourth fixture wording.',
    });
    expect(fourth.statusCode).toBe(200);
    const v4 = fourth.json<DraftBody>().draft;
    const olderDraft = await approve(
      sessionA,
      randomUUID(),
      target.id,
      v3.id,
      body(fourth.json<DraftBody>().listing.rowVersion),
    );
    expect(olderDraft.statusCode).toBe(200);
    expect(
      (await versionRows(sellerA.sellerId))
        .filter((v) => v.listing_id === target.id)
        .map((v) => [v.version_number, v.status]),
    ).toEqual([
      [1, 'SUPERSEDED'],
      [2, 'SUPERSEDED'],
      [3, 'APPROVED'],
      [4, 'SELLER_DRAFT'],
    ]);
    expect((await read(sessionA.token, target.id)).json<WorkspaceBody>().draft).toMatchObject({
      id: v4.id,
      status: 'SELLER_DRAFT',
    });
    expect(
      (await listingRows(sellerA.sellerId)).find((l) => l.id === target.id)?.current_content_version_id,
    ).toBe(v3.id);
  });

  it('fails without mutation on a stale row version, malformed identifiers, a missing or malformed key, and any submitted words, identity, status or price', async () => {
    const target = await drafted(sessionA);
    const before = await snapshot(sellerA.sellerId);
    const attempts: [string, Promise<LightMyRequestResponse>, number, string][] = [
      [
        'stale row version',
        approve(sessionA, randomUUID(), target.id, target.version.id, body(target.rowVersion - 1)),
        409,
        'stale_row_version',
      ],
      [
        'future row version',
        approve(sessionA, randomUUID(), target.id, target.version.id, body(target.rowVersion + 1)),
        409,
        'stale_row_version',
      ],
      [
        'malformed listing id',
        approve(sessionA, randomUUID(), 'not-a-uuid', target.version.id, body(target.rowVersion)),
        400,
        'bad_request',
      ],
      [
        'malformed version id',
        approve(sessionA, randomUUID(), target.id, 'not-a-uuid', body(target.rowVersion)),
        400,
        'bad_request',
      ],
      [
        'missing key',
        approve(sessionA, undefined, target.id, target.version.id, body(target.rowVersion)),
        400,
        'idempotency_key_required',
      ],
      [
        'malformed key',
        approve(sessionA, 'not-a-uuid', target.id, target.version.id, body(target.rowVersion)),
        400,
        'idempotency_key_required',
      ],
      [
        'missing row version',
        approve(sessionA, randomUUID(), target.id, target.version.id, {}),
        400,
        'bad_request',
      ],
      [
        'zero row version',
        approve(sessionA, randomUUID(), target.id, target.version.id, body(0)),
        400,
        'bad_request',
      ],
      [
        'fractional row version',
        approve(sessionA, randomUUID(), target.id, target.version.id, { expectedRowVersion: 1.5 }),
        400,
        'bad_request',
      ],
      [
        'title in body',
        approve(sessionA, randomUUID(), target.id, target.version.id, {
          ...body(target.rowVersion),
          title: 'x',
        }),
        400,
        'bad_request',
      ],
      [
        'description in body',
        approve(sessionA, randomUUID(), target.id, target.version.id, {
          ...body(target.rowVersion),
          description: 'x',
        }),
        400,
        'bad_request',
      ],
      [
        'facts in body',
        approve(sessionA, randomUUID(), target.id, target.version.id, {
          ...body(target.rowVersion),
          facts: FACTS,
        }),
        400,
        'bad_request',
      ],
      [
        'status in body',
        approve(sessionA, randomUUID(), target.id, target.version.id, {
          ...body(target.rowVersion),
          status: 'APPROVED',
        }),
        400,
        'bad_request',
      ],
      [
        'provenance in body',
        approve(sessionA, randomUUID(), target.id, target.version.id, {
          ...body(target.rowVersion),
          provenance: 'AI_ENHANCED_COPY',
        }),
        400,
        'bad_request',
      ],
      [
        'approvedBy in body',
        approve(sessionA, randomUUID(), target.id, target.version.id, {
          ...body(target.rowVersion),
          approvedBy: sellerA.sellerId,
        }),
        400,
        'bad_request',
      ],
      [
        'sellerId in body',
        approve(sessionA, randomUUID(), target.id, target.version.id, {
          ...body(target.rowVersion),
          sellerId: sellerB.sellerId,
        }),
        400,
        'bad_request',
      ],
      [
        'listingStatus in body',
        approve(sessionA, randomUUID(), target.id, target.version.id, {
          ...body(target.rowVersion),
          listingStatus: 'READY',
        }),
        400,
        'bad_request',
      ],
      [
        'askingPrice in body',
        approve(sessionA, randomUUID(), target.id, target.version.id, {
          ...body(target.rowVersion),
          askingPrice: { amountMinor: 1, currency: 'CAD' },
        }),
        400,
        'bad_request',
      ],
      [
        'minimumPrice in body',
        approve(sessionA, randomUUID(), target.id, target.version.id, {
          ...body(target.rowVersion),
          minimumPrice: { amountMinor: 1, currency: 'CAD' },
        }),
        400,
        'bad_request',
      ],
      [
        'accessCode in body',
        approve(sessionA, randomUUID(), target.id, target.version.id, {
          ...body(target.rowVersion),
          accessCode: '123456',
        }),
        400,
        'bad_request',
      ],
    ];
    for (const [label, pending, status, error] of attempts) {
      const res = await pending;
      expect(res.statusCode, label).toBe(status);
      expect(res.json(), label).toEqual({ error });
    }
    expect(await snapshot(sellerA.sellerId)).toEqual(before);
    // Identity headers change nothing: the tenant is the session's.
    const spoofed = await approve(
      sessionA,
      randomUUID(),
      target.id,
      target.version.id,
      body(target.rowVersion),
      {
        'x-seller-id': sellerB.sellerId,
        'x-tenant-id': sellerB.sellerId,
      },
    );
    expect(spoofed.statusCode).toBe(200);
    expect((await versionRows(sellerA.sellerId)).find((v) => v.id === target.version.id)?.approved_by).toBe(
      sellerA.sellerId,
    );
    expect(await versionRows(sellerB.sellerId)).toEqual([]);
  });

  it('keeps tenants apart: another tenant’s listing or version, a version of another listing and a nonexistent version are indistinguishable, and seller B approves nothing of seller A', async () => {
    const a = await drafted(sessionA);
    const aOther = await drafted(sessionA);
    const b = await drafted(sessionB);
    const stateA = await snapshot(sellerA.sellerId);
    const stateB = await snapshot(sellerB.sellerId);
    const shape = (res: LightMyRequestResponse) =>
      `${res.statusCode}|${res.body}|${String(res.headers['content-type'])}|${String(res.headers['content-length'])}`;
    const nothing = await approve(sessionB, randomUUID(), randomUUID(), randomUUID(), body(1));
    expect(nothing.statusCode).toBe(404);
    expect(nothing.json()).toEqual({ error: 'not_found' });
    for (const [label, res] of [
      [
        'B on A’s listing and version',
        await approve(sessionB, randomUUID(), a.id, a.version.id, body(a.rowVersion)),
      ],
      [
        'B’s own listing with A’s version',
        await approve(sessionB, randomUUID(), b.id, a.version.id, body(b.rowVersion)),
      ],
      [
        'A’s listing with a version of A’s other listing',
        await approve(sessionA, randomUUID(), a.id, aOther.version.id, body(a.rowVersion)),
      ],
      [
        'A’s listing with a nonexistent version',
        await approve(sessionA, randomUUID(), a.id, randomUUID(), body(a.rowVersion)),
      ],
      [
        'A on B’s listing and version',
        await approve(sessionA, randomUUID(), b.id, b.version.id, body(b.rowVersion)),
      ],
    ] as const) {
      expect(shape(res), label).toBe(shape(nothing));
    }
    expect(await snapshot(sellerA.sellerId)).toEqual(stateA);
    expect(await snapshot(sellerB.sellerId)).toEqual(stateB);
    // Under B's own context A's version does not exist.
    const seenByB = await withTenant(harness.runtime.db, sellerB.sellerId, (trx) =>
      trx.selectFrom('listing_content_version').select('id').where('id', '=', a.version.id).execute(),
    );
    expect(seenByB).toEqual([]);
    // Each seller still approves its own.
    expect((await approve(sessionA, randomUUID(), a.id, a.version.id, body(a.rowVersion))).statusCode).toBe(
      200,
    );
    expect((await approve(sessionB, randomUUID(), b.id, b.version.id, body(b.rowVersion))).statusCode).toBe(
      200,
    );
  });

  it('enforces D-10 where the canon places it: a draft cannot cite an unstated fact, and a version approved after its fact was cleared keeps the listing from READY', async () => {
    const target = await drafted(sessionA, { name: FACTS.name });
    // A draft with an unstated detail is refused before it exists.
    const uncovered = await putDraft(sessionA, target.id, target.rowVersion, target.version.id, {
      ...COPY,
      structuredDetails: { model: 'not a stated fact' },
    });
    expect(uncovered.statusCode).toBe(400);
    // The backing fact is cleared, then the existing draft is approved: the existing command does
    // not re-check coverage (listing-lifecycle suite, D-10 at the data layer), READY does.
    expect((await putFacts(sessionA, target.id, {}, target.rowVersion)).statusCode).toBe(200);
    const approved = await approve(
      sessionA,
      randomUUID(),
      target.id,
      target.version.id,
      body(target.rowVersion + 1),
    );
    expect(approved.statusCode).toBe(200);
    const rv = approved.json<ApprovalBody>().listing.rowVersion;
    await withTenant(harness.runtime.db, sellerA.sellerId, async (trx) => {
      const priced = await listings.setAskingPrice(trx, command(sellerA.sellerId, 'price'), {
        listingId: target.id,
        price: FIXTURE.askingPrice,
        expectedRowVersion: rv,
      });
      const policy = await listings.setPolicy(trx, command(sellerA.sellerId, 'policy'), {
        listingId: target.id,
        expectedRowVersion: priced.rowVersion,
        policy: { ...FIXTURE.policy, minimumPrice: FIXTURE.minimumPrice },
      });
      await expect(
        listings.markReady(trx, command(sellerA.sellerId, 'ready'), {
          listingId: target.id,
          expectedRowVersion: policy.listing.rowVersion,
        }),
      ).rejects.toMatchObject({ missing: ['seller_provided_facts'] });
    });
    expect((await listingRows(sellerA.sellerId)).find((l) => l.id === target.id)?.status).toBe('DRAFT');
    // Restating the fact restores readiness.
    const current = (await read(sessionA.token, target.id)).json<WorkspaceBody>();
    expect(
      (await putFacts(sessionA, target.id, { name: FACTS.name }, current.listing.rowVersion)).statusCode,
    ).toBe(200);
    const gaps = await withTenant(harness.runtime.db, sellerA.sellerId, async (trx) =>
      listings.readinessGaps(trx, await listings.getListing(trx, target.id)),
    );
    expect(gaps).toEqual([]);
    expect(ListingNotReadyError.name).toBe('ListingNotReadyError');
  });

  it('approves in EXPIRED without publishing or relisting, and refuses READY, LISTED, CANCELLED and ARCHIVED without mutation', async () => {
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
    for (const [status, id, versionId] of [
      ['READY', ready.listingId, ready.versionId ?? ''],
      ['LISTED', listed.listed.listing.id, listed.built.versionId ?? ''],
      ['CANCELLED', cancelled.listed.listing.id, cancelled.built.versionId ?? ''],
      ['ARCHIVED', archived.listed.listing.id, archived.built.versionId ?? ''],
    ] as const) {
      const ws = await current(id);
      expect(ws.listing.status, status).toBe(status);
      const res = await approve(sessionA, randomUUID(), id, versionId, body(ws.listing.rowVersion));
      expect(res.statusCode, status).toBe(409);
      expect(res.json(), status).toEqual({ error: 'invalid_state' });
    }
    expect(await snapshot(sellerA.sellerId)).toEqual(before);

    // EXPIRED: a new draft (identical words allowed, D-21 correction) is approved; v1 is
    // superseded, the listing stays EXPIRED, the code and the publication reference are untouched.
    const ws = await current(expired.listed.listing.id);
    expect(ws.listing.status).toBe('EXPIRED');
    const codesBefore = (await codeRows(sellerA.sellerId)).filter((c) => c.id === expired.listed.code.id);
    const draft = await putDraft(sessionA, ws.listing.id, ws.listing.rowVersion, ws.draft?.id ?? null, {
      ...FIXTURE.copy,
      structuredDetails: { ...FIXTURE.facts },
    });
    expect(draft.statusCode).toBe(200);
    const v2 = draft.json<DraftBody>().draft;
    const transitions = await statusEvents(sellerA.sellerId, ws.listing.id);
    const codeEventsOf = async (listingId: string) =>
      (await events(sellerA.sellerId)).filter(
        (e) => e.event_type.startsWith('ACCESS_CODE_') && e.summary['listing_id'] === listingId,
      );
    const codeEventsBefore = await codeEventsOf(ws.listing.id);
    expect(codeEventsBefore.map((e) => e.event_type)).toEqual(['ACCESS_CODE_CREATED', 'ACCESS_CODE_EXPIRED']);
    const key = randomUUID();
    const approved = await approve(
      sessionA,
      key,
      ws.listing.id,
      v2.id,
      body(draft.json<DraftBody>().listing.rowVersion),
    );
    expect(approved.statusCode).toBe(200);
    expect(approved.json<ApprovalBody>().listing).toMatchObject({
      status: 'EXPIRED',
      rowVersion: draft.json<DraftBody>().listing.rowVersion + 1,
    });
    expect(approved.json<ApprovalBody>().approvedContentVersion).toMatchObject({
      id: v2.id,
      versionNumber: 2,
      status: 'APPROVED',
      sourceVersionId: ws.draft?.id,
    });
    const rows = (await versionRows(sellerA.sellerId)).filter((v) => v.listing_id === ws.listing.id);
    expect(rows.map((v) => [v.version_number, v.status])).toEqual([
      [1, 'SUPERSEDED'],
      [2, 'APPROVED'],
    ]);
    const listingRow = await query<{
      status: string;
      published_content_version_id: string | null;
      current_content_version_id: string | null;
    }>(
      env.superuserUrl,
      `SELECT status::text, published_content_version_id, current_content_version_id FROM app.listing WHERE id = $1`,
      [ws.listing.id],
    );
    expect(listingRow[0]).toEqual({
      status: 'EXPIRED',
      published_content_version_id: ws.draft?.id,
      current_content_version_id: v2.id,
    });
    expect(await statusEvents(sellerA.sellerId, ws.listing.id)).toEqual(transitions);
    expect((await codeRows(sellerA.sellerId)).filter((c) => c.id === expired.listed.code.id)).toEqual(
      codesBefore,
    );
    expect(await codeEventsOf(ws.listing.id)).toEqual(codeEventsBefore);
    const state = await snapshot(sellerA.sellerId);
    const replay = await approve(
      sessionA,
      key,
      ws.listing.id,
      v2.id,
      body(draft.json<DraftBody>().listing.rowVersion),
    );
    expect(replay.body).toBe(approved.body);
    expect(await snapshot(sellerA.sellerId)).toEqual(state);
  });

  it('rolls back the supersession, the approval, the listing row, the event and the receipt together when any write fails', async () => {
    const session = remember(await signIn(harness, faulty));
    const target = await drafted(session);
    const firstKey = randomUUID();
    expect(
      (await approve(session, firstKey, target.id, target.version.id, body(target.rowVersion))).statusCode,
    ).toBe(200);
    const rv = (await read(session.token, target.id)).json<WorkspaceBody>().listing.rowVersion;
    const second = await putDraft(session, target.id, rv, target.version.id, {
      ...COPY,
      description: 'Faulty fixture wording.',
    });
    expect(second.statusCode).toBe(200);
    const v2 = second.json<DraftBody>().draft;
    const rv2 = second.json<DraftBody>().listing.rowVersion;
    const inject = async (table: string, timing: 'INSERT' | 'UPDATE', condition: string) => {
      await query(
        env.superuserUrl,
        `CREATE FUNCTION public.fail_approval_for_test() RETURNS trigger LANGUAGE plpgsql AS $$
           BEGIN RAISE EXCEPTION 'injected failure'; END $$;
         CREATE TRIGGER fail_approval_for_test BEFORE ${timing} ON ${table}
           FOR EACH ROW WHEN (${condition}) EXECUTE FUNCTION public.fail_approval_for_test();`,
      );
      return async () => {
        await query(
          env.superuserUrl,
          `DROP TRIGGER fail_approval_for_test ON ${table}; DROP FUNCTION public.fail_approval_for_test();`,
        );
      };
    };
    const mine = `'${faulty.sellerId}'`;
    const key = randomUUID();
    const faults: [string, string, 'INSERT' | 'UPDATE', string][] = [
      [
        'supersession of v1',
        'app.listing_content_version',
        'UPDATE',
        `NEW.seller_id = ${mine} AND OLD.status = 'APPROVED' AND NEW.status = 'SUPERSEDED'`,
      ],
      [
        'approval of v2',
        'app.listing_content_version',
        'UPDATE',
        `NEW.seller_id = ${mine} AND NEW.status = 'APPROVED'`,
      ],
      ['listing row after both', 'app.listing', 'UPDATE', `NEW.seller_id = ${mine}`],
      [
        'approval event after the rows',
        'app.audit_event',
        'INSERT',
        `NEW.seller_id = ${mine} AND NEW.event_type = 'LISTING_CONTENT_APPROVED'`,
      ],
      ['receipt after the event', 'app.idempotency_receipt', 'INSERT', `NEW.seller_id = ${mine}`],
    ];
    const before = await snapshot(faulty.sellerId);
    for (const [label, table, timing, condition] of faults) {
      const remove = await inject(table, timing, condition);
      try {
        const res = await approve(session, key, target.id, v2.id, body(rv2));
        expect(res.statusCode, label).toBe(500);
        expect(res.json(), label).toEqual({ error: 'internal' });
      } finally {
        await remove();
      }
      expect(await snapshot(faulty.sellerId), label).toEqual(before);
    }
    // With the faults gone the same key approves once and then replays.
    const ok = await approve(session, key, target.id, v2.id, body(rv2));
    expect(ok.statusCode).toBe(200);
    expect((await approve(session, key, target.id, v2.id, body(rv2))).body).toBe(ok.body);
    const final = await snapshot(faulty.sellerId);
    expect(final.versions.map((v) => [v.version_number, v.status])).toEqual([
      [1, 'SUPERSEDED'],
      [2, 'APPROVED'],
    ]);
    expect(final.events.map((e) => e.event_type)).toEqual([
      'LISTING_CREATED',
      'LISTING_FACTS_CHANGED',
      'LISTING_CONTENT_DRAFTED',
      'LISTING_CONTENT_APPROVED',
      'LISTING_CONTENT_DRAFTED',
      'LISTING_CONTENT_APPROVED',
    ]);
    expect(final.receipts).toHaveLength(6);
    expect(final.listings[0]?.row_version).toBe(rv2 + 1);
    expect(harness.logText()).toMatch(/"error_type":/);
  });

  it('leaves no tenant context on a reused pooled connection after an approval and a refused approval', async () => {
    const one = await startAuthApp(env, { poolMax: 1 });
    try {
      const s = remember(await signIn(one, sellerA));
      const connectionState = () =>
        one.runtime.db.transaction().execute(async (trx) => {
          const value = await sql<{ setting: string | null; seller: string | null }>`
            select current_setting(${TENANT_SETTING}, true) as setting, app.current_seller_id()::text as seller`.execute(
            trx,
          );
          const versions = await sql<{
            n: string;
          }>`select count(*)::text as n from app.listing_content_version`.execute(trx);
          return {
            setting: value.rows[0]?.setting ?? '',
            seller: value.rows[0]?.seller ?? null,
            visible: Number(versions.rows[0]?.n),
          };
        });
      const target = await drafted(s, FACTS, one);
      expect(await connectionState()).toEqual({ setting: '', seller: null, visible: 0 });
      expect(
        (await approve(s, randomUUID(), target.id, target.version.id, body(target.rowVersion), {}, one))
          .statusCode,
      ).toBe(200);
      expect(await connectionState()).toEqual({ setting: '', seller: null, visible: 0 });
      expect(
        (await approve(s, randomUUID(), target.id, target.version.id, body(target.rowVersion + 1), {}, one))
          .statusCode,
      ).toBe(409);
      expect(await connectionState()).toEqual({ setting: '', seller: null, visible: 0 });
    } finally {
      await one.close();
    }
  });

  it('exposes no seller, account, session, policy, receipt, audit, approver or secret field in any response, and neither events, receipts nor logs carry a word of copy, a fact value, a cookie, a token, an anti-forgery value or an amount', async () => {
    const forbidden =
      /seller_?id|tenant|account_?id|session_?id|minimum|target|policy|receipt|fingerprint|audit|token|hash|code|secret|cookie|acquisition|approved_?by|request_?id/i;
    expect(responses.length).toBeGreaterThan(40);
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
        expectNoWords(JSON.stringify(e.summary), `event ${e.event_type}`);
      for (const r of (await receipts(sellerId)).filter((r) => r.command === 'listing.approve_content'))
        expectNoWords(JSON.stringify(r.outcome), `receipt ${r.idempotency_key}`);
    }
    const log = harness.logText();
    for (const s of secrets) expect(log).not.toContain(s);
    expectNoWords(log, 'log');
    expect(log).not.toMatch(/"cookie":"(?!\[REDACTED\])/);
    expect(log).not.toContain('"amountMinor"');
    expect(log).not.toMatch(/minimum_?price/i);
    expect(log).not.toContain('expectedRowVersion');
  });
});
