-- 0005_listed_lifecycle.sql
--
-- Forward-only (OPS-513, OPS-514). Applied once by app_migrator after 0004.
--
-- Slice 1c: the seller-controlled lifecycle around LISTED. STATE_MACHINES.md §1 draws
-- LISTED → CANCELLED, LISTED → EXPIRED, EXPIRED → LISTED and CANCELLED → ARCHIVED, and SM-L-02
-- closes public access on SOLD, CANCELLED, ARCHIVED and EXPIRED. This migration makes that closure
-- a data-layer invariant, so no command and no direct statement can leave a closed listing with an
-- open surface or an ACTIVE code, and records the authoritative listing and closing times
-- (INVENTORY_AND_SALES.md §3.2 `listed_at`, `closed_at`) from the database clock.
--
-- Transitions this slice does not command (PENDING_SALE → SOLD, SOLD → ARCHIVED) are covered by
-- the same triggers: they cannot complete while access is open.

ALTER TABLE app.listing
  ADD COLUMN listed_at timestamptz,
  ADD COLUMN closed_at timestamptz;

-- The four closing states of SM-L-02.
CREATE FUNCTION app.listing_status_closed(s app.listing_status) RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $fn$
  SELECT s IN ('SOLD', 'CANCELLED', 'ARCHIVED', 'EXPIRED')
$fn$;

-- The states in which a buyer surface may be open at the end of a transaction.
CREATE FUNCTION app.listing_status_open(s app.listing_status) RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $fn$
  SELECT s IN ('LISTED', 'ACTIVE_CONVERSATIONS', 'OFFER_PENDING', 'PENDING_SALE')
$fn$;

CREATE FUNCTION app.listing_public_access_open(listing_id uuid, seller_id uuid) RETURNS boolean
LANGUAGE sql
STABLE
AS $fn$
  SELECT EXISTS (
    SELECT 1 FROM app.public_listing_access a
     WHERE a.listing_id = $1 AND a.seller_id = $2 AND a.enabled
  ) OR EXISTS (
    SELECT 1
      FROM app.listing_access_code c
      JOIN app.public_listing_access a ON a.id = c.public_access_id AND a.seller_id = c.seller_id
     WHERE a.listing_id = $1 AND a.seller_id = $2 AND c.status = 'ACTIVE'
  )
$fn$;

-- Runs after app.listing_guard (LS001) and before app.listing_listed_guard (LS005): trigger names
-- fire in alphabetical order. Entering a closing state requires the surface to be closed already
-- (LS006), and the listing and closing times come from the database clock, never from a caller.
CREATE FUNCTION app.listing_lifecycle_guard() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  NEW.listed_at := OLD.listed_at;
  NEW.closed_at := OLD.closed_at;
  IF NEW.status <> OLD.status THEN
    IF app.listing_status_closed(NEW.status) AND NOT app.listing_status_closed(OLD.status) THEN
      IF app.listing_public_access_open(NEW.id, NEW.seller_id) THEN
        RAISE EXCEPTION 'listing cannot close while public access is enabled or an ACTIVE code remains (SM-L-02)'
          USING ERRCODE = 'LS006';
      END IF;
      NEW.closed_at := now();
    END IF;
    IF NEW.status = 'LISTED' THEN
      NEW.listed_at := now();
      NEW.closed_at := NULL;
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER listing_lifecycle_guard BEFORE UPDATE ON app.listing
  FOR EACH ROW EXECUTE FUNCTION app.listing_lifecycle_guard();

-- Immediate: a surface is never enabled, and a code never issued, for a listing that is a DRAFT or
-- terminally closed (SOLD, CANCELLED, ARCHIVED). READY and EXPIRED are admitted because publication
-- and relisting open the surface inside the transaction that then moves the listing to LISTED; the
-- deferred checks below make sure that move actually happened by commit.
CREATE FUNCTION app.listing_status_terminal(s app.listing_status) RETURNS boolean
LANGUAGE sql
IMMUTABLE
AS $fn$
  SELECT s IN ('SOLD', 'CANCELLED', 'ARCHIVED')
$fn$;

CREATE FUNCTION app.public_access_enable_guard() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  s app.listing_status;
BEGIN
  IF NEW.enabled THEN
    SELECT l.status INTO s FROM app.listing l WHERE l.id = NEW.listing_id AND l.seller_id = NEW.seller_id;
    IF s IS NULL OR s = 'DRAFT' OR app.listing_status_terminal(s) THEN
      RAISE EXCEPTION 'public access cannot be enabled for a listing in % (SM-L-02)', COALESCE(s::text, 'no state')
        USING ERRCODE = 'PA003';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER public_access_enable_guard BEFORE INSERT OR UPDATE OF enabled ON app.public_listing_access
  FOR EACH ROW EXECUTE FUNCTION app.public_access_enable_guard();

CREATE FUNCTION app.access_code_issue_guard() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  a_enabled boolean;
  s app.listing_status;
BEGIN
  IF NEW.status = 'ACTIVE' THEN
    SELECT a.enabled, l.status INTO a_enabled, s
      FROM app.public_listing_access a
      JOIN app.listing l ON l.id = a.listing_id AND l.seller_id = a.seller_id
     WHERE a.id = NEW.public_access_id AND a.seller_id = NEW.seller_id;
    IF a_enabled IS DISTINCT FROM true OR s = 'DRAFT' OR app.listing_status_terminal(s) THEN
      RAISE EXCEPTION 'an ACTIVE code requires an enabled public access on an open listing (SM-L-02)'
        USING ERRCODE = 'AC003';
    END IF;
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER access_code_issue_guard BEFORE INSERT OR UPDATE OF status ON app.listing_access_code
  FOR EACH ROW EXECUTE FUNCTION app.access_code_issue_guard();

-- Deferred to commit: whatever order a transaction wrote in, it cannot end with an enabled surface
-- or an ACTIVE code on a listing that is not open. The current row is re-read, so a row enabled
-- and disabled again inside one transaction is judged by its final state.
CREATE FUNCTION app.public_access_open_state_check() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  a app.public_listing_access;
  s app.listing_status;
BEGIN
  SELECT * INTO a FROM app.public_listing_access WHERE id = NEW.id;
  IF a.id IS NOT NULL AND a.enabled THEN
    SELECT l.status INTO s FROM app.listing l WHERE l.id = a.listing_id AND l.seller_id = a.seller_id;
    IF s IS NULL OR NOT app.listing_status_open(s) THEN
      RAISE EXCEPTION 'public access is enabled on a listing that is not open at commit (SM-L-02)'
        USING ERRCODE = 'PA003';
    END IF;
  END IF;
  RETURN NULL;
END
$fn$;
CREATE CONSTRAINT TRIGGER public_access_open_state AFTER INSERT OR UPDATE ON app.public_listing_access
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.public_access_open_state_check();

CREATE FUNCTION app.access_code_open_state_check() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  c app.listing_access_code;
  a_enabled boolean;
  s app.listing_status;
BEGIN
  SELECT * INTO c FROM app.listing_access_code WHERE id = NEW.id;
  IF c.id IS NOT NULL AND c.status = 'ACTIVE' THEN
    SELECT a.enabled, l.status INTO a_enabled, s
      FROM app.public_listing_access a
      JOIN app.listing l ON l.id = a.listing_id AND l.seller_id = a.seller_id
     WHERE a.id = c.public_access_id AND a.seller_id = c.seller_id;
    IF a_enabled IS DISTINCT FROM true OR s IS NULL OR NOT app.listing_status_open(s) THEN
      RAISE EXCEPTION 'an ACTIVE code remains on a surface that is not open at commit (SM-L-02)'
        USING ERRCODE = 'AC003';
    END IF;
  END IF;
  RETURN NULL;
END
$fn$;
CREATE CONSTRAINT TRIGGER access_code_open_state AFTER INSERT OR UPDATE ON app.listing_access_code
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION app.access_code_open_state_check();
