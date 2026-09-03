# Backend foundation spike (D-17 acceptance evidence)

**Status: disposable spike. Not production code. Not a product feature.**

This directory exists to produce reproducible evidence for the acceptance conditions of
decision D-17 in `docs/decisions/DECISION_LOG.md` (TypeScript on Node.js 24, Fastify,
PostgreSQL with Kysely, pg-boss, row-level security, separated migration and runtime roles).
It implements no product behaviour: no authentication, no listings workflow, no buyer
conversation, no negotiation, no marketplace integration, no notifications, no AI calls.
Delete it once D-17 is accepted, revised or rejected (see "How to delete this spike").

Everything lives under `spikes/backend-foundation/`. Nothing here is imported by, or
should ever be imported by, application code.

## What is proved

| # | Claim under test | Test file | Result |
|---|---|---|---|
| 1 | PostgreSQL role separation: runtime roles are not superusers, cannot bypass RLS, own nothing, cannot create/alter/drop protected tables or schemas, cannot disable RLS, cannot assume the migration role, hold DML-only privileges | `test/roles.test.ts` | PASS |
| 2 | Tenant isolation with transaction-scoped context; RLS fails closed on missing or invalid context; `FORCE ROW LEVEL SECURITY` applies to the owner | `test/rls.test.ts` | PASS |
| 2b | A pooled connection carries no tenant identity into its next use (and the test is shown to be sensitive to the leak it guards against) | `test/rls.test.ts` | PASS |
| 3 | pg-boss schema is installed only by the migration role through the pg-boss CLI; the worker starts and operates with `migrate: false`, needs no DDL, cannot change the schema, and refuses to start when migrations are pending instead of migrating | `test/pgboss-schema.test.ts` | PASS |
| 4 | A domain insert and its job are written by one PostgreSQL transaction on one connection (`xmin` of both rows equals the transaction id); commit keeps both, rollback keeps neither; a control shows a non-transactional enqueue is not atomic | `test/transactional-enqueue.test.ts` | PASS |
| 5a | Exception retry: a failing handler is retried per the explicit queue policy; the attempt count is observable; the final state is `completed` or, when the policy is exhausted, `failed` | `test/retry.test.ts` | PASS |
| 5b | Crash redelivery: a worker **process** killed with `SIGKILL` mid-job leaves an `active` row; the monitor expires the attempt after `expireInSeconds` and another instance completes it | `test/retry.test.ts` | PASS (see limitations) |
| 5c | Heartbeat redelivery: an active job whose heartbeat stops is failed by the monitor ("job heartbeat timeout") and redelivered | `test/retry.test.ts` | PASS |
| 6 | Idempotent processing: a pg-boss redelivery after a lost acknowledgement, and four concurrent duplicate deliveries, produce exactly one side effect, enforced by a `UNIQUE` constraint | `test/idempotency.test.ts` | PASS |
| 7 | `GET /health` and the server-rendered `GET /buyer/demo` answer over a loopback socket while no worker process or worker-role session exists; the web module graph does not import pg-boss | `test/web-without-worker.test.ts` | PASS |
| 8 | Zod validation at the untrusted boundary rejects unknown and forbidden keys; the buyer-safe projection is a distinct constructed type, cannot hold a protected key (compile-time), and rejects spread-in fields at serialisation | `test/projection.test.ts` | PASS |
| 9 | Pino structured logging with request correlation, job id, attempt, outcome and error category; secrets and protected seller fields are redacted at any depth | `test/logging.test.ts` | PASS |

Two complete runs from clean containers, with shuffled file and test order, passed
54 of 54 tests at the evidence commit. On 2026-09-03 the spike was reproduced
independently from the committed lockfile in a fresh detached worktree at that commit
(`npm ci --ignore-scripts` with the lockfile unchanged, type-check clean, 54 of 54 against
a real PostgreSQL container, `npm audit` clean, no committed file changed) as the
acceptance gate for D-17; see `docs/decisions/DECISION_LOG.md` D-17.

## Prerequisites

- Node.js 24 LTS (developed and run on 24.20.0; `engines` pins `>=24 <25`)
- npm 11 (ships with Node 24)
- Docker with a reachable daemon (Testcontainers uses `/var/run/docker.sock` by default)
- Network access to pull `postgres:16-alpine` and `testcontainers/ryuk:0.14.0`

No local PostgreSQL is used or required. Every test file starts its own container and
stops it in `afterAll`; Ryuk removes containers left by an interrupted run.

If Docker Hub is not reachable directly, point Testcontainers at a mirror. This is how
the spike was run in its original environment, where Docker Hub blob downloads were
blocked by policy but Google's mirror was permitted:

```
export TESTCONTAINERS_HUB_IMAGE_NAME_PREFIX=mirror.gcr.io/
```

## PostgreSQL test image

The suite ran, and D-17 was accepted, against this image:

| Field | Value |
|---|---|
| Registry | `docker.io` is the canonical source. In the acceptance environment the image was pulled through the Google pull-through mirror `mirror.gcr.io`, because Docker Hub blob downloads were refused by the egress policy |
| Repository | `library/postgres` |
| Tag | `16-alpine` |
| Manifest digest | `sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685` as reported by `docker image inspect` (RepoDigests) after the pull from `mirror.gcr.io` on 2026-09-02; image created 2026-08-13; `linux/amd64` |
| PostgreSQL | 16.15 (`postgres --version` inside the image; `PG_MAJOR=16`) |

A tag is mutable: `16-alpine` will point at a different image after the next upstream
rebuild, so the tag alone does not guarantee an identical future test environment. The
digest does. `test/helpers/database.ts` reads `SPIKE_POSTGRES_IMAGE`, so CI can pin the
approved digest without changing any file:

```
export SPIKE_POSTGRES_IMAGE=postgres@sha256:cf78e76683b9ca8c5733cbbdce6c9262b45b6767934dd0a95e671f9a0fc20685
```

With `TESTCONTAINERS_HUB_IMAGE_NAME_PREFIX` also set, Testcontainers rewrites that
reference to `<prefix>postgres@sha256:...`. Both forms were exercised in the acceptance
environment: a database test file passed 5 of 5 with the pinned digest. The digest could
not be checked against Docker Hub itself from that environment; re-verify it there when
the mirror is not in use. When the pin is moved to a newer image, re-run the whole suite
and record the new digest and PostgreSQL version here.

## Install

```
cd spikes/backend-foundation
npm ci --ignore-scripts
```

`.npmrc` sets `ignore-scripts=true` and `save-exact=true`, so install scripts never run
here even without the flag. Three transitive packages declare install scripts and were
reviewed and skipped: `ssh2` (optional native build via `cpu-features`, both pulled in by
`testcontainers`, pure-JS fallback works) and `protobufjs` (a postinstall that only
rewrites its own package files; also a `testcontainers` dependency). None is needed at
runtime for this spike.

## Run

```
npm run typecheck   # tsc --noEmit, strict
npm test            # vitest run: 9 files, 54 tests, real PostgreSQL containers
npm audit           # dependency audit (0 vulnerabilities at the time of the spike)
```

Run `npm test` at least twice; file and test order is shuffled on every run and the seed
is printed, so order dependence shows up as a failure. A typical run takes 25 to 35
seconds; the heartbeat proof alone waits eleven seconds because pg-boss's minimum
`heartbeatSeconds` is 10.

Manual entry points (not used by the tests) exist for inspection only:
`node src/web/main.ts` and `node src/worker/main.ts`; both read connection strings from
environment variables named in the file headers and bind to `127.0.0.1`.

## Layout

```
src/db/constants.ts             role and schema names (no secrets)
src/db/migrations/0001_app_schema.sql
                                the explicit SQL migration: schema, tables, RLS, grants
src/db/migrate.ts               bootstrap roles, apply migration, install pg-boss via CLI,
                                grant runtime access, declare queues
src/db/kysely.ts                Kysely factory and withTenant(): the single tenant-context site
src/db/schema.ts, seed.ts       Kysely types; seed helper (runs under RLS)
src/domain/projection.ts        internal record vs. buyer-safe projection, type-level guard
src/domain/input.ts             strict Zod validation policy for buyer input
src/observability/logger.ts     Pino logger, allowlisted job/request fields, redaction
src/web/app.ts, render.ts, main.ts
                                Fastify web entry point: /health, /buyer/demo (server-rendered)
src/jobs/queues.ts, enqueue.ts, handler.ts
                                queue declarations, transactional enqueue, idempotent effect
src/worker/boss.ts, main.ts     runtime pg-boss configuration (no migrate, no DDL) and entry point
test/helpers/database.ts        one fresh container + full migration per test file
test/fixtures/crash-worker.ts   a worker process the crash test kills with SIGKILL
test/*.test.ts                  the nine proofs
```

## Role and permission model

Three roles, created once by the container superuser, which is never used afterwards
except by tests for privileged inspection.

| Role | Attributes | Owns | May |
|---|---|---|---|
| `spike_migrator` | `LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT`, `CREATE` on the database | schema `app`, schema `pgboss` and every object in both | run the SQL migration, run the pg-boss CLI, declare queues |
| `spike_web` | `LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT` | nothing | `app.listings`: SELECT INSERT UPDATE DELETE; `app.demo_records`: SELECT INSERT; `pgboss.*`: SELECT, plus INSERT on the `job*` tables so it can enqueue |
| `spike_worker` | same as web | nothing | `app.listings`, `app.demo_records`: SELECT; `app.side_effects`: SELECT INSERT; `pgboss.*`: SELECT INSERT UPDATE DELETE, except `pgboss.version`: SELECT only |

Neither runtime role has `CREATE` on any schema or on the database, `EXECUTE` on
`pgboss.create_queue` or `pgboss.delete_queue`, or membership in any other role.
`UPDATE`/`DELETE` on `app.listings` is granted to the web role only so that the
cross-tenant update and delete proofs fail for the RLS reason (0 rows) rather than for lack
of privilege; a product schema would grant per table what each module needs.

Tenant context is `set_config('app.seller_id', <uuid>, true)` inside a transaction
(`withTenant()` in `src/db/kysely.ts`). `app.current_seller_id()` returns
`NULLIF(current_setting('app.seller_id', true), '')::uuid`: absent or empty context is NULL
and admits no row; a non-UUID value raises `22P02`. Note that after a transaction-local
setting reverts PostgreSQL reports the placeholder as `''`, which is why `NULLIF` is part of
the design rather than an optimisation.

## pg-boss install and runtime separation

Install (migration role only), as done by `installPgBossSchema()`:

```
PGBOSS_DATABASE_URL=<migrator connection string> PGBOSS_SCHEMA=pgboss node node_modules/pg-boss/dist/cli.js create
PGBOSS_DATABASE_URL=<migrator connection string> PGBOSS_SCHEMA=pgboss node node_modules/pg-boss/dist/cli.js version
```

Upgrades use `pg-boss migrate` the same way; `pg-boss plans migrate --dry-run` prints the
SQL for review. The runtime never runs either.

Runtime (both entry points), `createRuntimeBoss()` in `src/worker/boss.ts`:
`migrate: false`, `createSchema: false`, `reindex: false`, `schedule: false`,
`supervise` off in tests and driven explicitly with `supervise()`.

Primary-source evidence, pg-boss 12.29.0 (package `pg-boss@12.29.0`, repository
`timgit/pg-boss` at commit `20fdc8aeed2fb6294eb03a71f319d1eee4ce3ba5`, whose
`package.json` version is 12.29.0):

- `docs/cli.md`: the CLI exists "for managing database migrations without writing code",
  with `create`, `migrate`, `version`, `plans`, `rollback`, and reads `PGBOSS_DATABASE_URL`
  so that "admin credentials for migrations [can] coexist with regular application database
  credentials".
- `docs/install.md`: "If the CREATE privilege is not available or desired ... CLI
  (recommended)".
- `docs/api/constructor.md`, `migrate`: "If this is set to false, this instance will skip
  attempts to run schema migrations during `start()`. If schema migrations exist, `start()`
  will throw ... This is an advanced use case when the configured user account does not have
  schema mutation privileges."
- `dist/index.js` `#doStart()`: `if (migrate) contractor.start() else contractor.check()`;
  `dist/contractor.js` `check()` throws `pg-boss is not installed` or
  `pg-boss database requires migrations` and issues no DDL.
- `dist/plans.js` `create_queue`: DDL only when a queue is declared with `partition: true`
  (default `false`); the spike revokes EXECUTE on it from runtime roles regardless.
- `dist/boss.js` `#reindex()`: rebuild candidates are filtered by `owned`, so a role that does
  not own the indexes never issues `REINDEX`; the spike additionally sets `reindex: false`.
- `docs/api/adapters.md` (Kysely): `boss.send(name, data, { db: fromKysely(trx) })` runs the
  job insert inside the caller's transaction; "When the ORM transaction is rolled back ...
  all pg-boss operations executed through the adapter are rolled back as well."
- `docs/api/queues.md`, "Heartbeat vs expiration": expiration bounds one attempt;
  heartbeat detects a dead worker; both feed the same retry logic. `heartbeatSeconds`
  minimum is 10.
- `docs/api/ops.md`, `supervise(name)`: runs one maintenance pass on demand (expired and
  heartbeat-abandoned jobs, retention), the same pass the background supervisor runs.

The `test/pgboss-schema.test.ts` fingerprint test shows the pg-boss catalog (relations,
columns, indexes, constraints, function bodies, version) is byte-identical before and after
a worker starts, processes a job and runs a maintenance pass under the runtime role.

## Dependency selection

All direct dependencies are pinned exactly in `package.json`; `package-lock.json` is
committed. Versions were resolved on 2026-09-02 from the npm registry (`npm view`), and
release dates come from the registry `time` field.

| Package | Version | Released | Compatibility evidence | Why this version |
|---|---|---|---|---|
| typescript | 6.0.3 | 2026-04-16 | JS-based compiler; `erasableSyntaxOnly` + `verbatimModuleSyntax` match Node's native type stripping | Latest maintained JS-based line. 7.0.2 (2026-07-08, native compiler) is two months old and an x.0 release; the ecosystem's programmatic API still targets the JS package |
| @types/node | 24.13.3 | 2026-07-08 | matches the Node 24 line | Latest 24.x; 26.x targets a newer runtime |
| fastify | 5.12.1 | 2026-08-18 | peer range for pino is `^9.14.0 \|\| ^10.1.0` | Current major, latest patch |
| kysely | 0.29.5 | 2026-08-10 | `engines.node >=22` | Latest release of the only stable line; pg-boss ships a `fromKysely` adapter for it |
| pg | 8.23.0 | 2026-08-08 | `engines.node >=16` | Latest; pg-boss 12.29.0 depends on `pg ^8.23.0` |
| @types/pg | 8.23.1 | 2026-08-17 | matches pg 8.23 | Latest |
| pg-boss | 12.29.0 | 2026-08-30 | `engines.node >=22.12`, PostgreSQL 13+ | Latest; 12.x is the current major (since 2025-11-09) and the only one with the documented CLI, heartbeat and Kysely adapter used here. Release cadence is roughly weekly, which is itself a finding (RISK-24) |
| zod | 4.5.4 | 2026-08-29 | ESM, no engines constraint | Latest of the current major (`z.strictObject`, `z.uuid`, `z.int`) |
| pino | 10.3.1 | 2026-02-09 | in Fastify's accepted range | Latest |
| vitest | 4.1.11 | 2026-08-18 | `engines.node ^20 \|\| ^22 \|\| >=24` | Latest of the current major |
| testcontainers, @testcontainers/postgresql | 12.1.0 | 2026-08-04 | `engines.node >=22.22`; default Ryuk `0.14.0` | Latest; Node 24.20 satisfies the floor |

Node.js 24.20.0 was the "Latest LTS" (Krypton) reported by `nvm ls-remote --lts` on the
run date.

## Limitations

- **Crash redelivery is expiration-based in the SIGKILL test.** The killed process leaves an
  `active` row; recovery happens when the monitor's `failJobsByTimeout` pass runs after
  `expireInSeconds` (3 s in the spike queue). The separate heartbeat test proves the
  liveness path with pg-boss's minimum 10 s heartbeat using `fetch()` (which marks the job
  active and sends no heartbeats) rather than a killed process. Neither test kills a
  process that is actively heartbeating; that combination is a longer test and is listed as
  unresolved below.
- **Buyer tenant resolution is not designed here.** `/buyer/demo` renders a fixed demo
  tenant and listing supplied at construction. How a public listing id resolves to a
  tenant before RLS context exists is Slice 1 and 2 design work, not spike scope.
- **Queue topology is a migration-role step** in this spike (queues are declared by
  `createQueues()` and `EXECUTE` on `create_queue` is revoked from runtime roles). pg-boss
  would allow a runtime role to create non-partitioned queues with DML only; the spike
  chose the stricter posture. Either is compatible with D-17.
- **`supervise` is driven manually** in the tests so maintenance passes are deterministic.
  A production worker would enable the background supervisor; every statement in that
  pass ran under the worker role in the spike and is DML.
- **No CI wiring.** The spike is run by hand. `OPS-714` (migrations run in CI against
  production-shaped volumes) is not exercised.
- **Testcontainers image source.** In the original environment Docker Hub blob downloads
  were refused by the egress policy; images were pulled from `mirror.gcr.io` via
  `TESTCONTAINERS_HUB_IMAGE_NAME_PREFIX`. The image tags are unchanged, and the digest
  actually used is recorded under "PostgreSQL test image".
- **Formatting and linting are not configured** in this repository, so none were run.
  Type checking (`tsc --noEmit`, strict) passes.

## Unresolved findings

1. Kill-while-heartbeating: a worker process killed while it is actively sending
   heartbeats (needs `heartbeatSeconds >= 10` plus a monitor pass, so roughly 15 s per
   case). Expected to behave as the heartbeat test shows; not executed.
2. Deploy-time drain (`OPS-773`, `OPS-515`): graceful `stop()` under a real deploy was not
   tested.
3. `pg-boss` releases almost weekly and is maintained by one person (its README says so).
   The pin protects the build; the upgrade cadence and CLI-based migration step need an
   operating rule. Recorded as `RISK-24`.
4. Connection pooling under PgBouncer transaction mode was not tested. `withTenant()` uses
   `set_config(..., true)` (transaction scope) which is compatible with it; pg-boss's
   `useListenNotify` is not and was left off.
5. Performance at target row counts (`OPS-756`, `OPS-757`) is out of scope for this spike.

## Security notes

- No real user data. Seed values are fictional.
- No external AI provider, no external service of any kind, no shared or production
  database. The only database is the per-test container on the Docker loopback interface
  (the daemon in the original environment was started with `--ip=127.0.0.1`).
- All passwords are generated per run from `crypto.randomBytes` and exist only in process
  memory and the container. No `.env` file exists or is read; `.gitignore` excludes any.
- Runtime roles never receive ownership, `SUPERUSER` or `BYPASSRLS`. RLS was not weakened
  for any test; the negative tests assert the specific SQLSTATE (`42501`, `22P02`).
- The logger redacts by key and the job/request log APIs are allowlisted; the logging test
  asserts that secret values passed by mistake do not appear in output.

## How to delete this spike

```
git rm -r spikes/backend-foundation
```

Nothing outside this directory references it. If a Docker daemon was started by hand for
the spike, stop it; Testcontainers leaves no containers behind (Ryuk exits on its own).
