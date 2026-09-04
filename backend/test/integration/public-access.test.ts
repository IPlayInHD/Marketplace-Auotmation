import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_SCHEMA, SQLSTATE } from '../../src/db/constants.ts';
import { createDb, withTenant, type DbHandle } from '../../src/db/kysely.ts';
import * as accessCodes from '../../src/modules/access-codes/index.ts';
import * as audit from '../../src/modules/audit/index.ts';
import * as listings from '../../src/modules/listings/index.ts';
import * as publicAccess from '../../src/modules/public-listing-access/index.ts';
import { createLogger } from '../../src/observability/logger.ts';
import type { CommandContext } from '../../src/shared/command.ts';
import {
  ConcurrentModificationError,
  IdempotencyConflictError,
  InvalidStateError,
  mapDatabaseError,
  NotFoundError,
  PublicAccessRequiredError,
} from '../../src/shared/errors.ts';
import { startDatabase, type TestDatabase } from '../helpers/database.ts';
import { buildListing, command, FIXTURE, publishListing, seedSeller } from '../helpers/fixtures.ts';
import { expectPgError, query, setTenant, withClient } from '../helpers/inspect.ts';

// Slice 1b: PublicListingAccess and ListingAccessCode (DM-08, DM-09), SM-L-02, SM-C-01 to SM-C-03,
// OPS-710, OPS-711, OPS-737, OPS-730 to OPS-732, OPS-780 to OPS-787, SEC-040, SEC-100, ACCESS-013.
// Every code in this file is generated at run time; none is written down.

const PUBLIC_ID = /^[a-z2-7]{16}$/;
const CODE = /^[0-9]{6}$/;
const wrong = (code: string) => code.slice(0, 5) + String((Number(code[5]) + 1) % 10);
const plaintextOf = (issued: accessCodes.IssuedAccessCode) => {
  expect(issued.plaintextCode).toMatch(CODE);
  return issued.plaintextCode ?? '';
};
/** Removes identifiers and timestamps, whose digits are unrelated to any code, before scanning. */
const scrub = (text: string) =>
  text
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>')
    .replace(/\d{4}-\d{2}-\d{2}T[0-9:.+Z-]+/g, '<ts>');

describe('Public access domain', () => {
  let env: TestDatabase;
  let runtime: DbHandle;
  let sellerA: string;
  let sellerB: string;

  beforeAll(async () => {
    env = await startDatabase();
    runtime = createDb(env.runtimeUrl, { max: 4, applicationName: 'public-access-test' });
    sellerA = await seedSeller(runtime.db, FIXTURE.sellers.a);
    sellerB = await seedSeller(runtime.db, FIXTURE.sellers.b);
  });
  afterAll(async () => {
    await runtime?.close();
    await env?.stop();
  });

  const tenant = <T>(sellerId: string, fn: Parameters<typeof withTenant<T>>[2]) =>
    withTenant(runtime.db, sellerId, fn);
  const eventsFor = (sellerId: string, subjectType: string, subjectId: string) =>
    tenant(sellerId, (trx) => audit.listAuditEventsForSubject(trx, sellerId, subjectType, subjectId));
  const codesOf = (sellerId: string, accessId: string) =>
    tenant(sellerId, (trx) => accessCodes.listAccessCodes(trx, accessId));
  const accessOf = (sellerId: string, accessId: string) =>
    tenant(sellerId, (trx) => publicAccess.getPublicAccess(trx, accessId));
  const listingOf = (sellerId: string, listingId: string) =>
    tenant(sellerId, (trx) => listings.getListing(trx, listingId));
  const verify = (sellerId: string, publicId: string, candidate: unknown) =>
    tenant(sellerId, (trx) => accessCodes.verifyAccessCode(trx, { publicId, candidate }));
  const receiptFor = (sellerId: string, key: string) =>
    tenant(sellerId, (trx) => audit.findIdempotencyReceipt(trx, sellerId, key));
  const rotate = (ctx: CommandContext, accessId: string, expectedRowVersion: number) =>
    tenant(ctx.sellerId, (trx) => accessCodes.rotateAccessCode(trx, ctx, { accessId, expectedRowVersion }));
  const revoke = (ctx: CommandContext, accessId: string, expectedRowVersion: number) =>
    tenant(ctx.sellerId, (trx) => accessCodes.revokeAccessCode(trx, ctx, { accessId, expectedRowVersion }));
  const reissue = (ctx: CommandContext, accessId: string, expectedRowVersion: number) =>
    tenant(ctx.sellerId, (trx) => accessCodes.issueAccessCode(trx, ctx, { accessId, expectedRowVersion }));
  const count = async (sql: string, values: unknown[]) =>
    Number((await query<{ n: string }>(env.superuserUrl, sql, values))[0]?.n ?? '0');
  /** Every stored row of the tables that could carry a code, as text, read as the superuser. */
  const storedText = async () => {
    const parts: string[] = [];
    for (const table of [
      'public_listing_access',
      'listing_access_code',
      'audit_event',
      'idempotency_receipt',
    ]) {
      const rows = await query<{ t: string }>(
        env.superuserUrl,
        `SELECT row_to_json(r)::text AS t FROM ${APP_SCHEMA}.${table} r`,
      );
      parts.push(...rows.map((r) => r.t));
    }
    return scrub(parts.join('\n'));
  };
  /** READY → LISTED with a known key, so the publication can be replayed. */
  const publish = async (sellerId: string) => {
    const built = await buildListing(runtime.db, sellerId);
    const ready = await tenant(sellerId, (trx) =>
      listings.markReady(trx, command(sellerId, 'ready'), {
        listingId: built.listingId,
        expectedRowVersion: built.rowVersion,
      }),
    );
    const ctx = command(sellerId, 'listed');
    const input = { listingId: built.listingId, expectedRowVersion: ready.rowVersion };
    const result = await tenant(sellerId, (trx) => listings.markListed(trx, ctx, input));
    return { built, ready, ctx, input, result };
  };

  it('READY → LISTED issues an enabled public access and one ACTIVE code in one transaction, with the mandatory events and a receipt, and no plaintext anywhere', async () => {
    const { built, ready, ctx, result } = await publish(sellerA);
    expect(result.listing.status).toBe('LISTED');
    expect(result.listing.rowVersion).toBe(ready.rowVersion + 1);
    expect(result.access).toMatchObject({
      sellerId: sellerA,
      listingId: built.listingId,
      enabled: true,
      rowVersion: 1,
    });
    expect(result.access.publicId).toMatch(PUBLIC_ID);
    // BUYER-002: nothing internal is embedded in the public id.
    for (const id of [built.listingId, sellerA, result.access.id, result.code.id]) {
      const hex = id.replace(/-/g, '');
      for (let i = 0; i + 8 <= hex.length; i += 4)
        expect(result.access.publicId).not.toContain(hex.slice(i, i + 8));
    }
    expect(result.code).toMatchObject({
      sellerId: sellerA,
      publicAccessId: result.access.id,
      versionNumber: 1,
      status: 'ACTIVE',
      expiresAt: null,
    });
    const plaintext = plaintextOf(result.code);

    const codes = await codesOf(sellerA, result.access.id);
    expect(codes.map((c) => [c.versionNumber, c.status])).toEqual([[1, 'ACTIVE']]);
    expect(
      await count(
        `SELECT count(*)::text AS n FROM ${APP_SCHEMA}.public_listing_access WHERE listing_id = $1`,
        [built.listingId],
      ),
    ).toBe(1);

    // Mandatory events: the transition on the listing, the issue on the code (OPS-780, OPS-781).
    const status = (await eventsFor(sellerA, 'listing', built.listingId)).filter(
      (e) => e.eventType === 'LISTING_STATUS_CHANGED',
    );
    expect(status.map((e) => e.summary)).toEqual([
      { from: 'DRAFT', to: 'READY', row_version: ready.rowVersion },
      {
        from: 'READY',
        to: 'LISTED',
        row_version: result.listing.rowVersion,
        public_access_id: result.access.id,
      },
    ]);
    expect(status[1]).toMatchObject({
      idempotencyKey: ctx.idempotencyKey,
      requestId: ctx.requestId,
      policyVersionId: built.policyVersionId,
    });
    const created = await eventsFor(sellerA, 'listing_access_code', result.code.id);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      eventType: 'ACCESS_CODE_CREATED',
      actorType: 'SELLER',
      actorRef: sellerA,
      requestId: ctx.requestId,
      policyVersionId: built.policyVersionId,
      idempotencyKey: null,
      summary: { public_access_id: result.access.id, listing_id: built.listingId, version_number: 1 },
    });

    // The receipt records the outcome without the plaintext (OPS-731, DATA-106).
    const receipt = await receiptFor(sellerA, ctx.idempotencyKey);
    expect(receipt).toMatchObject({
      command: 'listing.mark_listed',
      subjectId: built.listingId,
      auditEventId: status[1]?.id,
    });
    expect(JSON.stringify(receipt?.outcome)).not.toContain(plaintext);
    expect(JSON.stringify(receipt?.outcome)).not.toMatch(/plaintext/i);

    // One transaction wrote the listing, the access, the code, both events and the receipt (OPS-787).
    const xmins = (
      await Promise.all([
        query<{ x: string }>(
          env.superuserUrl,
          `SELECT xmin::text AS x FROM ${APP_SCHEMA}.listing WHERE id = $1`,
          [built.listingId],
        ),
        query<{ x: string }>(
          env.superuserUrl,
          `SELECT xmin::text AS x FROM ${APP_SCHEMA}.public_listing_access WHERE id = $1`,
          [result.access.id],
        ),
        query<{ x: string }>(
          env.superuserUrl,
          `SELECT xmin::text AS x FROM ${APP_SCHEMA}.listing_access_code WHERE id = $1`,
          [result.code.id],
        ),
        query<{ x: string }>(
          env.superuserUrl,
          `SELECT xmin::text AS x FROM ${APP_SCHEMA}.audit_event WHERE id = ANY($1::uuid[])`,
          [[status[1]?.id, created[0]?.id]],
        ),
        query<{ x: string }>(
          env.superuserUrl,
          `SELECT xmin::text AS x FROM ${APP_SCHEMA}.idempotency_receipt WHERE idempotency_key = $1`,
          [ctx.idempotencyKey],
        ),
      ])
    )
      .flat()
      .map((r) => r.x);
    expect(xmins).toHaveLength(6);
    expect(new Set(xmins).size).toBe(1);

    // No plaintext column exists and no stored row carries the code (OPS-710, DM-08, SEC-040).
    const columns = await query<{ column_name: string }>(
      env.superuserUrl,
      `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'listing_access_code'`,
      [APP_SCHEMA],
    );
    expect(columns.map((c) => c.column_name).sort()).toEqual([
      'code_hash',
      'expires_at',
      'id',
      'issued_at',
      'public_access_id',
      'request_id',
      'seller_id',
      'status',
      'status_changed_at',
      'version_number',
    ]);
    const [hashRow] = await query<{ code_hash: string }>(
      env.superuserUrl,
      `SELECT code_hash FROM ${APP_SCHEMA}.listing_access_code WHERE id = $1`,
      [result.code.id],
    );
    expect(hashRow?.code_hash).toMatch(/^\$scrypt\$/);
    expect(hashRow?.code_hash).not.toContain(plaintext);
    expect(await storedText()).not.toContain(plaintext);

    // The code verifies internally; a near miss does not.
    expect(await verify(sellerA, result.access.publicId, plaintext)).toBe(true);
    expect(await verify(sellerA, result.access.publicId, wrong(plaintext))).toBe(false);

    // The logger redacts the code even when the whole result is logged by mistake (OPS-566).
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        lines.push(chunk.toString());
        callback();
      },
    });
    const log = createLogger({ module: 'web', env: 'ci', release: 'test', stream });
    log.info({ result }, 'published');
    log.info({ code: result.code }, 'issued');
    log.info({ plaintextCode: plaintext }, 'flat');
    expect(lines.join('')).not.toContain(plaintext);
  });

  it('replays the publication under the same key without a second access, code or event, returning the outcome without the plaintext', async () => {
    const { built, ctx, input, result } = await publish(sellerA);
    const again = await tenant(sellerA, (trx) => listings.markListed(trx, ctx, input));
    expect(again.listing).toEqual(result.listing);
    expect(again.access).toEqual(result.access);
    expect(again.code).toEqual({ ...result.code, plaintextCode: null });

    expect(await codesOf(sellerA, result.access.id)).toHaveLength(1);
    expect(
      await count(
        `SELECT count(*)::text AS n FROM ${APP_SCHEMA}.public_listing_access WHERE listing_id = $1`,
        [built.listingId],
      ),
    ).toBe(1);
    expect(
      (await eventsFor(sellerA, 'listing', built.listingId)).filter(
        (e) => e.eventType === 'LISTING_STATUS_CHANGED',
      ),
    ).toHaveLength(2);
    expect(await eventsFor(sellerA, 'listing_access_code', result.code.id)).toHaveLength(1);
    expect(
      await count(
        `SELECT count(*)::text AS n FROM ${APP_SCHEMA}.idempotency_receipt WHERE idempotency_key = $1`,
        [ctx.idempotencyKey],
      ),
    ).toBe(1);

    // A fresh key on the LISTED listing is refused by state, and a reused key with another payload conflicts.
    await expect(
      tenant(sellerA, (trx) =>
        listings.markListed(trx, command(sellerA, 'listed-again'), {
          listingId: built.listingId,
          expectedRowVersion: result.listing.rowVersion,
        }),
      ),
    ).rejects.toBeInstanceOf(InvalidStateError);
    await expect(
      tenant(sellerA, (trx) =>
        listings.markListed(trx, ctx, { ...input, expectedRowVersion: input.expectedRowVersion + 1 }),
      ),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
  });

  it('rolls back the transition, the access record, the code, the events and the receipt when the transaction fails after issuance', async () => {
    const built = await buildListing(runtime.db, sellerA);
    const ready = await tenant(sellerA, (trx) =>
      listings.markReady(trx, command(sellerA, 'ready'), {
        listingId: built.listingId,
        expectedRowVersion: built.rowVersion,
      }),
    );
    const ctx = command(sellerA, 'listed');
    await expect(
      tenant(sellerA, async (trx) => {
        const result = await listings.markListed(trx, ctx, {
          listingId: built.listingId,
          expectedRowVersion: ready.rowVersion,
        });
        expect(result.listing.status).toBe('LISTED');
        plaintextOf(result.code);
        throw new Error('forced rollback');
      }),
    ).rejects.toThrow('forced rollback');

    const after = await listingOf(sellerA, built.listingId);
    expect(after.status).toBe('READY');
    expect(after.rowVersion).toBe(ready.rowVersion);
    expect(
      await count(
        `SELECT count(*)::text AS n FROM ${APP_SCHEMA}.public_listing_access WHERE listing_id = $1`,
        [built.listingId],
      ),
    ).toBe(0);
    expect(
      await count(
        `SELECT count(*)::text AS n FROM ${APP_SCHEMA}.listing_access_code c JOIN ${APP_SCHEMA}.public_listing_access a ON a.id = c.public_access_id WHERE a.listing_id = $1`,
        [built.listingId],
      ),
    ).toBe(0);
    expect(
      (await eventsFor(sellerA, 'listing', built.listingId)).filter((e) => e.summary['to'] === 'LISTED'),
    ).toEqual([]);
    expect(
      await count(
        `SELECT count(*)::text AS n FROM ${APP_SCHEMA}.audit_event WHERE event_type = 'ACCESS_CODE_CREATED' AND summary->>'listing_id' = $1`,
        [built.listingId],
      ),
    ).toBe(0);
    expect(await receiptFor(sellerA, ctx.idempotencyKey)).toBeUndefined();
  });

  it('refuses LISTED from any state but READY, and at the data layer without an enabled access carrying an ACTIVE code (SM-L-02)', async () => {
    const draft = await buildListing(runtime.db, sellerA);
    await expect(
      tenant(sellerA, (trx) =>
        listings.markListed(trx, command(sellerA, 'listed'), {
          listingId: draft.listingId,
          expectedRowVersion: draft.rowVersion,
        }),
      ),
    ).rejects.toBeInstanceOf(InvalidStateError);
    const ready = await tenant(sellerA, (trx) =>
      listings.markReady(trx, command(sellerA, 'ready'), {
        listingId: draft.listingId,
        expectedRowVersion: draft.rowVersion,
      }),
    );
    for (const url of [env.runtimeUrl, env.migratorUrl]) {
      const err = await expectPgError(
        url,
        `UPDATE ${APP_SCHEMA}.listing SET status = 'LISTED', row_version = row_version + 1 WHERE id = $1`,
        [ready.id],
        (client) => setTenant(client, sellerA),
      );
      expect(err.code).toBe(SQLSTATE.listingPublicAccessMissing);
      expect(err.message).toContain('SM-L-02');
    }
    expect(mapDatabaseError({ code: SQLSTATE.listingPublicAccessMissing }, 'listing')).toBeInstanceOf(
      PublicAccessRequiredError,
    );
    expect((await listingOf(sellerA, draft.listingId)).status).toBe('READY');
  });

  it('rejects illegal code and access mutations at the data layer: a plaintext-shaped hash, a second ACTIVE code, undrawn transitions, identity changes and deletes', async () => {
    const { listed } = await publishListing(runtime.db, sellerA);
    const accessId = listed.access.id;
    const asOwner = (text: string, values: unknown[]) =>
      expectPgError(env.migratorUrl, text, values, (c) => setTenant(c, sellerA));
    const asRuntime = (text: string, values: unknown[]) =>
      expectPgError(env.runtimeUrl, text, values, (c) => setTenant(c, sellerA));
    const insert = `INSERT INTO ${APP_SCHEMA}.listing_access_code (seller_id, public_access_id, version_number, status, code_hash, request_id) VALUES ($1, $2, $3, $4, $5, 'req-guard')`;
    const [row] = await query<{ code_hash: string }>(
      env.superuserUrl,
      `SELECT code_hash FROM ${APP_SCHEMA}.listing_access_code WHERE id = $1`,
      [listed.code.id],
    );
    const shaped = row?.code_hash ?? '';

    expect((await asOwner(insert, [sellerA, accessId, 90, 'ACTIVE', '123456'])).code).toBe(
      SQLSTATE.checkViolation,
    );
    expect((await asOwner(insert, [sellerA, accessId, 91, 'ACTIVE', shaped])).code).toBe(
      SQLSTATE.uniqueViolation,
    );
    expect((await asOwner(insert, [sellerA, accessId, 92, 'ROTATED', shaped])).code).toBe(
      SQLSTATE.accessCodeTransitionIllegal,
    );

    const altered = shaped.slice(0, -2) + (shaped.endsWith('AA') ? 'BB' : 'AA');
    expect(
      (
        await asOwner(`UPDATE ${APP_SCHEMA}.listing_access_code SET code_hash = $2 WHERE id = $1`, [
          listed.code.id,
          altered,
        ])
      ).code,
    ).toBe(SQLSTATE.accessCodeImmutable);
    expect(
      (
        await asOwner(`UPDATE ${APP_SCHEMA}.listing_access_code SET version_number = 7 WHERE id = $1`, [
          listed.code.id,
        ])
      ).code,
    ).toBe(SQLSTATE.accessCodeImmutable);
    expect(
      (
        await asOwner(
          `UPDATE ${APP_SCHEMA}.listing_access_code SET status_changed_at = now() + interval '1 hour' WHERE id = $1`,
          [listed.code.id],
        )
      ).code,
    ).toBe(SQLSTATE.accessCodeImmutable);

    const rotated = await rotate(command(sellerA, 'rotate'), accessId, listed.access.rowVersion);
    for (const target of ['ACTIVE', 'REVOKED', 'EXPIRED']) {
      const err = await asOwner(`UPDATE ${APP_SCHEMA}.listing_access_code SET status = $2 WHERE id = $1`, [
        rotated.rotated.id,
        target,
      ]);
      expect(err.code, `ROTATED -> ${target}`).toBe(SQLSTATE.accessCodeTransitionIllegal);
    }
    expect(
      (await asRuntime(`DELETE FROM ${APP_SCHEMA}.listing_access_code WHERE id = $1`, [listed.code.id])).code,
    ).toBe(SQLSTATE.insufficientPrivilege);
    expect(
      (await asOwner(`DELETE FROM ${APP_SCHEMA}.listing_access_code WHERE id = $1`, [listed.code.id])).code,
    ).toBe(SQLSTATE.accessCodeImmutable);

    expect(
      (
        await asOwner(
          `UPDATE ${APP_SCHEMA}.public_listing_access SET public_id = 'abcdefghijklmnop', row_version = row_version + 1 WHERE id = $1`,
          [accessId],
        )
      ).code,
    ).toBe(SQLSTATE.publicAccessImmutable);
    expect(
      (
        await asOwner(
          `UPDATE ${APP_SCHEMA}.public_listing_access SET enabled = false, row_version = row_version + 2 WHERE id = $1`,
          [accessId],
        )
      ).code,
    ).toBe(SQLSTATE.publicAccessRowVersionMismatch);
    expect(
      (await asRuntime(`DELETE FROM ${APP_SCHEMA}.public_listing_access WHERE id = $1`, [accessId])).code,
    ).toBe(SQLSTATE.insufficientPrivilege);
    expect(
      (await asOwner(`DELETE FROM ${APP_SCHEMA}.public_listing_access WHERE id = $1`, [accessId])).code,
    ).toBe(SQLSTATE.publicAccessImmutable);
    expect(
      (
        await asOwner(
          `INSERT INTO ${APP_SCHEMA}.public_listing_access (seller_id, listing_id, public_id, request_id) VALUES ($1, $2, 'abcdefghijklmnop', 'req-guard')`,
          [sellerA, listed.listing.id],
        )
      ).code,
    ).toBe(SQLSTATE.uniqueViolation);
    expect(
      (
        await asOwner(
          `INSERT INTO ${APP_SCHEMA}.public_listing_access (seller_id, listing_id, public_id, request_id) VALUES ($1, $2, 'ABCDEFGHIJKLMNOP', 'req-guard')`,
          [sellerA, listed.listing.id],
        )
      ).code,
    ).toBe(SQLSTATE.checkViolation);
  });

  it('rotates atomically: old ROTATED, new ACTIVE, exactly one ACTIVE, URL unchanged, one ROTATED event, old code dead; replays without the plaintext; conflicts on reuse', async () => {
    const { listed } = await publishListing(runtime.db, sellerA);
    const first = plaintextOf(listed.code);
    const ctx = command(sellerA, 'rotate');
    const rotated = await rotate(ctx, listed.access.id, listed.access.rowVersion);
    expect(rotated.rotated).toMatchObject({ id: listed.code.id, versionNumber: 1, status: 'ROTATED' });
    expect(rotated.issued).toMatchObject({
      publicAccessId: listed.access.id,
      versionNumber: 2,
      status: 'ACTIVE',
    });
    const second = plaintextOf(rotated.issued);
    expect(rotated.access).toMatchObject({
      id: listed.access.id,
      publicId: listed.access.publicId,
      enabled: true,
      rowVersion: 2,
    });

    const codes = await codesOf(sellerA, listed.access.id);
    expect(codes.map((c) => [c.versionNumber, c.status])).toEqual([
      [1, 'ROTATED'],
      [2, 'ACTIVE'],
    ]);
    const events = await eventsFor(sellerA, 'listing_access_code', rotated.issued.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventType: 'ACCESS_CODE_ROTATED',
      idempotencyKey: ctx.idempotencyKey,
      requestId: ctx.requestId,
      summary: {
        public_access_id: listed.access.id,
        listing_id: listed.listing.id,
        from_version_number: 1,
        to_version_number: 2,
      },
    });
    expect((await eventsFor(sellerA, 'listing_access_code', listed.code.id)).map((e) => e.eventType)).toEqual(
      ['ACCESS_CODE_CREATED'],
    );

    expect(await verify(sellerA, listed.access.publicId, first)).toBe(false);
    expect(await verify(sellerA, listed.access.publicId, second)).toBe(true);
    expect(await verify(sellerA, listed.access.publicId, wrong(second))).toBe(false);

    const replay = await rotate(ctx, listed.access.id, listed.access.rowVersion);
    expect(replay).toEqual({
      access: rotated.access,
      rotated: rotated.rotated,
      issued: { ...rotated.issued, plaintextCode: null },
    });
    expect(await codesOf(sellerA, listed.access.id)).toHaveLength(2);
    expect(await eventsFor(sellerA, 'listing_access_code', rotated.issued.id)).toHaveLength(1);

    await expect(revoke(ctx, listed.access.id, rotated.access.rowVersion)).rejects.toBeInstanceOf(
      IdempotencyConflictError,
    );
    await expect(rotate(ctx, listed.access.id, rotated.access.rowVersion)).rejects.toBeInstanceOf(
      IdempotencyConflictError,
    );
    const stale = await rotate(
      command(sellerA, 'rotate-stale'),
      listed.access.id,
      listed.access.rowVersion,
    ).then(
      () => undefined,
      (err: unknown) => err as Error,
    );
    expect(stale).toBeInstanceOf(ConcurrentModificationError);
    expect(stale?.message).not.toContain(first);
    expect(stale?.message).not.toContain(second);
    expect(await codesOf(sellerA, listed.access.id)).toHaveLength(2);
    const stored = await storedText();
    expect(stored).not.toContain(first);
    expect(stored).not.toContain(second);
  });

  it('revokes atomically: code REVOKED, surface disabled, one REVOKED event, code dead; replays idempotently; re-issue reopens the surface with a new ACTIVE code', async () => {
    const { listed } = await publishListing(runtime.db, sellerA);
    const first = plaintextOf(listed.code);
    const ctx = command(sellerA, 'revoke');
    const revoked = await revoke(ctx, listed.access.id, listed.access.rowVersion);
    expect(revoked.access).toMatchObject({
      id: listed.access.id,
      publicId: listed.access.publicId,
      enabled: false,
      rowVersion: 2,
    });
    expect(revoked.revoked).toMatchObject({ id: listed.code.id, versionNumber: 1, status: 'REVOKED' });
    expect(
      (await eventsFor(sellerA, 'listing_access_code', listed.code.id)).map((e) => [e.eventType, e.summary]),
    ).toEqual([
      [
        'ACCESS_CODE_CREATED',
        { public_access_id: listed.access.id, listing_id: listed.listing.id, version_number: 1 },
      ],
      [
        'ACCESS_CODE_REVOKED',
        {
          public_access_id: listed.access.id,
          listing_id: listed.listing.id,
          version_number: 1,
          surface_enabled: false,
        },
      ],
    ]);
    expect(await verify(sellerA, listed.access.publicId, first)).toBe(false);
    expect(
      await tenant(sellerA, (trx) => accessCodes.findActiveAccessCode(trx, listed.access.id)),
    ).toBeUndefined();
    expect((await listingOf(sellerA, listed.listing.id)).status).toBe('LISTED');

    expect(await revoke(ctx, listed.access.id, listed.access.rowVersion)).toEqual(revoked);
    expect(await eventsFor(sellerA, 'listing_access_code', listed.code.id)).toHaveLength(2);
    await expect(revoke(command(sellerA, 'revoke-again'), listed.access.id, 2)).rejects.toBeInstanceOf(
      InvalidStateError,
    );
    expect((await accessOf(sellerA, listed.access.id)).rowVersion).toBe(2);
    await expect(rotate(command(sellerA, 'rotate-revoked'), listed.access.id, 2)).rejects.toBeInstanceOf(
      InvalidStateError,
    );

    const reissueCtx = command(sellerA, 'reissue');
    const reissued = await reissue(reissueCtx, listed.access.id, 2);
    expect(reissued.access).toMatchObject({ enabled: true, rowVersion: 3, publicId: listed.access.publicId });
    expect(reissued.issued).toMatchObject({ versionNumber: 2, status: 'ACTIVE' });
    const third = plaintextOf(reissued.issued);
    expect(
      (await eventsFor(sellerA, 'listing_access_code', reissued.issued.id)).map((e) => e.eventType),
    ).toEqual(['ACCESS_CODE_CREATED']);
    expect(await verify(sellerA, listed.access.publicId, third)).toBe(true);
    expect(await verify(sellerA, listed.access.publicId, first)).toBe(false);
    expect(await reissue(reissueCtx, listed.access.id, 2)).toEqual({
      access: reissued.access,
      issued: { ...reissued.issued, plaintextCode: null },
    });
    await expect(reissue(command(sellerA, 'reissue-again'), listed.access.id, 3)).rejects.toBeInstanceOf(
      InvalidStateError,
    );
    expect(await codesOf(sellerA, listed.access.id)).toHaveLength(2);
  });

  it('verifies only the ACTIVE, unexpired code of the right enabled access and answers false for everything else without throwing', async () => {
    const one = await publishListing(runtime.db, sellerA);
    const two = await publishListing(runtime.db, sellerA);
    const codeOne = plaintextOf(one.listed.code);
    expect(await verify(sellerA, one.listed.access.publicId, codeOne)).toBe(true);
    expect(await verify(sellerA, two.listed.access.publicId, codeOne)).toBe(
      codeOne === two.listed.code.plaintextCode,
    );
    expect(await verify(sellerA, 'zzzzzzzzzzzzzzzz', codeOne)).toBe(false);
    expect(await verify(sellerA, 'not-a-public-id', codeOne)).toBe(false);
    expect(await verify(sellerA, one.listed.access.publicId, codeOne.slice(1))).toBe(false);
    expect(await verify(sellerA, one.listed.access.publicId, Number(codeOne))).toBe(false);
    expect(await verify(sellerA, one.listed.access.publicId, null)).toBe(false);

    // An expired code is unusable while still ACTIVE in status; the EXPIRED transition is a later job.
    const revoked = await revoke(
      command(sellerA, 'revoke'),
      two.listed.access.id,
      two.listed.access.rowVersion,
    );
    const expiring = await tenant(sellerA, async (trx) => {
      const access = await publicAccess.updatePublicAccess(
        trx,
        command(sellerA, 'reopen'),
        revoked.access.id,
        revoked.access.rowVersion,
        { enabled: true },
      );
      return accessCodes.issueCode(trx, command(sellerA, 'expiring'), {
        access,
        versionNumber: await accessCodes.nextVersionNumber(trx, access.id),
        expiresAt: new Date(Date.now() + 300),
      });
    });
    const short = plaintextOf(expiring);
    expect(await verify(sellerA, two.listed.access.publicId, short)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(await verify(sellerA, two.listed.access.publicId, short)).toBe(false);
    expect((await codesOf(sellerA, two.listed.access.id)).map((c) => c.status)).toEqual([
      'REVOKED',
      'ACTIVE',
    ]);
  });

  it('lets another tenant neither read, rotate, revoke, re-issue, verify nor see the access or its codes, and exposes nothing without a tenant context', async () => {
    const { result: listed, ctx } = await publish(sellerA);
    const code = plaintextOf(listed.code);
    await expect(accessOf(sellerB, listed.access.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(rotate(command(sellerB, 'rotate'), listed.access.id, 1)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(revoke(command(sellerB, 'revoke'), listed.access.id, 1)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(reissue(command(sellerB, 'reissue'), listed.access.id, 1)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(rotate({ ...ctx, sellerId: sellerB }, listed.access.id, 1)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    expect(await verify(sellerB, listed.access.publicId, code)).toBe(false);
    expect(await codesOf(sellerB, listed.access.id)).toEqual([]);
    expect(
      await tenant(sellerB, (trx) => publicAccess.findPublicAccessByPublicId(trx, listed.access.publicId)),
    ).toBeUndefined();
    expect(await eventsFor(sellerB, 'listing_access_code', listed.code.id)).toEqual([]);
    for (const table of ['public_listing_access', 'listing_access_code'] as const) {
      const rows = await tenant(sellerB, (trx) => trx.selectFrom(table).select('seller_id').execute());
      expect(
        rows.filter((r) => r.seller_id !== sellerB),
        table,
      ).toEqual([]);
    }
    await withClient(env.runtimeUrl, async (client) => {
      for (const table of ['public_listing_access', 'listing_access_code']) {
        const res = await client.query(`SELECT seller_id FROM ${APP_SCHEMA}.${table}`);
        expect(res.rows, table).toEqual([]);
      }
    });
    const rows = await query<{ seller_id: string }>(
      env.superuserUrl,
      `SELECT seller_id FROM ${APP_SCHEMA}.public_listing_access WHERE id = $1`,
      [listed.access.id],
    );
    expect(rows).toEqual([{ seller_id: sellerA }]);
    expect(await accessOf(sellerA, listed.access.id)).toEqual(listed.access);
    expect(await verify(sellerA, listed.access.publicId, code)).toBe(true);
  });

  it('preserves the invariants under concurrent rotation and concurrent publication', async () => {
    const { listed } = await publishListing(runtime.db, sellerA);
    const outcomes = await Promise.allSettled([
      rotate(command(sellerA, 'rotate-1'), listed.access.id, listed.access.rowVersion),
      rotate(command(sellerA, 'rotate-2'), listed.access.id, listed.access.rowVersion),
    ]);
    expect(outcomes.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const failed = outcomes.find((o) => o.status === 'rejected');
    expect(failed?.status === 'rejected' && failed.reason).toBeInstanceOf(ConcurrentModificationError);
    expect((await codesOf(sellerA, listed.access.id)).map((c) => [c.versionNumber, c.status])).toEqual([
      [1, 'ROTATED'],
      [2, 'ACTIVE'],
    ]);
    expect(
      await count(
        `SELECT count(*)::text AS n FROM ${APP_SCHEMA}.listing_access_code WHERE public_access_id = $1 AND status = 'ACTIVE'`,
        [listed.access.id],
      ),
    ).toBe(1);
    expect(
      await count(
        `SELECT count(*)::text AS n FROM ${APP_SCHEMA}.audit_event WHERE event_type = 'ACCESS_CODE_ROTATED' AND summary->>'public_access_id' = $1`,
        [listed.access.id],
      ),
    ).toBe(1);
    expect((await accessOf(sellerA, listed.access.id)).rowVersion).toBe(2);

    const built = await buildListing(runtime.db, sellerA);
    const ready = await tenant(sellerA, (trx) =>
      listings.markReady(trx, command(sellerA, 'ready'), {
        listingId: built.listingId,
        expectedRowVersion: built.rowVersion,
      }),
    );
    const publications = await Promise.allSettled([
      tenant(sellerA, (trx) =>
        listings.markListed(trx, command(sellerA, 'listed-1'), {
          listingId: built.listingId,
          expectedRowVersion: ready.rowVersion,
        }),
      ),
      tenant(sellerA, (trx) =>
        listings.markListed(trx, command(sellerA, 'listed-2'), {
          listingId: built.listingId,
          expectedRowVersion: ready.rowVersion,
        }),
      ),
    ]);
    expect(publications.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const lost = publications.find((o) => o.status === 'rejected');
    const reason: unknown = lost?.status === 'rejected' ? lost.reason : undefined;
    expect(reason instanceof InvalidStateError || reason instanceof ConcurrentModificationError).toBe(true);
    expect(
      await count(
        `SELECT count(*)::text AS n FROM ${APP_SCHEMA}.public_listing_access WHERE listing_id = $1`,
        [built.listingId],
      ),
    ).toBe(1);
    expect(
      await count(
        `SELECT count(*)::text AS n FROM ${APP_SCHEMA}.listing_access_code c JOIN ${APP_SCHEMA}.public_listing_access a ON a.id = c.public_access_id WHERE a.listing_id = $1`,
        [built.listingId],
      ),
    ).toBe(1);
    expect(
      await count(
        `SELECT count(*)::text AS n FROM ${APP_SCHEMA}.audit_event WHERE event_type = 'ACCESS_CODE_CREATED' AND summary->>'listing_id' = $1`,
        [built.listingId],
      ),
    ).toBe(1);
    expect(
      (await eventsFor(sellerA, 'listing', built.listingId)).filter((e) => e.summary['to'] === 'LISTED'),
    ).toHaveLength(1);
    expect((await listingOf(sellerA, built.listingId)).status).toBe('LISTED');
  });
});
