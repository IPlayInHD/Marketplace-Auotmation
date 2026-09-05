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
with migrations `0007` to `0010` and the seller route tree `src/web/routes/seller.ts`. Founder-controlled
synthetic accounts only (D-18): there is no sign-up, no password reset, no verification, no
second factor and no buyer authentication.

| Concern                                         | Where                                                                                             | What holds                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Passwords (`AUTH-201`)                          | `password.ts`                                                                                     | Argon2id from `node:crypto` (`crypto.argon2`, Node.js 24.7.0+), policy `m=19456` KiB, `t=2`, `p=1`, 32-byte tag, 16-byte salt, PHC encoding, bounded decoding, `needsRehash`, a decoy verifier for unknown accounts. Startup fails closed without the capability; no fallback library exists                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Sessions (`AUTH-205` to `AUTH-208`, `AUTH-219`) | `session-token.ts`, `service.ts`, migration `0007`                                                | 32-byte CSPRNG tokens; only the SHA-256 is stored; idle and absolute lifetimes decided by the database clock; rotation, sign-out and sign-out-all in one transaction each; identity immutable and revocation final at the data layer (`SS001`, `SS002`). At most `AUTH_MAX_ACTIVE_SESSIONS` (default 10) live sessions per account: a sign-in at the cap evicts the oldest live sessions under the account's row lock, each audited as `SELLER_SESSION_EVICTED` (`AUTH-230`, D-20)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Cookie (`AUTH-205`)                             | `cookie.ts`                                                                                       | `__Host-seller_session`, `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, no `Domain`; `http` on loopback in `local` only; no signing secret                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| CSRF (`SEC-310`, `SEC-311`)                     | `csrf.ts`                                                                                         | `Origin`, else `Referer`, must equal `AUTH_SELLER_ORIGIN`; `Sec-Fetch-Site` other than `same-origin` refuses; absence refuses. State-changing session routes also need the `x-anti-forgery` header, an HMAC of the session token that is stored nowhere                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Client identity (`SEC-043`, `OPS-568`)          | `client-identity.ts`                                                                              | The TCP peer is the client unless it is a configured trusted proxy; then the forwarding chain is walked from the right past trusted hops and the first untrusted node is the client. Malformed, ambiguous or conflicting chains fail closed. IPv4 exact, IPv6 by /64. Stored and audited only as `HMAC-SHA256(AUTH_CLIENT_HASH_KEY, …)` with its key version                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Throttling (`AUTH-204`)                         | `throttle.ts`, `auth.reserve_sign_in_attempt`, `auth.finalize_sign_in_attempt` (migration `0008`) | Only completed authentication failures count, per hashed account and per hashed client. Capacity is reserved under a row lock before any credential work and finalized by the outcome: a failure adds one failure and the lock it earns, a success adds nothing and clears the account's failures only. Free allowance 3 failures (account) and 10 (client); then `base × 2^(n−free−1)` seconds capped at 60 s (account) and 900 s (client), one attempt in flight at a time beyond the allowance; refusals answer `429` with the database clock's remaining lock as `Retry-After` and change nothing; failures decay after an hour without one; a reservation left unfinalized (a lost process) counts as in flight for at most 60 s, never as a failure                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Tenant context (`SEC-101`)                      | `service.ts` `withSellerSession`                                                                  | One transaction resolves the session by hash, checks expiry and revocation, then calls the same `establishTenantContext` as `withTenant`; the setting dies with the transaction. Seller identifiers in headers, query strings, bodies or other cookies are never read. A revoked, expired or unknown session never establishes seller context: the only capability a revoked token keeps is the exact sign-out-all replay below, which resolves no seller, session or token identifier to application code                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Data access (`OPS-716`)                         | migrations `0007` to `0010`                                                                       | Schema `auth` is owned by `app_migrator`; `app_runtime` holds no table privilege and executes twelve `SECURITY DEFINER` keyhole functions with a pinned `search_path`, each taking the one identifier it needs. The runtime role cannot create an account                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Audit (`AUTH-217`)                              | `ai/POLICY_AND_AUTHORIZATION.md` §12                                                              | `SELLER_SIGN_IN_SUCCEEDED`, `SELLER_SESSION_ROTATED`, `SELLER_SIGNED_OUT`, `SELLER_SESSIONS_REVOKED`, `SELLER_SESSION_EVICTED` in the seller's audit trail; `SELLER_SIGN_IN_FAILED`, `SELLER_SIGN_IN_THROTTLED` in the pre-authentication ledger `auth.sign_in_event`, hashed identifiers only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Routes (`AUTH-222`)                             | `src/web/authorization.ts`, `src/web/routes/seller.ts`, `src/web/routes/seller-listings.ts`       | `POST /seller/auth/sign-in`, `GET /seller/auth/me`, `GET /seller/auth/sessions`, `POST /seller/auth/sessions/rotate`, `POST /seller/auth/sign-out`, `POST /seller/auth/sign-out-all`. Every seller route carries a structured `RouteDeclaration` (actor, resource, action, authentication, authorization rule, tenant source, classification, idempotency, audit, failure) or the process refuses to start; the declarations are the constants `SELLER_AUTH_DECLARATIONS` and `SELLER_LISTING_DECLARATIONS`, and `web.test.ts` asserts the inventory against them. The listing routes are in the next section. Idempotency (D-20): the GET routes and sign-in take no key; sign-in and rotation are one-time-secret exceptions with no exact-response receipt (an `Idempotency-Key` header on them is ignored); sign-out answers one fixed `204` however often it is repeated; sign-out-all requires an `Idempotency-Key` header holding a client-generated UUID (`400 idempotency_key_required` otherwise), stores a non-secret receipt, replays `{ revoked }` under the same key and initiating token even after that token was revoked, and answers `409 idempotency_conflict` for the same key under another session or command. That replay is a narrow keyhole (`auth.replay_sign_out_all`, migration `0010`), not authentication: it takes the token digest and the key, answers only the stored outcome, a conflict or nothing, and creates no tenant context; a fresh sign-out-all still requires a live session through the ordinary path |

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

## Slice 1e: the first seller listing routes

Three authenticated routes over Module 3 (`src/modules/listings/`), registered into the seller tree by
`src/web/routes/seller-listings.ts` so the origin hook covers them. Identity comes from the
session cookie only (`AUTH-220`): every handler runs its command inside `withSellerSession`
under forced row-level security, and another tenant's listing or inventory item answers exactly
like one that does not exist (`AUTH-221`). Nothing lists, searches, deletes, publishes,
transitions, uploads, enhances, recommends a price or reaches a buyer.

| Route                                            | Declaration                                                                                                                                              | Request                                                                                                                                                                                                                                          | Success                                                                |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------- |
| `POST /seller/listings`                          | seller · listing · create · seller-session · tenant from session · consequential · `Idempotency-Key` required · `LISTING_CREATED`                        | `{ "acquisitionCost"?: { "amountMinor": integer, "currency": "XXX" }, "acquisitionDate"?: "YYYY-MM-DD" }`, the seller's inventory facts, both optional (`LIST-100` AC1); `inventoryItemId` is generated by the server and refused in the request | `201 { listing }`                                                      |
| `GET /seller/listings/:listingId`                | seller · listing · read_workspace · seller-session · tenant from session · read-only · no key · no event                                                 | none                                                                                                                                                                                                                                             | `200 { listing, facts, draft }` (the seller workspace, Slice 1f below) |
| `PATCH /seller/listings/:listingId/asking-price` | seller · listing · set_asking_price · seller-session · tenant from session · consequential · `Idempotency-Key` required · `LISTING_ASKING_PRICE_CHANGED` | `{ "expectedRowVersion": n, "price": { "amountMinor": integer, "currency": "XXX" } }`, the domain's own representation (`LIST-130`, `DM-07`)                                                                                                     | `200 { listing }`                                                      |

Creation is the seller's one action of `LIST-100` AC1: the composite command
`listing.create_with_item` creates the inventory item and its `DRAFT` listing in one transaction,
under one command name, one fingerprint over the submitted facts and one receipt, and writes
`LISTING_CREATED` with the generated inventory item identifier in that transaction; a failure of
either insert, the event or the receipt leaves neither record. An exact replay answers the same
`201 { listing }` with the same listing and inventory item identifiers.

`listing` is the seller-safe view `{ id, inventoryItemId, status, askingPrice, rowVersion,
createdAt, updatedAt, listedAt, closedAt }`: no seller, account, session, policy, content,
receipt or audit identifier, and never a minimum or target price. Strict schemas reject every
unknown key, so a client-supplied seller, tenant, account or session identifier is a
`400 bad_request`, as is a malformed listing identifier, a fractional or negative amount or a
currency that is not an ISO 4217 code. Failures are fixed bodies mapped centrally in
`src/web/app.ts`: `401 unauthenticated`, `403 forbidden_origin` or `forbidden_anti_forgery`,
`400 idempotency_key_required`, `404 not_found` (a listing that is not this tenant's or does not exist), `409 invalid_state` (a
price change outside `DRAFT`), `409 stale_row_version` (`OPS-738`),
`409 idempotency_conflict` (`OPS-732`) and `500 internal` with the request id in the log only.

Idempotency follows `OPS-730` to `OPS-732` through the domain's `runIdempotent`: the route passes
the header key and the authenticated command context, no second receipt is written, and an exact
replay returns the original outcome and status (`201` for create) without a second row, a second
`row_version` increment or a second event. Resubmitting the asking price a `DRAFT` listing
already carries is the domain's no-op: `200 { listing }` with the unchanged `rowVersion`, no
write and no event, and, by the canonical rule of migration `0003`, the key is consumed and its
outcome stored so a retry of that key is stable. Test suite: `test/integration/seller-listings.test.ts`.

Not here, by design: a separate inventory-item route (the listing creates its item), listing
enumeration, publication, closure, photos, buyer surfaces. Facts and seller drafts are Slice 1f.

## Slice 1f: seller facts and seller drafts (D-21)

Two consequential routes and the workspace read, all over Module 3 with Module 4
(`src/modules/listing-content/`) doing the fact and version work, registered by the same
`src/web/routes/seller-listings.ts` under the same session, origin, anti-forgery and RLS rules
as Slice 1e. `decisions/DECISION_LOG.md` D-21 (Accepted 2026-09-05) classifies both saves as
consequential and fixes their semantics; migration `0011` adds the two audit events, `DELETE` on
`product_fact` for the runtime role and the same-listing lineage constraint. No AI, approval,
publication, image, enumeration, pricing or buyer capability is involved, and nothing rewrites
a seller's words (`LIST-006`, D-12).

| Route                                   | Declaration                                                                                                                                          | Request                                                                                                                                                                                                                                                                                             | Success                         |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `PUT /seller/listings/:listingId/facts` | seller · listing · replace_facts · seller-session · tenant from session · consequential · `Idempotency-Key` required · `LISTING_FACTS_CHANGED`       | `{ "expectedRowVersion": n, "facts": { "<key>": "text", ... } }` over the eleven `LIST-002` keys `name`, `brand`, `model`, `size`, `colour`, `condition`, `included_items`, `defects`, `age`, `usage_history`, `specifications`; values trimmed, at most 2000 characters; `{}` is a valid statement | `200 { listing, facts }`        |
| `PUT /seller/listings/:listingId/draft` | seller · listing · save_seller_draft · seller-session · tenant from session · consequential · `Idempotency-Key` required · `LISTING_CONTENT_DRAFTED` | `{ "expectedRowVersion": n, "sourceVersionId": uuid or null, "title": text, "summary"?: text, "description"?: text, "structuredDetails"?: { "<key>": "text" } }`; title 1 to 200, summary to 1000, description to 10 000, details over the fact keys                                                | `200 { listing, draft }`        |
| `GET /seller/listings/:listingId`       | seller · listing · read_workspace · seller-session · tenant from session · read-only · no key · no event                                             | none                                                                                                                                                                                                                                                                                                | `200 { listing, facts, draft }` |

**Facts (D-21 rules 7 to 9, 19).** The body is the seller's complete statement, so `PUT` is the
verb: supplied non-blank facts become or replace the listing's seller-provided facts, omitted
keys return to unknown, and a blank value is not a fact and clears the key. Unknown is the absence
of a `product_fact` row (`LIST-033`, D-10): never null, zero, false or placeholder text, and a
cleared value is retained nowhere. The command `listing.replace_facts` locks the listing row,
requires `DRAFT` or `EXPIRED` and the row version the seller read, compares the statement with the
current `SELLER_PROVIDED_FACT` rows, upserts the keys that are new or changed, deletes the keys
omitted, leaves equal keys untouched (their `supplied_at` stands), increments `row_version` once
and writes `LISTING_FACTS_CHANGED` with `set_keys`, `cleared_keys`, `set_count`, `cleared_count`,
`previous_row_version` and `row_version`, never a value. An identical statement, whitespace and
blank keys aside, is a no-op: no write, no `row_version` change, no event, key consumed and its
outcome stored. `facts` in every response is keyed by fact key,
`{ "<key>": { "value", "provenance": "SELLER_PROVIDED_FACT", "suppliedAt" } }`, with unknown keys
absent. The condition ladder of `ai/LISTING_ENHANCEMENT.md` §6.4 validates enhancement output,
not seller input: the seller may state any condition text.

**Drafts (D-21 rules 10 to 15).** Content versions are immutable (`DM-06`, `OPS-706`), so a save
appends: `listing.save_seller_draft` locks the listing row, requires `DRAFT` or `EXPIRED` and the
expected row version, requires `sourceVersionId` to be the listing's latest content version by
number whatever its status (null before the first), refuses a stale, null-after-the-first or
unrelated predecessor with `409 stale_row_version` before any write, requires every structured
detail to be a recorded seller fact (`INV-12`, `400 bad_request` otherwise), and inserts exactly one
`SELLER_DRAFT` version with `SELLER_PROVIDED_FACT` provenance and `source_version_id` set to the
predecessor (`LIST-042`), incrementing `row_version` once and writing `LISTING_CONTENT_DRAFTED`
with `content_version_id`, `version_number`, `source_version_id` when present,
`previous_row_version` and `row_version`, never a word of copy. Copy identical to the
predecessor, trimmed, is a no-op that consumes the key and answers the predecessor. `draft` in
every response is `{ id, versionNumber, status, provenance, title, summary, description,
structuredDetails, sourceVersionId, createdAt, approvedAt }`, the words exactly as stored; the
approver is the seller id and is not exposed. A blank summary, description or detail is absent,
never stored as empty text.

**Workspace.** `GET` answers `{ listing, facts, draft }`: the Slice 1e view, the facts as above
(`{}` before any is stated) and the latest content version or `null`. It writes no event and no
receipt, ignores an `Idempotency-Key`, and does not change the stored outcome of the create
command, which stays `{ listing }`.

**States.** Both saves are allowed in `DRAFT` and in `EXPIRED` (where `SM-L-06` requires a new
seller-approved version before a relist) and refused with `409 invalid_state` in `READY`,
`LISTED`, `ACTIVE_CONVERSATIONS`, `OFFER_PENDING`, `PENDING_SALE`, `SOLD`, `CANCELLED` and
`ARCHIVED`. Neither performs a listing transition; a `READY` listing is edited after
`revertToDraft`.

**Idempotency and receipts.** One `runIdempotent` call per command, one fingerprint over the
normalised payload (so `{ "name": "" }` and `{}` are the same statement), one receipt. The fact
receipt stores the listing record and the resulting fact keys; a replay returns the stored record
with the seller-provided facts re-read, so no receipt holds a value a seller later cleared. The
draft receipt stores the listing record and the version identifier; a replay re-reads the
immutable version. The same key with another payload or command is `409 idempotency_conflict`.
The two `PUT` routes carry a 256 KiB body bound of their own, because eleven facts of 2000
characters or a 10 000-character description exceed the process-wide 16 KiB limit once encoded;
the schemas still refuse anything beyond the canonical lengths. Test suite:
`test/integration/seller-workspace.test.ts`.

Not here, by design: approval over HTTP, enhancement, version history or enumeration, deleting a
version, editing an approved version, images, listing enumeration, publication, buyer surfaces.

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

| Role           | Attributes                                                                                  | Owns                                                    | May                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| -------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app_migrator` | `LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT`, `CREATE` on the database | schema `app`, schema `migration` and everything in both | run migrations                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `app_runtime`  | same, without `CREATE`                                                                      | nothing                                                 | `seller`, `inventory_item`, `listing`, `listing_content_version`: SELECT INSERT UPDATE · `product_fact`: SELECT INSERT UPDATE DELETE (the delete for D-21 rule 19 only, migration `0011`) · `public_listing_access`, `listing_access_code`: SELECT INSERT UPDATE · `seller_policy_version`, `audit_event`, `idempotency_receipt`: SELECT INSERT · schema `auth`: EXECUTE on the twelve keyhole functions of migrations `0007` to `0010` and no table privilege at all · nothing on `migration` |

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
  backs (INV-12); `createSellerDraft` refuses such a draft earlier. Under D-21 the seller's
  statement replaces the set in full (`replaceSellerFacts`): omitted keys are deleted, since the
  unknown state is the absence of a row, and the identity and provenance of a surviving row stay
  immutable.
- **Lineage.** A content version's `source_version_id` must name a version of the same listing
  (composite foreign key, migration `0011`); a seller draft cites the listing's latest version as
  its predecessor, or null for the first (D-21 rules 11 and 12, `LIST-042`).
- **Policy versions**, **audit events** and **idempotency receipts** are append-only at two
  layers: the runtime role holds no UPDATE or DELETE privilege, and a trigger rejects them for
  the owner as well.
- **Listing status** changes only along STATE_MACHINES §1 edges, enforced by a trigger; READY
  additionally requires the SM-L-01 prerequisites, and the refusal names what is missing
  (`SQLSTATE LS002`, DETAIL). `row_version` must advance by exactly one on every update.
- **Audit event types** are exactly the §12 list of `ai/POLICY_AND_AUTHORIZATION.md`, which since
  2026-09-03 names `LISTING_STATUS_CHANGED` (every lifecycle transition, previous and new status)
  and `LISTING_ASKING_PRICE_CHANGED` (every asking-price or currency change, previous and new
  values, never the minimum), and since 2026-09-05 (D-21, migration `0011`) `LISTING_FACTS_CHANGED`
  (keys set and cleared, counts and row versions, never a value) and `LISTING_CONTENT_DRAFTED`
  (version identifiers and numbers and row versions, never a word). A unit test and an
  integration test keep the document, the TypeScript list and the database enum identical
  (`OPS-781`).
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
