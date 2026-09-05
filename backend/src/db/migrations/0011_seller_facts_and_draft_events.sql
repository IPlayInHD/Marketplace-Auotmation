-- 0011_seller_facts_and_draft_events.sql
--
-- Forward-only (OPS-513, OPS-514). Applied once by app_migrator after 0010.
--
-- D-21 (Accepted 2026-09-05): seller product-fact replacement and seller-authored draft saves
-- are consequential actions. Three completions follow, no product field and no state transition.
--
-- 1. Two audit event types complete the catalogue (ai/POLICY_AND_AUTHORIZATION.md §12, updated
--    2026-09-05 under D-21) for consequential actions the list did not name (OPS-780, OPS-781):
--    LISTING_FACTS_CHANGED, the seller-provided fact set of a listing changed (keys set, keys
--    cleared, counts and row versions, never a value), and LISTING_CONTENT_DRAFTED, a seller
--    draft content version was created (identifiers, version numbers and row versions, never a
--    title, summary or description).
--
-- 2. D-21 rule 19: returning a fact to unknown removes its row, because the canonical unknown
--    state is the absence of a ProductFact (LIST-033, D-10). The runtime role gains DELETE on
--    app.product_fact for that one purpose. Row-level security governs DELETE like every other
--    statement, so a tenant removes only its own rows; product_fact is not a ledger of OPS-705,
--    and the identity and provenance of a surviving row stay immutable (the 0001 guard).
--
-- 3. D-21 rule 11: a content version's predecessor belongs to the same listing. The composite
--    foreign key enforces that lineage at the data layer; a null predecessor, the first seller
--    draft of rule 12, passes as before. The words of a version, its predecessor included, remain
--    immutable under the 0001 guard.
--
-- ALTER TYPE ... ADD VALUE is permitted inside a transaction on PostgreSQL 12 and later; the new
-- values are usable once this migration's transaction commits. Enum values are never removed.

ALTER TYPE app.audit_event_type ADD VALUE IF NOT EXISTS 'LISTING_FACTS_CHANGED';
ALTER TYPE app.audit_event_type ADD VALUE IF NOT EXISTS 'LISTING_CONTENT_DRAFTED';

GRANT DELETE ON app.product_fact TO app_runtime;

ALTER TABLE app.listing_content_version
  ADD CONSTRAINT content_version_source_same_listing
    FOREIGN KEY (source_version_id, listing_id) REFERENCES app.listing_content_version (id, listing_id);
