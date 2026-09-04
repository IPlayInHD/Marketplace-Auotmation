-- 0003_idempotency_receipt.sql
--
-- Forward-only (OPS-513, OPS-514). Applied once by app_migrator after 0002.
--
-- The idempotency store (OPS-730 to OPS-733). Until now the primary audit event doubled as the
-- store: a key was found through its event row. A consequential command that changed nothing
-- (an asking price resubmitted unchanged) wrote no event, so its key was never consumed and a
-- later retry could take a different path once the listing had moved on. A receipt is now
-- written for every successful command, whether or not it changed domain state, and holds:
--   * the command name and a SHA-256 fingerprint of its payload, never the payload itself
--     (OPS-732: a key reused with a different command or payload is a conflict, not a replay);
--   * the outcome returned to the caller, so a retry returns exactly it (OPS-731) whatever the
--     listing looks like by then;
--   * the primary audit event, when the command changed state. A no-op has none.
-- The outcome never carries a protected value: the application applies the audit-payload key
-- guard to it before the insert (OPS-569, OPS-783, AUTH-INV-08).
--
-- Retention (OPS-733): receipts are append-only and no role of this slice may delete them, so
-- they outlive any client retry horizon. A configured horizon and a retention job are not part
-- of this slice.

CREATE TABLE app.idempotency_receipt (
  seller_id        uuid         NOT NULL REFERENCES app.seller (id),
  idempotency_key  text         NOT NULL,
  command          text         NOT NULL CHECK (command ~ '^[a-z][a-z0-9_.]{0,63}$'),
  fingerprint      text         NOT NULL CHECK (fingerprint ~ '^[0-9a-f]{64}$'),
  subject_type     text         NOT NULL CHECK (subject_type ~ '^[a-z][a-z_]{0,63}$'),
  subject_id       uuid         NOT NULL,
  outcome          jsonb        NOT NULL CHECK (jsonb_typeof(outcome) = 'object'),
  audit_event_id   uuid         REFERENCES app.audit_event (id),
  request_id       text         NOT NULL,
  created_at       timestamptz  NOT NULL DEFAULT now(),
  -- OPS-730 to OPS-732: one receipt per key per seller. The key is consumed by the insert.
  CONSTRAINT idempotency_receipt_pkey PRIMARY KEY (seller_id, idempotency_key)
);
ALTER TABLE app.idempotency_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.idempotency_receipt FORCE ROW LEVEL SECURITY;
CREATE POLICY idempotency_receipt_tenant_isolation ON app.idempotency_receipt
  USING (seller_id = app.current_seller_id())
  WITH CHECK (seller_id = app.current_seller_id());
CREATE TRIGGER idempotency_receipt_append_only BEFORE UPDATE OR DELETE ON app.idempotency_receipt
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();

GRANT SELECT, INSERT ON app.idempotency_receipt TO app_runtime;
