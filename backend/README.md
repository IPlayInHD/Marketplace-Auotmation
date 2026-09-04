# Backend — private alpha

**Status.** Private-alpha implementation authorised by `docs/decisions/DECISION_LOG.md` D-18 on
the D-17 baseline. Slice 0 validation is deferred, incomplete and unpassed; nothing here is
validation evidence. No public surface exists: no buyer page, no sign-up, no marketplace link.
Every seller in this codebase is a synthetic, founder-controlled identity.

This directory is the one modular monolith of D-17 (`ARCH-015`): one codebase, one container
image later, two entry points (`web` here; `worker` is not yet part of any slice).

## What this slice contains (Slice 1a)

The listing-domain foundation and the DRAFT → READY transition:

| Concern                                                                                                                                                   | Where                                                              | Canonical anchor                               |
| --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------- |
| Forward-only SQL migrations, ledger with checksums, advisory-locked runner                                                                                | `src/db/migrate.ts`, `src/db/migrations/`                          | `OPS-513`, `OPS-514`, `OPS-714`                |
| Roles: `app_migrator` owns everything; `app_runtime` is DML-only, no DDL, no `BYPASSRLS`                                                                  | `src/db/migrate.ts` (bootstrap), migration grants                  | `OPS-716`, D-17                                |
| Row-level security on every seller-owned table, forced for the owner, fail-closed without context                                                         | migration `0001`                                                   | `SEC-100`, `SEC-101`                           |
| Single tenant-context construction site, transaction-scoped                                                                                               | `src/db/kysely.ts` `withTenant()`                                  | `SEC-101`                                      |
| Entities: `seller`, `inventory_item`, `listing`, `listing_content_version`, `product_fact`, `seller_policy_version`, `audit_event`, `idempotency_receipt` | migrations `0001`, `0003`, `src/db/schema.ts`                      | `DOMAIN_MODEL.md`, `DM-01`, `DM-06`, `DM-07`   |
| Listing lifecycle guard: only the drawn transitions, SM-L-01 prerequisites named, `row_version` increment                                                 | migration `0001` triggers, `src/modules/listings/`                 | `STATE_MACHINES.md` §1, `OPS-707`, `OPS-738`   |
| Content version guard: words immutable, only §8 transitions, one APPROVED per listing                                                                     | migration `0001` triggers                                          | `STATE_MACHINES.md` §8, `SM-CT-01`, `OPS-706`  |
| Seller-provided facts as the only provenance; approved copy details must be backed by facts                                                               | `product_fact` constraint, READY guard                             | D-10, `INV-12`                                 |
| Minimum price on the policy version only, protected; buyer-safe projection cannot hold it                                                                 | `src/modules/seller-policy/`, `src/modules/public-listing-access/` | D-04, `SEC-021`, `OPS-724`                     |
| Append-only audit events with request id, actor, subject, policy version; idempotency receipts with command fingerprint and stored outcome                | `src/modules/audit/`                                               | `OPS-780` to `OPS-784`, `OPS-730` to `OPS-733` |
| Module boundaries enforced in the build                                                                                                                   | `.dependency-cruiser.cjs`                                          | `ARCH` §3, `OPS-702`                           |
| Fastify `web` skeleton: `/health`, empty seller and buyer route trees, loopback bind                                                                      | `src/web/`                                                         | `ARCH-002`, `AUTH-222`, D-18                   |

Not here, by design: authentication (Q-12 stays open), sign-up, any frontend, images,
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

## Environment variables

| Variable                 | Used by           | Meaning                                                                                                                                                                 |
| ------------------------ | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MIGRATION_DATABASE_URL` | `npm run migrate` | Connection string for `app_migrator`. Never given to a running process                                                                                                  |
| `DATABASE_URL`           | `npm run web`     | Connection string for `app_runtime`                                                                                                                                     |
| `APP_ENV`                | web               | `local` (default), `ci`, `staging`, `production` (`OPERATIONS.md` §1)                                                                                                   |
| `HOST`, `PORT`           | web               | Bind address. Loopback (default `127.0.0.1`) unless `BACKEND_ALLOW_NETWORK_BIND=true`, which an operator sets only for a founder-operated internal demonstration (D-18) |
| `LOG_LEVEL`              | web               | pino level                                                                                                                                                              |
| `BACKEND_POSTGRES_IMAGE` | tests             | Test image reference (see above)                                                                                                                                        |

No `.env` file is read and none is committed. Credentials come from the environment or a secret
store (`OPS-729`).

## Role and permission model

Two roles, created once by a superuser (`bootstrapRoles`), which is never used afterwards except
by tests for privileged inspection.

| Role           | Attributes                                                                                  | Owns                                                    | May                                                                                                                                                                                                            |
| -------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `app_migrator` | `LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT`, `CREATE` on the database | schema `app`, schema `migration` and everything in both | run migrations                                                                                                                                                                                                 |
| `app_runtime`  | same, without `CREATE`                                                                      | nothing                                                 | `seller`, `inventory_item`, `listing`, `listing_content_version`, `product_fact`: SELECT INSERT UPDATE · `seller_policy_version`, `audit_event`, `idempotency_receipt`: SELECT INSERT · nothing on `migration` |

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
  `OPS-733`; a configured retry horizon and a retention job are not part of it.
- Layouts that DOMAIN_MODEL.md leaves indicative (policy fields, fact keys) are fixed here as the
  LIST-002 and LIST-022 lists. If the founders read any of this as a deviation from the domain
  model, it is recorded in the decision log, per that document's own rule.

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
