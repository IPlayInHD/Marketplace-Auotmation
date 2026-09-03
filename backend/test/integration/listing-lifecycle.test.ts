import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_SCHEMA, SQLSTATE } from '../../src/db/constants.ts';
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
  ListingNotReadyError,
  NotFoundError,
  ValidationError,
} from '../../src/shared/errors.ts';
import { startDatabase, type TestDatabase } from '../helpers/database.ts';
import { buildListing, command, FIXTURE, seedSeller } from '../helpers/fixtures.ts';
import { expectPgError, query, setTenant, withClient } from '../helpers/inspect.ts';

// SM-L-01 and STATE_MACHINES §1 and §8, enforced at the application and at the data layer, with
// the audit trail of OPS-780 to OPS-784 and the idempotency rules of OPS-730 to OPS-732.

describe('Listing lifecycle: DRAFT to READY', () => {
  let env: TestDatabase;
  let runtime: DbHandle;
  let sellerA: string;
  let sellerB: string;

  beforeAll(async () => {
    env = await startDatabase();
    runtime = createDb(env.runtimeUrl, { max: 3, applicationName: 'lifecycle-test' });
    sellerA = await seedSeller(runtime.db, FIXTURE.sellers.a);
    sellerB = await seedSeller(runtime.db, FIXTURE.sellers.b);
  });
  afterAll(async () => {
    await runtime?.close();
    await env?.stop();
  });

  it('succeeds when approved copy, an asking price, a minimum price and a policy version are all present, and records the audit trail', async () => {
    const built = await buildListing(runtime.db, sellerA);
    const ctx = command(sellerA, 'ready');
    const ready = await withTenant(runtime.db, sellerA, (trx) =>
      listings.markReady(trx, ctx, { listingId: built.listingId, expectedRowVersion: built.rowVersion }),
    );
    expect(ready.status).toBe('READY');
    expect(ready.rowVersion).toBe(built.rowVersion + 1);
    expect(ready.askingPrice).toEqual(FIXTURE.askingPrice);
    expect(ready.currentContentVersionId).toBe(built.versionId);
    expect(ready.currentPolicyVersionId).toBe(built.policyVersionId);

    const events = await withTenant(runtime.db, sellerA, (trx) =>
      audit.listAuditEventsForSubject(trx, sellerA, 'listing', built.listingId),
    );
    expect(events.map((e) => e.eventType)).toEqual([
      'LISTING_CREATED',
      'SELLER_POLICY_CHANGED',
      'MINIMUM_PRICE_CHANGED',
      'LISTING_STATUS_CHANGED',
    ]);
    const transition = events.at(-1);
    expect(transition).toMatchObject({
      actorType: 'SELLER',
      actorRef: sellerA,
      subjectType: 'listing',
      subjectId: built.listingId,
      policyVersionId: built.policyVersionId,
      requestId: ctx.requestId,
      idempotencyKey: ctx.idempotencyKey,
      summary: { from: 'DRAFT', to: 'READY', row_version: ready.rowVersion },
    });
    for (const e of events) {
      expect(e.requestId).toMatch(/^req-/);
      const json = JSON.stringify(e.summary);
      expect(json, `${e.eventType} summary`).not.toContain(String(FIXTURE.minimumPrice.amountMinor));
      expect(json, `${e.eventType} summary`).not.toMatch(/minimum/i);
    }
    const approval = await withTenant(runtime.db, sellerA, (trx) =>
      audit.listAuditEventsForSubject(trx, sellerA, 'content_version', built.versionId ?? ''),
    );
    expect(approval.map((e) => e.eventType)).toEqual(['LISTING_CONTENT_APPROVED']);
  });

  it('is refused without approved content, and the listing stays DRAFT with no transition event', async () => {
    const built = await buildListing(runtime.db, sellerA, { approve: 'draftOnly' });
    const attempt = withTenant(runtime.db, sellerA, (trx) =>
      listings.markReady(trx, command(sellerA, 'ready'), {
        listingId: built.listingId,
        expectedRowVersion: built.rowVersion,
      }),
    );
    await expect(attempt).rejects.toBeInstanceOf(ListingNotReadyError);
    await expect(attempt).rejects.toMatchObject({ missing: ['approved_content'] });
    const after = await withTenant(runtime.db, sellerA, (trx) => listings.getListing(trx, built.listingId));
    expect(after.status).toBe('DRAFT');
    expect(after.rowVersion).toBe(built.rowVersion);
    const events = await withTenant(runtime.db, sellerA, (trx) =>
      audit.listAuditEventsForSubject(trx, sellerA, 'listing', built.listingId),
    );
    expect(events.map((e) => e.eventType)).not.toContain('LISTING_STATUS_CHANGED');
  });

  it('is refused without an asking price', async () => {
    const built = await buildListing(runtime.db, sellerA, { price: false });
    await expect(
      withTenant(runtime.db, sellerA, (trx) =>
        listings.markReady(trx, command(sellerA, 'ready'), {
          listingId: built.listingId,
          expectedRowVersion: built.rowVersion,
        }),
      ),
    ).rejects.toMatchObject({ code: 'LISTING_NOT_READY', missing: ['asking_price'] });
  });

  it('is refused without a policy version, which is where the minimum price lives', async () => {
    const built = await buildListing(runtime.db, sellerA, { policy: false });
    await expect(
      withTenant(runtime.db, sellerA, (trx) =>
        listings.markReady(trx, command(sellerA, 'ready'), {
          listingId: built.listingId,
          expectedRowVersion: built.rowVersion,
        }),
      ),
    ).rejects.toMatchObject({ code: 'LISTING_NOT_READY', missing: ['policy_version', 'minimum_price'] });
  });

  it('is refused when the minimum price currency differs from the asking currency (OPS-704)', async () => {
    const built = await buildListing(runtime.db, sellerA, {
      policy: { amountMinor: 20_000, currency: 'EUR' },
    });
    await expect(
      withTenant(runtime.db, sellerA, (trx) =>
        listings.markReady(trx, command(sellerA, 'ready'), {
          listingId: built.listingId,
          expectedRowVersion: built.rowVersion,
        }),
      ),
    ).rejects.toMatchObject({ code: 'LISTING_NOT_READY', missing: ['currency_match'] });
  });

  it('names every missing prerequisite at once', async () => {
    const built = await buildListing(runtime.db, sellerA, { approve: false, price: false, policy: false });
    await expect(
      withTenant(runtime.db, sellerA, (trx) =>
        listings.markReady(trx, command(sellerA, 'ready'), {
          listingId: built.listingId,
          expectedRowVersion: built.rowVersion,
        }),
      ),
    ).rejects.toMatchObject({
      missing: ['asking_price', 'approved_content', 'policy_version', 'minimum_price'],
    });
  });

  it('never lets a draft carry a detail the seller did not state (INV-12)', async () => {
    const built = await buildListing(runtime.db, sellerA, { approve: false, price: false, policy: false });
    await expect(
      withTenant(runtime.db, sellerA, (trx) =>
        content.createSellerDraft(trx, command(sellerA, 'draft'), {
          listingId: built.listingId,
          title: 'Draft with an invented detail',
          structuredDetails: { model: 'not a fact the seller supplied' },
        }),
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION', fields: ['model'] });
    await expect(
      withTenant(runtime.db, sellerA, (trx) =>
        content.recordFacts(trx, command(sellerA, 'facts'), {
          listingId: built.listingId,
          facts: { estimated_value: '1000' },
        }),
      ),
    ).rejects.toThrow();
  });

  it('is refused by the data layer when the application layer is bypassed, and the refusal names the gaps (SM-L-01, OPS-707)', async () => {
    const built = await buildListing(runtime.db, sellerA, { approve: 'draftOnly', policy: false });
    const err = await expectPgError(
      env.runtimeUrl,
      `UPDATE ${APP_SCHEMA}.listing SET status = 'READY', row_version = row_version + 1 WHERE id = $1`,
      [built.listingId],
      (client) => setTenant(client, sellerA),
    );
    expect(err.code).toBe(SQLSTATE.listingReadyPrerequisitesMissing);
    expect(err.detail?.split(',')).toEqual(['approved_content', 'policy_version', 'minimum_price']);
  });

  it('is refused by the data layer when the approved copy carries a detail no seller fact backs (D-10)', async () => {
    // Bypass the service: a draft whose structured_details name a key with no product_fact row.
    const built = await buildListing(runtime.db, sellerA, { approve: false });
    const versionId = await runtimeInsertDraft(env.runtimeUrl, sellerA, built.listingId);
    const approved = await withTenant(runtime.db, sellerA, (trx) =>
      listings.approveContent(trx, command(sellerA, 'approve'), {
        listingId: built.listingId,
        versionId,
        expectedRowVersion: built.rowVersion,
      }),
    );
    const viaService = withTenant(runtime.db, sellerA, (trx) =>
      listings.markReady(trx, command(sellerA, 'ready'), {
        listingId: built.listingId,
        expectedRowVersion: approved.listing.rowVersion,
      }),
    );
    await expect(viaService).rejects.toMatchObject({
      code: 'LISTING_NOT_READY',
      missing: ['seller_provided_facts'],
    });
    const direct = await expectPgError(
      env.runtimeUrl,
      `UPDATE ${APP_SCHEMA}.listing SET status = 'READY', row_version = row_version + 1 WHERE id = $1`,
      [built.listingId],
      (client) => setTenant(client, sellerA),
    );
    expect(direct.code).toBe(SQLSTATE.listingReadyPrerequisitesMissing);
    expect(direct.detail).toBe('seller_provided_facts');
  });

  it('rejects every transition the state machine does not draw, at the data layer', async () => {
    const draft = await buildListing(runtime.db, sellerA);
    for (const target of [
      'LISTED',
      'ACTIVE_CONVERSATIONS',
      'OFFER_PENDING',
      'PENDING_SALE',
      'SOLD',
      'CANCELLED',
      'ARCHIVED',
      'EXPIRED',
    ]) {
      const err = await expectPgError(
        env.runtimeUrl,
        `UPDATE ${APP_SCHEMA}.listing SET status = $2, row_version = row_version + 1 WHERE id = $1`,
        [draft.listingId, target],
        (client) => setTenant(client, sellerA),
      );
      expect(err.code, `DRAFT -> ${target}`).toBe(SQLSTATE.listingTransitionIllegal);
    }
    const ready = await withTenant(runtime.db, sellerA, (trx) =>
      listings.markReady(trx, command(sellerA, 'ready'), {
        listingId: draft.listingId,
        expectedRowVersion: draft.rowVersion,
      }),
    );
    for (const target of ['SOLD', 'ARCHIVED', 'PENDING_SALE', 'CANCELLED']) {
      const err = await expectPgError(
        env.runtimeUrl,
        `UPDATE ${APP_SCHEMA}.listing SET status = $2, row_version = row_version + 1 WHERE id = $1`,
        [ready.id, target],
        (client) => setTenant(client, sellerA),
      );
      expect(err.code, `READY -> ${target}`).toBe(SQLSTATE.listingTransitionIllegal);
    }
    const insert = await expectPgError(
      env.runtimeUrl,
      `INSERT INTO ${APP_SCHEMA}.listing (seller_id, inventory_item_id, status, request_id) VALUES ($1, $2, 'READY', 'req-bypass')`,
      [sellerA, draft.inventoryItemId],
      (client) => setTenant(client, sellerA),
    );
    expect(insert.code).toBe(SQLSTATE.listingTransitionIllegal);
  });

  it('agrees with the application’s transition table on every pair of statuses', async () => {
    const rows = await query<{ f: string; t: string; ok: boolean }>(
      env.superuserUrl,
      `SELECT a::text AS f, b::text AS t, ${APP_SCHEMA}.listing_transition_allowed(a, b) AS ok
         FROM unnest(enum_range(NULL::${APP_SCHEMA}.listing_status)) a
        CROSS JOIN unnest(enum_range(NULL::${APP_SCHEMA}.listing_status)) b`,
    );
    expect(rows).toHaveLength(100);
    for (const r of rows) {
      const expected = listings.isListingTransitionAllowed(
        r.f as (typeof listings.LISTING_STATUSES)[number],
        r.t as (typeof listings.LISTING_STATUSES)[number],
      );
      expect(r.ok, `${r.f} -> ${r.t}`).toBe(expected);
    }
  });

  it('allows READY to return to DRAFT when the seller edits, and audits both transitions', async () => {
    const built = await buildListing(runtime.db, sellerA);
    const ready = await withTenant(runtime.db, sellerA, (trx) =>
      listings.markReady(trx, command(sellerA, 'ready'), {
        listingId: built.listingId,
        expectedRowVersion: built.rowVersion,
      }),
    );
    const draft = await withTenant(runtime.db, sellerA, (trx) =>
      listings.revertToDraft(trx, command(sellerA, 'edit'), {
        listingId: ready.id,
        expectedRowVersion: ready.rowVersion,
      }),
    );
    expect(draft.status).toBe('DRAFT');
    const events = await withTenant(runtime.db, sellerA, (trx) =>
      audit.listAuditEventsForSubject(trx, sellerA, 'listing', built.listingId),
    );
    const transitions = events.filter((e) => e.eventType === 'LISTING_STATUS_CHANGED').map((e) => e.summary);
    expect(transitions).toEqual([
      { from: 'DRAFT', to: 'READY', row_version: ready.rowVersion },
      { from: 'READY', to: 'DRAFT', row_version: draft.rowVersion },
    ]);
  });

  it('requires row_version to advance by exactly one and reports a stale read as a concurrent modification (OPS-738)', async () => {
    const built = await buildListing(runtime.db, sellerA);
    const skip = await expectPgError(
      env.runtimeUrl,
      `UPDATE ${APP_SCHEMA}.listing SET row_version = row_version + 2 WHERE id = $1`,
      [built.listingId],
      (client) => setTenant(client, sellerA),
    );
    expect(skip.code).toBe(SQLSTATE.listingRowVersionMismatch);
    const same = await expectPgError(
      env.runtimeUrl,
      `UPDATE ${APP_SCHEMA}.listing SET request_id = 'req-bypass' WHERE id = $1`,
      [built.listingId],
      (client) => setTenant(client, sellerA),
    );
    expect(same.code).toBe(SQLSTATE.listingRowVersionMismatch);
    await expect(
      withTenant(runtime.db, sellerA, (trx) =>
        listings.markReady(trx, command(sellerA, 'ready'), {
          listingId: built.listingId,
          expectedRowVersion: built.rowVersion - 1,
        }),
      ),
    ).rejects.toBeInstanceOf(ConcurrentModificationError);
  });

  it('treats another seller’s listing exactly like a listing that does not exist (AUTH-221)', async () => {
    const built = await buildListing(runtime.db, sellerA);
    await expect(
      withTenant(runtime.db, sellerB, (trx) =>
        listings.markReady(trx, command(sellerB, 'ready'), {
          listingId: built.listingId,
          expectedRowVersion: built.rowVersion,
        }),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
    await expect(
      withTenant(runtime.db, sellerB, (trx) =>
        listings.getListing(trx, '00000000-0000-4000-8000-000000000000'),
      ),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('replays an idempotency key without a second effect and rejects the key for a different action (OPS-730 to OPS-732)', async () => {
    const built = await buildListing(runtime.db, sellerA);
    const ctx = command(sellerA, 'ready');
    const first = await withTenant(runtime.db, sellerA, (trx) =>
      listings.markReady(trx, ctx, { listingId: built.listingId, expectedRowVersion: built.rowVersion }),
    );
    const replay = await withTenant(runtime.db, sellerA, (trx) =>
      listings.markReady(trx, ctx, { listingId: built.listingId, expectedRowVersion: built.rowVersion }),
    );
    expect(replay).toEqual(first);
    const events = await withTenant(runtime.db, sellerA, (trx) =>
      audit.listAuditEventsForSubject(trx, sellerA, 'listing', built.listingId),
    );
    expect(events.filter((e) => e.eventType === 'LISTING_STATUS_CHANGED')).toHaveLength(1);

    const reused = { ...command(sellerA, 'policy'), idempotencyKey: ctx.idempotencyKey };
    const back = await withTenant(runtime.db, sellerA, (trx) =>
      listings.revertToDraft(trx, command(sellerA, 'edit'), {
        listingId: first.id,
        expectedRowVersion: first.rowVersion,
      }),
    );
    await expect(
      withTenant(runtime.db, sellerA, (trx) =>
        listings.setPolicy(trx, reused, {
          listingId: back.id,
          expectedRowVersion: back.rowVersion,
          policy: { ...FIXTURE.policy, minimumPrice: FIXTURE.minimumPrice },
        }),
      ),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it('refuses a second READY and refuses edits to a READY listing until it returns to DRAFT', async () => {
    const built = await buildListing(runtime.db, sellerA);
    const ready = await withTenant(runtime.db, sellerA, (trx) =>
      listings.markReady(trx, command(sellerA, 'ready'), {
        listingId: built.listingId,
        expectedRowVersion: built.rowVersion,
      }),
    );
    await expect(
      withTenant(runtime.db, sellerA, (trx) =>
        listings.markReady(trx, command(sellerA, 'again'), {
          listingId: ready.id,
          expectedRowVersion: ready.rowVersion,
        }),
      ),
    ).rejects.toBeInstanceOf(InvalidStateError);
    await expect(
      withTenant(runtime.db, sellerA, (trx) =>
        listings.setAskingPrice(trx, command(sellerA, 'price'), {
          listingId: ready.id,
          price: { amountMinor: 30_000, currency: 'CAD' },
          expectedRowVersion: ready.rowVersion,
        }),
      ),
    ).rejects.toBeInstanceOf(InvalidStateError);
  });

  it('keeps content versions immutable and singly approved (DM-06, SM-CT-01, SM-CT-02)', async () => {
    const built = await buildListing(runtime.db, sellerA);
    const versionId = built.versionId ?? '';
    for (const text of [
      `UPDATE ${APP_SCHEMA}.listing_content_version SET title = 'rewritten' WHERE id = $1`,
      `UPDATE ${APP_SCHEMA}.listing_content_version SET structured_details = '{}' WHERE id = $1`,
      `UPDATE ${APP_SCHEMA}.listing_content_version SET provenance = 'AI_ENHANCED_COPY' WHERE id = $1`,
    ]) {
      const err = await expectPgError(env.runtimeUrl, text, [versionId], (client) =>
        setTenant(client, sellerA),
      );
      expect(err.code, text).toBe(SQLSTATE.contentVersionViolation);
    }
    // DELETE: the runtime role holds no privilege, and the owner is stopped by the guard.
    const del = `DELETE FROM ${APP_SCHEMA}.listing_content_version WHERE id = $1`;
    const delAsRuntime = await expectPgError(env.runtimeUrl, del, [versionId], (client) =>
      setTenant(client, sellerA),
    );
    expect(delAsRuntime.code).toBe(SQLSTATE.insufficientPrivilege);
    const delAsOwner = await expectPgError(env.migratorUrl, del, [versionId], (client) =>
      setTenant(client, sellerA),
    );
    expect(delAsOwner.code).toBe(SQLSTATE.contentVersionViolation);
    // A second draft approved later supersedes the first; exactly one APPROVED version remains.
    const listing = await withTenant(runtime.db, sellerA, (trx) => listings.getListing(trx, built.listingId));
    const second = await withTenant(runtime.db, sellerA, async (trx) => {
      const draft = await content.createSellerDraft(trx, command(sellerA, 'draft2'), {
        listingId: built.listingId,
        title: 'Synthetic road bicycle, second wording',
        structuredDetails: { brand: FIXTURE.facts.brand },
      });
      return listings.approveContent(trx, command(sellerA, 'approve2'), {
        listingId: built.listingId,
        versionId: draft.id,
        expectedRowVersion: listing.rowVersion,
      });
    });
    expect(second.version.status).toBe('APPROVED');
    expect(second.version.provenance).toBe('SELLER_APPROVED_COPY');
    expect(second.version.approvedBy).toBe(sellerA);
    const statuses = await withTenant(runtime.db, sellerA, (trx) =>
      trx
        .selectFrom('listing_content_version')
        .select(['version_number', 'status', 'title'])
        .where('listing_id', '=', built.listingId)
        .orderBy('version_number')
        .execute(),
    );
    expect(statuses).toEqual([
      { version_number: 1, status: 'SUPERSEDED', title: FIXTURE.copy.title },
      { version_number: 2, status: 'APPROVED', title: 'Synthetic road bicycle, second wording' },
    ]);
    // The data layer refuses a bare status flip to APPROVED without the approval marks.
    const bare = await expectPgError(
      env.runtimeUrl,
      `UPDATE ${APP_SCHEMA}.listing_content_version SET status = 'APPROVED' WHERE id = $1`,
      [versionId],
      (client) => setTenant(client, sellerA),
    );
    expect(bare.code).toBe(SQLSTATE.contentVersionViolation);
  });

  it('keeps policy versions and audit events append-only at both layers (OPS-705, OPS-706, OPS-782)', async () => {
    const built = await buildListing(runtime.db, sellerA);
    const policyId = built.policyVersionId ?? '';
    for (const text of [
      `UPDATE ${APP_SCHEMA}.seller_policy_version SET minimum_price_minor = 1 WHERE id = $1`,
      `DELETE FROM ${APP_SCHEMA}.seller_policy_version WHERE id = $1`,
      `UPDATE ${APP_SCHEMA}.audit_event SET summary = '{}' WHERE policy_version_id = $1`,
      `DELETE FROM ${APP_SCHEMA}.audit_event WHERE policy_version_id = $1`,
    ]) {
      const asRuntime = await expectPgError(env.runtimeUrl, text, [policyId], (client) =>
        setTenant(client, sellerA),
      );
      expect(asRuntime.code, `runtime: ${text}`).toBe(SQLSTATE.insufficientPrivilege);
      const asOwner = await expectPgError(env.migratorUrl, text, [policyId], (client) =>
        setTenant(client, sellerA),
      );
      expect(asOwner.code, `owner: ${text}`).toBe(SQLSTATE.appendOnlyViolation);
    }
  });

  it('records MINIMUM_PRICE_CHANGED only when the minimum actually changes', async () => {
    const built = await buildListing(runtime.db, sellerA);
    const same = await withTenant(runtime.db, sellerA, (trx) =>
      listings.setPolicy(trx, command(sellerA, 'policy2'), {
        listingId: built.listingId,
        expectedRowVersion: built.rowVersion,
        policy: { ...FIXTURE.policy, negotiationEnabled: false, minimumPrice: FIXTURE.minimumPrice },
      }),
    );
    expect(same.policyVersion.versionNumber).toBe(2);
    const changed = await withTenant(runtime.db, sellerA, (trx) =>
      listings.setPolicy(trx, command(sellerA, 'policy3'), {
        listingId: built.listingId,
        expectedRowVersion: same.listing.rowVersion,
        policy: { ...FIXTURE.policy, minimumPrice: { amountMinor: 21_000, currency: 'CAD' } },
      }),
    );
    expect(changed.policyVersion.versionNumber).toBe(3);
    const events = await withTenant(runtime.db, sellerA, (trx) =>
      audit.listAuditEventsForSubject(trx, sellerA, 'listing', built.listingId),
    );
    expect(events.filter((e) => e.eventType === 'SELLER_POLICY_CHANGED')).toHaveLength(3);
    expect(events.filter((e) => e.eventType === 'MINIMUM_PRICE_CHANGED')).toHaveLength(2);
  });

  it('exposes the minimum price to the seller only, never in the buyer-safe projection', async () => {
    const built = await buildListing(runtime.db, sellerA);
    const projectionJson = await withTenant(runtime.db, sellerA, async (trx) => {
      const listing = await listings.getListing(trx, built.listingId);
      const approved = await content.getApprovedVersion(trx, built.listingId);
      const seller = await sellers.getSeller(trx, sellerA);
      if (!approved || !listing.askingPrice) throw new Error('fixture incomplete');
      return access.serializeBuyerSafeProjection(
        access.buildBuyerSafeProjection({
          content: approved,
          askingPrice: listing.askingPrice,
          sellerDisplayName: seller.displayName,
        }),
      );
    });
    expect(projectionJson).toContain('"askingPriceMinor":25000');
    expect(projectionJson).not.toContain('20000');
    expect(projectionJson).not.toMatch(/minimum/i);
    expect(projectionJson).not.toContain(sellerA);
    expect(projectionJson).not.toContain(built.listingId);
  });

  it('validates command contexts and fact keys at the boundary', async () => {
    const built = await buildListing(runtime.db, sellerA, { approve: false, price: false, policy: false });
    await expect(
      withTenant(runtime.db, sellerA, (trx) =>
        listings.setAskingPrice(trx, command(sellerA, 'price'), {
          listingId: built.listingId,
          price: { amountMinor: 12.5, currency: 'CAD' },
          expectedRowVersion: built.rowVersion,
        }),
      ),
    ).rejects.toThrow(/fractional|int/i);
    await expect(
      withTenant(runtime.db, sellerA, (trx) =>
        content.recordFacts(trx, command(sellerA, 'facts'), { listingId: built.listingId, facts: {} }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

/** Inserts a seller draft directly as the runtime role, bypassing the module's fact-coverage check. */
async function runtimeInsertDraft(runtimeUrl: string, sellerId: string, listingId: string): Promise<string> {
  return withClient(runtimeUrl, async (client) => {
    await client.query('BEGIN');
    await setTenant(client, sellerId);
    const result = await client.query<{ id: string }>(
      `INSERT INTO ${APP_SCHEMA}.listing_content_version
         (seller_id, listing_id, version_number, status, provenance, title, structured_details, request_id)
       VALUES ($1, $2, 1, 'SELLER_DRAFT', 'SELLER_PROVIDED_FACT', 'Fixture title', '{"model": "invented"}', 'req-bypass')
       RETURNING id`,
      [sellerId, listingId],
    );
    await client.query('COMMIT');
    return result.rows[0]?.id ?? '';
  });
}
