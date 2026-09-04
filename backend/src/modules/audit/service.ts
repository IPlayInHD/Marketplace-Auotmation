import { createHash } from 'node:crypto';
import type { TenantTransaction } from '../../db/kysely.ts';
import type { AuditActorType, AuditEventType } from '../../db/schema.ts';
import type { CommandContext } from '../../shared/command.ts';
import { IdempotencyConflictError, ValidationError } from '../../shared/errors.ts';

export interface AuditEventInput {
  eventType: AuditEventType;
  actorType: AuditActorType;
  /** A seller id or a buyer-session reference. Never a name, a token or a code. */
  actorRef?: string;
  subjectType: string;
  subjectId: string;
  policyVersionId?: string;
  requestId: string;
  idempotencyKey?: string;
  summary?: Record<string, unknown>;
}

export interface AuditEventRecord {
  id: string;
  sellerId: string;
  eventType: AuditEventType;
  actorType: AuditActorType;
  actorRef: string | null;
  subjectType: string;
  subjectId: string;
  policyVersionId: string | null;
  requestId: string;
  idempotencyKey: string | null;
  summary: Record<string, unknown>;
  createdAt: Date;
}

/**
 * Keys that may never appear in an audit payload or in a stored idempotency outcome (OPS-783,
 * OPS-569, SEC-040): protected seller values, credentials, codes and free text that could carry
 * personal data.
 */
const FORBIDDEN_SUMMARY_KEY =
  /(minimum|target|concession|auto_decline|threshold|password|token|secret|code|cookie|email|phone|address|note|transcript|prompt|completion|message_body)/i;

export function assertAuditSummaryIsSafe(summary: Record<string, unknown>, path = ''): void {
  for (const [key, value] of Object.entries(summary)) {
    const here = path ? `${path}.${key}` : key;
    if (FORBIDDEN_SUMMARY_KEY.test(key)) {
      throw new ValidationError('audit summary carries a forbidden key', [here]);
    }
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      assertAuditSummaryIsSafe(value as Record<string, unknown>, here);
    }
  }
}

function toRecord(row: {
  id: string;
  seller_id: string;
  event_type: AuditEventType;
  actor_type: AuditActorType;
  actor_ref: string | null;
  subject_type: string;
  subject_id: string;
  policy_version_id: string | null;
  request_id: string;
  idempotency_key: string | null;
  summary: Record<string, unknown>;
  created_at: Date;
}): AuditEventRecord {
  return {
    id: row.id,
    sellerId: row.seller_id,
    eventType: row.event_type,
    actorType: row.actor_type,
    actorRef: row.actor_ref,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    policyVersionId: row.policy_version_id,
    requestId: row.request_id,
    idempotencyKey: row.idempotency_key,
    summary: row.summary,
    createdAt: row.created_at,
  };
}

/** Appends one audit event for the tenant of the transaction. Fails the transaction on any error (OPS-787). */
export async function appendAuditEvent(
  trx: TenantTransaction,
  sellerId: string,
  input: AuditEventInput,
): Promise<AuditEventRecord> {
  const summary = input.summary ?? {};
  assertAuditSummaryIsSafe(summary);
  const row = await trx
    .insertInto('audit_event')
    .values({
      seller_id: sellerId,
      event_type: input.eventType,
      actor_type: input.actorType,
      actor_ref: input.actorRef ?? null,
      subject_type: input.subjectType,
      subject_id: input.subjectId,
      policy_version_id: input.policyVersionId ?? null,
      request_id: input.requestId,
      idempotency_key: input.idempotencyKey ?? null,
      summary: JSON.stringify(summary),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return toRecord(row);
}

export async function listAuditEventsForSubject(
  trx: TenantTransaction,
  sellerId: string,
  subjectType: string,
  subjectId: string,
): Promise<AuditEventRecord[]> {
  const rows = await trx
    .selectFrom('audit_event')
    .selectAll()
    .where('seller_id', '=', sellerId)
    .where('subject_type', '=', subjectType)
    .where('subject_id', '=', subjectId)
    .orderBy('seq', 'asc')
    .execute();
  return rows.map(toRecord);
}

// ---------------------------------------------------------------------------------------------
// Idempotency store (OPS-730 to OPS-733): app.idempotency_receipt, migration 0003
// ---------------------------------------------------------------------------------------------

export interface IdempotencyReceiptRecord {
  sellerId: string;
  idempotencyKey: string;
  command: string;
  fingerprint: string;
  subjectType: string;
  subjectId: string;
  /** The outcome as returned to the caller, in its stored (JSON) form. Never a protected value. */
  outcome: Record<string, unknown>;
  /** The primary audit event, or null when the command was a valid no-op. */
  auditEventId: string | null;
  requestId: string;
  createdAt: Date;
}

function compareKeys(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => compareKeys(a, b))
        .map(([k, v]) => [k, sortKeys(v)]),
    );
  }
  return value;
}

/**
 * Canonical JSON: keys sorted at every depth, dates as ISO strings, undefined dropped. Two payloads
 * that mean the same thing serialise identically; any difference in a value serialises differently.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

/**
 * The identity of a command for OPS-732: its name and its payload, hashed. Only the hash is stored,
 * so a receipt never carries the payload itself (a policy payload holds the minimum price).
 */
export function fingerprintCommand(command: string, payload: unknown): string {
  return createHash('sha256').update(canonicalJson({ command, payload })).digest('hex');
}

function toReceipt(row: {
  seller_id: string;
  idempotency_key: string;
  command: string;
  fingerprint: string;
  subject_type: string;
  subject_id: string;
  outcome: Record<string, unknown>;
  audit_event_id: string | null;
  request_id: string;
  created_at: Date;
}): IdempotencyReceiptRecord {
  return {
    sellerId: row.seller_id,
    idempotencyKey: row.idempotency_key,
    command: row.command,
    fingerprint: row.fingerprint,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    outcome: row.outcome,
    auditEventId: row.audit_event_id,
    requestId: row.request_id,
    createdAt: row.created_at,
  };
}

/** The receipt stored under a key for the tenant of the transaction, if the key was consumed. */
export async function findIdempotencyReceipt(
  trx: TenantTransaction,
  sellerId: string,
  idempotencyKey: string,
): Promise<IdempotencyReceiptRecord | undefined> {
  const row = await trx
    .selectFrom('idempotency_receipt')
    .selectAll()
    .where('seller_id', '=', sellerId)
    .where('idempotency_key', '=', idempotencyKey)
    .executeTakeFirst();
  return row ? toReceipt(row) : undefined;
}

interface ReceiptInput {
  command: string;
  fingerprint: string;
  subjectType: string;
  subjectId: string;
  outcome: Record<string, unknown>;
  auditEventId: string | null;
}

/** Consumes the key: the insert fails the transaction if the key was used concurrently (OPS-731). */
async function storeIdempotencyReceipt(
  trx: TenantTransaction,
  ctx: CommandContext,
  input: ReceiptInput,
): Promise<IdempotencyReceiptRecord> {
  assertAuditSummaryIsSafe(input.outcome);
  const row = await trx
    .insertInto('idempotency_receipt')
    .values({
      seller_id: ctx.sellerId,
      idempotency_key: ctx.idempotencyKey,
      command: input.command,
      fingerprint: input.fingerprint,
      subject_type: input.subjectType,
      subject_id: input.subjectId,
      outcome: JSON.stringify(input.outcome),
      audit_event_id: input.auditEventId,
      request_id: ctx.requestId,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  return toReceipt(row);
}

export interface IdempotentOutcome<T> {
  value: T;
  /** True when the key had already been consumed and the stored outcome was returned (OPS-731). */
  replayed: boolean;
  receipt: IdempotencyReceiptRecord;
}

export interface IdempotentAction<T> {
  /** The command's name, e.g. `listing.set_asking_price`. With the payload it identifies the command. */
  command: string;
  /** The validated command payload. Fingerprinted (OPS-732), never stored. */
  payload: unknown;
  eventType: AuditEventType;
  subjectType: string;
  /**
   * Validates current state, performs the effect and returns the value plus the audit details of
   * the primary event. `changed: false` declares a valid no-op: domain state is untouched and no
   * event is written, but the receipt still is.
   */
  run: () => Promise<{
    value: T;
    subjectId: string;
    policyVersionId?: string;
    summary?: Record<string, unknown>;
    changed?: boolean;
  }>;
  /** The outcome as stored in the receipt. Subject to the forbidden-key guard; never a protected value. */
  serialize: (value: T) => Record<string, unknown>;
  /** The outcome as returned on a replay, rebuilt from what `serialize` stored. */
  revive: (stored: Record<string, unknown>) => Promise<T> | T;
}

/**
 * Runs a consequential command exactly once per idempotency key (OPS-730 to OPS-732).
 *
 * The receipt lookup is the first read. A stored outcome is returned before any current-state
 * validation runs, so a retry never fails a check its original passed and never re-runs the
 * mutation, however the subject has changed since (OPS-731). A key found under a different
 * command or payload is a conflict (OPS-732). Otherwise the command runs, the primary audit event
 * is appended when state changed, and the receipt is written, all in the caller's transaction:
 * a failure anywhere leaves no effect, no event and no receipt (OPS-787).
 */
export async function runIdempotent<T>(
  trx: TenantTransaction,
  ctx: CommandContext,
  action: IdempotentAction<T>,
): Promise<IdempotentOutcome<T>> {
  const fingerprint = fingerprintCommand(action.command, action.payload);
  const existing = await findIdempotencyReceipt(trx, ctx.sellerId, ctx.idempotencyKey);
  if (existing) {
    if (existing.fingerprint !== fingerprint) throw new IdempotencyConflictError();
    return { value: await action.revive(existing.outcome), replayed: true, receipt: existing };
  }
  const outcome = await action.run();
  const event =
    outcome.changed === false
      ? null
      : await appendAuditEvent(trx, ctx.sellerId, {
          eventType: action.eventType,
          actorType: 'SELLER',
          actorRef: ctx.sellerId,
          subjectType: action.subjectType,
          subjectId: outcome.subjectId,
          ...(outcome.policyVersionId !== undefined ? { policyVersionId: outcome.policyVersionId } : {}),
          requestId: ctx.requestId,
          idempotencyKey: ctx.idempotencyKey,
          ...(outcome.summary !== undefined ? { summary: outcome.summary } : {}),
        });
  const receipt = await storeIdempotencyReceipt(trx, ctx, {
    command: action.command,
    fingerprint,
    subjectType: action.subjectType,
    subjectId: outcome.subjectId,
    outcome: action.serialize(outcome.value),
    auditEventId: event?.id ?? null,
  });
  return { value: outcome.value, replayed: false, receipt };
}
