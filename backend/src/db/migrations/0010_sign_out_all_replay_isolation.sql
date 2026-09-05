-- 0010_sign_out_all_replay_isolation.sql
--
-- Forward-only (OPS-513, OPS-514, OPS-714). Applied once by app_migrator after 0009. Security
-- repair of the D-20 sign-out-all replay path.
--
-- Before this migration, find_session_for_command resolved any token digest, revoked or not, to
-- its seller, and the application established that seller's transaction-local RLS context before
-- it had proven that the request was the exact replay D-20 permits. A revoked token must never be
-- a tenant-resolution credential: it may authorise exactly one thing, the replay of the completed
-- sign-out-all it initiated, and must disclose no seller, session or token identifier and no
-- session existence on the way. Two strictly separated capabilities replace that function:
--
--   * replay_sign_out_all(token digest, idempotency key): answers 'replay' with the sanitized
--     stored outcome when, and only when, the digest names the session that initiated the
--     sign-out-all receipt stored under that key for its own seller; 'conflict' when that key
--     was consumed by another command or another initiating session (OPS-732, D-20); otherwise
--     no row. It returns nothing else. The receipt is read under the seller's row-level security
--     inside a subtransaction that is rolled back, so the tenant setting never survives the call.
--   * sign_out_session(token digest, idle timeout): revokes a live session by digest and returns
--     its identifiers only when it did; nothing for a revoked, expired or unknown digest.
--
-- Fresh sign-out-all execution goes through resolve_session like every other authenticated
-- action: a live session, then tenant context, then the idempotency store.

DROP FUNCTION auth.find_session_for_command(bytea, integer);

-- Revokes a live session by digest (AUTH-219, AUTH-231). The identifiers are returned only for
-- the session this call revoked, so the caller may audit it under its seller; any other digest
-- answers no row and discloses nothing.
CREATE FUNCTION auth.sign_out_session(p_token_hash bytea, p_idle_seconds integer)
RETURNS TABLE (session_id uuid, account_id uuid, seller_id uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, auth, app
AS $fn$
BEGIN
  IF p_token_hash IS NULL OR octet_length(p_token_hash) <> 32 OR p_idle_seconds IS NULL OR p_idle_seconds < 1 THEN
    RAISE EXCEPTION 'invalid sign-out arguments' USING ERRCODE = 'SO001';
  END IF;
  UPDATE auth.seller_session AS s
     SET revoked_at = now(), revocation_reason = 'signed_out'
    FROM auth.seller_account AS a
   WHERE s.token_hash = p_token_hash
     AND a.id = s.account_id
     AND s.revoked_at IS NULL
     AND s.absolute_expires_at > now()
     AND s.last_seen_at > now() - make_interval(secs => p_idle_seconds)
  RETURNING s.id, s.account_id, a.seller_id INTO session_id, account_id, seller_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  RETURN NEXT;
END
$fn$;

-- The exact-replay capability of D-20 (AUTH-232, OPS-731). Inputs: the presented token's digest
-- and the client's idempotency key; the command identity is fixed here and the fingerprint is
-- computed exactly as the application does (canonical JSON of the command name and the
-- initiating session id). Output: verdict 'replay' with the stored outcome, verdict 'conflict'
-- with no outcome, or no row. Never a seller, session, account or token identifier, never
-- whether the digest names a session, never any other receipt.
CREATE FUNCTION auth.replay_sign_out_all(p_token_hash bytea, p_idempotency_key text)
RETURNS TABLE (verdict text, outcome jsonb)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, auth, app
AS $fn$
DECLARE
  v_session_id uuid;
  v_seller_id uuid;
  v_fingerprint text;
  v_command text;
  v_found_command text;
  v_found_fingerprint text;
  v_found_outcome jsonb;
BEGIN
  IF p_token_hash IS NULL OR octet_length(p_token_hash) <> 32
     OR p_idempotency_key IS NULL OR p_idempotency_key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'invalid replay arguments' USING ERRCODE = 'SO002';
  END IF;
  SELECT s.id, a.seller_id
    INTO v_session_id, v_seller_id
    FROM auth.seller_session AS s
    JOIN auth.seller_account AS a ON a.id = s.account_id
   WHERE s.token_hash = p_token_hash;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  v_command := 'seller.sign_out_all';
  v_fingerprint := encode(
    sha256(convert_to('{"command":"' || v_command || '","payload":{"sessionId":"' || v_session_id::text || '"}}', 'UTF8')),
    'hex');
  -- The receipt store is under forced row-level security for every role, this function's owner
  -- included. The tenant setting is created inside a subtransaction that is always rolled back,
  -- so it is gone before this function returns and nothing else in the transaction can use it.
  BEGIN
    PERFORM pg_catalog.set_config('app.seller_id', v_seller_id::text, true);
    SELECT r.command, r.fingerprint, r.outcome
      INTO v_found_command, v_found_fingerprint, v_found_outcome
      FROM app.idempotency_receipt AS r
     WHERE r.seller_id = v_seller_id AND r.idempotency_key = p_idempotency_key;
    RAISE EXCEPTION 'unwind' USING ERRCODE = 'SO003';
  EXCEPTION
    WHEN SQLSTATE 'SO003' THEN
      NULL;
  END;
  IF v_found_command IS NULL THEN
    RETURN;
  END IF;
  IF v_found_command = v_command AND v_found_fingerprint = v_fingerprint THEN
    verdict := 'replay';
    outcome := v_found_outcome;
  ELSE
    verdict := 'conflict';
    outcome := NULL;
  END IF;
  RETURN NEXT;
END
$fn$;

-- Privileges (OPS-716): a new function is executable by PUBLIC by default, so revoke first.
REVOKE ALL ON FUNCTION
  auth.sign_out_session(bytea, integer),
  auth.replay_sign_out_all(bytea, text)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  auth.sign_out_session(bytea, integer),
  auth.replay_sign_out_all(bytea, text)
TO app_runtime;
