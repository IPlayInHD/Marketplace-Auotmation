# Backend — private alpha

**Status.** Private-alpha implementation authorised by `docs/decisions/DECISION_LOG.md` D-18 on
the D-17 baseline. Slice 0 validation is deferred, incomplete and unpassed; nothing here is
validation evidence. No public surface exists: no buyer page, no sign-up, no marketplace link.
Every seller in this codebase is a synthetic, founder-controlled identity.

This directory is the one modular monolith of D-17 (`ARCH-015`): one codebase, one container
image later, two entry points (`web` here; `worker` is not yet part of any slice).

## What this slice contains (Slice 1a)

The listing-domain foundation and the DRAFT → READY transition:

| Concern                                                                                                                                                                                                   | Where                                                                         | Canonical anchor                               |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------- |
| Forward-only SQL migrations, ledger with checksums, advisory-locked runner                                                                                                                                | `src/db/migrate.ts`, `src/db/migrations/`                                     | `OPS-513`, `OPS-514`, `OPS-714`                |
| Roles: `app_migrator` owns everything; `app_runtime` is DML-only, no DDL, no `BYPASSRLS`                                                                                                                  | `src/db/migrate.ts` (bootstrap), migration grants                             | `OPS-716`, D-17                                |
| Row-level security on every seller-owned table, forced for the owner, fail-closed without context                                                                                                         | migration `0001`                                                              | `SEC-100`, `SEC-101`                           |
| Single tenant-context construction site, transaction-scoped                                                                                                                                               | `src/db/kysely.ts` `withTenant()`                                             | `SEC-101`                                      |
| Entities: `seller`, `inventory_item`, `listing`, `listing_content_version`, `product_fact`, `seller_policy_version`, `audit_event`, `idempotency_receipt`, `public_listing_access`, `listing_access_code` | migrations `0001`, `0003`, `0004`, `0005`, `0006`, `0007`, `src/db/schema.ts` | `DOMAIN_MODEL.md`, `DM-01`, `DM-06`, `DM-07`   |
| Listing lifecycle guard: only the drawn transitions, SM-L-01 prerequisites named, `row_version` increment                                                                                                 | migration `0001` triggers, `src/modules/listings/`                            | `STATE_MACHINES.md` §1, `OPS-707`, `OPS-738`   |
| Content version guard: words immutable, only §8 transitions, one APPROVED per listing                                                                                                                     | migration `0001` triggers                                                     | `STATE_MACHINES.md` §8, `SM-CT-01`, `OPS-706`  |
| Seller-provided facts as the only provenance; approved copy details must be backed by facts                                                                                                               | `product_fact` constraint, READY guard                                        | D-10, `INV-12`                                 |
| Minimum price on the policy version only, protected; buyer-safe projection cannot hold it                                                                                                                 | `src/modules/seller-policy/`, `src/modules/public-listing-access/`            | D-04, `SEC-021`, `OPS-724`                     |
| Append-only audit events with request id, actor, subject, policy version; idempotency receipts with command fingerprint and stored outcome                                                                | `src/modules/audit/`                                                          | `OPS-780` to `OPS-784`, `OPS-730` to `OPS-733` |
| Module boundaries enforced in the build                                                                                                                                                                   | `.dependency-cruiser.cjs`                                                     | `ARCH` §3, `OPS-702`                           |
| Fastify `web` skeleton: `/health`, empty seller and buyer route trees, loopback bind                                                                                                                      | `src/web/`                                                                    | `ARCH-002`, `AUTH-222`, D-18                   |

Not here, by design: authentication (the approach is D-19, Accepted 2026-09-04, and not yet
implemented; implementation is bound by D-19's acceptance conditions), sign-up, any frontend, images,
enhancement, AI, buyer sessions, conversations, offers, notifications, analytics, pg-boss jobs,
public buyer routes, deployment.

## D-17 follow-up 7: formatter and linter

Closed by this directory's configuration:

| Tool               | Version                                                                                    | Role                                                                                              |
| ------------------ | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| Prettier           | 3.9.6                                                                                      | The canonical formatter (`.prettierrc.json`); `npm run format:check` fails the build              |
| ESLint             | 10.9.1 with typescript-eslint 8.69.0, `@eslint/js` 10.0.1, `eslint-config-prettier` 10.1.8 | The canonical linter: type-checked recommended rules plus the project rules in `eslint.config.js` |
| dependency-cruiser | 18.2.0                                                                                     | Architecture-boundary rules (`.dependency-cruiser.cjs`)                                           |

TypeScript 6.0.3 with `strict` and the settings in `tsconfig.json`; Vitest 4.1.11; Testcontainers
12.1.0. All versions are pinned exactly and the lockfile is committed (`.npmrc` sets
`save-exact` and `ignore-scripts`).

## Prerequisites

- Node.js 24 LTS and npm 11. `.node-version` pins the exact release the backend is developed and
  verified on; CI installs that release.
- Docker with a reachable daemon, for the integration tests. No local PostgreSQL is used.
- Network access to pull `postgres:16-alpine` and `testcontainers/ryuk:0.14.0`, directly or
  through a mirror:

```
export TESTCONTAINERS_HUB_IMAGE_NAME_PREFIX=mirror.gcr.io/
```

### PostgreSQL test image

The suite runs against `postgres:16-alpine`. The digest the D-17 spike was accepted against, and
that this suite was run against, is
`sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685` (PostgreSQL 16.15). A
tag is mutable; pin the digest in CI without changing any file:

```
export BACKEND_POSTGRES_IMAGE=postgres@sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685
```

## Commands

```
npm ci --ignore-scripts     # install from the lockfile
npm run format:check        # Prettier
npm run lint                # ESLint (type-checked)
npm run typecheck           # tsc --noEmit
npm run depcruise           # module-boundary rules
npm test                    # unit + integration (real PostgreSQL containers)
npm run check               # all of the above, in order
npm run migrate             # apply pending migrations; needs MIGRATION_DATABASE_URL (app_migrator)
npm run web                 # start the web process; needs DATABASE_URL (app_runtime)
```

## Slice 1d: seller authentication foundation (D-19)

Decision D-19 (Accepted 2026-09-04) is implemented as Module 1, `src/modules/identity-auth/`,
with migrations `0007` to `0009` and the seller route tree `src/web/routes/seller.ts`. Founder-controlled
synthetic accounts only (D-18): there is no sign-up, no password reset, no verification, no
second factor and no buyer authentication.

| Concern                                         | Where                                                                                             | What holds                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Passwords (`AUTH-201`)                          | `password.ts`                                                                                     | Argon2id from `node:crypto` (`crypto.argon2`, Node.js 24.7.0+), policy `m=19456` KiB, `t=2`, `p=1`, 32-byte tag, 16-byte salt, PHC encoding, bounded decoding, `needsRehash`, a decoy verifier for unknown accounts. Startup fails closed without the capability; no fallback library exists                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Sessions (`AUTH-205` to `AUTH-208`, `AUTH-219`) | `session-token.ts`, `service.ts`, migration `0007`                                                | 32-byte CSPRNG tokens; only the SHA-256 is stored; idle and absolute lifetimes decided by the database clock; rotation, sign-out and sign-out-all in one transaction each; identity immutable and revocation final at the data layer (`SS001`, `SS002`). At most `AUTH_MAX_ACTIVE_SESSIONS` (default 10) live sessions per account: a sign-in at the cap evicts the oldest live sessions under the account's row lock, each audited as `SELLER_SESSION_EVICTED` (`AUTH-230`, D-20)                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Cookie (`AUTH-205`)                             | `cookie.ts`                                                                                       | `__Host-seller_session`, `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, no `Domain`; `http` on loopback in `local` only; no signing secret                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| CSRF (`SEC-310`, `SEC-311`)                     | `csrf.ts`                                                                                         | `Origin`, else `Referer`, must equal `AUTH_SELLER_ORIGIN`; `Sec-Fetch-Site` other than `same-origin` refuses; absence refuses. State-changing session routes also need the `x-anti-forgery` header, an HMAC of the session token that is stored nowhere                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Client identity (`SEC-043`, `OPS-568`)          | `client-identity.ts`                                                                              | The TCP peer is the client unless it is a configured trusted proxy; then the forwarding chain is walked from the right past trusted hops and the first untrusted node is the client. Malformed, ambiguous or conflicting chains fail closed. IPv4 exact, IPv6 by /64. Stored and audited only as `HMAC-SHA256(AUTH_CLIENT_HASH_KEY, …)` with its key version                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Throttling (`AUTH-204`)                         | `throttle.ts`, `auth.reserve_sign_in_attempt`, `auth.finalize_sign_in_attempt` (migration `0008`) | Only completed authentication failures count, per hashed account and per hashed client. Capacity is reserved under a row lock before any credential work and finalized by the outcome: a failure adds one failure and the lock it earns, a success adds nothing and clears the account's failures only. Free allowance 3 failures (account) and 10 (client); then `base × 2^(n−free−1)` seconds capped at 60 s (account) and 900 s (client), one attempt in flight at a time beyond the allowance; refusals answer `429` with the database clock's remaining lock as `Retry-After` and change nothing; failures decay after an hour without one; a reservation left unfinalized (a lost process) counts as in flight for at most 60 s, never as a failure                                                                                                                                           |
| Tenant context (`SEC-101`)                      | `service.ts` `withSellerSession`                                                                  | One transaction resolves the session by hash, checks expiry and revocation, then calls the same `establishTenantContext` as `withTenant`; the setting dies with the transaction. Seller identifiers in headers, query strings, bodies or other cookies are never read                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Data access (`OPS-716`)                         | migrations `0007` to `0009`                                                                       | Schema `auth` is owned by `app_migrator`; `app_runtime` holds no table privilege and executes eleven `SECURITY DEFINER` keyhole functions with a pinned `search_path`, each taking the one identifier it needs. The runtime role cannot create an account                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Audit (`AUTH-217`)                              | `ai/POLICY_AND_AUTHORIZATION.md` §12                                                              | `SELLER_SIGN_IN_SUCCEEDED`, `SELLER_SESSION_ROTATED`, `SELLER_SIGNED_OUT`, `SELLER_SESSIONS_REVOKED`, `SELLER_SESSION_EVICTED` in the seller's audit trail; `SELLER_SIGN_IN_FAILED`, `SELLER_SIGN_IN_THROTTLED` in the pre-authentication ledger `auth.sign_in_event`, hashed identifiers only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Routes (`AUTH-222`)                             | `src/web/authorization.ts`, `src/web/routes/seller.ts`                                            | `POST /seller/auth/sign-in`, `GET /seller/auth/me`, `GET /seller/auth/sessions`, `POST /seller/auth/sessions/rotate`, `POST /seller/auth/sign-out`, `POST /seller/auth/sign-out-all`. Every seller route carries an authorization declaration or the process refuses to start. Idempotency (D-20): the GET routes and sign-in take no key; sign-in and rotation are one-time-secret exceptions with no exact-response receipt (an `Idempotency-Key` header on them is ignored); sign-out answers one fixed `204` however often it is repeated; sign-out-all requires an `Idempotency-Key` header holding a client-generated UUID (`400 idempotency_key_required` otherwise), stores a non-secret receipt, replays `{ revoked }` under the same key and initiating token even after that token was revoked, and answers `409 idempotency_conflict` for the same key under another session or command |

Provisioning is an operator action as the migration role, never a route:

```
printf '%s' '{"displayName":"Synthetic Seller A","email":"seller-a@synthetic.invalid","password":"…"}' \
  | MIGRATION_DATABASE_URL=postgresql://app_migrator:…@localhost/marketplace APP_ENV=local npm run provision:seller-account
```

The password travels on stdin only, the tool refuses `APP_ENV=production`, prints the created
identifiers and nothing else, and states that open registration does not exist. Test suites:
`test/unit/seller-auth-*.test.ts`, `test/integration/seller-auth*.test.ts` (`seller-auth-idempotency`
proves D-20, `seller-auth-throttle` the `AUTH-204` limiter, and `seller-auth-timing` is the
`AUTH-203` timing-distribution gate and prints its observations), plus the auth-schema checks in
`migrations.test.ts` and the route inventory in `web.test.ts`.

## Environment variables

| Variable                                                     | Used by           | Meaning                                                                                                                                                                                                 |
| ------------------------------------------------------------ | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MIGRATION_DATABASE_URL`                                     | `npm run migrate` | Connection string for `app_migrator`. Never given to a running process                                                                                                                                  |
| `DATABASE_URL`                                               | `npm run web`     | Connection string for `app_runtime`                                                                                                                                                                     |
| `APP_ENV`                                                    | web               | `local` (default), `ci`, `staging`, `production` (`OPERATIONS.md` §1)                                                                                                                                   |
| `HOST`, `PORT`                                               | web               | Bind address. Loopback (default `127.0.0.1`) unless `BACKEND_ALLOW_NETWORK_BIND=true`, which an operator sets only for a founder-operated internal demonstration (D-18)                                 |
| `LOG_LEVEL`                                                  | web               | pino level                                                                                                                                                                                              |
| `BACKEND_POSTGRES_IMAGE`                                     | tests             | Test image reference (see above)                                                                                                                                                                        |
| `AUTH_SELLER_ORIGIN`                                         | web               | The seller application's origin, e.g. `https://seller.example`; `http` on loopback in `local` only. Every state-changing seller request must come from it (`SEC-311`)                                   |
| `AUTH_CLIENT_HASH_KEY`                                       | web               | 32 to 64 random bytes as lowercase hex: the key of the keyed client and account identifier hashes (`SEC-043`). A server-side secret from the environment or a secret store, never in source (`OPS-729`) |
| `AUTH_CLIENT_HASH_KEY_VERSION`                               | web               | Integer, default `1`; stored beside every hash so the key can be rotated                                                                                                                                |
| `AUTH_TRUSTED_PROXIES`                                       | web               | Comma-separated IP addresses or CIDR ranges whose forwarding headers are believed. Empty (default): the TCP peer is the client and every forwarding header is ignored                                   |
| `AUTH_SESSION_IDLE_SECONDS`, `AUTH_SESSION_ABSOLUTE_SECONDS` | web               | Session lifetimes, defaults 12 hours and 30 days (`AUTH-207`)                                                                                                                                           |
| `AUTH_MAX_ACTIVE_SESSIONS`                                   | web               | Live sessions per seller account, integer 1 to 50, default 10; a sign-in beyond it evicts the oldest live sessions (`AUTH-230`, D-20)                                                                   |

No `.env` file is read and none is committed. Credentials come from the environment or a secret
store (`OPS-729`).

## Role and permission model

Two roles, created once by a superuser (`bootstrapRoles`), which is never used afterwards except
by tests for privileged inspection.

| Role           | Attributes                                                                                  | Owns                                                    | May                                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app_migrator` | `LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT`, `CREATE` on the database | schema `app`, schema `migration` and everything in both | run migrations                                                                                                                                                                                                                                                                                                                                                                                              |
| `app_runtime`  | same, without `CREATE`                                                                      | nothing                                                 | `seller`, `inventory_item`, `listing`, `listing_content_version`, `product_fact`: SELECT INSERT UPDATE · `public_listing_access`, `listing_access_code`: SELECT INSERT UPDATE · `seller_policy_version`, `audit_event`, `idempotency_receipt`: SELECT INSERT · schema `auth`: EXECUTE on the eleven keyhole functions of migrations `0007` to `0009` and no table privilege at all · nothing on `migration` |

Tenant context is `set_config('app.seller_id', <uuid>, true)` inside a transaction, established
only by `withTenant()`. `app.current_seller_id()` returns `NULLIF(current_setting(..., true),
'')::uuid`: absent or empty context is NULL and admits no row; a non-UUID value raises `22P02`.
`FORCE ROW LEVEL SECURITY` makes the owner subject to the policies too.

## Schema notes

- **Money.** `app.minor_units` (bigint, ≥ 0) with `app.currency_code` (ISO 4217). No float,
  numeric or decimal money column exists; a test scans the schema for one.
- **Asking price** is on `listing`; **minimum price** is on `seller_policy_version` and nowhere
  else (D-04). The buyer-safe projection type cannot hold it (compile-time and runtime guards).
- **Content versions** are written once. Approval marks the same version `APPROVED` with
  `SELLER_APPROVED_COPY` provenance, `approved_at` and `approved_by` (LIST-105, LIST-108); the
  words never change and a trigger rejects any other update or any delete. A newer approval
  supersedes the previous version in the same transaction (SM-CT-01, SM-CT-02).
- **Facts.** `product_fact` accepts only `SELLER_PROVIDED_FACT` provenance (D-10). A listing
  cannot reach READY while its approved copy carries a structured detail that no seller fact
  backs (INV-12); `createSellerDraft` refuses such a draft earlier.
- **Policy versions**, **audit events** and **idempotency receipts** are append-only at two
  layers: the runtime role holds no UPDATE or DELETE privilege, and a trigger rejects them for
  the owner as well.
- **Listing status** changes only along STATE_MACHINES §1 edges, enforced by a trigger; READY
  additionally requires the SM-L-01 prerequisites, and the refusal names what is missing
  (`SQLSTATE LS002`, DETAIL). `row_version` must advance by exactly one on every update.
- **Audit event types** are exactly the §12 list of `ai/POLICY_AND_AUTHORIZATION.md`, which since
  2026-09-03 names `LISTING_STATUS_CHANGED` (every lifecycle transition, previous and new status)
  and `LISTING_ASKING_PRICE_CHANGED` (every asking-price or currency change, previous and new
  values, never the minimum). A unit test and an integration test keep the document, the
  TypeScript list and the database enum identical (`OPS-781`).
- **Idempotency** (`OPS-730` to `OPS-733`). Every command writes a receipt under its key in the
  same transaction as its effect: the command name, a SHA-256 fingerprint of the payload (never
  the payload, which for a policy holds the minimum price) and the outcome returned to the
  caller, which the forbidden-key guard checks like an audit payload. The receipt is read before
  any current-state check, so a retry with the same key and payload returns the original
  outcome even after the price, the status or `row_version` has moved on, and never re-runs the
  mutation; the same key with a different command or payload is a conflict. Submitting the
  asking price a DRAFT listing already carries is a successful no-op: no write, no `row_version`
  change and no change event, but the receipt is written and the key consumed, so its retry is
  stable too. Receipts are never deleted in this slice, which satisfies the retention floor of
  `OPS-733`; a configured retry horizon and a retention job are not part of it. The sign-out-all
  receipt of D-20 (`seller.sign_out_all`) is part of that same follow-up: until retention is
  implemented the private-alpha restriction of D-18 stays in force.
- Layouts that DOMAIN_MODEL.md leaves indicative (policy fields, fact keys) are fixed here as the
  LIST-002 and LIST-022 lists. If the founders read any of this as a deviation from the domain
  model, it is recorded in the decision log, per that document's own rule.

## Slice 1b: public access domain

Migration `0004` adds `PublicListingAccess` and `ListingAccessCode` (`DOMAIN_MODEL.md`, `DM-08`,
`DM-09`) and the modules that own them: `src/modules/public-listing-access/` (Module 6, the surface
record and its opaque public id; it still never imports Seller Policy or Audit) and
`src/modules/access-codes/` (Module 7: issue, hash, verify, rotate, revoke). No buyer route exists;
everything runs inside a seller's tenant transaction (D-18).

- **Opaque public id** (`SEC-003`, `OPS-711`, `BUYER-002`): sixteen lowercase base32 characters
  from ten CSPRNG bytes, 80 bits, generated from nothing else. One access per listing; rotation
  and re-issue keep it (`BUYER-003`).
- **Codes** (`BUYER-008`, `OPS-710`, `ACCESS-013`): six digits from `randomInt`, leading zeros
  kept. The only stored form is a salted scrypt hash in a self-describing string
  (`$scrypt$ln=14,r=8,p=1$salt$key`); a CHECK refuses any other shape, so a six-digit value cannot
  be written. No pepper, no dependency added. A miss costs one derivation like a hit.
- **READY → LISTED** (`SM-L-02`, `ACCESS-100`): `markListed` locks the listing row, creates or
  re-enables the access, issues the initial ACTIVE code, writes `ACCESS_CODE_CREATED`, then moves
  the listing and writes `LISTING_STATUS_CHANGED` under the seller's key, all in one transaction.
  A trigger refuses LISTED without an enabled access carrying an ACTIVE code (`LS005`).
- **Rotate, revoke, re-issue** (`SM-C-01`, `SM-C-02`, `OPS-737`, `ACCESS-101`, `ACCESS-102`):
  the access row's version predicate takes the lock first, so concurrent commands serialise and
  the loser sees a concurrency error; a partial unique index allows one ACTIVE code per access;
  a trigger allows only ACTIVE → ROTATED, REVOKED or EXPIRED and never a delete. Revocation
  disables the surface; re-issue reopens it. Events: `ACCESS_CODE_ROTATED`,
  `ACCESS_CODE_REVOKED`, `ACCESS_CODE_CREATED`.
- **Replay without plaintext** (`OPS-731` with `ACCESS-013`, `DATA-106`): the plaintext exists
  only in the return value of the command that issued it. Receipts and audit payloads store the
  code's id, version and status; a replay returns the same outcome with `plaintextCode: null`.
  A seller who never saw the code rotates to get a new one. The logger redacts `plaintextCode`,
  `code` and `code_hash` as a backstop (`OPS-566`).
- **Verification** is an internal function only: true for the ACTIVE, unexpired code of an
  enabled access the tenant owns, false otherwise with no distinguishing error (`SM-C-03`). No
  session, gate, rate limit or lockout exists yet; `EXPIRED` is a drawn state with no job.

## Slice 1c: the lifecycle around LISTED

Migration `0005` and the listings module complete the seller-controlled edges of
`STATE_MACHINES.md` §1 around LISTED and make SM-L-02 a data-layer invariant.

- **Commands** (`src/modules/listings/`): `cancelListing` (LISTED, ACTIVE_CONVERSATIONS or
  OFFER_PENDING → CANCELLED; the ACTIVE code is REVOKED and `ACCESS_CODE_REVOKED` is written),
  `expireListing` (LISTED → EXPIRED; the code becomes EXPIRED and `ACCESS_CODE_EXPIRED` is
  written, an event added to the catalogue on 2026-09-04 to complete `OPS-781`),
  `archiveListing` (CANCELLED → ARCHIVED, `OPS-224`) and `relistListing` (EXPIRED → LISTED on the
  same listing, `SM-L-06`, `OPS-216`, `OPS-219`: the SM-L-01 prerequisites are revalidated, the
  seller must first create and explicitly approve a new content version, which `approveContent`
  now permits while EXPIRED, the same access and public id are re-enabled, a fresh code version is
  issued and no earlier code returns). The listing records the content version each publication
  used (`published_content_version_id`, migration `0006`), and both the command and a trigger
  (`LS007`) refuse a relist whose current version is the previously published one or was created
  or approved before that publication; the earlier version stays in history as SUPERSEDED.
  Relisting from CANCELLED is not drawn: per `OPS-215` it is a new listing on the same item
  through DRAFT → READY → LISTED. SOLD needs the deal flow and is not here. Expiry is an internal
  command with no schedule; nothing decides when a listing expires yet.
- **Invariant**: a listing cannot enter SOLD, CANCELLED, ARCHIVED or EXPIRED while its surface is
  enabled or an ACTIVE code remains (`LS006`); a surface cannot be enabled, nor a code issued, for a
  DRAFT or terminally closed listing (`PA003`, `AC003`); and deferred constraint triggers refuse, at
  commit, any transaction that leaves an enabled surface or an ACTIVE code on a listing that is not
  open, whatever order it wrote in. `listed_at` and `closed_at` come from the database clock.
- **Copy block** (`src/modules/marketplace-abstractions/`, Module 22): a pure formatter that
  builds the pasteable block of `ACCESS-103` from the buyer-safe projection, so it cannot carry a
  protected field: approved title, description and details, price, the buyer URL
  `<origin>/l/<public-id>` (D-02) and the code, plus the `BUYER-024` notice and nothing beyond it
  (`INT-022`). `markListed` and `relistListing` return it when the caller supplies a buyer origin,
  which is validated (https, or http on loopback only, no path, query, credentials or fragment) and
  never hard-coded: hosting and the domain remain undecided (`Q-09`). It is never stored, audited
  or logged, and it is null on a replay because the plaintext code is gone (`ACCESS-013`).

## Continuous integration

`.github/workflows/backend.yml` runs on pull requests, on pushes to `main` and to `claude/**`
branches, and by manual dispatch, filtered to `backend/**`, the workflow and its script, and the
canonical audit-event catalogue that `test/unit/audit-catalogue.test.ts` reads. Two jobs on a
GitHub-hosted `ubuntu-24.04` runner, both with a read-only token (`contents: read`), no secret
and no deploy step (`SEC-384`); actions pinned to commit SHAs and the PostgreSQL image to the
digest above (`SEC-385`); `npm ci --ignore-scripts` from the committed lockfile (`SEC-380`).

- **verify**: `format:check`, `lint`, `typecheck`, `depcruise`, `test:unit`, the migration
  tests alone, then the whole PostgreSQL integration suite under Testcontainers. Any failure
  fails the job. Superseded runs on the same ref are cancelled.
- **audit** (`SEC-382`): `.github/scripts/npm-audit.sh` fails on a confirmed vulnerability with
  the report, and fails separately, saying so, when the advisory service cannot be reached after
  three attempts. An outage is reported as "not assessed", never as clean, and cannot affect the
  `verify` result.

`OPS-714` in CI: the forward-only runner, its checksum ledger and the schema scans run against a
fresh database on every change. The requirement's other half, running migrations against a
database loaded with production-shaped volumes, is not done here: no production data exists
(D-18) and no synthetic volume model has been authorised. It remains an explicit follow-up.
The Testcontainers reaper image `testcontainers/ryuk:0.14.0` is pinned by tag by the library;
version 12.1.0 offers no digest override.

## Tests

`test/unit/` needs no database. `test/integration/` starts one PostgreSQL container per file,
bootstraps the roles, applies the migrations and runs under `app_runtime`, with privileged
inspection through the container superuser only in assertions. Every fixture is synthetic
(`test/helpers/fixtures.ts`); `test/unit/fixtures.test.ts` scans the test tree for anything that
looks like a real contact route.

## Private-alpha boundaries (D-18)

Local development, automated tests, synthetic accounts and data, and founder-operated internal
demonstrations. Not authorised and not present: public launch, open registration, real
participant information, live payments or subscriptions, marketplace scraping, automated posting
or messaging, marketplace credentials, representing Slice 0 as passed, removing seller approval
from anything, fabricating product facts, bypassing marketplace policies.
