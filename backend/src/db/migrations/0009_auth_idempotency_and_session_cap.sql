-- 0009_auth_idempotency_and_session_cap.sql
--
-- Forward-only (OPS-513, OPS-514, OPS-714). Applied once by app_migrator after 0008. Persistence
-- for decisions/DECISION_LOG.md D-20 (Accepted 2026-09-04): the authentication-route idempotency
-- semantics and the active-session cap.
--
--   * Sign-in and rotation are one-time-secret exceptions to exact replay (OPS-731): the token
--     they answer is stored nowhere but as its SHA-256 (AUTH-205), so no receipt can return it.
--     A retried sign-in therefore creates another session. To bound that, create_session now
--     enforces a per-account cap on live sessions under the account's row lock: the newest
--     p_max_active survive, older live sessions are revoked with reason `evicted` in the same
--     transaction, and their identifiers are returned so the application audits each eviction
--     (SELLER_SESSION_EVICTED). Revoked and expired sessions are not live and are never counted.
--   * Sign-out-all is a consequential command with full OPS-730/OPS-731 idempotency through the
--     existing app.idempotency_receipt store. A replay arrives with the token the original call
--     revoked, so find_session_for_command resolves a session by digest whether or not it is
--     live and reports liveness; the application reads the receipt first and requires liveness
--     only for a fresh execution. It never touches last_seen_at and never extends a session.
--   * Sign-out converges to signed-out: the same finder tells the application whether there is
--     a live session to revoke, and a repeat finds none.
--
-- Nothing here stores a token, a token hash outside auth.seller_session, an anti-forgery value,
-- a password, an address or a raw client identifier (D-19, OPS-712).

ALTER TYPE app.audit_event_type ADD VALUE IF NOT EXISTS 'SELLER_SESSION_EVICTED';
ALTER TYPE auth.revocation_reason ADD VALUE IF NOT EXISTS 'evicted';

DROP FUNCTION auth.create_session(uuid, bytea, text, smallint, integer);

-- A new session for a verified account, under the active-session cap (AUTH-230, D-20). The
-- account row lock serialises every concurrent sign-in of one account, so the cap holds under
-- concurrency. The oldest live sessions beyond the cap are evicted; the new session is never
-- evicted. Liveness is the database clock's decision (AUTH-207).
CREATE FUNCTION auth.create_session(
  p_account_id uuid,
  p_token_hash bytea,
  p_client_hash text,
  p_client_key_version smallint,
  p_absolute_seconds integer,
  p_idle_seconds integer,
  p_max_active integer
)
RETURNS TABLE (id uuid, absolute_expires_at timestamptz, evicted_session_ids uuid[])
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, auth, app
AS $fn$
DECLARE
  v_id uuid;
  v_expires timestamptz;
  v_evicted uuid[];
BEGIN
  IF p_max_active < 1 OR p_idle_seconds < 1 OR p_absolute_seconds < 1 THEN
    RAISE EXCEPTION 'invalid session policy' USING ERRCODE = 'SC001';
  END IF;
  PERFORM 1 FROM auth.seller_account a WHERE a.id = p_account_id FOR UPDATE;
  INSERT INTO auth.seller_session (account_id, token_hash, client_hash, client_key_version, absolute_expires_at)
  VALUES (p_account_id, p_token_hash, p_client_hash, p_client_key_version, now() + make_interval(secs => p_absolute_seconds))
  RETURNING seller_session.id, seller_session.absolute_expires_at INTO v_id, v_expires;
  WITH live AS (
    SELECT s.id, s.created_at
      FROM auth.seller_session s
     WHERE s.account_id = p_account_id
       AND s.id <> v_id
       AND s.revoked_at IS NULL
       AND s.absolute_expires_at > now()
       AND s.last_seen_at > now() - make_interval(secs => p_idle_seconds)
  ), kept AS (
    SELECT live.id FROM live ORDER BY live.created_at DESC, live.id DESC LIMIT GREATEST(p_max_active - 1, 0)
  ), evicted AS (
    UPDATE auth.seller_session s
       SET revoked_at = now(), revocation_reason = 'evicted', replaced_by_session_id = v_id
      FROM live
     WHERE s.id = live.id AND live.id NOT IN (SELECT kept.id FROM kept)
    RETURNING s.id
  )
  SELECT COALESCE(array_agg(evicted.id ORDER BY evicted.id), '{}'::uuid[]) INTO v_evicted FROM evicted;
  id := v_id;
  absolute_expires_at := v_expires;
  evicted_session_ids := v_evicted;
  RETURN NEXT;
END
$fn$;

-- The session a token digest names, live or not, with its account and seller, or no row. Locks
-- the account row so a command and a concurrent replay of it serialise. Never touches the
-- session: a replay must not extend anything. The application uses the seller only to read a
-- receipt under that tenant's row-level security, and requires `live` for any mutation.
CREATE FUNCTION auth.find_session_for_command(p_token_hash bytea, p_idle_seconds integer)
RETURNS TABLE (session_id uuid, account_id uuid, seller_id uuid, live boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, auth, app
AS $fn$
BEGIN
  SELECT s.id, s.account_id, a.seller_id,
         (s.revoked_at IS NULL AND s.absolute_expires_at > now()
          AND s.last_seen_at > now() - make_interval(secs => p_idle_seconds))
    INTO session_id, account_id, seller_id, live
    FROM auth.seller_session s
    JOIN auth.seller_account a ON a.id = s.account_id
   WHERE s.token_hash = p_token_hash
     FOR UPDATE OF a;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  RETURN NEXT;
END
$fn$;

-- Privileges (OPS-716): a new function is executable by PUBLIC by default, so revoke first.
REVOKE ALL ON FUNCTION
  auth.create_session(uuid, bytea, text, smallint, integer, integer, integer),
  auth.find_session_for_command(bytea, integer)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  auth.create_session(uuid, bytea, text, smallint, integer, integer, integer),
  auth.find_session_for_command(bytea, integer)
TO app_runtime;
