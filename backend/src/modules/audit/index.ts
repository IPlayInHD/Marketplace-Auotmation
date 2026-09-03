// Module 19 — Audit & Events (ARCH §3). Owns app.audit_event. Append-only; stores no secret.
export {
  appendAuditEvent,
  assertAuditSummaryIsSafe,
  findAuditEventByIdempotencyKey,
  listAuditEventsForSubject,
  runIdempotent,
  type AuditEventInput,
  type AuditEventRecord,
  type IdempotentOutcome,
} from './service.ts';
