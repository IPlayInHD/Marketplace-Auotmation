// Module 19 — Audit & Events (ARCH §3). Owns app.audit_event and the idempotency store
// app.idempotency_receipt. Both append-only; neither stores a secret or a protected value.
export {
  appendAuditEvent,
  assertAuditSummaryIsSafe,
  canonicalJson,
  findIdempotencyReceipt,
  fingerprintCommand,
  listAuditEventsForSubject,
  runIdempotent,
  type AuditEventInput,
  type AuditEventRecord,
  type IdempotencyReceiptRecord,
  type IdempotentAction,
  type IdempotentOutcome,
} from './service.ts';
