-- Spike-only schema. NOT a production migration: it is applied by the spike's test harness after
-- the production migrations, to evaluate the shape a real forward-only migration would take.
--
-- Two tables, owned by the migration role, DML-only for the runtime role (OPS-716):
--   auth.seller_account  one account per seller; the Argon2id verifier lives here (AUTH-201)
--   auth.seller_session  one row per issued session; only the token's SHA-256 is stored (AUTH-205)
-- Neither table carries tenant row-level security: the session row is what resolves the tenant,
-- so it is read before any tenant context exists. The runtime role holds no DELETE on either.

CREATE SCHEMA auth;

CREATE TABLE auth.seller_account (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  seller_id         uuid        NOT NULL UNIQUE REFERENCES app.seller (id),
  email             text        NOT NULL CHECK (length(email) BETWEEN 3 AND 254),
  email_normalized  text        NOT NULL UNIQUE CHECK (email_normalized = lower(btrim(email_normalized))),
  -- Argon2id PHC string only. No plaintext, no reversible form (AUTH-201).
  password_hash     text        NOT NULL CHECK (
    password_hash ~ '^\$argon2id\$v=19\$m=[0-9]{1,7},t=[0-9]{1,3},p=[0-9]{1,3}\$[A-Za-z0-9+/]{11,}\$[A-Za-z0-9+/]{6,}$'
  ),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE auth.seller_session (
  id                      uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id              uuid        NOT NULL REFERENCES auth.seller_account (id),
  -- SHA-256 of the opaque token: exactly 32 bytes, unique (OPS-712).
  token_hash              bytea       NOT NULL UNIQUE CHECK (octet_length(token_hash) = 32),
  client_hash             text        NOT NULL CHECK (client_hash ~ '^[0-9a-f]{32}$'),
  created_at              timestamptz NOT NULL DEFAULT now(),
  last_seen_at            timestamptz NOT NULL DEFAULT now(),
  absolute_expires_at     timestamptz NOT NULL,
  revoked_at              timestamptz,
  revocation_reason       text        CHECK (revocation_reason IN ('signed_out', 'signed_out_all', 'rotated')),
  replaced_by_session_id  uuid        REFERENCES auth.seller_session (id),
  CONSTRAINT seller_session_revocation_pair CHECK ((revoked_at IS NULL) = (revocation_reason IS NULL)),
  CONSTRAINT seller_session_lifetime CHECK (absolute_expires_at > created_at)
);
CREATE INDEX seller_session_account_open ON auth.seller_session (account_id) WHERE revoked_at IS NULL;

-- A session's identity never changes, and a revocation is final.
CREATE FUNCTION auth.seller_session_guard() RETURNS trigger
LANGUAGE plpgsql
AS $fn$
BEGIN
  IF NEW.id <> OLD.id OR NEW.account_id <> OLD.account_id OR NEW.token_hash <> OLD.token_hash
     OR NEW.created_at <> OLD.created_at OR NEW.absolute_expires_at <> OLD.absolute_expires_at THEN
    RAISE EXCEPTION 'session identity is immutable' USING ERRCODE = 'SS001';
  END IF;
  IF OLD.revoked_at IS NOT NULL AND (NEW.revoked_at IS DISTINCT FROM OLD.revoked_at
     OR NEW.revocation_reason IS DISTINCT FROM OLD.revocation_reason) THEN
    RAISE EXCEPTION 'a revoked session stays revoked' USING ERRCODE = 'SS002';
  END IF;
  RETURN NEW;
END
$fn$;
CREATE TRIGGER seller_session_guard BEFORE UPDATE ON auth.seller_session
  FOR EACH ROW EXECUTE FUNCTION auth.seller_session_guard();

GRANT USAGE ON SCHEMA auth TO app_runtime;
GRANT SELECT, INSERT, UPDATE ON auth.seller_account, auth.seller_session TO app_runtime;
