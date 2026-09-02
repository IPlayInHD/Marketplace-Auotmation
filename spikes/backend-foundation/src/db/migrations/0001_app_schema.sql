-- 0001_app_schema.sql
-- Executed once, inside one transaction, by the migration/owner role (spike_migrator).
-- The runtime roles (spike_web, spike_worker) never run this file and never own anything it creates.
--
-- Tenant isolation model
--   * Every seller-owned table carries seller_id and has row-level security ENABLED and FORCED.
--     FORCE means the table owner is subject to the policies too, so ownership is never a bypass.
--   * The tenant context is the transaction-scoped setting app.seller_id, established with
--     set_config('app.seller_id', <uuid>, true). It disappears at COMMIT or ROLLBACK, so a pooled
--     connection carries nothing into its next transaction.
--   * app.current_seller_id() reads that setting. With no context it returns NULL, and a NULL
--     predicate admits no row: the policies fail closed. With a non-UUID value the cast raises
--     22P02, which also admits no row.

CREATE SCHEMA app;

CREATE FUNCTION app.current_seller_id() RETURNS uuid
LANGUAGE sql
STABLE
AS $fn$
  SELECT NULLIF(current_setting('app.seller_id', true), '')::uuid
$fn$;

-- Seller-owned listing. minimum_price_minor and internal_notes are seller-private (P3).
CREATE TABLE app.listings (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id           uuid        NOT NULL,
  title               text        NOT NULL,
  asking_price_minor  integer     NOT NULL CHECK (asking_price_minor >= 0),
  currency            char(3)     NOT NULL,
  minimum_price_minor integer     NOT NULL CHECK (minimum_price_minor >= 0),
  internal_notes      text        NOT NULL DEFAULT '',
  seller_display_name text        NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE app.listings ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.listings FORCE ROW LEVEL SECURITY;
CREATE POLICY listings_tenant_isolation ON app.listings
  USING (seller_id = app.current_seller_id())
  WITH CHECK (seller_id = app.current_seller_id());

-- Minimal domain record whose creation must be atomic with its job (proof 4).
CREATE TABLE app.demo_records (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id  uuid        NOT NULL,
  payload    text        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE app.demo_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.demo_records FORCE ROW LEVEL SECURITY;
CREATE POLICY demo_records_tenant_isolation ON app.demo_records
  USING (seller_id = app.current_seller_id())
  WITH CHECK (seller_id = app.current_seller_id());

-- Side-effect ledger for the idempotency proof (proof 6). The unique constraint on effect_key is
-- the database-enforced idempotency mechanism: a redelivered job cannot create a second effect.
CREATE TABLE app.side_effects (
  id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id  uuid        NOT NULL,
  effect_key text        NOT NULL,
  job_id     uuid        NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT side_effects_effect_key_unique UNIQUE (effect_key)
);
ALTER TABLE app.side_effects ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.side_effects FORCE ROW LEVEL SECURITY;
CREATE POLICY side_effects_tenant_isolation ON app.side_effects
  USING (seller_id = app.current_seller_id())
  WITH CHECK (seller_id = app.current_seller_id());

-- Runtime grants: the minimum each entry point needs for this spike. No DDL, no ownership.
GRANT USAGE ON SCHEMA app TO spike_web, spike_worker;
GRANT EXECUTE ON FUNCTION app.current_seller_id() TO spike_web, spike_worker;

-- web: reads and writes listings on behalf of an authenticated seller (UPDATE/DELETE are granted
-- so the cross-tenant update and delete proofs fail for the RLS reason, not for lack of privilege),
-- and creates demo records.
GRANT SELECT, INSERT, UPDATE, DELETE ON app.listings TO spike_web;
GRANT SELECT, INSERT ON app.demo_records TO spike_web;

-- worker: reads domain records it processes and appends side effects.
GRANT SELECT ON app.listings TO spike_worker;
GRANT SELECT ON app.demo_records TO spike_worker;
GRANT SELECT, INSERT ON app.side_effects TO spike_worker;
