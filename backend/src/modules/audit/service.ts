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
 * Keys that may never appear in an audit payload (OPS-783, OPS-569, SEC-040): protected seller
 * values, credentials, codes and free text that could carry personal data.
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

export async function findAuditEventByIdempotencyKey(
  trx: TenantTransaction,
  sellerId: string,
  idempotencyKey: string,
): Promise<AuditEventRecord | undefined> {
  const row = await trx
    .selectFrom('audit_event')
    .selectAll()
    .where('seller_id', '=', sellerId)
    .where('idempotency_key', '=', idempotencyKey)
    .executeTakeFirst();
  return row ? toRecord(row) : undefined;
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

export interface IdempotentOutcome<T> {
  value: T;
  /** True when the key had already been used and the stored outcome was returned (OPS-731). */
  replayed: boolean;
  event: AuditEventRecord;
}

export interface IdempotentAction<T> {
  eventType: AuditEventType;
  subjectType: string;
  /** Known before the action runs for updates; absent for creations. */
  subjectId?: string;
  /** Performs the effect and returns the value plus the audit details of the primary event. */
  run: () => Promise<{
    value: T;
    subjectId: string;
    policyVersionId?: string;
    summary?: Record<string, unknown>;
  }>;
  /** Reconstructs the value from the stored event when the key is replayed. */
  replay: (event: AuditEventRecord) => Promise<T>;
}

/**
 * Runs a consequential action exactly once per idempotency key (OPS-730 to OPS-732). The primary
 * audit event carries the key; a retry with the same key returns the original outcome and creates
 * no second effect; a key reused for a different event type or subject is an error.
 */
export async function runIdempotent<T>(
  trx: TenantTransaction,
  ctx: CommandContext,
  action: IdempotentAction<T>,
): Promise<IdempotentOutcome<T>> {
  const existing = await findAuditEventByIdempotencyKey(trx, ctx.sellerId, ctx.idempotencyKey);
  if (existing) {
    const sameSubject =
      existing.eventType === action.eventType &&
      existing.subjectType === action.subjectType &&
      (action.subjectId === undefined || existing.subjectId === action.subjectId);
    if (!sameSubject) throw new IdempotencyConflictError();
    return { value: await action.replay(existing), replayed: true, event: existing };
  }
  const outcome = await action.run();
  const event = await appendAuditEvent(trx, ctx.sellerId, {
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
  return { value: outcome.value, replayed: false, event };
}
