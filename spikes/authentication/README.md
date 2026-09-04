# Authentication spike (Q-12 evaluation evidence)

**Status: evaluation spike, retained as evidence. Not production code. Not a product feature.**

This directory holds the reproducible evidence behind decision **D-19 (Accepted 2026-09-04)**
in `docs/decisions/DECISION_LOG.md`, the bounded evaluation of the seller-authentication
approach that resolved `Q-12`. It implements no product behaviour: no sign-up page, no seller
route tree, no production migration, no buyer authentication, no email. It is retained under
D-19 acceptance condition 8; see "Retention and deletion" below.

Everything lives under `spikes/authentication/`. Nothing here is imported by application code.
The test harness _reads_ `backend/src/db/migrations/*.sql` from disk, unmodified, to build the
real schema inside a throw-away container; it never writes to `backend/`.

## What is proved

The accepted approach is a first-party module built from focused primitives already in the
D-17 baseline: Argon2id from `node:crypto`, opaque 256-bit session tokens stored as SHA-256,
`@fastify/cookie` for the cookie itself, an Origin check plus a per-session anti-forgery value
for state-changing requests, and one transaction that resolves the session and sets the
row-level-security context.

| #   | Claim under test                                                                                                                                                                                                                                                                            | Test file                                              | Result |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | ------ |
| 1   | Argon2id creation and verification: the reference implementation's known-answer vectors are reproduced raw and PHC-encoded; policy parameters `m=19456,t=2,p=1`, fresh 16-byte salt, only the right password verifies                                                                       | `test/password.test.ts`                                | PASS   |
| 2   | One generic failure for an unknown account and for a wrong password; the key derivation runs in both cases; the rate limiter is consulted per account key and per client hash first; a refused attempt gets a neutral response without any key derivation                                   | `test/auth-flow.test.ts`                               | PASS   |
| 3   | Opaque tokens: 32 CSPRNG bytes as 43 base64url characters, unique, well-formed only in that shape                                                                                                                                                                                           | `test/session-token.test.ts`                           | PASS   |
| 4   | Only a 32-byte SHA-256 of the token is stored; the token appears in no row, audit event or log line                                                                                                                                                                                         | `test/session-token.test.ts`, `test/auth-flow.test.ts` | PASS   |
| 5   | Cookie construction: `__Host-seller_session`, `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, no `Domain`; http permitted on loopback in `local` only                                                                                                                                       | `test/session-token.test.ts`, `test/auth-flow.test.ts` | PASS   |
| 6   | Session lookup and expiry: idle timeout and absolute lifetime are decided by the database clock, not by the cookie                                                                                                                                                                          | `test/auth-flow.test.ts`                               | PASS   |
| 7   | Rotation: new token, old token dead, absolute lifetime inherited, both rows written by one transaction (`xmin` equal); a cookie presented at sign-in is never honoured or reused                                                                                                            | `test/auth-flow.test.ts`                               | PASS   |
| 8   | Single-session revocation: a captured cookie replayed after sign-out fails; another session of the account continues                                                                                                                                                                        | `test/auth-flow.test.ts`                               | PASS   |
| 9   | Logout everywhere: every open session of the account revoked in one transaction; other accounts untouched; the session list shows the current session                                                                                                                                       | `test/auth-flow.test.ts`                               | PASS   |
| 10  | CSRF: state-changing requests without an `Origin`/`Referer`, from another origin, or with `Sec-Fetch-Site: cross-site` are refused (sign-in included, so no session is created and no key derivation runs); same-origin requests without the session's anti-forgery value are refused       | `test/session-token.test.ts`, `test/auth-flow.test.ts` | PASS   |
| 11  | Seller resolution followed by transaction-scoped RLS context against the production schema (migrations 0001 to 0006): a signed-in seller sees exactly its own rows, writes land under its own id, a smuggled seller id is rejected, and the pooled connection carries no context afterwards | `test/auth-flow.test.ts`                               | PASS   |
| 12  | Missing, malformed, padded or unknown session: `401`, cookie cleared, no tenant data touched                                                                                                                                                                                                | `test/auth-flow.test.ts`                               | PASS   |
| 13  | No token, password, verifier, anti-forgery value or token hash in any stored row, audit event, log line or error body; values that reach the logger by mistake are redacted; error bodies are fixed strings                                                                                 | `test/auth-flow.test.ts` (`afterAll` corpus scan)      | PASS   |
| 14  | Node 24 and strict TypeScript: the spike type-checks under the production `tsconfig` (strict, `exactOptionalPropertyTypes`, `erasableSyntaxOnly`) and lints under the production ESLint rules                                                                                               | `npm run typecheck`, `npm run lint`                    | PASS   |
| 15  | Deterministic: no sleeps, no clock injection; expiry is proven by backdating rows; files and tests are shuffled on every run                                                                                                                                                                | `vitest.config.ts`                                     | PASS   |
| —   | Data layer: session identity is immutable and revocation is final (`SS001`, `SS002`); the runtime role holds `SELECT, INSERT, UPDATE` only on the auth tables and cannot `DELETE` or alter them                                                                                             | `test/auth-flow.test.ts`                               | PASS   |

23 of 23 tests, in 3 files, passed twice with shuffled file and test order at the evidence
commit, and once more after a clean `npm ci --ignore-scripts` from the committed lockfile.

## Layout

| Path                     | Purpose                                                                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| `src/password.ts`        | Argon2id via `crypto.argon2` (Node.js 24.7.0+), PHC encoding, bounded decoding, `needsRehash`, a decoy verifier for unknown accounts |
| `src/session-token.ts`   | Token generation, SHA-256 storage form, HMAC-derived anti-forgery value                                                              |
| `src/cookie.ts`          | Cookie policy: attributes, `__Host-` prefix, the local-http exception                                                                |
| `src/csrf.ts`            | Origin / `Sec-Fetch-Site` / `Referer` check and anti-forgery verification                                                            |
| `src/auth/service.ts`    | Sign-in, `withSellerSession` (the single tenant-context construction site), rotation, sign-out, sign-out-all, session list           |
| `src/auth/ports.ts`      | The two seams: audit sink (in-transaction) and rate-limit gate; the proposed audit event types                                       |
| `src/db/auth-schema.sql` | Spike-only `auth` schema: `seller_account`, `seller_session`, guards, DML-only grants. **Not a migration.**                          |
| `src/db/bootstrap.ts`    | Test setup: role bootstrap identical to production, applies the production migrations from disk, seeds synthetic sellers             |
| `src/web/app.ts`         | Fastify routes under `/spike/*` used only by the tests                                                                               |
| `test/`                  | The proofs above; `helpers/` start the container and capture audit events and logs                                                   |

## Prerequisites and procedure

- Node.js 24.7.0 or later on the 24 line (`crypto.argon2` was added in 24.7.0; evaluated on
  24.20.0 with OpenSSL 3.5.7). `engines` pins `>=24.7.0 <25`.
- Docker with a reachable daemon; network access to pull `postgres:16-alpine` and
  `testcontainers/ryuk`. If Docker Hub is not reachable directly, set
  `TESTCONTAINERS_HUB_IMAGE_NAME_PREFIX=mirror.gcr.io/`.

```
cd spikes/authentication
npm ci --ignore-scripts
npm run check        # prettier --check, eslint, tsc --noEmit, vitest run
npm audit
```

## Dependency review (leading candidate)

Recorded on 2026-09-04 from the committed `package-lock.json`.

- Production dependencies: `@fastify/cookie` 11.1.2 (new to the codebase; `cookie` and
  `fastify-plugin` only), plus `fastify` 5.12.1, `kysely` 0.29.5, `pg` 8.23.0, `pino` 10.3.1 and
  `zod` 4.5.4, all already pinned in `backend/`. 73 production packages in total, all MIT,
  BSD-3-Clause or ISC. None deprecated. No install script and no native addon among them.
- Argon2id needs no package: it is `node:crypto`. The fallback if a runtime lacks it is
  `@node-rs/argon2` 2.2.0 (MIT, no install script, platform binaries as `optionalDependencies`,
  same PHC format and identical default parameters), behind the `PasswordVerifier` interface.
- `npm audit`: 0 vulnerabilities.
- Install scripts in the lockfile exist only in development tooling (`cpu-features`, `ssh2`,
  `protobufjs` via Testcontainers; `fsevents`), and `.npmrc` sets `ignore-scripts=true`.

## Limitations, stated plainly

- The AUTH-203 statistical timing test (response-time distributions over n samples) is not run
  here; the spike proves equal work and byte-identical responses, which is the precondition.
- Rate limiting is an integration point with a recording stub. The progressive-delay policy of
  AUTH-204 is production work.
- Sign-up, password change, password reset, email change, second factor and notifications are
  out of scope; they depend on open questions (email and notification providers, `Q-11`) and
  are listed in D-19 as custom work with interfaces or explicit deferrals.
- The `auth` schema here is a shape, not the production migration.

## Retention and deletion

D-19 acceptance condition 8 governs this directory:

- It is not deleted merely because D-19 became Accepted.
- It is retained as reproducible evidence until production authentication implements and
  passes equivalent or stronger tests.
- It is deleted only in or after the production implementation commit that proves that
  parity, and the deletion is clearly reported in that change.
- Its history is preserved in Git.

Nothing else references it; removing the directory is the whole deletion when that time comes.
