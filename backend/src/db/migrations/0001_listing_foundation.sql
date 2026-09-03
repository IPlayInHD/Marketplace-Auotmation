-- 0001_listing_foundation.sql
--
-- Forward-only (OPS-513, OPS-514, OPS-714). Applied once, inside one transaction, by the
-- migration/owner role `app_migrator`. The runtime role `app_runtime` never runs this file and
-- never owns anything it creates (OPS-716, D-17).
--
-- Scope: the Slice 1a listing-domain foundation authorised by D-18. Entities follow
-- architecture/DOMAIN_MODEL.md; lifecycles follow architecture/STATE_MACHINES.md §1 and §8;
-- requirement ids (OPS-7xx, SEC-1xx, DM-xx, SM-xx) are cited where a constraint enforces them.
--
-- Tenant isolation (SEC-100, SEC-101)
--   * Every seller-owned table carries seller_id and has row-level security ENABLED and FORCED,
--     so the owner is subject to the policies too.
--   * The tenant context is the transaction-scoped setting app.seller_id, established with
--     set_config('app.seller_id', <uuid>, true). It disappears at COMMIT or ROLLBACK, so a pooled
--     connection carries nothing into its next transaction.
--   * app.current_seller_id() reads that setting. With no context it returns NULL and admits no
--     row (fail closed). With a non-UUID value the cast raises 22P02, which also admits no row.
--
-- Money (DM-07, OPS-703): integer minor units in `app.minor_units` with an explicit ISO 4217 code
-- in `app.currency_code`. No float, numeric or decimal money column exists.

CREATE SCHEMA app;

CREATE FUNCTION app.current_seller_id() RETURNS uuid
LANGUAGE sql
STABLE
AS $fn$
  SELECT NULLIF(current_setting('app.seller_id', true), '')::uuid
$fn$;

-- ---------------------------------------------------------------------------------------------
-- Value types
-- ---------------------------------------------------------------------------------------------

CREATE DOMAIN app.currency_code AS char(3) CHECK (VALUE ~ '^[A-Z]{3}$');
CREATE DOMAIN app.minor_units AS bigint CHECK (VALUE >= 0);

-- Canonical status names. Adding a value is a forward migration.
CREATE TYPE app.listing_status AS ENUM (
  'DRAFT', 'READY', 'LISTED', 'ACTIVE_CONVERSATIONS', 'OFFER_PENDING', 'PENDING_SALE',
  'SOLD', 'CANCELLED', 'ARCHIVED', 'EXPIRED'
);
CREATE TYPE app.content_provenance AS ENUM ('SELLER_PROVIDED_FACT', 'AI_ENHANCED_COPY', 'SELLER_APPROVED_COPY');
CREATE TYPE app.content_version_status AS ENUM (
  'SELLER_DRAFT', 'ENHANCEMENT_PENDING', 'ENHANCED', 'ENHANCEMENT_FAILED', 'SELLER_EDITED', 'APPROVED', 'SUPERSEDED'
);
-- D-14: location disclosure is a policy setting with an area-level maximum.
CREATE TYPE app.location_disclosure_mode AS ENUM ('NONE', 'AREA');
CREATE TYPE app.audit_actor_type AS ENUM ('SELLER', 'BUYER_SESSION', 'SYSTEM', 'MODEL');
CREATE TYPE app.audit_event_type AS ENUM (
  -- ai/POLICY_AND_AUTHORIZATION.md §12, in order.
  'LISTING_CREATED', 'LISTING_CONTENT_ENHANCED', 'LISTING_CONTENT_APPROVED', 'SELLER_POLICY_CHANGED',
  'MINIMUM_PRICE_CHANGED', 'ACCESS_CODE_CREATED', 'ACCESS_CODE_ROTATED', 'ACCESS_CODE_REVOKED',
  'BUYER_SESSION_CREATED', 'OFFER_CREATED', 'OFFER_CHANGED', 'COUNTEROFFER_SENT', 'SELLER_ACTION_REQUIRED',
  'SELLER_APPROVED', 'SELLER_DECLINED', 'SELLER_COUNTERED', 'APPROVAL_INVALIDATED',
  'BUYER_ACCEPTANCE_COMMUNICATED', 'DEAL_PENDING', 'DEAL_CANCELLED', 'LISTING_SOLD', 'GUARDRAIL_DENIED',
  'ESCALATED_TO_SELLER',
  -- A listing lifecycle transition (STATE_MACHINES §1) is a consequential action (OPS-780) and is
  -- recorded under this type with the from/to statuses in the summary.
  'LISTING_STATUS_CHANGED'
);

-- ---------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------

-- Seller: the tenant boundary (DM-01). Identity and authentication are out of scope here (Q-12);
-- in the private alpha every row is a synthetic, founder-controlled identity (D-18).
CREATE TABLE app.seller (
  id            uuid        PRIMARY KEY,
  display_name  text        NOT NULL CHECK (length(btrim(display_name)) BETWEEN 1 AND 80),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE app.seller ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.seller FORCE ROW LEVEL SECURITY;
CREATE POLICY seller_tenant_isolation ON app.seller
  USING (id = app.current_seller_id())
  WITH CHECK (id = app.current_seller_id());

-- InventoryItem: the physical good, separate from its listings so relisting keeps history and
-- cost basis. Acquisition cost is seller-entered and P3 (DATA_AND_PRIVACY §3.1).
CREATE TABLE app.inventory_item (
  id                      uuid              PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id               uuid              NOT NULL REFERENCES app.seller (id),
  acquisition_cost_minor  app.minor_units,
  acquisition_currency    app.currency_code,
  acquisition_date        date,
  request_id              text              NOT NULL,
  created_at              timestamptz       NOT NULL DEFAULT now(),
  updated_at              timestamptz       NOT NULL DEFAULT now(),
  CONSTRAINT inventory_item_cost_currency_pair CHECK ((acquisition_cost_minor IS NULL) = (acquisition_currency IS NULL)),
  CONSTRAINT inventory_item_id_seller UNIQUE (id, seller_id)
);
ALTER TABLE app.inventory_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.inventory_item FORCE ROW LEVEL SECURITY;
CREATE POLICY inventory_item_tenant_isolation ON app.inventory_item
  USING (seller_id = app.current_seller_id())
  WITH CHECK (seller_id = app.current_seller_id());

-- Listing: the sellable presentation. Owns lifecycle status, asking price and currency, and the
-- pointers to the current content version and policy version. Holds no derived valuation of any
-- kind (D-09, OPS-725). The minimum price is NOT here: it lives on the policy version (D-04).
CREATE TABLE app.listing (
  id                          uuid               PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id                   uuid               NOT NULL REFERENCES app.seller (id),
  inventory_item_id           uuid               NOT NULL,
  status                      app.listing_status NOT NULL DEFAULT 'DRAFT',
  asking_price_minor          app.minor_units,
  currency                    app.currency_code,
  current_content_version_id  uuid,
  current_policy_version_id   uuid,
  -- OPS-738: mutable rows carry a version and are updated with an optimistic predicate.
  row_version                 integer            NOT NULL DEFAULT 1 CHECK (row_version >= 1),
  -- OPS-720: the request that last wrote this row.
  request_id                  text               NOT NULL,
  created_at                  timestamptz        NOT NULL DEFAULT now(),
  updated_at                  timestamptz        NOT NULL DEFAULT now(),
  CONSTRAINT listing_item_same_tenant FOREIGN KEY (inventory_item_id, seller_id)
    REFERENCES app.inventory_item (id, seller_id),
  CONSTRAINT listing_price_currency_pair CHECK ((asking_price_minor IS NULL) = (currency IS NULL)),
  CONSTRAINT listing_id_seller UNIQUE (id, seller_id)
);
-- One live listing per item at a time; relisting creates a new listing (LIST-100 AC2, SM-L-06).
CREATE UNIQUE INDEX listing_one_live_per_item ON app.listing (inventory_item_id)
  WHERE status NOT IN ('SOLD', 'CANCELLED', 'ARCHIVED', 'EXPIRED');
CREATE INDEX listing_seller_status ON app.listing (seller_id, status);
ALTER TABLE app.listing ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.listing FORCE ROW LEVEL SECURITY;
CREATE POLICY listing_tenant_isolation ON app.listing
  USING (seller_id = app.current_seller_id())
  WITH CHECK (seller_id = app.current_seller_id());

-- ListingContentVersion: immutable snapshot of buyer-facing copy (DM-06, OPS-706). The words
-- never change after insert; only the lifecycle marks of STATE_MACHINES §8 do (see the guard).
CREATE TABLE app.listing_content_version (
  id                  uuid                       PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id           uuid                       NOT NULL REFERENCES app.seller (id),
  listing_id          uuid                       NOT NULL,
  version_number      integer                    NOT NULL CHECK (version_number >= 1),
  status              app.content_version_status NOT NULL,
  provenance          app.content_provenance     NOT NULL,
  title               text                       NOT NULL CHECK (length(btrim(title)) > 0),
  summary             text,
  description         text,
  -- Structured detail fields (LIST-002), snapshotted with the copy. Every key must be backed by a
  -- seller-provided fact before the listing can reach READY (D-10, INV-12; see listing guard).
  structured_details  jsonb                      NOT NULL DEFAULT '{}'::jsonb
                        CHECK (jsonb_typeof(structured_details) = 'object'),
  source_version_id   uuid                       REFERENCES app.listing_content_version (id),
  request_id          text                       NOT NULL,
  created_at          timestamptz                NOT NULL DEFAULT now(),
  approved_at         timestamptz,
  approved_by         uuid,
  CONSTRAINT content_version_listing_same_tenant FOREIGN KEY (listing_id, seller_id)
    REFERENCES app.listing (id, seller_id),
  CONSTRAINT content_version_number_unique UNIQUE (listing_id, version_number),
  CONSTRAINT content_version_id_listing UNIQUE (id, listing_id),
  CONSTRAINT content_version_approval_marks CHECK (
    (status IN ('APPROVED', 'SUPERSEDED')) = (approved_at IS NOT NULL AND approved_by IS NOT NULL)
  )
);
-- SM-CT-01: exactly one APPROVED version per listing.
CREATE UNIQUE INDEX content_version_one_approved ON app.listing_content_version (listing_id)
  WHERE status = 'APPROVED';
ALTER TABLE app.listing_content_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.listing_content_version FORCE ROW LEVEL SECURITY;
CREATE POLICY content_version_tenant_isolation ON app.listing_content_version
  USING (seller_id = app.current_seller_id())
  WITH CHECK (seller_id = app.current_seller_id());

-- The listing's current content pointer must name a version of that same listing.
ALTER TABLE app.listing ADD CONSTRAINT listing_current_content_version_fk
  FOREIGN KEY (current_content_version_id, id) REFERENCES app.listing_content_version (id, listing_id);

-- ProductFact: the atomic grounding record. The seller is the sole source of product facts
-- (D-10, INV-12): no other provenance is accepted, by constraint.
CREATE TABLE app.product_fact (
  id           uuid                   PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id    uuid                   NOT NULL REFERENCES app.seller (id),
  listing_id   uuid                   NOT NULL,
  key          text                   NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{0,63}$'),
  value        text                   NOT NULL CHECK (length(btrim(value)) > 0),
  provenance   app.content_provenance NOT NULL CHECK (provenance = 'SELLER_PROVIDED_FACT'),
  supplied_at  timestamptz            NOT NULL DEFAULT now(),
  request_id   text                   NOT NULL,
  CONSTRAINT product_fact_listing_same_tenant FOREIGN KEY (listing_id, seller_id)
    REFERENCES app.listing (id, seller_id),
  CONSTRAINT product_fact_key_unique UNIQUE (listing_id, key)
);
ALTER TABLE app.product_fact ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.product_fact FORCE ROW LEVEL SECURITY;
CREATE POLICY product_fact_tenant_isolation ON app.product_fact
  USING (seller_id = app.current_seller_id())
  WITH CHECK (seller_id = app.current_seller_id());

-- SellerPolicyVersion: the deterministic rule set, versioned and immutable (DM-06). The minimum
-- price is P3: it is never placed in a buyer payload, a log or model context (D-04, OPS-569).
CREATE TABLE app.seller_policy_version (
  id                               uuid                         PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id                        uuid                         NOT NULL REFERENCES app.seller (id),
  listing_id                       uuid                         NOT NULL,
  version_number                   integer                      NOT NULL CHECK (version_number >= 1),
  minimum_price_minor              app.minor_units              NOT NULL,
  currency                         app.currency_code            NOT NULL,
  negotiation_enabled              boolean                      NOT NULL,
  max_autonomous_concession_minor  app.minor_units,
  trades_allowed                   boolean                      NOT NULL,
  delivery_allowed                 boolean                      NOT NULL,
  pickup_allowed                   boolean                      NOT NULL,
  location_disclosure_mode         app.location_disclosure_mode NOT NULL,
  hold_window_seconds              integer                      CHECK (hold_window_seconds > 0),
  request_id                       text                         NOT NULL,
  created_at                       timestamptz                  NOT NULL DEFAULT now(),
  CONSTRAINT policy_version_listing_same_tenant FOREIGN KEY (listing_id, seller_id)
    REFERENCES app.listing (id, seller_id),
  CONSTRAINT policy_version_number_unique UNIQUE (listing_id, version_number),
  CONSTRAINT policy_version_id_listing UNIQUE (id, listing_id)
);
ALTER TABLE app.seller_policy_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.seller_policy_version FORCE ROW LEVEL SECURITY;
CREATE POLICY policy_version_tenant_isolation ON app.seller_policy_version
  USING (seller_id = app.current_seller_id())
  WITH CHECK (seller_id = app.current_seller_id());

ALTER TABLE app.listing ADD CONSTRAINT listing_current_policy_version_fk
  FOREIGN KEY (current_policy_version_id, id) REFERENCES app.seller_policy_version (id, listing_id);

-- AuditEvent: append-only consequential record (OPS-780 to OPS-784, AUTH-INV-09). Carries no
-- secret, no access code, no protected value and no unnecessary personal data (OPS-783).
CREATE TABLE app.audit_event (
  id                 uuid                  PRIMARY KEY DEFAULT gen_random_uuid(),
  -- OPS-741: ordering is database-assigned, never a wall-clock comparison.
  seq                bigint                NOT NULL GENERATED ALWAYS AS IDENTITY UNIQUE,
  seller_id          uuid                  NOT NULL REFERENCES app.seller (id),
  event_type         app.audit_event_type  NOT NULL,
  actor_type         app.audit_actor_type  NOT NULL,
  actor_ref          text,
  subject_type       text                  NOT NULL CHECK (subject_type ~ '^[a-z][a-z_]{0,63}$'),
  subject_id         uuid                  NOT NULL,
  policy_version_id  uuid,
  request_id         text                  NOT NULL,
  idempotency_key    text,
  summary            jsonb                 NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(summary) = 'object'),
  created_at         timestamptz           NOT NULL DEFAULT now()
);
-- OPS-730 to OPS-732: a client-supplied idempotency key is stored with the outcome, once.
CREATE UNIQUE INDEX audit_event_idempotency ON app.audit_event (seller_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX audit_event_subject ON app.audit_event (seller_id, subject_type, subject_id, created_at);
ALTER TABLE app.audit_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.audit_event FORCE ROW LEVEL SECURITY;
CREATE POLICY audit_event_tenant_isolation ON app.audit_event
  USING (seller_id = app.current_seller_id())
  WITH CHECK (seller_id = app.current_seller_id());

-- ---------------------------------------------------------------------------------------------
-- Guards: the data layer rejects what the state machines do not draw (OPS-705 to OPS-707)
-- ---------------------------------------------------------------------------------------------

CREATE FUNCTION app.touch_updated_at() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END
$fn$;
CREATE TRIGGER seller_touch_updated_at BEFORE UPDATE ON app.seller
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER inventory_item_touch_updated_at BEFORE UPDATE ON app.inventory_item
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- Append-only and immutable tables: even the owner cannot update or delete a row.
CREATE FUNCTION app.reject_mutation() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  RAISE EXCEPTION '% is append-only: % rejected (OPS-705, OPS-706)', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'AP001';
END
$fn$;
CREATE TRIGGER audit_event_append_only BEFORE UPDATE OR DELETE ON app.audit_event
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();
CREATE TRIGGER seller_policy_version_immutable BEFORE UPDATE OR DELETE ON app.seller_policy_version
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();

-- Product facts: the value may be corrected by the seller; identity and provenance never change.
CREATE FUNCTION app.product_fact_guard() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.id <> OLD.id OR NEW.seller_id <> OLD.seller_id OR NEW.listing_id <> OLD.listing_id
     OR NEW.key <> OLD.key OR NEW.provenance <> OLD.provenance THEN
    RAISE EXCEPTION 'product fact identity and provenance are immutable (D-10)' USING ERRCODE = 'CV001';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER product_fact_guard BEFORE UPDATE ON app.product_fact
  FOR EACH ROW EXECUTE FUNCTION app.product_fact_guard();

-- STATE_MACHINES §1, exactly the drawn edges.
CREATE FUNCTION app.listing_transition_allowed(old_status app.listing_status, new_status app.listing_status)
RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $fn$
  SELECT (old_status::text, new_status::text) IN (
    ('DRAFT', 'READY'),
    ('READY', 'DRAFT'),
    ('READY', 'LISTED'),
    ('LISTED', 'ACTIVE_CONVERSATIONS'),
    ('ACTIVE_CONVERSATIONS', 'OFFER_PENDING'),
    ('OFFER_PENDING', 'ACTIVE_CONVERSATIONS'),
    ('OFFER_PENDING', 'PENDING_SALE'),
    ('PENDING_SALE', 'SOLD'),
    ('PENDING_SALE', 'ACTIVE_CONVERSATIONS'),
    ('LISTED', 'CANCELLED'),
    ('ACTIVE_CONVERSATIONS', 'CANCELLED'),
    ('OFFER_PENDING', 'CANCELLED'),
    ('SOLD', 'ARCHIVED'),
    ('CANCELLED', 'ARCHIVED'),
    ('LISTED', 'EXPIRED'),
    ('EXPIRED', 'LISTED')
  )
$fn$;

-- SM-L-01 prerequisites, named so the refusal can say what is missing (LIST-134 AC1).
CREATE FUNCTION app.listing_ready_missing(l app.listing) RETURNS text[]
LANGUAGE plpgsql
STABLE
AS $fn$
DECLARE
  missing   text[] := '{}';
  cv        app.listing_content_version;
  pv        app.seller_policy_version;
  uncovered text[];
BEGIN
  IF l.asking_price_minor IS NULL OR l.currency IS NULL THEN
    missing := array_append(missing, 'asking_price');
  END IF;

  IF l.current_content_version_id IS NULL THEN
    missing := array_append(missing, 'approved_content');
  ELSE
    SELECT * INTO cv FROM app.listing_content_version v
     WHERE v.id = l.current_content_version_id AND v.listing_id = l.id;
    IF cv.id IS NULL OR cv.status <> 'APPROVED' OR cv.provenance <> 'SELLER_APPROVED_COPY'
       OR length(btrim(cv.title)) = 0 THEN
      missing := array_append(missing, 'approved_content');
    ELSE
      -- D-10, INV-12: every structured detail on the approved copy is backed by a seller-provided fact.
      SELECT array_agg(k ORDER BY k) INTO uncovered
        FROM jsonb_object_keys(cv.structured_details) AS k
       WHERE NOT EXISTS (
         SELECT 1 FROM app.product_fact f
          WHERE f.listing_id = l.id AND f.key = k AND f.provenance = 'SELLER_PROVIDED_FACT'
       );
      IF uncovered IS NOT NULL THEN
        missing := array_append(missing, 'seller_provided_facts');
      END IF;
    END IF;
  END IF;

  IF l.current_policy_version_id IS NULL THEN
    missing := array_append(array_append(missing, 'policy_version'), 'minimum_price');
  ELSE
    SELECT * INTO pv FROM app.seller_policy_version p
     WHERE p.id = l.current_policy_version_id AND p.listing_id = l.id;
    IF pv.id IS NULL THEN
      missing := array_append(array_append(missing, 'policy_version'), 'minimum_price');
    ELSIF l.currency IS NOT NULL AND pv.currency <> l.currency THEN
      -- OPS-704: amounts in different currencies are never compared; the mismatch is a refusal.
      missing := array_append(missing, 'currency_match');
    END IF;
  END IF;

  RETURN missing;
END
$fn$;

CREATE FUNCTION app.listing_guard() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  missing text[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'DRAFT' THEN
      RAISE EXCEPTION 'a listing starts in DRAFT (STATE_MACHINES §1)' USING ERRCODE = 'LS001';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.id <> OLD.id OR NEW.seller_id <> OLD.seller_id OR NEW.inventory_item_id <> OLD.inventory_item_id
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'listing identity columns are immutable' USING ERRCODE = 'LS004';
  END IF;

  IF NEW.row_version <> OLD.row_version + 1 THEN
    RAISE EXCEPTION 'a listing update increments row_version by exactly one (OPS-738)' USING ERRCODE = 'LS003';
  END IF;

  IF NEW.status <> OLD.status THEN
    IF NOT app.listing_transition_allowed(OLD.status, NEW.status) THEN
      RAISE EXCEPTION 'illegal listing transition % -> % (STATE_MACHINES §1)', OLD.status, NEW.status
        USING ERRCODE = 'LS001';
    END IF;
    IF NEW.status = 'READY' THEN
      missing := app.listing_ready_missing(NEW);
      IF cardinality(missing) > 0 THEN
        RAISE EXCEPTION 'listing cannot reach READY (SM-L-01): missing %', array_to_string(missing, ', ')
          USING ERRCODE = 'LS002', DETAIL = array_to_string(missing, ',');
      END IF;
    END IF;
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END
$fn$;
CREATE TRIGGER listing_guard BEFORE INSERT OR UPDATE ON app.listing
  FOR EACH ROW EXECUTE FUNCTION app.listing_guard();

-- STATE_MACHINES §8, exactly the drawn edges.
CREATE FUNCTION app.content_version_transition_allowed(
  old_status app.content_version_status, new_status app.content_version_status
) RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $fn$
  SELECT (old_status::text, new_status::text) IN (
    ('SELLER_DRAFT', 'ENHANCEMENT_PENDING'),
    ('ENHANCEMENT_PENDING', 'ENHANCED'),
    ('ENHANCEMENT_PENDING', 'ENHANCEMENT_FAILED'),
    ('ENHANCEMENT_FAILED', 'SELLER_DRAFT'),
    ('ENHANCED', 'SELLER_EDITED'),
    ('ENHANCED', 'APPROVED'),
    ('SELLER_EDITED', 'APPROVED'),
    ('SELLER_DRAFT', 'APPROVED'),
    ('ENHANCED', 'SELLER_DRAFT'),
    ('APPROVED', 'SUPERSEDED')
  )
$fn$;

CREATE FUNCTION app.content_version_guard() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'content versions are never deleted (DM-06)' USING ERRCODE = 'CV001';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'SELLER_DRAFT' THEN
      RAISE EXCEPTION 'a content version starts as SELLER_DRAFT (STATE_MACHINES §8)' USING ERRCODE = 'CV001';
    END IF;
    IF NEW.provenance <> 'SELLER_PROVIDED_FACT' THEN
      RAISE EXCEPTION 'a seller draft carries SELLER_PROVIDED_FACT provenance (D-10)' USING ERRCODE = 'CV001';
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE: the words and the lineage never change (DM-06, OPS-706).
  IF NEW.id <> OLD.id OR NEW.seller_id <> OLD.seller_id OR NEW.listing_id <> OLD.listing_id
     OR NEW.version_number <> OLD.version_number
     OR NEW.title IS DISTINCT FROM OLD.title
     OR NEW.summary IS DISTINCT FROM OLD.summary
     OR NEW.description IS DISTINCT FROM OLD.description
     OR NEW.structured_details <> OLD.structured_details
     OR NEW.source_version_id IS DISTINCT FROM OLD.source_version_id
     OR NEW.request_id <> OLD.request_id
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'content version text and lineage are immutable (DM-06, OPS-706)' USING ERRCODE = 'CV001';
  END IF;

  IF NEW.status = OLD.status THEN
    IF NEW.provenance <> OLD.provenance OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
       OR NEW.approved_by IS DISTINCT FROM OLD.approved_by THEN
      RAISE EXCEPTION 'approval marks change only with a lifecycle transition' USING ERRCODE = 'CV001';
    END IF;
    RETURN NEW;
  END IF;

  IF NOT app.content_version_transition_allowed(OLD.status, NEW.status) THEN
    RAISE EXCEPTION 'illegal content version transition % -> % (STATE_MACHINES §8)', OLD.status, NEW.status
      USING ERRCODE = 'CV001';
  END IF;

  IF NEW.status = 'APPROVED' THEN
    -- LIST-105: the approved version carries SELLER_APPROVED_COPY; only the owning seller approves (AUTH-INV-04).
    IF NEW.provenance <> 'SELLER_APPROVED_COPY' OR NEW.approved_at IS NULL OR NEW.approved_by IS NULL
       OR NEW.approved_by <> NEW.seller_id THEN
      RAISE EXCEPTION 'approval sets SELLER_APPROVED_COPY, approved_at and approved_by = owning seller (LIST-105)'
        USING ERRCODE = 'CV001';
    END IF;
  ELSIF NEW.provenance <> OLD.provenance OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
        OR NEW.approved_by IS DISTINCT FROM OLD.approved_by THEN
    RAISE EXCEPTION 'only approval changes provenance and approval marks' USING ERRCODE = 'CV001';
  END IF;

  RETURN NEW;
END
$fn$;
CREATE TRIGGER content_version_guard BEFORE INSERT OR UPDATE OR DELETE ON app.listing_content_version
  FOR EACH ROW EXECUTE FUNCTION app.content_version_guard();

-- ---------------------------------------------------------------------------------------------
-- Runtime grants: DML only, per table, exactly what this slice needs. No DDL, no ownership.
-- ---------------------------------------------------------------------------------------------

GRANT USAGE ON SCHEMA app TO app_runtime;
GRANT EXECUTE ON FUNCTION app.current_seller_id() TO app_runtime;
GRANT SELECT, INSERT, UPDATE ON app.seller TO app_runtime;
GRANT SELECT, INSERT, UPDATE ON app.inventory_item TO app_runtime;
GRANT SELECT, INSERT, UPDATE ON app.listing TO app_runtime;
GRANT SELECT, INSERT, UPDATE ON app.listing_content_version TO app_runtime;
GRANT SELECT, INSERT, UPDATE ON app.product_fact TO app_runtime;
GRANT SELECT, INSERT ON app.seller_policy_version TO app_runtime;
GRANT SELECT, INSERT ON app.audit_event TO app_runtime;
