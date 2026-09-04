-- 0007_seller_authentication.sql
--
-- Forward-only (OPS-513, OPS-514, OPS-714). Applied once by app_migrator after 0006. Implements
-- the persistence of decisions/DECISION_LOG.md D-19 (Accepted 2026-09-04): seller accounts,
-- opaque database-backed sessions, sign-in throttling and the pre-authentication audit ledger.
--
-- Access model (OPS-716, D-19 condition 3): the runtime role holds NO table privilege in schema
-- auth. Every read and write goes through a SECURITY DEFINER keyhole function owned by the
-- migration role, each taking the one identifier it needs. The runtime role can therefore never
-- select every verifier or every session, and cannot create an account at all: provisioning is
-- an operator action as app_migrator (D-18: no open registration).
--
-- Secrets (AUTH-201, AUTH-205, OPS-712): only an Argon2id PHC verifier and a SHA-256 token
-- digest are ever stored. No plaintext password, no raw session token, no anti-forgery secret
-- (it is derived, never stored), no raw client address (SEC-043) and no raw account identifier
-- in throttle or ledger rows (both are keyed hashes computed by the application).

-- Audit catalogue (ai/POLICY_AND_AUTHORIZATION.md §12, D-19): the six seller-authentication
-- events. Usable once this migration's transaction commits; nothing below references them.
ALTER TYPE app.audit_event_type ADD VALUE IF NOT EXISTS 'SELLER_SIGN_IN_SUCCEEDED';
ALTER TYPE app.audit_event_type ADD VALUE IF NOT EXISTS 'SELLER_SIGN_IN_FAILED';
ALTER TYPE app.audit_event_type ADD VALUE IF NOT EXISTS 'SELLER_SIGN_IN_THROTTLED';
ALTER TYPE app.audit_event_type ADD VALUE IF NOT EXISTS 'SELLER_SESSION_ROTATED';
ALTER TYPE app.audit_event_type ADD VALUE IF NOT EXISTS 'SELLER_SIGNED_OUT';
ALTER TYPE app.audit_event_type ADD VALUE IF NOT EXISTS 'SELLER_SESSIONS_REVOKED';

CREATE SCHEMA auth;
REVOKE ALL ON SCHEMA auth FROM PUBLIC;

CREATE TYPE auth.throttle_scope AS ENUM ('account', 'client');
CREATE TYPE auth.revocation_reason AS ENUM ('signed_out', 'signed_out_all', 'rotated');

-- ---------------------------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------------------------

-- One account per seller. The verifier is an Argon2id PHC string and nothing else (AUTH-201).
CREATE TABLE auth.seller_account (
  id                   uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id            uuid         NOT NULL UNIQUE REFERENCES app.seller (id),
  email                text         NOT NULL CHECK (length(email) BETWEEN 3 AND 254 AND email !~ '\s'),
  email_normalized     text         NOT NULL UNIQUE
                                    CHECK (email_normalized = lower(btrim(email_normalized)) AND email_normalized ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  password_hash        text         NOT NULL CHECK (
    password_hash ~ '^\$argon2id\$v=19\$m=[0-9]{1,7},t=[0-9]{1,3},p=[0-9]{1,3}\$[A-Za-z0-9+/]{11,}\$[A-Za-z0-9+/]{6,}$'
  ),
  password_updated_at  timestamptz  NOT NULL DEFAULT now(),
  created_at           timestamptz  NOT NULL DEFAULT now(),
  updated_at           timestamptz  NOT NULL DEFAULT now()
);

-- One row per issued session. token_hash is the SHA-256 of the opaque token (OPS-712); the
-- client identifier is a keyed hash with its key version (SEC-043, OPS-568).
CREATE TABLE auth.seller_session (
  id                      uuid                     PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id              uuid                     NOT NULL REFERENCES auth.seller_account (id),
  token_hash              bytea                    NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  client_hash             text                     NOT NULL CHECK (client_hash ~ '^[0-9a-f]{64}$'),
  client_key_version      smallint                 NOT NULL CHECK (client_key_version >= 1),
  created_at              timestamptz              NOT NULL DEFAULT now(),
  last_seen_at            timestamptz              NOT NULL DEFAULT now(),
  absolute_expires_at     timestamptz              NOT NULL,
  revoked_at              timestamptz,
  revocation_reason       auth.revocation_reason,
  replaced_by_session_id  uuid                     REFERENCES auth.seller_session (id),
  CONSTRAINT seller_session_revocation_pair CHECK ((revoked_at IS NULL) = (revocation_reason IS NULL)),
  CONSTRAINT seller_session_lifetime CHECK (absolute_expires_at > created_at)
);
CREATE INDEX seller_session_account_open ON auth.seller_session (account_id) WHERE revoked_at IS NULL;

-- AUTH-204: one counter per hashed subject and scope. Survives restarts; time is the database's.
CREATE TABLE auth.sign_in_throttle (
  scope            auth.throttle_scope  NOT NULL,
  subject_hash     text                 NOT NULL CHECK (subject_hash ~ '^[0-9a-f]{64}$'),
  attempts         integer              NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  locked_until     timestamptz,
  last_attempt_at  timestamptz          NOT NULL DEFAULT now(),
  updated_at       timestamptz          NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, subject_hash)
);

-- AUTH-217 before a seller is known: failed and throttled sign-ins carry hashed identifiers
-- only. app.audit_event needs a tenant; these events happen before one exists.
CREATE TABLE auth.sign_in_event (
  id                    uuid                  PRIMARY KEY DEFAULT gen_random_uuid(),
  seq                   bigint                NOT NULL GENERATED ALWAYS AS IDENTITY UNIQUE,
  -- Compared as text: a value added by ALTER TYPE above cannot be named as an enum literal in
  -- the same transaction (PostgreSQL rule), and the constraint is only ever evaluated on insert.
  event_type            app.audit_event_type  NOT NULL
                                              CHECK (event_type::text IN ('SELLER_SIGN_IN_FAILED', 'SELLER_SIGN_IN_THROTTLED')),
  account_subject_hash  text                  NOT NULL CHECK (account_subject_hash ~ '^[0-9a-f]{64}$'),
  client_hash           text                  NOT NULL CHECK (client_hash ~ '^[0-9a-f]{64}$'),
  client_key_version    smallint              NOT NULL CHECK (client_key_version >= 1),
  request_id            text                  NOT NULL,
  summary               jsonb                 NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(summary) = 'object'),
  created_at            timestamptz           NOT NULL DEFAULT now()
);
CREATE INDEX sign_in_event_account ON auth.sign_in_event (account_subject_hash, created_at);
CREATE INDEX sign_in_event_client ON auth.sign_in_event (client_hash, created_at);

-- ---------------------------------------------------------------------------------------------
-- Guards: identity immutable, revocation final, ledger append-only
-- ---------------------------------------------------------------------------------------------

CREATE FUNCTION auth.seller_account_guard() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'seller accounts are not deleted in this slice' USING ERRCODE = 'SA001';
  END IF;
  IF NEW.id <> OLD.id OR NEW.seller_id <> OLD.seller_id OR NEW.email_normalized <> OLD.email_normalized
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'seller account identity is immutable' USING ERRCODE = 'SA001';
  END IF;
  IF NEW.password_hash <> OLD.password_hash THEN
    NEW.password_updated_at := now();
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$fn$;
CREATE TRIGGER seller_account_guard BEFORE UPDATE OR DELETE ON auth.seller_account
  FOR EACH ROW EXECUTE FUNCTION auth.seller_account_guard();

CREATE FUNCTION auth.seller_session_guard() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'sessions are revoked, never deleted, in this slice' USING ERRCODE = 'SS001';
  END IF;
  IF NEW.id <> OLD.id OR NEW.account_id <> OLD.account_id OR NEW.token_hash <> OLD.token_hash
     OR NEW.created_at <> OLD.created_at OR NEW.absolute_expires_at <> OLD.absolute_expires_at
     OR NEW.client_hash <> OLD.client_hash OR NEW.client_key_version <> OLD.client_key_version THEN
    RAISE EXCEPTION 'session identity is immutable' USING ERRCODE = 'SS001';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
     OR NEW.revocation_reason IS DISTINCT FROM OLD.revocation_reason
     OR NEW.replaced_by_session_id IS DISTINCT FROM OLD.replaced_by_session_id
     OR NEW.last_seen_at <> OLD.last_seen_at) THEN
    RAISE EXCEPTION 'a revoked session stays revoked' USING ERRCODE = 'SS002';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER seller_session_guard BEFORE UPDATE OR DELETE ON auth.seller_session
  FOR EACH ROW EXECUTE FUNCTION auth.seller_session_guard();

CREATE TRIGGER sign_in_event_append_only BEFORE UPDATE OR DELETE ON auth.sign_in_event
  FOR EACH ROW EXECUTE FUNCTION app.reject_mutation();

-- ---------------------------------------------------------------------------------------------
-- Keyhole functions (SECURITY DEFINER, owned by app_migrator, search_path pinned)
-- ---------------------------------------------------------------------------------------------

-- The verifier for exactly one normalized address, or no row. The only way the runtime role can
-- read a verifier, one at a time and only by knowing the address.
CREATE FUNCTION auth.sign_in_lookup(p_email_normalized text)
RETURNS TABLE (account_id uuid, seller_id uuid, password_hash text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, auth, app
AS $fn$
  SELECT a.id, a.seller_id, a.password_hash
    FROM auth.seller_account a
   WHERE a.email_normalized = p_email_normalized
$fn$;

-- AUTH-204: counts an attempt under a row lock before any credential work, so parallel attempts
-- serialise here and cannot slip past the limit. Policy parameters come from the application and
-- are documented there. An attempt refused while locked does not extend the lock, so a flood
-- cannot lock the owner out for longer than the cap (the cap itself is the policy's bound).
CREATE FUNCTION auth.reserve_sign_in_attempt(
  p_scope auth.throttle_scope,
  p_subject_hash text,
  p_free_attempts integer,
  p_base_seconds integer,
  p_cap_seconds integer,
  p_decay_seconds integer
)
RETURNS TABLE (allowed boolean, retry_after_seconds integer, attempts integer)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, auth, app
AS $fn$
DECLARE
  row_attempts integer;
  row_locked_until timestamptz;
  row_last timestamptz;
  delay_seconds numeric;
BEGIN
  IF p_free_attempts < 0 OR p_base_seconds < 1 OR p_cap_seconds < p_base_seconds OR p_decay_seconds < 1 THEN
    RAISE EXCEPTION 'invalid throttle policy' USING ERRCODE = 'ST001';
  END IF;
  INSERT INTO auth.sign_in_throttle (scope, subject_hash) VALUES (p_scope, p_subject_hash)
  ON CONFLICT (scope, subject_hash) DO UPDATE SET updated_at = now()
  RETURNING sign_in_throttle.attempts, sign_in_throttle.locked_until, sign_in_throttle.last_attempt_at
       INTO row_attempts, row_locked_until, row_last;
  IF row_last < now() - make_interval(secs => p_decay_seconds) THEN
    row_attempts := 0;
    row_locked_until := NULL;
  END IF;
  IF row_locked_until IS NOT NULL AND row_locked_until > now() THEN
    allowed := false;
    retry_after_seconds := GREATEST(1, ceil(extract(epoch FROM (row_locked_until - now())))::integer);
    attempts := row_attempts;
    RETURN NEXT;
    RETURN;
  END IF;
  row_attempts := row_attempts + 1;
  IF row_attempts > p_free_attempts THEN
    delay_seconds := LEAST(p_cap_seconds::numeric, p_base_seconds::numeric * power(2::numeric, row_attempts - p_free_attempts - 1));
    row_locked_until := now() + make_interval(secs => delay_seconds);
  ELSE
    row_locked_until := NULL;
  END IF;
  UPDATE auth.sign_in_throttle
     SET attempts = row_attempts, locked_until = row_locked_until, last_attempt_at = now(), updated_at = now()
   WHERE scope = p_scope AND subject_hash = p_subject_hash;
  allowed := true;
  retry_after_seconds := 0;
  attempts := row_attempts;
  RETURN NEXT;
END
$fn$;

-- A successful sign-in clears the account's counter (the owner is back in). Client counters
-- decay with time only, so one valid account cannot be used to reset a client's limit.
CREATE FUNCTION auth.record_sign_in_success(p_account_subject_hash text)
RETURNS void
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, auth, app
AS $fn$
  UPDATE auth.sign_in_throttle
     SET attempts = 0, locked_until = NULL, updated_at = now()
   WHERE scope = 'account' AND subject_hash = p_account_subject_hash
$fn$;

CREATE FUNCTION auth.record_sign_in_event(
  p_event_type app.audit_event_type,
  p_account_subject_hash text,
  p_client_hash text,
  p_client_key_version smallint,
  p_request_id text,
  p_summary jsonb
)
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, auth, app
AS $fn$
  INSERT INTO auth.sign_in_event (event_type, account_subject_hash, client_hash, client_key_version, request_id, summary)
  VALUES (p_event_type, p_account_subject_hash, p_client_hash, p_client_key_version, p_request_id, p_summary)
  RETURNING id
$fn$;

CREATE FUNCTION auth.create_session(
  p_account_id uuid,
  p_token_hash bytea,
  p_client_hash text,
  p_client_key_version smallint,
  p_absolute_seconds integer
)
RETURNS TABLE (id uuid, absolute_expires_at timestamptz)
LANGUAGE sql
SECURITY DEFINER
SET search_path = pg_catalog, auth, app
AS $fn$
  INSERT INTO auth.seller_session (account_id, token_hash, client_hash, client_key_version, absolute_expires_at)
  VALUES (p_account_id, p_token_hash, p_client_hash, p_client_key_version, now() + make_interval(secs => p_absolute_seconds))
  RETURNING seller_session.id, seller_session.absolute_expires_at
$fn$;

-- The live session for a token digest, locked for the transaction and touched, or no row.
-- Liveness is the database clock's decision: not revoked, before the absolute lifetime, and
-- seen within the idle timeout (AUTH-207, OPS-741).
CREATE FUNCTION auth.resolve_session(p_token_hash bytea, p_idle_seconds integer)
RETURNS TABLE (session_id uuid, account_id uuid, seller_id uuid, absolute_expires_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, auth, app
AS $fn$
BEGIN
  SELECT s.id, s.account_id, a.seller_id, s.absolute_expires_at
    INTO session_id, account_id, seller_id, absolute_expires_at
    FROM auth.seller_session s
    JOIN auth.seller_account a ON a.id = s.account_id
   WHERE s.token_hash = p_token_hash
     AND s.revoked_at IS NULL
     AND s.absolute_expires_at > now()
     AND s.last_seen_at > now() - make_interval(secs => p_idle_seconds)
     FOR UPDATE OF s;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  UPDATE auth.seller_session SET last_seen_at = now() WHERE id = session_id;
  RETURN NEXT;
END
$fn$;

-- AUTH-206: a new session inherits the absolute lifetime; the old one is revoked in the same
-- statement sequence, so no observer sees two live sessions from one rotation.
CREATE FUNCTION auth.rotate_session(
  p_session_id uuid,
  p_new_token_hash bytea,
  p_client_hash text,
  p_client_key_version smallint
)
RETURNS TABLE (id uuid, absolute_expires_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, auth, app
AS $fn$
DECLARE
  old auth.seller_session;
  v_new_id uuid;
  v_new_expires timestamptz;
BEGIN
  SELECT * INTO old FROM auth.seller_session s WHERE s.id = p_session_id AND s.revoked_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'session is not live' USING ERRCODE = 'SS003';
  END IF;
  INSERT INTO auth.seller_session (account_id, token_hash, client_hash, client_key_version, absolute_expires_at)
  VALUES (old.account_id, p_new_token_hash, p_client_hash, p_client_key_version, old.absolute_expires_at)
  RETURNING seller_session.id, seller_session.absolute_expires_at INTO v_new_id, v_new_expires;
  UPDATE auth.seller_session s
     SET revoked_at = now(), revocation_reason = 'rotated', replaced_by_session_id = v_new_id
   WHERE s.id = p_session_id;
  id := v_new_id;
  absolute_expires_at := v_new_expires;
  RETURN NEXT;
END
$fn$;

CREATE FUNCTION auth.revoke_session(p_session_id uuid, p_reason auth.revocation_reason)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, auth, app
AS $fn$
DECLARE
  n integer;
BEGIN
  UPDATE auth.seller_session
     SET revoked_at = now(), revocation_reason = p_reason
   WHERE id = p_session_id AND revoked_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n = 1;
END
$fn$;

CREATE FUNCTION auth.revoke_account_sessions(p_account_id uuid, p_reason auth.revocation_reason)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, auth, app
AS $fn$
DECLARE
  n integer;
BEGIN
  UPDATE auth.seller_session
     SET revoked_at = now(), revocation_reason = p_reason
   WHERE account_id = p_account_id AND revoked_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END
$fn$;

-- AUTH-208: the account's live sessions, without the token digest.
CREATE FUNCTION auth.list_account_sessions(p_account_id uuid)
RETURNS TABLE (id uuid, created_at timestamptz, last_seen_at timestamptz, absolute_expires_at timestamptz)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, auth, app
AS $fn$
  SELECT s.id, s.created_at, s.last_seen_at, s.absolute_expires_at
    FROM auth.seller_session s
   WHERE s.account_id = p_account_id AND s.revoked_at IS NULL AND s.absolute_expires_at > now()
   ORDER BY s.created_at
$fn$;

-- ---------------------------------------------------------------------------------------------
-- Privileges: the runtime role executes the keyholes and touches no table (OPS-716)
-- ---------------------------------------------------------------------------------------------

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA auth FROM PUBLIC;
GRANT USAGE ON SCHEMA auth TO app_runtime;
GRANT EXECUTE ON FUNCTION
  auth.sign_in_lookup(text),
  auth.reserve_sign_in_attempt(auth.throttle_scope, text, integer, integer, integer, integer),
  auth.record_sign_in_success(text),
  auth.record_sign_in_event(app.audit_event_type, text, text, smallint, text, jsonb),
  auth.create_session(uuid, bytea, text, smallint, integer),
  auth.resolve_session(bytea, integer),
  auth.rotate_session(uuid, bytea, text, smallint),
  auth.revoke_session(uuid, auth.revocation_reason),
  auth.revoke_account_sessions(uuid, auth.revocation_reason),
  auth.list_account_sessions(uuid)
TO app_runtime;
