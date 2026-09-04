import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { APP_SCHEMA, SQLSTATE } from '../../src/db/constants.ts';
import { createDb, withTenant, type DbHandle } from '../../src/db/kysely.ts';
import * as accessCodes from '../../src/modules/access-codes/index.ts';
import * as audit from '../../src/modules/audit/index.ts';
import * as content from '../../src/modules/listing-content/index.ts';
import * as listings from '../../src/modules/listings/index.ts';
import * as publicAccess from '../../src/modules/public-listing-access/index.ts';
import { createLogger } from '../../src/observability/logger.ts';
import type { CommandContext } from '../../src/shared/command.ts';
import {
  ConcurrentModificationError,
  IdempotencyConflictError,
  InvalidStateError,
  ListingNotReadyError,
  NotFoundError,
} from '../../src/shared/errors.ts';
import { startDatabase, type TestDatabase } from '../helpers/database.ts';
import { buildListing, command, FIXTURE, publishListing, seedSeller } from '../helpers/fixtures.ts';
import { expectPgError, query, setTenant, withClient } from '../helpers/inspect.ts';

// Slice 1c: STATE_MACHINES.md §1 around LISTED (SM-L-02, SM-L-06), OPS-215 to OPS-224, ACCESS-103,
// OPS-730 to OPS-732, OPS-780 to OPS-787, SEC-040, SEC-100. Every code is generated at run time.

const CODE = /^[0-9]{6}$/;
const ORIGIN = 'https://alpha.example';
const scrub = (text: string) =>
  text
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>')
    .replace(/\d{4}-\d{2}-\d{2}T[0-9:.+Z-]+/g, '<ts>');
const plaintextOf = (issued: accessCodes.IssuedAccessCode) => {
  expect(issued.plaintextCode).toMatch(CODE);
  return issued.plaintextCode ?? '';
};

describe('Listed listing lifecycle', () => {
  let env: TestDatabase;
  let runtime: DbHandle;
  let sellerA: string;
  let sellerB: string;

  beforeAll(async () => {
    env = await startDatabase();
    runtime = createDb(env.runtimeUrl, { max: 4, applicationName: 'listed-lifecycle-test' });
    sellerA = await seedSeller(runtime.db, FIXTURE.sellers.a);
    sellerB = await seedSeller(runtime.db, FIXTURE.sellers.b);
  });
  afterAll(async () => {
    await runtime?.close();
    await env?.stop();
  });

  const tenant = <T>(sellerId: string, fn: Parameters<typeof withTenant<T>>[2]) =>
    withTenant(runtime.db, sellerId, fn);
  const listingOf = (sellerId: string, id: string) => tenant(sellerId, (trx) => listings.getListing(trx, id));
  const accessOf = (sellerId: string, id: string) =>
    tenant(sellerId, (trx) => publicAccess.getPublicAccess(trx, id));
  const codesOf = (sellerId: string, accessId: string) =>
    tenant(sellerId, (trx) => accessCodes.listAccessCodes(trx, accessId));
  const eventsFor = (sellerId: string, subjectType: string, subjectId: string) =>
    tenant(sellerId, (trx) => audit.listAuditEventsForSubject(trx, sellerId, subjectType, subjectId));
  const statusEvents = async (sellerId: string, listingId: string) =>
    (await eventsFor(sellerId, 'listing', listingId)).filter((e) => e.eventType === 'LISTING_STATUS_CHANGED');
  const verify = (sellerId: string, publicId: string, candidate: unknown) =>
    tenant(sellerId, (trx) => accessCodes.verifyAccessCode(trx, { publicId, candidate }));
  const receiptFor = (sellerId: string, key: string) =>
    tenant(sellerId, (trx) => audit.findIdempotencyReceipt(trx, sellerId, key));
  const cancel = (ctx: CommandContext, listingId: string, expectedRowVersion: number) =>
    tenant(ctx.sellerId, (trx) => listings.cancelListing(trx, ctx, { listingId, expectedRowVersion }));
  const expire = (ctx: CommandContext, listingId: string, expectedRowVersion: number) =>
    tenant(ctx.sellerId, (trx) => listings.expireListing(trx, ctx, { listingId, expectedRowVersion }));
  const archive = (ctx: CommandContext, listingId: string, expectedRowVersion: number) =>
    tenant(ctx.sellerId, (trx) => listings.archiveListing(trx, ctx, { listingId, expectedRowVersion }));
  const relist = (ctx: CommandContext, listingId: string, expectedRowVersion: number, buyerOrigin?: string) =>
    tenant(ctx.sellerId, (trx) =>
      listings.relistListing(trx, ctx, {
        listingId,
        expectedRowVersion,
        ...(buyerOrigin ? { buyerOrigin } : {}),
      }),
    );
  const count = async (sql: string, values: unknown[]) =>
    Number((await query<{ n: string }>(env.superuserUrl, sql, values))[0]?.n ?? '0');
  const xminsOf = async (specs: [string, string, unknown][]) => {
    const rows = await Promise.all(
      specs.map(([table, where, value]) =>
        query<{ x: string }>(
          env.superuserUrl,
          `SELECT xmin::text AS x FROM ${APP_SCHEMA}.${table} WHERE ${where}`,
          [value],
        ),
      ),
    );
    return rows.flat().map((r) => r.x);
  };
  const storedText = async () => {
    const parts: string[] = [];
    for (const table of [
      'listing',
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
  /** A published listing whose expired state can be reached with `expire`. */
  const expired = async (sellerId: string) => {
    const { listed } = await publishListing(runtime.db, sellerId);
    const closed = await expire(command(sellerId, 'expire'), listed.listing.id, listed.listing.rowVersion);
    return { listed, closed };
  };

  it('cancels a LISTED listing atomically: surface disabled, code REVOKED, listing CANCELLED with a database-clock closing time, both events and a receipt, no plaintext', async () => {
    const { listed } = await publishListing(runtime.db, sellerA);
    const first = plaintextOf(listed.code);
    const ctx = command(sellerA, 'cancel');
    const result = await cancel(ctx, listed.listing.id, listed.listing.rowVersion);

    expect(result.listing).toMatchObject({
      id: listed.listing.id,
      status: 'CANCELLED',
      rowVersion: listed.listing.rowVersion + 1,
    });
    expect(result.listing.listedAt).toBeInstanceOf(Date);
    expect(result.listing.closedAt).toBeInstanceOf(Date);
    expect(result.access).toMatchObject({
      id: listed.access.id,
      publicId: listed.access.publicId,
      enabled: false,
      rowVersion: 2,
    });
    expect(result.closed).toMatchObject({ id: listed.code.id, versionNumber: 1, status: 'REVOKED' });
    expect(JSON.stringify(result)).not.toContain(first);
    expect(JSON.stringify(result)).not.toMatch(/plaintext|copyBlock/);

    expect(await verify(sellerA, listed.access.publicId, first)).toBe(false);
    expect((await codesOf(sellerA, listed.access.id)).map((c) => c.status)).toEqual(['REVOKED']);
    const [dbRow] = await query<{ closed_at: Date; listed_at: Date }>(
      env.superuserUrl,
      `SELECT closed_at, listed_at FROM ${APP_SCHEMA}.listing WHERE id = $1`,
      [listed.listing.id],
    );
    expect(dbRow?.closed_at.getTime()).toBeGreaterThanOrEqual(dbRow?.listed_at.getTime() ?? Infinity);

    const status = await statusEvents(sellerA, listed.listing.id);
    expect(status.at(-1)).toMatchObject({
      idempotencyKey: ctx.idempotencyKey,
      requestId: ctx.requestId,
      policyVersionId: listed.listing.currentPolicyVersionId,
      summary: {
        from: 'LISTED',
        to: 'CANCELLED',
        row_version: result.listing.rowVersion,
        public_access_id: listed.access.id,
        access_terminal_status: 'REVOKED',
        access_version_number: 1,
      },
    });
    const codeEvents = await eventsFor(sellerA, 'listing_access_code', listed.code.id);
    expect(codeEvents.map((e) => e.eventType)).toEqual(['ACCESS_CODE_CREATED', 'ACCESS_CODE_REVOKED']);
    expect(codeEvents[1]?.summary).toEqual({
      public_access_id: listed.access.id,
      listing_id: listed.listing.id,
      version_number: 1,
      surface_enabled: false,
      cause: 'listing_closed',
    });
    const receipt = await receiptFor(sellerA, ctx.idempotencyKey);
    expect(receipt).toMatchObject({ command: 'listing.cancel', auditEventId: status.at(-1)?.id });

    // One transaction wrote the listing, the access, the code, both events and the receipt (OPS-787).
    const xmins = await xminsOf([
      ['listing', 'id = $1', listed.listing.id],
      ['public_listing_access', 'id = $1', listed.access.id],
      ['listing_access_code', 'id = $1', listed.code.id],
      ['audit_event', 'id = $1', status.at(-1)?.id],
      ['audit_event', 'id = $1', codeEvents[1]?.id],
      ['idempotency_receipt', 'idempotency_key = $1', ctx.idempotencyKey],
    ]);
    expect(xmins).toHaveLength(6);
    expect(new Set(xmins).size).toBe(1);

    // Replay: the same outcome, no second event, no second effect.
    expect(await cancel(ctx, listed.listing.id, listed.listing.rowVersion)).toEqual(result);
    expect(await statusEvents(sellerA, listed.listing.id)).toHaveLength(status.length);
    expect(await eventsFor(sellerA, 'listing_access_code', listed.code.id)).toHaveLength(2);
    await expect(
      cancel(command(sellerA, 'cancel-again'), listed.listing.id, result.listing.rowVersion),
    ).rejects.toBeInstanceOf(InvalidStateError);
    expect((await storedText()).includes(first)).toBe(false);
  });

  it('expires a LISTED listing: surface disabled, code EXPIRED, status event carries the terminal status, no code event, replay identical', async () => {
    const { listed } = await publishListing(runtime.db, sellerA);
    const first = plaintextOf(listed.code);
    const ctx = command(sellerA, 'expire');
    const result = await expire(ctx, listed.listing.id, listed.listing.rowVersion);
    expect(result.listing).toMatchObject({ status: 'EXPIRED', rowVersion: listed.listing.rowVersion + 1 });
    expect(result.listing.closedAt).toBeInstanceOf(Date);
    expect(result.access).toMatchObject({ id: listed.access.id, enabled: false });
    expect(result.closed).toMatchObject({ id: listed.code.id, status: 'EXPIRED', versionNumber: 1 });
    expect(await verify(sellerA, listed.access.publicId, first)).toBe(false);
    expect((await statusEvents(sellerA, listed.listing.id)).at(-1)?.summary).toEqual({
      from: 'LISTED',
      to: 'EXPIRED',
      row_version: result.listing.rowVersion,
      public_access_id: listed.access.id,
      access_terminal_status: 'EXPIRED',
      access_version_number: 1,
    });
    expect((await eventsFor(sellerA, 'listing_access_code', listed.code.id)).map((e) => e.eventType)).toEqual(
      ['ACCESS_CODE_CREATED'],
    );
    expect(await expire(ctx, listed.listing.id, listed.listing.rowVersion)).toEqual(result);
    expect(await receiptFor(sellerA, ctx.idempotencyKey)).toMatchObject({ command: 'listing.expire' });
    await expect(
      expire(command(sellerA, 'expire-again'), listed.listing.id, result.listing.rowVersion),
    ).rejects.toBeInstanceOf(InvalidStateError);
  });

  it('relists an EXPIRED listing with a fresh code, the same public id, revalidated prerequisites and a one-time copy block', async () => {
    const { listed, closed } = await expired(sellerA);
    const first = plaintextOf(listed.code);
    const ctx = command(sellerA, 'relist');
    const result = await relist(ctx, listed.listing.id, closed.listing.rowVersion, ORIGIN);

    expect(result.listing).toMatchObject({
      status: 'LISTED',
      rowVersion: closed.listing.rowVersion + 1,
      closedAt: null,
    });
    expect(result.listing.listedAt?.getTime()).toBeGreaterThanOrEqual(
      listed.listing.listedAt?.getTime() ?? Infinity,
    );
    expect(result.access).toMatchObject({
      id: listed.access.id,
      publicId: listed.access.publicId,
      enabled: true,
      rowVersion: 3,
    });
    expect(result.code).toMatchObject({
      publicAccessId: listed.access.id,
      versionNumber: 2,
      status: 'ACTIVE',
    });
    const second = plaintextOf(result.code);
    expect((await codesOf(sellerA, listed.access.id)).map((c) => [c.versionNumber, c.status])).toEqual([
      [1, 'EXPIRED'],
      [2, 'ACTIVE'],
    ]);
    expect(await verify(sellerA, listed.access.publicId, second)).toBe(true);
    expect(await verify(sellerA, listed.access.publicId, first)).toBe(false);

    const status = await statusEvents(sellerA, listed.listing.id);
    expect(status.map((e) => `${String(e.summary['from'])}>${String(e.summary['to'])}`)).toEqual([
      'DRAFT>READY',
      'READY>LISTED',
      'LISTED>EXPIRED',
      'EXPIRED>LISTED',
    ]);
    expect(status.at(-1)?.summary).toMatchObject({
      public_access_id: listed.access.id,
      access_version_number: 2,
    });
    expect((await eventsFor(sellerA, 'listing_access_code', result.code.id)).map((e) => e.eventType)).toEqual(
      ['ACCESS_CODE_CREATED'],
    );

    // The copy block: buyer URL with the opaque id, the code, the approved copy, the price, the notice.
    const block = result.copyBlock;
    expect(block).not.toBeNull();
    expect(block?.buyerUrl).toBe(`${ORIGIN}/l/${listed.access.publicId}`);
    expect(block?.text).toContain(block?.buyerUrl ?? '');
    expect(block?.text).toContain(`Access code: ${second}`);
    expect(block?.text).toContain(FIXTURE.copy.title);
    expect(block?.text).toContain(FIXTURE.copy.description);
    expect(block?.text).toContain(`- brand: ${FIXTURE.facts.brand}`);
    expect(block?.text).toContain('Price: CAD 250.00');
    expect(block?.text).toMatch(/rules on external links vary/);
    for (const internal of [
      listed.listing.id,
      listed.access.id,
      result.code.id,
      sellerA,
      listed.listing.currentPolicyVersionId ?? 'x',
    ]) {
      expect(block?.text).not.toContain(internal);
    }
    expect(block?.text).not.toContain(String(FIXTURE.minimumPrice.amountMinor));
    expect(block?.text).not.toMatch(/minimum|concession|negotiat|Fixture Seller/i);

    // Replay: same outcome, no plaintext, no copy block, no third code, no duplicate events.
    const replay = await relist(ctx, listed.listing.id, closed.listing.rowVersion, ORIGIN);
    expect(replay).toEqual({ ...result, code: { ...result.code, plaintextCode: null }, copyBlock: null });
    expect(await codesOf(sellerA, listed.access.id)).toHaveLength(2);
    expect(await statusEvents(sellerA, listed.listing.id)).toHaveLength(4);

    // Nothing stored carries the code or the block (OPS-710, SEC-040, ACCESS-013).
    const stored = await storedText();
    expect(stored).not.toContain(second);
    expect(stored).not.toContain(first);
    expect(stored).not.toContain('Access code:');
    expect(stored).not.toMatch(/copyBlock|copy_block|buyerUrl/);
    expect(JSON.stringify((await receiptFor(sellerA, ctx.idempotencyKey))?.outcome)).not.toMatch(
      /plaintext|copy|Access code/i,
    );

    // The logger redacts the block and the code even when the whole result is logged by mistake.
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        lines.push(chunk.toString());
        callback();
      },
    });
    const log = createLogger({ module: 'web', env: 'ci', release: 'test', stream });
    log.info({ result }, 'relisted');
    log.info({ copyBlock: result.copyBlock }, 'block');
    expect(lines.join('')).not.toContain(second);
    expect(lines.join('')).not.toContain('Access code:');
  });

  it('refuses relisting from any state but EXPIRED, revalidates the SM-L-01 prerequisites, and the data layer refuses undrawn returns to LISTED', async () => {
    const draft = await buildListing(runtime.db, sellerA);
    await expect(relist(command(sellerA, 'r1'), draft.listingId, draft.rowVersion)).rejects.toBeInstanceOf(
      InvalidStateError,
    );
    const ready = await tenant(sellerA, (trx) =>
      listings.markReady(trx, command(sellerA, 'ready'), {
        listingId: draft.listingId,
        expectedRowVersion: draft.rowVersion,
      }),
    );
    await expect(relist(command(sellerA, 'r2'), ready.id, ready.rowVersion)).rejects.toBeInstanceOf(
      InvalidStateError,
    );
    const { listed } = await publishListing(runtime.db, sellerA);
    await expect(
      relist(command(sellerA, 'r3'), listed.listing.id, listed.listing.rowVersion),
    ).rejects.toBeInstanceOf(InvalidStateError);
    const cancelled = await cancel(command(sellerA, 'cancel'), listed.listing.id, listed.listing.rowVersion);
    await expect(
      relist(command(sellerA, 'r4'), listed.listing.id, cancelled.listing.rowVersion),
    ).rejects.toBeInstanceOf(InvalidStateError);
    const archived = await archive(
      command(sellerA, 'archive'),
      listed.listing.id,
      cancelled.listing.rowVersion,
    );
    await expect(
      relist(command(sellerA, 'r5'), listed.listing.id, archived.listing.rowVersion),
    ).rejects.toBeInstanceOf(InvalidStateError);
    for (const url of [env.runtimeUrl, env.migratorUrl]) {
      const err = await expectPgError(
        url,
        `UPDATE ${APP_SCHEMA}.listing SET status = 'LISTED', row_version = row_version + 1 WHERE id = $1`,
        [listed.listing.id],
        (c) => setTenant(c, sellerA),
      );
      expect(err.code).toBe(SQLSTATE.listingTransitionIllegal);
    }

    // An EXPIRED listing whose approved copy is no longer current fails SM-L-01 again (OPS-219).
    const { listed: other, closed } = await expired(sellerA);
    await withClient(env.migratorUrl, async (client) => {
      await client.query('BEGIN');
      await setTenant(client, sellerA);
      await client.query(
        `UPDATE ${APP_SCHEMA}.listing SET current_content_version_id = NULL, row_version = row_version + 1 WHERE id = $1`,
        [other.listing.id],
      );
      await client.query('COMMIT');
    });
    const stale = closed.listing.rowVersion + 1;
    const refused = await relist(command(sellerA, 'r6'), other.listing.id, stale, ORIGIN).then(
      () => undefined,
      (err: unknown) => err as Error,
    );
    expect(refused).toBeInstanceOf(ListingNotReadyError);
    expect((refused as ListingNotReadyError).missing).toContain('approved_content');
    expect((await listingOf(sellerA, other.listing.id)).status).toBe('EXPIRED');
    expect(await codesOf(sellerA, other.access.id)).toHaveLength(1);
    expect((await accessOf(sellerA, other.access.id)).enabled).toBe(false);
  });

  it('enforces closure at the data layer for direct SQL as owner and as runtime, immediately and at commit', async () => {
    const { listed } = await publishListing(runtime.db, sellerA);
    const listingId = listed.listing.id;
    const accessId = listed.access.id;
    const [hashRow] = await query<{ code_hash: string }>(
      env.superuserUrl,
      `SELECT code_hash FROM ${APP_SCHEMA}.listing_access_code WHERE id = $1`,
      [listed.code.id],
    );
    const shaped = hashRow?.code_hash ?? '';

    // A LISTED listing with an open surface cannot close (LS006), whoever asks.
    for (const url of [env.runtimeUrl, env.migratorUrl]) {
      for (const target of ['CANCELLED', 'EXPIRED']) {
        const err = await expectPgError(
          url,
          `UPDATE ${APP_SCHEMA}.listing SET status = $2, row_version = row_version + 1 WHERE id = $1`,
          [listingId, target],
          (c) => setTenant(c, sellerA),
        );
        expect(err.code, `${target}`).toBe(SQLSTATE.listingCloseWithOpenAccess);
      }
    }
    // The listing and closing times are the database's, not a caller's.
    await withClient(env.migratorUrl, async (client) => {
      await client.query('BEGIN');
      await setTenant(client, sellerA);
      await client.query(
        `UPDATE ${APP_SCHEMA}.listing SET listed_at = '2001-01-01T00:00:00Z', closed_at = now(), row_version = row_version + 1 WHERE id = $1`,
        [listingId],
      );
      await client.query('COMMIT');
    });
    const after = await listingOf(sellerA, listingId);
    expect(after.listedAt?.getTime()).toBe(listed.listing.listedAt?.getTime());
    expect(after.closedAt).toBeNull();

    // Once cancelled, neither the surface nor a code can be reopened (PA003, AC003), immediately.
    const cancelled = await cancel(command(sellerA, 'cancel'), listingId, after.rowVersion);
    for (const url of [env.runtimeUrl, env.migratorUrl]) {
      const reopen = await expectPgError(
        url,
        `UPDATE ${APP_SCHEMA}.public_listing_access SET enabled = true, row_version = row_version + 1 WHERE id = $1`,
        [accessId],
        (c) => setTenant(c, sellerA),
      );
      expect(reopen.code).toBe(SQLSTATE.publicAccessOnClosedListing);
      const reissue = await expectPgError(
        url,
        `INSERT INTO ${APP_SCHEMA}.listing_access_code (seller_id, public_access_id, version_number, code_hash, request_id) VALUES ($1, $2, 50, $3, 'req-guard')`,
        [sellerA, accessId, shaped],
        (c) => setTenant(c, sellerA),
      );
      expect(reissue.code).toBe(SQLSTATE.accessCodeOnClosedAccess);
    }
    expect((await accessOf(sellerA, accessId)).enabled).toBe(false);
    expect(cancelled.listing.status).toBe('CANCELLED');

    // An EXPIRED listing admits the surface transiently, but a transaction that does not relist fails at commit.
    const { listed: exp } = await expired(sellerA);
    for (const url of [env.runtimeUrl, env.migratorUrl]) {
      const commitError = await withClient(url, async (client) => {
        await client.query('BEGIN');
        await setTenant(client, sellerA);
        await client.query(
          `UPDATE ${APP_SCHEMA}.public_listing_access SET enabled = true, row_version = row_version + 1 WHERE id = $1`,
          [exp.access.id],
        );
        try {
          await client.query('COMMIT');
          return undefined;
        } catch (err) {
          return err as { code?: string };
        }
      });
      expect(commitError?.code, url === env.runtimeUrl ? 'runtime' : 'owner').toBe(
        SQLSTATE.publicAccessOnClosedListing,
      );
    }
    expect((await accessOf(sellerA, exp.access.id)).enabled).toBe(false);
    const codeCommitError = await withClient(env.migratorUrl, async (client) => {
      await client.query('BEGIN');
      await setTenant(client, sellerA);
      await client.query(
        `UPDATE ${APP_SCHEMA}.public_listing_access SET enabled = true, row_version = row_version + 1 WHERE id = $1`,
        [exp.access.id],
      );
      await client.query(
        `INSERT INTO ${APP_SCHEMA}.listing_access_code (seller_id, public_access_id, version_number, code_hash, request_id) VALUES ($1, $2, 60, $3, 'req-guard')`,
        [sellerA, exp.access.id, shaped],
      );
      try {
        await client.query('COMMIT');
        return undefined;
      } catch (err) {
        return err as { code?: string };
      }
    });
    expect([SQLSTATE.publicAccessOnClosedListing, SQLSTATE.accessCodeOnClosedAccess]).toContain(
      codeCommitError?.code,
    );
    expect(await codesOf(sellerA, exp.access.id)).toHaveLength(1);
    expect(
      await count(
        `SELECT count(*)::text AS n FROM ${APP_SCHEMA}.listing l JOIN ${APP_SCHEMA}.public_listing_access a ON a.listing_id = l.id WHERE l.status IN ('SOLD','CANCELLED','ARCHIVED','EXPIRED') AND a.enabled`,
        [],
      ),
    ).toBe(0);
  });

  it('archives a CANCELLED listing with a status event and refuses archiving from LISTED or with a stale version', async () => {
    const { listed } = await publishListing(runtime.db, sellerA);
    await expect(
      archive(command(sellerA, 'a1'), listed.listing.id, listed.listing.rowVersion),
    ).rejects.toBeInstanceOf(InvalidStateError);
    const cancelled = await cancel(command(sellerA, 'cancel'), listed.listing.id, listed.listing.rowVersion);
    await expect(
      archive(command(sellerA, 'a2'), listed.listing.id, listed.listing.rowVersion),
    ).rejects.toBeInstanceOf(ConcurrentModificationError);
    const ctx = command(sellerA, 'archive');
    const archived = await archive(ctx, listed.listing.id, cancelled.listing.rowVersion);
    expect(archived.listing).toMatchObject({
      status: 'ARCHIVED',
      rowVersion: cancelled.listing.rowVersion + 1,
    });
    expect(archived.listing.closedAt?.getTime()).toBe(cancelled.listing.closedAt?.getTime());
    expect(archived.closed).toBeNull();
    expect(archived.access?.enabled).toBe(false);
    expect((await statusEvents(sellerA, listed.listing.id)).at(-1)?.summary).toEqual({
      from: 'CANCELLED',
      to: 'ARCHIVED',
      row_version: archived.listing.rowVersion,
      public_access_id: listed.access.id,
    });
    expect(await archive(ctx, listed.listing.id, cancelled.listing.rowVersion)).toEqual(archived);
  });

  it('rolls back every record when a closure or a relist transaction fails after the command succeeded', async () => {
    const { listed } = await publishListing(runtime.db, sellerA);
    const ctx = command(sellerA, 'cancel');
    await expect(
      tenant(sellerA, async (trx) => {
        const r = await listings.cancelListing(trx, ctx, {
          listingId: listed.listing.id,
          expectedRowVersion: listed.listing.rowVersion,
        });
        expect(r.listing.status).toBe('CANCELLED');
        throw new Error('forced rollback');
      }),
    ).rejects.toThrow('forced rollback');
    expect(await listingOf(sellerA, listed.listing.id)).toEqual(listed.listing);
    expect(await accessOf(sellerA, listed.access.id)).toEqual(listed.access);
    expect((await codesOf(sellerA, listed.access.id)).map((c) => c.status)).toEqual(['ACTIVE']);
    expect(
      (await statusEvents(sellerA, listed.listing.id)).filter((e) => e.summary['to'] === 'CANCELLED'),
    ).toEqual([]);
    expect(await eventsFor(sellerA, 'listing_access_code', listed.code.id)).toHaveLength(1);
    expect(await receiptFor(sellerA, ctx.idempotencyKey)).toBeUndefined();
    expect(await verify(sellerA, listed.access.publicId, plaintextOf(listed.code))).toBe(true);

    const { listed: exp, closed } = await expired(sellerA);
    const relistCtx = command(sellerA, 'relist');
    await expect(
      tenant(sellerA, async (trx) => {
        const r = await listings.relistListing(trx, relistCtx, {
          listingId: exp.listing.id,
          expectedRowVersion: closed.listing.rowVersion,
          buyerOrigin: ORIGIN,
        });
        expect(r.copyBlock).not.toBeNull();
        throw new Error('forced rollback');
      }),
    ).rejects.toThrow('forced rollback');
    expect(await listingOf(sellerA, exp.listing.id)).toEqual(closed.listing);
    expect((await accessOf(sellerA, exp.access.id)).enabled).toBe(false);
    expect(await codesOf(sellerA, exp.access.id)).toHaveLength(1);
    expect(await receiptFor(sellerA, relistCtx.idempotencyKey)).toBeUndefined();
    expect((await statusEvents(sellerA, exp.listing.id)).at(-1)?.summary['to']).toBe('EXPIRED');
  });

  it('conflicts when a key is reused for a different command or payload', async () => {
    const { listed } = await publishListing(runtime.db, sellerA);
    const ctx = command(sellerA, 'cancel');
    await cancel(ctx, listed.listing.id, listed.listing.rowVersion);
    await expect(expire(ctx, listed.listing.id, listed.listing.rowVersion)).rejects.toBeInstanceOf(
      IdempotencyConflictError,
    );
    await expect(archive(ctx, listed.listing.id, listed.listing.rowVersion + 1)).rejects.toBeInstanceOf(
      IdempotencyConflictError,
    );
    const { listed: exp, closed } = await expired(sellerA);
    const relistCtx = command(sellerA, 'relist');
    await relist(relistCtx, exp.listing.id, closed.listing.rowVersion, ORIGIN);
    await expect(
      relist(relistCtx, exp.listing.id, closed.listing.rowVersion, 'https://other.example'),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
    await expect(relist(relistCtx, exp.listing.id, closed.listing.rowVersion)).rejects.toBeInstanceOf(
      IdempotencyConflictError,
    );
    await expect(
      relist(
        command(sellerA, 'bad-origin'),
        exp.listing.id,
        closed.listing.rowVersion,
        'http://alpha.example',
      ),
    ).rejects.toThrow(/https/);
  });

  it('preserves the invariants under concurrent cancellation and rotation, and under concurrent relisting', async () => {
    const { listed } = await publishListing(runtime.db, sellerA);
    const outcomes = await Promise.allSettled([
      cancel(command(sellerA, 'cancel-c'), listed.listing.id, listed.listing.rowVersion),
      tenant(sellerA, (trx) =>
        accessCodes.rotateAccessCode(trx, command(sellerA, 'rotate-c'), {
          accessId: listed.access.id,
          expectedRowVersion: listed.access.rowVersion,
        }),
      ),
    ]);
    for (const o of outcomes) {
      if (o.status === 'rejected') {
        const reason: unknown = o.reason;
        expect(reason instanceof ConcurrentModificationError || reason instanceof InvalidStateError).toBe(
          true,
        );
      }
    }
    const listing = await listingOf(sellerA, listed.listing.id);
    const access = await accessOf(sellerA, listed.access.id);
    const codes = await codesOf(sellerA, listed.access.id);
    const active = codes.filter((c) => c.status === 'ACTIVE');
    expect(['LISTED', 'CANCELLED']).toContain(listing.status);
    if (listing.status === 'CANCELLED') {
      expect(access.enabled).toBe(false);
      expect(active).toHaveLength(0);
    } else {
      expect(access.enabled).toBe(true);
      expect(active).toHaveLength(1);
    }
    expect(
      await count(
        `SELECT count(*)::text AS n FROM ${APP_SCHEMA}.listing_access_code WHERE public_access_id = $1 AND status = 'ACTIVE'`,
        [listed.access.id],
      ),
    ).toBe(active.length);

    const { listed: exp, closed } = await expired(sellerA);
    const relists = await Promise.allSettled([
      relist(command(sellerA, 'relist-1'), exp.listing.id, closed.listing.rowVersion, ORIGIN),
      relist(command(sellerA, 'relist-2'), exp.listing.id, closed.listing.rowVersion, ORIGIN),
    ]);
    expect(relists.filter((o) => o.status === 'fulfilled')).toHaveLength(1);
    const lost = relists.find((o) => o.status === 'rejected');
    const reason: unknown = lost?.status === 'rejected' ? lost.reason : undefined;
    expect(reason instanceof InvalidStateError || reason instanceof ConcurrentModificationError).toBe(true);
    expect((await codesOf(sellerA, exp.access.id)).map((c) => [c.versionNumber, c.status])).toEqual([
      [1, 'EXPIRED'],
      [2, 'ACTIVE'],
    ]);
    expect(
      await count(
        `SELECT count(*)::text AS n FROM ${APP_SCHEMA}.audit_event WHERE event_type = 'ACCESS_CODE_CREATED' AND summary->>'public_access_id' = $1`,
        [exp.access.id],
      ),
    ).toBe(2);
    expect(
      (await statusEvents(sellerA, exp.listing.id)).filter((e) => e.summary['from'] === 'EXPIRED'),
    ).toHaveLength(1);
  });

  it('lets another tenant neither cancel, expire, archive nor relist, and change nothing', async () => {
    const { listed } = await publishListing(runtime.db, sellerA);
    for (const attempt of [
      () => cancel(command(sellerB, 'cancel'), listed.listing.id, listed.listing.rowVersion),
      () => expire(command(sellerB, 'expire'), listed.listing.id, listed.listing.rowVersion),
      () => archive(command(sellerB, 'archive'), listed.listing.id, listed.listing.rowVersion),
      () => relist(command(sellerB, 'relist'), listed.listing.id, listed.listing.rowVersion, ORIGIN),
    ]) {
      await expect(attempt()).rejects.toBeInstanceOf(NotFoundError);
    }
    expect(await listingOf(sellerA, listed.listing.id)).toEqual(listed.listing);
    expect(await accessOf(sellerA, listed.access.id)).toEqual(listed.access);
    expect(await verify(sellerA, listed.access.publicId, plaintextOf(listed.code))).toBe(true);
    expect(
      await tenant(sellerB, (trx) =>
        audit.listAuditEventsForSubject(trx, sellerB, 'listing', listed.listing.id),
      ),
    ).toEqual([]);
  });

  it('relists from CANCELLED as a new listing on the same item (OPS-215), with a new public id, while the old surface stays closed', async () => {
    const { built, listed } = await publishListing(runtime.db, sellerA);
    const first = plaintextOf(listed.code);
    await expect(
      tenant(sellerA, (trx) =>
        listings.createListing(trx, command(sellerA, 'second-live'), {
          inventoryItemId: built.inventoryItemId,
        }),
      ),
    ).rejects.toMatchObject({ code: SQLSTATE.uniqueViolation });
    const cancelled = await cancel(command(sellerA, 'cancel'), listed.listing.id, listed.listing.rowVersion);
    expect(cancelled.listing.status).toBe('CANCELLED');

    const republished = await tenant(sellerA, async (trx) => {
      let listing = await listings.createListing(trx, command(sellerA, 'relist-create'), {
        inventoryItemId: built.inventoryItemId,
      });
      await content.recordFacts(trx, command(sellerA, 'facts'), {
        listingId: listing.id,
        facts: FIXTURE.facts,
      });
      const draft = await content.createSellerDraft(trx, command(sellerA, 'draft'), {
        listingId: listing.id,
        ...FIXTURE.copy,
        structuredDetails: { ...FIXTURE.facts },
      });
      listing = (
        await listings.approveContent(trx, command(sellerA, 'approve'), {
          listingId: listing.id,
          versionId: draft.id,
          expectedRowVersion: listing.rowVersion,
        })
      ).listing;
      listing = await listings.setAskingPrice(trx, command(sellerA, 'price'), {
        listingId: listing.id,
        price: FIXTURE.askingPrice,
        expectedRowVersion: listing.rowVersion,
      });
      listing = (
        await listings.setPolicy(trx, command(sellerA, 'policy'), {
          listingId: listing.id,
          expectedRowVersion: listing.rowVersion,
          policy: { ...FIXTURE.policy, minimumPrice: FIXTURE.minimumPrice },
        })
      ).listing;
      listing = await listings.markReady(trx, command(sellerA, 'ready'), {
        listingId: listing.id,
        expectedRowVersion: listing.rowVersion,
      });
      return listings.markListed(trx, command(sellerA, 'listed'), {
        listingId: listing.id,
        expectedRowVersion: listing.rowVersion,
        buyerOrigin: ORIGIN,
      });
    });
    expect(republished.listing.id).not.toBe(listed.listing.id);
    expect(republished.listing.inventoryItemId).toBe(built.inventoryItemId);
    expect(republished.access.publicId).not.toBe(listed.access.publicId);
    expect(republished.copyBlock?.buyerUrl).toBe(`${ORIGIN}/l/${republished.access.publicId}`);
    expect(await verify(sellerA, republished.access.publicId, plaintextOf(republished.code))).toBe(true);
    expect(await verify(sellerA, listed.access.publicId, first)).toBe(false);
    expect((await listingOf(sellerA, listed.listing.id)).status).toBe('CANCELLED');
    expect((await accessOf(sellerA, listed.access.id)).enabled).toBe(false);
    expect(
      await count(`SELECT count(*)::text AS n FROM ${APP_SCHEMA}.listing WHERE inventory_item_id = $1`, [
        built.inventoryItemId,
      ]),
    ).toBe(2);
  });
});
