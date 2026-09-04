-- 0008_sign_in_failure_throttle.sql
--
-- Forward-only (OPS-513, OPS-514, OPS-714). Applied once by app_migrator after 0007. Repairs the
-- AUTH-204 limiter of migration 0007, which counted every reserved attempt whatever its outcome:
-- a seller who signed in often, or several sellers behind one network address, were delayed by
-- their own successful sign-ins, and one valid account could not be told apart from a failure.
-- From this migration only completed authentication failures count.
--
-- Semantics (D-19 condition 6, AUTH-204):
--   * reserve_sign_in_attempt admits or refuses an attempt under the subject's row lock BEFORE
--     any credential work and records an admitted attempt as in flight (pending), so parallel
--     attempts serialise here and cannot all slip past the limit;
--   * finalize_sign_in_attempt settles that reservation by its outcome. A failure leaves exactly
--     one more failure and the lock that failure count earns. A success leaves no failure and, in
--     the account scope, clears the account's failure history (the owner is back in). In the
--     client scope a success changes nothing but the in-flight count, so one valid account can
--     neither add to nor erase the client's failures against other accounts;
--   * a reservation nobody finalizes (a process lost between the two calls) stays in flight for
--     at most p_reservation_seconds after the last admitted reservation on that subject, never
--     becomes a failure, blocks nothing while the free allowance covers it, and is discarded by
--     the next reservation after the window;
--   * failure history decays after p_decay_seconds without a failure, and a lock never outlives
--     the history it came from; a refusal writes nothing but updated_at, so checking a lock never
--     extends it; every counter is CHECKed non-negative and finalization clamps at zero.
--
-- Counters recorded under 0007 mixed successes and failures. They are not carried forward: the
-- renamed column keeps its value, but no failure time was ever recorded, so it decays at once.

ALTER TABLE auth.sign_in_throttle RENAME COLUMN attempts TO failures;
ALTER TABLE auth.sign_in_throttle RENAME CONSTRAINT sign_in_throttle_attempts_check TO sign_in_throttle_failures_check;
ALTER TABLE auth.sign_in_throttle RENAME COLUMN last_attempt_at TO last_reserved_at;
ALTER TABLE auth.sign_in_throttle
  ADD COLUMN pending          integer      NOT NULL DEFAULT 0 CONSTRAINT sign_in_throttle_pending_check CHECK (pending >= 0),
  ADD COLUMN last_failure_at  timestamptz;

COMMENT ON COLUMN auth.sign_in_throttle.failures IS 'Completed authentication failures since the last decay or account reset';
COMMENT ON COLUMN auth.sign_in_throttle.pending IS 'Reserved attempts not yet finalized; provisional failures for admission';
COMMENT ON COLUMN auth.sign_in_throttle.last_reserved_at IS 'Last admitted reservation; bounds how long an abandoned reservation counts';
COMMENT ON COLUMN auth.sign_in_throttle.last_failure_at IS 'Last completed failure; the decay clock';

DROP FUNCTION auth.reserve_sign_in_attempt(auth.throttle_scope, text, integer, integer, integer, integer);
DROP FUNCTION auth.record_sign_in_success(text);

-- Admission, before any credential work. Admitted when the failures plus the attempts in flight
-- still fit the free allowance, or when nothing is in flight and no lock is running: beyond the
-- allowance attempts proceed one at a time, each waiting for the lock the previous failure set.
CREATE FUNCTION auth.reserve_sign_in_attempt(
  p_scope auth.throttle_scope,
  p_subject_hash text,
  p_free_failures integer,
  p_base_seconds integer,
  p_cap_seconds integer,
  p_decay_seconds integer,
  p_reservation_seconds integer
)
RETURNS TABLE (allowed boolean, retry_after_seconds integer, failures integer, pending integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, auth, app
AS $fn$
DECLARE
  v_failures integer;
  v_pending integer;
  v_locked_until timestamptz;
  v_last_failure_at timestamptz;
  v_last_reserved_at timestamptz;
BEGIN
  IF p_free_failures < 0 OR p_base_seconds < 1 OR p_cap_seconds < p_base_seconds
     OR p_decay_seconds < 1 OR p_reservation_seconds < 1 THEN
    RAISE EXCEPTION 'invalid throttle policy' USING ERRCODE = 'ST001';
  END IF;
  -- The row lock every parallel attempt on this subject serialises on.
  INSERT INTO auth.sign_in_throttle AS t (scope, subject_hash) VALUES (p_scope, p_subject_hash)
  ON CONFLICT (scope, subject_hash) DO UPDATE SET updated_at = now()
  RETURNING t.failures, t.pending, t.locked_until, t.last_failure_at, t.last_reserved_at
       INTO v_failures, v_pending, v_locked_until, v_last_failure_at, v_last_reserved_at;
  -- Failure history decays after the window, and the lock with it.
  IF v_last_failure_at IS NULL OR v_last_failure_at < now() - make_interval(secs => p_decay_seconds) THEN
    v_failures := 0;
    v_locked_until := NULL;
    v_last_failure_at := NULL;
  END IF;
  -- Reservations nobody finalized are abandoned after the reservation window.
  IF v_pending > 0 AND v_last_reserved_at < now() - make_interval(secs => p_reservation_seconds) THEN
    v_pending := 0;
  END IF;
  IF v_failures + v_pending <= p_free_failures
     OR (v_pending = 0 AND (v_locked_until IS NULL OR v_locked_until <= now())) THEN
    UPDATE auth.sign_in_throttle AS t
       SET failures = v_failures, pending = v_pending + 1, locked_until = v_locked_until,
           last_failure_at = v_last_failure_at, last_reserved_at = now(), updated_at = now()
     WHERE t.scope = p_scope AND t.subject_hash = p_subject_hash;
    allowed := true;
    retry_after_seconds := 0;
    failures := v_failures;
    pending := v_pending + 1;
  ELSE
    -- Refused: nothing but updated_at changed, so checking never extends a lock. The answer is
    -- the lock's remaining time by the database clock; while an attempt is in flight its
    -- outcome decides the next lock, so the answer is never below one second.
    allowed := false;
    retry_after_seconds := GREATEST(1, COALESCE(ceil(extract(epoch FROM (v_locked_until - now())))::integer, 0));
    failures := v_failures;
    pending := v_pending;
  END IF;
  RETURN NEXT;
END
$fn$;

-- Settlement of one reservation by its outcome, under the same row lock. Failure: one more
-- failure and the lock it earns. Success: no failure; the account scope forgets its failures,
-- the client scope keeps them. The in-flight count goes down by one and never below zero.
CREATE FUNCTION auth.finalize_sign_in_attempt(
  p_scope auth.throttle_scope,
  p_subject_hash text,
  p_failed boolean,
  p_free_failures integer,
  p_base_seconds integer,
  p_cap_seconds integer,
  p_decay_seconds integer
)
RETURNS TABLE (failures integer, pending integer, locked_until timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, auth, app
AS $fn$
DECLARE
  v_failures integer;
  v_pending integer;
  v_locked_until timestamptz;
  v_last_failure_at timestamptz;
  v_exponent integer;
  v_delay_seconds bigint;
BEGIN
  IF p_free_failures < 0 OR p_base_seconds < 1 OR p_cap_seconds < p_base_seconds OR p_decay_seconds < 1 THEN
    RAISE EXCEPTION 'invalid throttle policy' USING ERRCODE = 'ST001';
  END IF;
  UPDATE auth.sign_in_throttle AS t SET updated_at = now()
   WHERE t.scope = p_scope AND t.subject_hash = p_subject_hash
  RETURNING t.failures, t.pending, t.locked_until, t.last_failure_at
       INTO v_failures, v_pending, v_locked_until, v_last_failure_at;
  IF NOT FOUND THEN
    -- Nothing was ever reserved for this subject: nothing to settle and nothing to count down.
    failures := 0;
    pending := 0;
    locked_until := NULL;
    RETURN NEXT;
    RETURN;
  END IF;
  IF v_last_failure_at IS NULL OR v_last_failure_at < now() - make_interval(secs => p_decay_seconds) THEN
    v_failures := 0;
    v_locked_until := NULL;
    v_last_failure_at := NULL;
  END IF;
  v_pending := GREATEST(0, v_pending - 1);
  IF p_failed THEN
    v_failures := v_failures + 1;
    v_last_failure_at := now();
    IF v_failures > p_free_failures THEN
      -- base * 2^(failures - free - 1), capped; exact integer arithmetic, the exponent bounded
      -- so a long failure history cannot overflow or slow the computation.
      v_exponent := LEAST(30, v_failures - p_free_failures - 1);
      v_delay_seconds := LEAST(p_cap_seconds::bigint, p_base_seconds::bigint * (1::bigint << v_exponent));
      v_locked_until := now() + make_interval(secs => v_delay_seconds);
    ELSE
      v_locked_until := NULL;
    END IF;
  ELSIF p_scope = 'account' THEN
    v_failures := 0;
    v_locked_until := NULL;
    v_last_failure_at := NULL;
  END IF;
  UPDATE auth.sign_in_throttle AS t
     SET failures = v_failures, pending = v_pending, locked_until = v_locked_until,
         last_failure_at = v_last_failure_at, updated_at = now()
   WHERE t.scope = p_scope AND t.subject_hash = p_subject_hash;
  failures := v_failures;
  pending := v_pending;
  locked_until := v_locked_until;
  RETURN NEXT;
END
$fn$;

-- Privileges (OPS-716): a new function is executable by PUBLIC by default, so revoke first.
REVOKE ALL ON FUNCTION
  auth.reserve_sign_in_attempt(auth.throttle_scope, text, integer, integer, integer, integer, integer),
  auth.finalize_sign_in_attempt(auth.throttle_scope, text, boolean, integer, integer, integer, integer)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  auth.reserve_sign_in_attempt(auth.throttle_scope, text, integer, integer, integer, integer, integer),
  auth.finalize_sign_in_attempt(auth.throttle_scope, text, boolean, integer, integer, integer, integer)
TO app_runtime;
