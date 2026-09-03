-- 0002_listing_asking_price_event.sql
--
-- Forward-only (OPS-513, OPS-514). Applied once by app_migrator after 0001.
--
-- Adds LISTING_ASKING_PRICE_CHANGED to the audit event catalogue (ai/POLICY_AND_AUTHORIZATION.md
-- §12, updated 2026-09-03 to complete OPS-780 and OPS-781): every successful change of a
-- listing's asking price or currency is a consequential action and writes an audit event in the
-- same transaction as the write (OPS-787). LISTING_STATUS_CHANGED already exists in 0001; the
-- 0001 comment that §12 "does not name" it predates the catalogue update and is left as history.
--
-- ALTER TYPE ... ADD VALUE is permitted inside a transaction on PostgreSQL 12 and later; the new
-- value is usable once this migration's transaction commits. Enum values are never removed.

ALTER TYPE app.audit_event_type ADD VALUE IF NOT EXISTS 'LISTING_ASKING_PRICE_CHANGED';
