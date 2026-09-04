import { randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { SQLSTATE } from '../../db/constants.ts';
import type { TenantTransaction } from '../../db/kysely.ts';
import { ACCESS_CODE_STATUSES, type AccessCodeStatus } from '../../db/schema.ts';
import type { CommandContext, WriteContext } from '../../shared/command.ts';
import {
  ConcurrentModificationError,
  InvalidStateError,
  mapDatabaseError,
  ValidationError,
} from '../../shared/errors.ts';
import * as audit from '../audit/index.ts';
import * as publicAccess from '../public-listing-access/index.ts';

// Module 7 — Access Codes (ARCH §3): issue, hash, verify, rotate, revoke (SM-C-01 to SM-C-03,
// OPS-710, OPS-737). The code is public by design (D-03) and is still never persisted, logged,
// audited or returned a second time (ACCESS-013, DATA-106, SEC-040, OPS-566): the plaintext exists
// only in the return value of the command that issued it. No error raised here carries a code.

export const ACCESS_CODE_LENGTH = 6;
const ACCESS_CODE_SPACE = 10 ** ACCESS_CODE_LENGTH;
const ACCESS_CODE_PATTERN = /^[0-9]{6}$/;

/** BUYER-008: six numeric digits, leading zeros kept. randomInt draws from the CSPRNG without modulo bias. */
export function generateAccessCode(): string {
  return String(randomInt(0, ACCESS_CODE_SPACE)).padStart(ACCESS_CODE_LENGTH, '0');
}

export function isWellFormedAccessCode(value: unknown): value is string {
  return typeof value === 'string' && ACCESS_CODE_PATTERN.test(value);
}

/**
 * OPS-710: a salted hash from a slow key-derivation function. scrypt (RFC 7914) ships with Node.js,
 * so no dependency is added (SEC-381); the parameters travel with the hash so they can be raised
 * later without touching stored rows. There is no pepper: a hard-coded secret would be a
 * credential in source (OPS-729), and the code is public by design anyway (D-03).
 */
export const SCRYPT_PARAMS = { ln: 14, r: 8, p: 1, keyLength: 32, saltLength: 16 } as const;
const PHC_PATTERN =
  /^\$scrypt\$ln=(\d{1,2}),r=(\d{1,3}),p=(\d{1,3})\$([A-Za-z0-9+/]+={0,2})\$([A-Za-z0-9+/]+={0,2})$/;

interface KdfParams {
  ln: number;
  r: number;
  p: number;
  keyLength: number;
}

function derive(code: string, salt: Buffer, params: KdfParams): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(
      code,
      salt,
      params.keyLength,
      { N: 2 ** params.ln, r: params.r, p: params.p, maxmem: 128 * 1024 * 1024 },
      (err, key) => {
        if (err) reject(err);
        else resolve(key);
      },
    );
  });
}

/** Hashes a well-formed code with a fresh salt. Two hashes of one code differ. */
export async function hashAccessCode(code: string): Promise<string> {
  if (!isWellFormedAccessCode(code)) throw new ValidationError('access code must be six digits');
  const salt = randomBytes(SCRYPT_PARAMS.saltLength);
  const key = await derive(code, salt, SCRYPT_PARAMS);
  return `$scrypt$ln=${SCRYPT_PARAMS.ln},r=${SCRYPT_PARAMS.r},p=${SCRYPT_PARAMS.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

/**
 * Compares a candidate with a stored hash in constant time. A malformed candidate or hash still
 * costs one derivation and answers false, so a miss is indistinguishable by timing (SEC-134).
 */
export async function verifyAccessCodeHash(candidate: unknown, stored: string): Promise<boolean> {
  const match = PHC_PATTERN.exec(stored);
  if (!match || !isWellFormedAccessCode(candidate)) {
    await derive('000000', randomBytes(SCRYPT_PARAMS.saltLength), SCRYPT_PARAMS);
    return false;
  }
  const expected = Buffer.from(match[5] ?? '', 'base64');
  const actual = await derive(candidate, Buffer.from(match[4] ?? '', 'base64'), {
    ln: Number(match[1]),
    r: Number(match[2]),
    p: Number(match[3]),
    keyLength: expected.length,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

let dummy: Promise<string> | undefined;
/** A hash of a code nobody holds, so a lookup miss costs the same derivation as a comparison. */
function dummyHash(): Promise<string> {
  dummy ??= hashAccessCode(generateAccessCode());
  return dummy;
}

export interface AccessCodeRecord {
  id: string;
  sellerId: string;
  publicAccessId: string;
  versionNumber: number;
  status: AccessCodeStatus;
  issuedAt: Date;
  expiresAt: Date | null;
  statusChangedAt: Date;
}

/** A code as issued. The plaintext is present only in the return value of the issuing command. */
export interface IssuedAccessCode extends AccessCodeRecord {
  /** Null on replay: the code is shown once and is thereafter obtainable only by rotation (ACCESS-013, DATA-106). */
  plaintextCode: string | null;
}

interface CodeRow {
  id: string;
  seller_id: string;
  public_access_id: string;
  version_number: number;
  status: AccessCodeStatus;
  code_hash: string;
  issued_at: Date;
  expires_at: Date | null;
  status_changed_at: Date;
  request_id: string;
}

/** The record never carries the hash out of this module. */
function toCode(row: CodeRow): AccessCodeRecord {
  return {
    id: row.id,
    sellerId: row.seller_id,
    publicAccessId: row.public_access_id,
    versionNumber: row.version_number,
    status: row.status,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    statusChangedAt: row.status_changed_at,
  };
}

const StoredAccessCode = z.object({
  id: z.uuid(),
  sellerId: z.uuid(),
  publicAccessId: z.uuid(),
  versionNumber: z.number().int(),
  status: z.enum(ACCESS_CODE_STATUSES),
  issuedAt: z.coerce.date(),
  expiresAt: z.coerce.date().nullable(),
  statusChangedAt: z.coerce.date(),
});

/** The receipt form of a code: named fields only, so a plaintext can never ride along (OPS-731, DATA-106). */
export function storeAccessCode(code: AccessCodeRecord): Record<string, unknown> {
  return {
    id: code.id,
    sellerId: code.sellerId,
    publicAccessId: code.publicAccessId,
    versionNumber: code.versionNumber,
    status: code.status,
    issuedAt: code.issuedAt,
    expiresAt: code.expiresAt,
    statusChangedAt: code.statusChangedAt,
  };
}

export function reviveAccessCode(stored: unknown): AccessCodeRecord {
  return StoredAccessCode.parse(stored);
}

export function reviveIssuedAccessCode(stored: unknown): IssuedAccessCode {
  return { ...reviveAccessCode(stored), plaintextCode: null };
}

export async function listAccessCodes(trx: TenantTransaction, accessId: string): Promise<AccessCodeRecord[]> {
  const rows = await trx
    .selectFrom('listing_access_code')
    .selectAll()
    .where('public_access_id', '=', accessId)
    .orderBy('version_number', 'asc')
    .execute();
  return rows.map(toCode);
}

async function findActiveRow(trx: TenantTransaction, accessId: string): Promise<CodeRow | undefined> {
  return trx
    .selectFrom('listing_access_code')
    .selectAll()
    .where('public_access_id', '=', accessId)
    .where('status', '=', 'ACTIVE')
    .executeTakeFirst();
}

export async function findActiveAccessCode(
  trx: TenantTransaction,
  accessId: string,
): Promise<AccessCodeRecord | undefined> {
  const row = await findActiveRow(trx, accessId);
  return row ? toCode(row) : undefined;
}

export async function nextVersionNumber(trx: TenantTransaction, accessId: string): Promise<number> {
  const row = await trx
    .selectFrom('listing_access_code')
    .select(({ fn }) => fn.max('version_number').as('max'))
    .where('public_access_id', '=', accessId)
    .executeTakeFirst();
  return (row?.max ?? 0) + 1;
}

/**
 * Inserts one ACTIVE code and returns it with its plaintext. Not a command: the caller's command
 * owns the audit event and the idempotency key. A second ACTIVE code is refused by the data layer
 * (SM-C-01) and reported as an invalid state.
 */
export async function issueCode(
  trx: TenantTransaction,
  ctx: WriteContext,
  input: { access: publicAccess.PublicAccessRecord; versionNumber: number; expiresAt?: Date },
): Promise<IssuedAccessCode> {
  const plaintextCode = generateAccessCode();
  const codeHash = await hashAccessCode(plaintextCode);
  let row: CodeRow;
  try {
    row = await trx
      .insertInto('listing_access_code')
      .values({
        seller_id: ctx.sellerId,
        public_access_id: input.access.id,
        version_number: input.versionNumber,
        code_hash: codeHash,
        expires_at: input.expiresAt ?? null,
        request_id: ctx.requestId,
      })
      .returningAll()
      .executeTakeFirstOrThrow();
  } catch (err) {
    const mapped = mapDatabaseError(err, 'access_code');
    if ((mapped as { code?: unknown }).code === SQLSTATE.uniqueViolation) {
      throw new InvalidStateError('access_code', 'ACTIVE', 'be issued while one is active (SM-C-01)');
    }
    throw mapped;
  }
  return { ...toCode(row), plaintextCode };
}

/** ACTIVE → ROTATED or REVOKED, applied only if the row is still ACTIVE (OPS-737). */
async function leaveActive(
  trx: TenantTransaction,
  ctx: WriteContext,
  code: AccessCodeRecord,
  to: 'ROTATED' | 'REVOKED',
): Promise<AccessCodeRecord> {
  let row: CodeRow | undefined;
  try {
    row = await trx
      .updateTable('listing_access_code')
      .set({ status: to, request_id: ctx.requestId })
      .where('id', '=', code.id)
      .where('status', '=', 'ACTIVE')
      .returningAll()
      .executeTakeFirst();
  } catch (err) {
    throw mapDatabaseError(err, 'access_code');
  }
  if (!row) throw new ConcurrentModificationError('access_code');
  return toCode(row);
}

/** The policy version in force for the listing behind an access (OPS-784). Reads the pointer, never the policy. */
async function policyVersionInForce(trx: TenantTransaction, listingId: string): Promise<string | undefined> {
  const row = await trx
    .selectFrom('listing')
    .select('current_policy_version_id')
    .where('id', '=', listingId)
    .executeTakeFirst();
  return row?.current_policy_version_id ?? undefined;
}

export interface RotateAccessCodeResult {
  access: publicAccess.PublicAccessRecord;
  rotated: AccessCodeRecord;
  issued: IssuedAccessCode;
}

/**
 * ACCESS-101, SM-C-02, OPS-737: in one transaction the ACTIVE code becomes ROTATED and a new
 * ACTIVE code is issued; the public id is unchanged (BUYER-003). Audited as ACCESS_CODE_ROTATED
 * under the seller's key. The access-row update takes the row lock and asserts the caller's
 * version first, so concurrent rotations serialise and the loser sees a version mismatch.
 */
export async function rotateAccessCode(
  trx: TenantTransaction,
  ctx: CommandContext,
  input: { accessId: string; expectedRowVersion: number },
): Promise<RotateAccessCodeResult> {
  const outcome = await audit.runIdempotent<RotateAccessCodeResult>(trx, ctx, {
    command: 'access_code.rotate',
    payload: input,
    eventType: 'ACCESS_CODE_ROTATED',
    subjectType: 'listing_access_code',
    run: async () => {
      const access = await publicAccess.updatePublicAccess(
        trx,
        ctx,
        input.accessId,
        input.expectedRowVersion,
        {},
      );
      const active = await findActiveAccessCode(trx, access.id);
      if (!active) throw new InvalidStateError('access_code', 'none', 'be rotated; issue a code first');
      const rotated = await leaveActive(trx, ctx, active, 'ROTATED');
      const issued = await issueCode(trx, ctx, {
        access,
        versionNumber: await nextVersionNumber(trx, access.id),
      });
      const policyVersionId = await policyVersionInForce(trx, access.listingId);
      return {
        value: { access, rotated, issued },
        subjectId: issued.id,
        ...(policyVersionId !== undefined ? { policyVersionId } : {}),
        summary: {
          public_access_id: access.id,
          listing_id: access.listingId,
          from_version_number: rotated.versionNumber,
          to_version_number: issued.versionNumber,
        },
      };
    },
    serialize: ({ access, rotated, issued }) => ({
      access,
      rotated: storeAccessCode(rotated),
      issued: storeAccessCode(issued),
    }),
    revive: (stored) => ({
      access: publicAccess.revivePublicAccess(stored['access']),
      rotated: reviveAccessCode(stored['rotated']),
      issued: reviveIssuedAccessCode(stored['issued']),
    }),
  });
  return outcome.value;
}

export interface RevokeAccessCodeResult {
  access: publicAccess.PublicAccessRecord;
  revoked: AccessCodeRecord;
}

/**
 * ACCESS-102, ACCESS-011: the ACTIVE code becomes REVOKED and the surface is disabled, so no new
 * buyer can start; the seller issues a new code to reopen it. Audited as ACCESS_CODE_REVOKED.
 * Buyer sessions do not exist in this slice, so the preserve-or-terminate choice is not here.
 */
export async function revokeAccessCode(
  trx: TenantTransaction,
  ctx: CommandContext,
  input: { accessId: string; expectedRowVersion: number },
): Promise<RevokeAccessCodeResult> {
  const outcome = await audit.runIdempotent<RevokeAccessCodeResult>(trx, ctx, {
    command: 'access_code.revoke',
    payload: input,
    eventType: 'ACCESS_CODE_REVOKED',
    subjectType: 'listing_access_code',
    run: async () => {
      const access = await publicAccess.updatePublicAccess(
        trx,
        ctx,
        input.accessId,
        input.expectedRowVersion,
        {
          enabled: false,
        },
      );
      const active = await findActiveAccessCode(trx, access.id);
      if (!active) throw new InvalidStateError('access_code', 'none', 'be revoked');
      const revoked = await leaveActive(trx, ctx, active, 'REVOKED');
      const policyVersionId = await policyVersionInForce(trx, access.listingId);
      return {
        value: { access, revoked },
        subjectId: revoked.id,
        ...(policyVersionId !== undefined ? { policyVersionId } : {}),
        summary: {
          public_access_id: access.id,
          listing_id: access.listingId,
          version_number: revoked.versionNumber,
          surface_enabled: false,
        },
      };
    },
    serialize: ({ access, revoked }) => ({ access, revoked: storeAccessCode(revoked) }),
    revive: (stored) => ({
      access: publicAccess.revivePublicAccess(stored['access']),
      revoked: reviveAccessCode(stored['revoked']),
    }),
  });
  return outcome.value;
}

export interface IssueAccessCodeResult {
  access: publicAccess.PublicAccessRecord;
  issued: IssuedAccessCode;
}

/**
 * Issues a code for an access that has none ACTIVE, reopening the surface after a revocation.
 * The initial code of a listing is issued by the LISTED transition (SM-L-02), not here.
 * Audited as ACCESS_CODE_CREATED.
 */
export async function issueAccessCode(
  trx: TenantTransaction,
  ctx: CommandContext,
  input: { accessId: string; expectedRowVersion: number },
): Promise<IssueAccessCodeResult> {
  const outcome = await audit.runIdempotent<IssueAccessCodeResult>(trx, ctx, {
    command: 'access_code.issue',
    payload: input,
    eventType: 'ACCESS_CODE_CREATED',
    subjectType: 'listing_access_code',
    run: async () => {
      const access = await publicAccess.updatePublicAccess(
        trx,
        ctx,
        input.accessId,
        input.expectedRowVersion,
        {
          enabled: true,
        },
      );
      if (await findActiveAccessCode(trx, access.id)) {
        throw new InvalidStateError(
          'access_code',
          'ACTIVE',
          'be issued while one is active; rotate instead (SM-C-01)',
        );
      }
      const issued = await issueCode(trx, ctx, {
        access,
        versionNumber: await nextVersionNumber(trx, access.id),
      });
      const policyVersionId = await policyVersionInForce(trx, access.listingId);
      return {
        value: { access, issued },
        subjectId: issued.id,
        ...(policyVersionId !== undefined ? { policyVersionId } : {}),
        summary: {
          public_access_id: access.id,
          listing_id: access.listingId,
          version_number: issued.versionNumber,
        },
      };
    },
    serialize: ({ access, issued }) => ({ access, issued: storeAccessCode(issued) }),
    revive: (stored) => ({
      access: publicAccess.revivePublicAccess(stored['access']),
      issued: reviveIssuedAccessCode(stored['issued']),
    }),
  });
  return outcome.value;
}

/**
 * Internal verification (SM-C-03): true only for the ACTIVE, unexpired code of an enabled access
 * that the current tenant owns. Every other case, an unknown public id included, costs one key
 * derivation and answers false, with nothing to tell them apart. Creates no session and grants
 * nothing (BUYER-018). The buyer gate, its rate limits and lockouts are not part of this slice.
 */
export async function verifyAccessCode(
  trx: TenantTransaction,
  input: { publicId: string; candidate: unknown },
): Promise<boolean> {
  const access = await publicAccess.findPublicAccessByPublicId(trx, input.publicId);
  const active = access?.enabled ? await findActiveRow(trx, access.id) : undefined;
  const usable =
    active !== undefined && (active.expires_at === null || active.expires_at.getTime() > Date.now());
  if (!usable) {
    await verifyAccessCodeHash(input.candidate, await dummyHash());
    return false;
  }
  return verifyAccessCodeHash(input.candidate, active.code_hash);
}
