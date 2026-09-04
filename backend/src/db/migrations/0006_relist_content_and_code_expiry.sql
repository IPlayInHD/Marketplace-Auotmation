-- 0006_relist_content_and_code_expiry.sql
--
-- Forward-only (OPS-513, OPS-514). Applied once by app_migrator after 0005.
--
-- Two completions of existing requirements, no new product decision:
--
-- 1. SM-L-06 (STATE_MACHINES.md §1) and OPS-216, OPS-219: relisting from EXPIRED creates a new
--    content version and nothing is auto-approved. The listing now records which content version
--    each publication used (published_content_version_id, set from the database on entry to
--    LISTED), and EXPIRED → LISTED is refused unless the current content version is a different,
--    seller-approved version created and approved after the previous publication (LS007). The
--    earlier version stays in history as SUPERSEDED.
--
-- 2. OPS-780, OPS-781: an ACTIVE access code becoming EXPIRED is a consequential change. The
--    catalogue (ai/POLICY_AND_AUTHORIZATION.md §12, updated 2026-09-04) now names
--    ACCESS_CODE_EXPIRED, following the ACCESS_CODE_<verb> pattern of its neighbours.
--
-- ALTER TYPE ... ADD VALUE is permitted inside a transaction on PostgreSQL 12 and later; the new
-- value is usable once this migration's transaction commits. Nothing below references it.

ALTER TYPE app.audit_event_type ADD VALUE IF NOT EXISTS 'ACCESS_CODE_EXPIRED';

ALTER TABLE app.listing
  ADD COLUMN published_content_version_id uuid,
  ADD CONSTRAINT listing_published_content_version_fk
    FOREIGN KEY (published_content_version_id, id) REFERENCES app.listing_content_version (id, listing_id);

-- Runs after app.listing_guard (LS001), app.listing_lifecycle_guard and app.listing_listed_guard
-- (LS005): trigger names fire in alphabetical order. The publication reference is managed here
-- and cannot be set directly.
CREATE FUNCTION app.listing_publication_guard() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
  cv app.listing_content_version;
BEGIN
  NEW.published_content_version_id := OLD.published_content_version_id;
  IF NEW.status = 'LISTED' AND OLD.status <> 'LISTED' THEN
    IF NEW.current_content_version_id IS NULL THEN
      RAISE EXCEPTION 'publication requires an approved content version (SM-L-01)' USING ERRCODE = 'LS007';
    END IF;
    SELECT * INTO cv FROM app.listing_content_version v
     WHERE v.id = NEW.current_content_version_id AND v.listing_id = NEW.id;
    IF cv.id IS NULL OR cv.status <> 'APPROVED' OR cv.provenance <> 'SELLER_APPROVED_COPY'
       OR cv.approved_at IS NULL THEN
      RAISE EXCEPTION 'publication requires the current content version to be APPROVED seller copy (SM-CT-03)'
        USING ERRCODE = 'LS007';
    END IF;
    IF OLD.status = 'EXPIRED' THEN
      IF OLD.published_content_version_id IS NOT NULL AND cv.id = OLD.published_content_version_id THEN
        RAISE EXCEPTION 'relisting requires a new seller-approved content version, not the one previously published (SM-L-06)'
          USING ERRCODE = 'LS007';
      END IF;
      IF OLD.listed_at IS NOT NULL AND (cv.created_at <= OLD.listed_at OR cv.approved_at <= OLD.listed_at) THEN
        RAISE EXCEPTION 'relisting requires a content version created and approved after the previous publication (SM-L-06)'
          USING ERRCODE = 'LS007';
      END IF;
    END IF;
    NEW.published_content_version_id := cv.id;
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER listing_publication_guard BEFORE UPDATE ON app.listing
  FOR EACH ROW EXECUTE FUNCTION app.listing_publication_guard();
