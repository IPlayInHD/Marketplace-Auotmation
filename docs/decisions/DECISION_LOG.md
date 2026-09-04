# Decision Log

Append-only. Each entry records what was decided, why, and what follows from it. A
decision is changed by adding a superseding entry, never by editing an old one.

**Repository history note.** No repository or prior documentation existed when this set
was written. The removed features below were rejected at specification time; they were
never implemented and are not deprecations of shipped behaviour.

---

## D-01 — Modular monolith
**Date** 2026-09-02 · **Status** Accepted

**Decision.** One deployable application with enforced internal module boundaries and
one relational database.

**Why.** Two people. Distributed architecture costs deployment, tracing, and
consistency work that buys nothing at this scale. Boundaries are enforced in code so
extraction stays possible.

**Consequences.** Modules do not read each other's tables. Any second deployable, broker
or datastore needs a superseding decision.

---

## D-02 — Buyer URL carries an opaque public listing id; the code is entered separately
**Date** 2026-09-02 · **Status** Accepted

**Decision.** `ourplatform.com/l/<opaque-public-id>` plus a 6-digit code entered on the
page. Options A and B (bare path plus code) are retained as fallbacks.

**Why.** The page must be able to render the listing before asking for anything. A link
from a stranger that opens to an empty code box is visually identical to phishing, and
marketplace buyers are trained to refuse it. Showing the item first is the difference
between a suspicious gate and the listing they were already looking at.

**Consequences.** The public id must be unguessable (≥64 bits). Two independently
revocable artefacts. The gate is on the conversation, not the page.

---

## D-03 — The access code is public by design and is not authentication
**Date** 2026-09-02 · **Status** Accepted

**Decision.** Treat the 6-digit code as known to an adversary. Its purpose is routing,
intent confirmation, abuse control and revocation — not secrecy.

**Why.** The primary flow requires the seller to publish the code in a public
marketplace advertisement. A number printed in public is not a secret, and pretending
otherwise would produce a security model that is false in its first assumption. 10^6
values is roughly 20 bits, which is not authentication at any threshold.

**Consequences.** Nothing sensitive may sit behind a code. Security comes from the
buyer-safe projection, session scoping and rate limiting. This is a stronger position
than secret-keeping and it is achievable, because everything a buyer needs is already
information the seller chose to publish.

---

## D-04 — The minimum acceptable price is never placed in model context
**Date** 2026-09-02 · **Status** Accepted

**Decision.** The policy engine computes a permitted counter range and passes only that
range to the model. The floor itself never enters the prompt.

**Why.** The specification requires that the agent never reveal the minimum. Two designs
satisfy it on paper: instruct the model not to reveal it, or never give it. The second
makes the requirement structurally true — a value absent from the context cannot be
extracted by any prompt — and eliminates a whole class of injection attack rather than
mitigating it. It costs nothing, because the engine validates the resulting number
anyway.

**Consequences.** The engine, not the model, decides whether a below-range offer becomes
a counter, an escalation or an auto-decline. This is a deliberate strengthening of the
stated requirement.

---

## D-05 — The model emits a structured proposed action, validated before any effect
**Date** 2026-09-02 · **Status** Accepted

**Decision.** Model output is a typed object — intent, draft text, optional price, cited
fact ids — evaluated by a deterministic guardrail engine before anything reaches a buyer
or the database.

**Why.** Prose cannot be validated. A typed action with a price field can be checked in
microseconds by a pure function that is exhaustively unit-testable.

**Consequences.** No `ACCEPT` intent exists. The guardrail engine performs no I/O. At
least 200 unit tests before the negotiation slice ships.

---

## D-06 — Approval binds to an offer version and a material-terms hash
**Date** 2026-09-02 · **Status** Accepted

**Decision.** A `SellerApproval` references one `OfferVersion` and stores a hash of the
material terms shown to the seller. Execution re-asserts the hash and listing
availability inside one transaction.

**Why.** "The seller approved this offer" is ambiguous once terms move. Binding to a
version and a hash makes approval unambiguous and makes stale approval detectable rather
than silent.

**Consequences.** Every material change supersedes and invalidates. Approval endpoints
are idempotent on a client key. Concurrency is resolved by conditional update, so two
simultaneous approvals produce exactly one winner.

---

## D-07 — Marketplace publication is manual; no marketplace integration
**Date** 2026-09-02 · **Status** Accepted

**Decision.** Sellers publish listings themselves. The platform reads no marketplace,
writes to no marketplace, and automates no marketplace messaging.

**Why.** Scraping and unofficial automation breach marketplace terms, break without
warning, and put the seller's account — not ours — at risk. Official APIs are either
unavailable for consumer marketplace selling or gated behind partner programs a
two-person company will not obtain.

**Consequences.** Buyer acquisition depends entirely on a human following a link, which
is the highest-risk business assumption (`ASM-01`). Marketplace link policy must be
verified per channel and may change without notice.

---

## D-08 — Technology stack deliberately undecided
**Date** 2026-09-02 · **Status** Superseded by D-17 (accepted 2026-09-03); retained unchanged as the historical record

**Decision.** No language, framework, cloud or datastore is specified by this
documentation set beyond "one relational database".

**Why.** The documentation is meant to survive the stack choice. Locking it in from a
specification rather than from a build constraint would be guessing.

**Consequences.** The first implementation slice must record the stack as a superseding
decision. Until then, no document may assume one.

---

## D-09 — No pricing or valuation feature
**Date** 2026-09-02 · **Status** Accepted · **Supersedes** any earlier product concept

**Decision.** The product does not estimate market value, recommend prices from market
data, produce quick-sale or maximum-profit prices, display demand estimates, fabricate
comparables, or present model-generated price guesses. The seller sets every price.

**Why.** No reliable, licensed, legally usable comparable-sales data is available.
Publishing valuation figures without a defensible data source is both a product-quality
problem and a consumer-protection exposure. Two of the marketplaces sellers use already
suggest prices natively and for free, so competing with worse data was never viable.

**Consequences.** `Listing` holds no derived valuation field. Analytics produce
operational counts and seller-entered costs only. Reintroduction requires licensed data
and a superseding decision. Any future work is marked FUTURE / CONDITIONAL / NOT
CURRENTLY APPROVED and must not be architected for.

---

## D-10 — The seller is the sole source of product facts
**Date** 2026-09-02 · **Status** Accepted

**Decision.** Product facts come from the seller. AI enhancement is a presentational
transformation. Images are not a source of inferred facts.

**Why.** A fabricated specification in a listing is a misdescription the seller carries
liability for, and in several jurisdictions a platform that supplied the text can be
jointly liable. It is also simply wrong: the model does not know whether the console in
the photograph has 1TB.

**Consequences.** Provenance is tracked per fact. The agent's correct answer to an
unknown attribute is "I don't have that confirmed — I can ask the seller." Absence of a
fact is a first-class state, not a gap to fill.

---

## D-11 — Automatic product identification removed from scope
**Date** 2026-09-02 · **Status** Accepted

**Decision.** No brand, model, variant, specification, authenticity or damage inference
from images.

**Why.** Follows from D-10. Confidence scores do not cure the problem; they present a
guess as a measurement.

**Consequences.** Images serve inventory, organisation and buyer presentation. Any
future image intelligence is a new decision.

---

## D-12 — Automatic listing generation replaced by seller-content enhancement
**Date** 2026-09-02 · **Status** Accepted · **Supersedes** the earlier "photos in,
complete listing out" concept

**Decision.** The seller writes what they know; AI improves how it reads.

**Why.** Follows from D-10. It is also a better product for the seller who has the
knowledge and wants the typing removed, rather than one who wants facts invented.

**Consequences.** Original and enhanced text are stored separately; the seller can
accept, edit, reject or restore; only approved copy reaches buyers or the agent.

---

## D-13 — The AI cannot finalise a transaction
**Date** 2026-09-02 · **Status** Accepted

**Decision.** The agent negotiates. It never accepts. Seller approval is mandatory.

**Why.** An agent that can commit money creates dispute, chargeback and
consumer-protection exposure disproportionate to the value of automating the last click.
It is also the boundary every major marketplace's own AI has chosen.

**Consequences.** No `ACCEPT` intent. `ACCEPT_PENDING` routes to the seller.
Communication of acceptance is gated on a successful backend authorization.

---

## D-14 — Fulfilment stays with the seller
**Date** 2026-09-02 · **Status** Accepted

**Decision.** Exact meetup location, payment execution, shipping and physical exchange
are seller-controlled. The agent may collect availability and non-sensitive logistics.

**Why.** Safety and privacy. An automated system disclosing a private address to a
stranger is an unacceptable failure mode, and there is no product value in automating it.

**Consequences.** Location disclosure is a policy setting with an area-level maximum. No
payment or escrow capability at MVP.

---

## D-15 — Unconditional AI disclosure to buyers
**Date** 2026-09-02 · **Status** Accepted

**Decision.** Every buyer is told plainly, before the conversation and persistently
during it, that they are talking to an AI assistant acting for the seller, and that only
the seller can accept an offer.

**Why.** It is honest; it sets expectations that reduce buyer frustration; it is the
safest position under consumer-protection rules that treat misrepresenting the purpose
of a communication, or an agent's authority to settle terms, as an unfair practice; and
it costs nothing. Disclosure also makes the agent's refusals more acceptable to buyers.

**Consequences.** Disclosure copy is fixed text, never model-generated. It is a blocking
test, not a content decision.

---

## D-16 — Buyer risk scoring excluded from MVP
**Date** 2026-09-02 · **Status** Accepted

**Decision.** No buyer quality, trust or scam scores.

**Why.** Unexplainable scoring of individuals, on thin evidence, with no appeal path.
Ranking that is shown to a seller must be explainable; "this buyer looks risky" is not.

**Consequences.** Offer ranking uses explicit, explainable factors only — amount, timing,
conditions. The platform never fabricates competing interest to pressure a buyer.

---

## D-17 — Backend engineering baseline: TypeScript modular monolith on PostgreSQL
**Date** 2026-09-02 · **Status** Accepted (2026-09-03) · **Supersedes** D-08

**Decision.** The backend is built in TypeScript with strict compiler settings on
Node.js 24 LTS, as one modular monolith shipped as one container image with two entry
points, `web` and `worker`, from the same codebase. Fastify is the HTTP framework.
PostgreSQL is the single relational source of truth, accessed through Kysely, with
explicit SQL migrations and row-level security on seller-owned data. pg-boss is the
PostgreSQL-backed job queue, provisional until the acceptance spike (see **Acceptance**).
The authenticated seller dashboard is React
with Vite; the public buyer pages are server-rendered. Exact runtime and dependency
versions are pinned during implementation, not here.

Acceptance was conditional on a technical spike proving pg-boss's transactional
enqueueing, retry behaviour, redelivery and restricted-role operation. That spike ran and
passed; the record is under **Acceptance** below. D-08 is superseded. No document may
assume more than this entry states.

| Area | Baseline |
|---|---|
| Language and runtime | TypeScript, `strict` compiler settings; Node.js 24 LTS. Exact versions pinned at implementation. |
| Application structure | Modular monolith (`D-01`). One deployable container image. Two entry points from one codebase: `web` and `worker` (`OPS-510`). Separate buyer-facing and seller-facing route trees with separate middleware (`ARCH-002`). Module boundaries enforced by tooling, not convention. No microservices for the MVP. |
| Backend framework | Fastify. Zod schemas at every untrusted input and output boundary. Domain modules expose no unrestricted internal object to a public route. Buyer responses are produced only from explicit buyer-safe projections (`SEC-020`, `OPS-724`, `SEC-138`). |
| Database | PostgreSQL, the single relational source of truth (`OPS-701`). Kysely for typed access. Explicit, forward-only SQL migrations (`OPS-714`). Row-level security for seller-owned data (`SEC-100`). Separate migration/owner role and runtime role: the runtime role owns no table, cannot bypass row-level security and holds no schema-changing permission (`OPS-716`). Row-level security fails closed when tenant context is missing. Tenant context is transaction-scoped and is reset before a pooled connection is reused (`SEC-101`). |
| Background jobs | pg-boss (provisional until the acceptance spike; accepted with this entry). Jobs are enqueued in the same transaction as the domain write they belong to (`OPS-722`). pg-boss installation and upgrades run only through the migration role or a controlled CLI step; the runtime role performs no DDL. The dependency version is pinned. Its single-maintainer risk is `RISK-24`. |
| User interfaces | React with Vite for the authenticated seller dashboard. Server-rendered buyer pages for the public buyer experience (`BUYER-021`, `SEC-131`). Buyer pages stay usable when no worker is available (`OPS-770`). |
| Storage | An S3-compatible object-storage abstraction for listing images and attachments; development may use a local adapter. "Own store" (`OPS-719`, `DATA-104`) means a dedicated PostgreSQL schema or logical ownership boundary inside the one approved database, not a second database, unless a later decision explicitly changes it. |
| Authentication and security | Opaque, database-backed seller sessions (`AUTH-205`, `AUTH-207`, `AUTH-219`). Argon2id for password hashing (`AUTH-201`). Secure, HttpOnly, SameSite cookies. CSRF protection where applicable (`SEC-310`, `SEC-311`). Rate limiting, session rotation, expiry, revocation and audit events (`AUTH-204`, `AUTH-206` to `AUTH-209`, `AUTH-217`). The authentication library is not selected here; see below. |
| Observability and testing | Pino structured logging (`OPS-563`). OpenTelemetry-compatible tracing and metrics (`OPS-578`). Vitest for unit and integration tests. Testcontainers for PostgreSQL integration and security tests. Architecture-boundary tests with dependency-cruiser or an equivalent enforceable tool (`OPS-702`, `SEC-138`, `AI-204`). Deterministic guardrail tests (`AI-205`) and the AI evaluation suites of `ai/EVAL_STRATEGY.md`. |
| Deployment and cost | The smallest reliable deployment: at least one `web` process and one `worker` process. Replica counts are not fixed in advance and grow only from measured demand. Hosting provider, model provider, and email, push and other notification providers remain undecided. Infrastructure is selected only after a provider-specific cost model exists (`BIZ-270`, `OPS-443`). No operating-cost figure is claimed without one. |

**Why.** One language across the buyer surface, the seller dashboard, the worker, the
migrations and the eval harness keeps a two-person team's system comprehensible to one
person (`RISK-20`). Every MVP-gated requirement in `engineering/SYSTEM_REQUIREMENTS.md`
maps to a concrete mechanism in this baseline. PostgreSQL row-level security, role
separation and a PostgreSQL-backed queue satisfy the one-database, no-broker rule
(`D-01`, `ARCH-001`) without a second datastore. Server-rendered buyer pages are the only
shape that satisfies `BUYER-021` and `SEC-131`. The documentation set was written to
survive this choice, and it does: module boundaries, invariants and requirements are
unchanged by it.

**Consequences.** `CLAUDE.md`, `architecture/ARCHITECTURE.md` and
`engineering/SYSTEM_REQUIREMENTS.md` no longer describe the stack as undecided; they
cite this entry. Hosting, model provider, notification providers and the authentication
library are recorded as open questions (`Q-09` to `Q-12` in
`product/MASTER_PRODUCT_SPEC.md` §18) and are not decided by this entry. The
authentication library is a separate security-reviewed implementation decision or
spike. The pg-boss spike was the precondition of acceptance and has run (see
**Acceptance**). `RISK-24` is added to
`business/RISK_REGISTER.md`. The cost model in `business/UNIT_ECONOMICS.md` is
recomputed when a provider is named, not now.

**Conflict resolutions recorded with this entry.**

| Conflict | Resolution |
|---|---|
| C-01 — append-only approvals versus mutable approval status | A `SellerApproval` is stored as an insert-only approval header plus insert-only approval status events, one per transition of `architecture/STATE_MACHINES.md` §6. The current status is derived from those events and is never written back onto the header. The original approval record is never mutated (`OPS-705`, `SM-A-06`, `DM-11`). |
| C-08 — meaning of dedicated storage | Dedicated ownership means a dedicated PostgreSQL schema or domain boundary inside the single approved database. Object storage holds binary objects such as images only. The architecture diagram, `OPS-719` and the backup and restore drill in `engineering/OPERATIONS.md` §11 are aligned to this reading. |
| C-09 — Slice 0 code-entry thresholds | The 50% and 80% figures are reconciled as bands on code-entry completion as a share of page opens: below 50%, stop or fundamentally rework the concept; 50%–79%, revise the workflow and run validation again; 80% or higher, a clean pass permitting progression. The bands describe how Slice 0 data is read. They are not Slice 0 evidence; actual validation data is still required and `PLAN-007` stands. |

C-03 (`Q-02` shown as open after D-02 accepted Option C), C-04 (master-spec scope list
worded as a build order) and C-05 (minimum safety controls scheduled after the first
real AI execution) are documentation corrections made alongside this entry, in
`product/MASTER_PRODUCT_SPEC.md` §12 and §18 and `planning/MVP_ROADMAP.md` Slice 3,
Slice 8 and `PLAN-008`. None changes product scope.

**Acceptance.** Accepted on 2026-09-03 on the evidence of the backend-foundation spike
committed at `08d2d86d5de95832914c4d7f89c09d73f77c75c6` (`spikes/backend-foundation/`, a
disposable spike, not product code; its README carries the full procedure).

| Item | Evidence |
|---|---|
| Clean reproduction | Reproduced on 2026-09-03 from the committed lockfile in a fresh detached worktree at that commit: `npm ci --ignore-scripts` with the lockfile unchanged, `tsc --noEmit` clean, the complete suite 54 of 54 against a real PostgreSQL container, `npm audit` with no findings, no committed file changed, the container removed afterwards |
| Runtime and versions | Node.js 24.20.0 (LTS); PostgreSQL 16.15 (`postgres:16-alpine`, digest recorded in the spike README); pg-boss 12.29.0; TypeScript 6.0.3, Fastify 5.12.1, Kysely 0.29.5, Zod 4.5.4, Pino 10.3.1, Vitest 4.1.11, Testcontainers 12.1.0, all pinned exactly with a committed lockfile |
| Tests | 54 of 54 passing in 9 files: twice at the evidence commit with shuffled file and test order, and once more in the clean reproduction |
| Transactional enqueue and rollback | The domain row and its job are written by one transaction on one connection (the `xmin` of both rows equals the transaction id); commit keeps both, rollback keeps neither; a non-transactional control is shown not to be atomic (`OPS-722`) |
| Runtime without DDL | pg-boss installed only by the migration role through its CLI; the worker runs with `migrate: false`, processes jobs and runs maintenance with a byte-identical catalog before and after; it cannot create, alter, drop or reindex queue objects; with migrations pending it refuses to start, and a misconfigured `migrate: true` instance is stopped by the role (`OPS-716`) |
| Row-level security and pooled-connection isolation | Runtime roles are not superusers, cannot bypass RLS and own nothing; seller A cannot read, update, delete or insert across tenants; missing or invalid tenant context exposes no row; `FORCE` applies to the owner; a reused pooled connection carries no tenant identity, and the test is shown to detect the leak it guards against (`SEC-100`, `SEC-101`) |
| Exception retry and crash/lease recovery | A failing handler is retried per the queue policy with an observable attempt count and ends `completed`, or `failed` once the policy is exhausted; a worker process killed with SIGKILL mid-job is recovered by another instance after the attempt expires; a job whose heartbeat stops is failed by the monitor and redelivered. Killing a process while it is actively heartbeating was not run (follow-up 1 below) |
| Database-enforced idempotency | A pg-boss redelivery after a lost acknowledgement and four concurrent duplicate deliveries produce exactly one side effect, enforced by a `UNIQUE` constraint, not by application memory (`OPS-730`, `ARCH-013`) |
| Buyer-safe projection | Strict input validation rejects unknown and mass-assignment keys; the projection is a distinct constructed type that cannot hold a protected key at compile time and rejects spread-in fields at serialisation; the server-rendered buyer page and `/health` answer with no worker present (`SEC-020`, `SEC-021`, `OPS-724`, `OPS-770`) |

pg-boss is no longer provisional. It is operated under the rule in
`engineering/OPERATIONS.md` §2.1 (`OPS-522` to `OPS-524`), and `RISK-24` records the
remaining dependency risk. Accepting this entry authorises the baseline, not production
implementation: `planning/MVP_ROADMAP.md` `PLAN-007` still blocks Slice 1 until Slice 0
has produced a decision, and no Slice 0 validation evidence exists at the time of
acceptance.

**Follow-ups recorded at acceptance.** Non-blocking for this decision. None of them has
been tested; each applicable item is complete before the production capability it names
launches (`PLAN-009`).

| # | Follow-up | Complete before |
|---|---|---|
| 1 | Kill a worker process while it is actively heartbeating and verify recovery | The first production worker (Slice 3) |
| 2 | Design public buyer-listing tenant resolution: how a public listing id resolves to a tenant before row-level-security context exists | Production buyer routes (Slice 2) |
| 3 | Test PgBouncer transaction-pooling compatibility, if PgBouncer is introduced | Any introduction of PgBouncer |
| 4 | Test graceful `web` and `worker` deployment draining (`OPS-515`, `OPS-773`) | The first production deploy (Slice 1) |
| 5 | Define CI migration execution and failure recovery (`OPS-513`, `OPS-714`) | The first production migration (Slice 1) |
| 6 | Run performance tests at representative row and job volumes (`OPS-756`, `OPS-757`) | General availability |
| 7 | Establish formatter and linter choices for production code | The first production code (Slice 1) |
| 8 | Select an authentication library through a separate security-reviewed decision (`Q-12`) | Seller authentication (Slice 1) |

**Rejected alternatives.** A Go monolith: stronger runtime structural guarantees, rejected
for the second toolchain a React dashboard would add and for cgo-based image
processing. A Python/Django monolith: rejected because `AI-200` and `OPS-724` demand a
type-level guarantee Python cannot give, because row-level security sits awkwardly on
its connection model, and because its administrative surface is exactly what `SEC-373`
forbids. Stateless or hosted-identity session tokens used directly as sessions: fail
`AUTH-205`, `AUTH-207`, `AUTH-209` and `AUTH-219`. A Redis-, RabbitMQ- or cloud-queue-backed
job system: fails `ARCH-001` and `OPS-701`. A client-rendered buyer surface: fails
`BUYER-021`, `FX-04` and `SEC-131`. Fixing two web and two worker replicas at launch:
rejected as unmeasured cost.

**Deliberately not decided here.** Initial launch jurisdiction (`Q-07`); buyer-code
pre-filling (`Q-03`); cross-device buyer-session continuation (`Q-04`); buyer email
collection (`Q-05`); model provider (`Q-10`); hosting provider and region (`Q-09`);
notification providers (`Q-11`); AI turn and cost budgets (`Q-AG-02`); shadow-mode exit
criteria (`Q-EV-01`); live-versus-stub CI evaluation policy (`Q-EV-02`); the
authentication library (`Q-12`).

**Reconsideration triggers.** Any pg-boss trigger named in `OPS-524`. Slice 0
returns a stop decision and D-02 is reopened. The `OPS-757` load test or the `OPS-756`
plan assertions show row-level security or the queue cannot meet the p95 targets at
target row counts. `Q-07` resolves with a localisation requirement that forces a
regional split (`DATA-325`). Any proposal for a second deployable, a broker or a second
datastore.

---

## D-18 — Defer Slice 0 and authorize private-alpha development
**Date** 2026-09-03 · **Status** Accepted · **Supersedes** the implementation-start reading of `planning/MVP_ROADMAP.md` `PLAN-007`, and the sentence under D-17 **Acceptance** that `PLAN-007` blocks Slice 1 until Slice 0 has produced a decision. D-17 is otherwise unchanged and remains Accepted.

**Decision.** The founders defer the complete Slice 0 real-world validation exercise and
authorize private-alpha implementation of the product without it.

1. **Slice 0 remains incomplete and unpassed.** It has not run. No Slice 0 evidence
   exists. No decision memo under `validation/slice-0/DECISION_MEMO_TEMPLATE.md` has
   been produced or signed.
2. **The founders knowingly accept the additional product and market risk.** `ASM-01`
   to `ASM-05` and `BIZ-092` are unvalidated; Tests 1, 2 and 3 of
   `business/RISK_REGISTER.md` §4 have not run; engineering investment now precedes the
   evidence that `PLAN-001` and `BIZ-210` were written to obtain first.
3. **Private-alpha implementation may begin**, starting with Slice 1 of
   `planning/MVP_ROADMAP.md`, inside the boundaries below.
4. **Development initially uses synthetic, fictional or founder-controlled test data
   only**, consistent with `engineering/OPERATIONS.md` §1, where the `local` and `ci`
   environments hold synthetic fixtures only (`OPS-500`, `DATA-110`).
5. **The Slice 0 execution kit in `validation/slice-0/` remains canonical.** It is not
   deleted, weakened, shortened or re-scored by this decision. Its status references are
   updated only to cite this entry.
6. **Complete validation is deferred to a later release gate:** `PLAN-007` part (b),
   before public beta or general availability.
7. **Slice 0, run as the kit specifies and producing a signed decision under its decision
   gate, or a separately accepted replacement validation decision in this log, is
   required before public beta or general availability.** Nothing in this entry
   satisfies that requirement.
8. **This decision may be reconsidered at any time** by either founder. Reconsideration
   is recorded as a new entry, never by editing this one.

**This decision does not mean** that Slice 0 passed, that market demand was proven, that
willingness to pay was proven, that marketplace feasibility (Test 1) or buyer conversion
(Test 2) was proven, or that any validation evidence exists. A document, message or
interface that describes Slice 0 as complete, passed or evidenced is wrong.

**Why.** The founders chose to begin building now and to run the validation before any
public exposure rather than before any code. This entry records that choice and its
cost; it does not argue that the cost is small. The structural controls the
documentation set specifies — the authorization invariants, the deterministic guardrail
engine, the buyer-safe projection, tenant isolation — do not depend on the market
answers, so they can be built and tested on synthetic data without prejudging those
answers. The market answers still decide whether what is built reaches the public.

**Private-alpha boundaries.**

| Permitted under this entry | Not authorized by this entry |
|---|---|
| Local development | Public launch of any surface |
| Automated tests: unit, integration, contract, build, eval | Open user registration |
| Synthetic test accounts and data | Collection of real participant information without an approved process (the consent script in `validation/slice-0/` for validation activity; `security/DATA_AND_PRIVACY.md` and `Q-07` for the product) |
| Founder-operated internal demonstrations | Live payments or subscriptions; pricing stays unfixed (`BIZ-092`) |
| Founder-controlled listings or simulations | Scraping any marketplace (`D-07`, `INT-060`) |
| Development of the approved backend architecture (D-17) | Automated posting to marketplace accounts, or automated marketplace messaging (`D-07`) |
| Development of the seller and buyer workflows behind non-public access | Collection of marketplace passwords or credentials (`INT-060`) |
| | Representing Slice 0 as completed or passed |
| | Removing seller approval from offers or negotiations (`D-13`, `AUTH-INV-04`) |
| | Fabricating product facts (`D-10`, `INV-12`) |
| | Bypassing marketplace policies (`INT-022`, `INT-032`) |

"Behind non-public access" means: no buyer URL is published on any marketplace or public
channel; no seller account exists for anyone other than the founders and synthetic
personas; every listing in the alpha is founder-owned or fictional. A founder-controlled
real listing that carries a buyer URL on a marketplace is a Slice 0 activity and runs
under the kit's consent, privacy and evidence rules, not under this authorization.

**Consequences.**

- `planning/MVP_ROADMAP.md` `PLAN-007` is restated in two parts: (a) private-alpha
  development authorization, granted by this entry; (b) public-release validation
  authorization, which still requires Slice 0 or its accepted replacement. The Slice 0
  section carries a status note. `PLAN-001`, the Slice 0 procedure, its arms, measures
  and decision gate are unchanged.
- `business/RISK_REGISTER.md` `BIZ-212` is annotated: its sequencing rule is a knowingly
  accepted risk for private-alpha development and stays binding for public release.
  Test 3 still gates the negotiation slice on real provider rates.
- D-17's follow-ups apply unchanged under `PLAN-009`. Items 7 (formatter and linter) and
  8 (authentication library, `Q-12`) precede the code they govern and are therefore
  prerequisites for the first private-alpha code and for seller authentication
  respectively. Items 1, 2, 4 and 5 complete before the public exposure of the
  capability they name; item 6 before general availability.
- In `validation/slice-0/`, `README.md`, `HYPOTHESIS_AND_REQUIREMENTS_MATRIX.md` and
  `DECISION_MEMO_TEMPLATE.md` cite this entry where they referred to the old block. No
  other kit content changes.
- `CLAUDE.md` records the development status so every session reads the boundaries.
- `Q-03` to `Q-07` and `Q-09` to `Q-12` remain open. Hosting and model provider are still
  decided by their own entries before anything runs outside `local` and `ci`.

**Rejected alternatives.** Running Slice 0 first, as specified: deferred by choice, not
rejected on merit; it remains required. Declaring Slice 0 unnecessary, or substituting
the alpha's own metrics for it: rejected, because alpha data is founder-controlled and
cannot satisfy the real-buyer denominators of Test 2 or the channel evidence of Test 1.
Reducing the kit's minimums to fit a shorter run: rejected (`SLICE_0_SCORECARD.md` §5
rule 3).

**Reconsideration triggers.** Either founder asks. Any private-alpha finding that bears
on `ASM-01` to `ASM-05`, for example a founder-controlled listing removed by a
marketplace or an internal demonstration in which the code gate is not understood. Any
proposal to expose a surface to a non-founder. Any resolution of `Q-07`.

---

## D-19 — Seller authentication approach
**Date** 2026-09-04 · **Status** Accepted (2026-09-04) · **Resolves** `Q-12` · **Depends on** D-17 (Accepted), D-18 (Accepted)

**Proposal.** Seller authentication is built as a first-party Identity & Auth module
(`architecture/ARCHITECTURE.md` §3 module 1) from focused, maintained primitives already in
the D-17 baseline, not from an authentication framework. Accepted on 2026-09-04 by founder
decision (see **Acceptance** below); production implementation is authorised only inside the
acceptance conditions recorded there.

| Concern | Proposed mechanism | Exact evaluated version |
|---|---|---|
| Password verifiers (`AUTH-201`) | Argon2id from `node:crypto` (`crypto.argon2`, added in Node.js v24.7.0; the Node.js v24.19.0 changelog records "doc,crypto: mark argon2 and encap/decap as stable"), parameters `m=19456` KiB, `t=2`, `p=1`, 32-byte tag, 16-byte CSPRNG salt, encoded as a PHC string so a verifier is portable to any Argon2 implementation | Node.js 24.20.0, OpenSSL 3.5.7 (`process.versions.openssl`) |
| Session tokens (`AUTH-205`, `OPS-712`) | 32 CSPRNG bytes as base64url; PostgreSQL stores the SHA-256 only; idle and absolute lifetimes decided by the database clock (`AUTH-207`, `OPS-741`); rotation, single revocation and revoke-all are single transactions (`AUTH-206`, `AUTH-219`) | `node:crypto`, Kysely 0.29.5, pg 8.23.0 |
| Cookie | `@fastify/cookie`: `__Host-seller_session`, `HttpOnly`, `Secure`, `SameSite=Lax`, `Path=/`, host-only; `http` on loopback in `local` only; no cookie signing and therefore no cookie secret | `@fastify/cookie` 11.1.2 (MIT; dependencies `cookie`, `fastify-plugin`; compatible with Fastify 5 per its README table) |
| CSRF (`SEC-310`, `SEC-311`) | `Origin`, else `Referer`, must equal the seller origin; `Sec-Fetch-Site` other than `same-origin` refuses; absence refuses. Per-session anti-forgery value = HMAC-SHA256 keyed by the session token, sent in a request header; nothing stored, no server secret | first-party |
| Tenant context (`SEC-100`, `SEC-101`) | `withSellerSession`: one transaction resolves the session by hash, calls `set_config('app.seller_id', …, true)`, then runs the work. No live session, no context; nothing survives the transaction | the existing `withTenant` mechanism of `backend/src/db/kysely.ts` |
| Storage | A dedicated `auth` schema (`seller_account`, `seller_session`) owned by the migration role, `SELECT, INSERT, UPDATE` only for the runtime role, no `DELETE`; a forward-only migration in the existing ledger (`OPS-714`, `OPS-716`) | shape evaluated in the spike; the production migration is not written |
| Rate limiting (`AUTH-204`) | An interface consulted per hashed account key and per hashed client identifier before any key derivation; refusal answers a neutral response (`SEC-011`). The progressive-delay policy is production work | interface only |
| Audit (`AUTH-217`, `OPS-783`, `OPS-787`) | Six event types proposed for `ai/POLICY_AND_AUTHORIZATION.md` §12 — `SELLER_SIGN_IN_SUCCEEDED`, `SELLER_SIGN_IN_FAILED`, `SELLER_SIGN_IN_THROTTLED`, `SELLER_SESSION_ROTATED`, `SELLER_SIGNED_OUT`, `SELLER_SESSIONS_REVOKED` — written in the same transaction through module 19, carrying identifiers and a hashed client identifier only | first-party |
| Fallback for Argon2id | If the deployed runtime lacks `crypto.argon2`, `@node-rs/argon2` 2.2.0 (MIT, no install script, platform binaries as `optionalDependencies`, PHC output, defaults `m=19456,t=2,p=1`) behind the same `PasswordVerifier` interface. Not installed now | registry metadata read 2026-09-04 |

**Why it fits the canonical architecture.** Every primitive is in the D-17 baseline; the only
new production dependency is `@fastify/cookie` (two transitive packages). Migrations stay in
the forward-only ledger with the existing role separation; tenant resolution uses the existing
transaction-scoped `set_config` mechanism rather than a second lookup; no third-party identity
service, no telemetry, no hosting cost; module 1 knows nothing about listings; the seller and
buyer route trees remain separate (`ARCH-002`); the tests are deterministic Testcontainers
runs in the same shape as `backend/`. No secret is required for sessions or CSRF, so there is
no session-signing key to manage or leak.

**Requirements satisfied directly by the spike.** `AUTH-201`, `AUTH-202`, `AUTH-205`,
`AUTH-206`, `AUTH-207`, `AUTH-215`, `AUTH-219`, `AUTH-220`, `AUTH-223`; `AUTH-203` in its
structural half (byte-identical responses and equal key-derivation work for unknown account
and wrong password); `AUTH-208` and `AUTH-209` in their primitives (session list, revoke-one,
revoke-all in one transaction); `AUTH-217` through the proposed events; `SEC-101`, `SEC-310`,
`SEC-311`, `SEC-043`; `OPS-712`, `OPS-716`, `OPS-729`, `OPS-783`, `OPS-787`, `OPS-567`;
`SEC-380` to `SEC-383` for the spike's own lockfile.

**Custom code still required before seller authentication ships (production scope if
accepted).** The production `auth` migration; the Identity & Auth module carrying the spike's
service behind the module `index.ts` boundary; the seller route tree with deny-by-default
authorization declarations (`AUTH-222`); the `AUTH-204` progressive-delay limiter (candidate:
`@fastify/rate-limit` 11.2.0, or a database-backed counter, to be chosen with `Q-09`); the
`AUTH-203` timing-distribution test; founder-controlled synthetic account creation only (no
open registration, D-18); password change with revoke-others and notification (`AUTH-209`);
password reset with single-use hashed tokens (`AUTH-210`); the `AUTH-212` cross-presentation
matrix once buyer sessions exist; the session-retention job (`DATA-100`); the §12 catalogue
additions; the `OPS-571` log-corpus scan extended to the new forbidden patterns. Deferred with
an interface, not decided: email delivery for reset and verification and every seller
notification (`Q-11`, `INT-102`); the production hostname and hosting (`Q-09`, `SEC-333`);
email change (`AUTH-211`, GA); re-authentication window (`AUTH-214`, GA); second factor
(`AUTH-213`, GA); social login (not required by any MVP requirement); public buyer
authentication (none exists by design, `D-03`, `AUTH-216`).

**Rejected alternatives.**

| Candidate | Evaluated | Why not |
|---|---|---|
| better-auth | 1.7.2 (MIT), registry and repository read 2026-09-04; Kysely-based core, PostgreSQL through `pg`, Fastify through a Web-Request adapter | (1) The session token is stored in plaintext: the documentation describes the session table field "`token`: The session token. Which is also used as the session cookie", and `createSession` in `packages/better-auth/src/db/internal-adapter.ts` writes `token: generateId(32)` as-is. That fails `AUTH-205` and `OPS-712`, and no supported option hashes it; changing it means replacing internal adapter behaviour, the "extensive custom overrides" weakness. (2) It owns its schema and migrations (`npx auth migrate`, `getMigrations`) outside our forward-only ledger and role separation (`OPS-714`, `OPS-716`). (3) Default password hashing is scrypt; Argon2id needs a custom `password.hash`/`verify` override (documented, so workable). (4) No transaction-scoped tenant resolution: the session is read on its own connection, so `SEC-101` needs a second lookup. (5) 21 transitive packages including adapters for four other ORMs and `@better-auth/telemetry` (off by default). (6) Ten GitHub security advisories published in 2026, mostly in plugins; two in the core package (`GHSA-qq9h-g4jm-xgf3`, high, patched in 1.6.22; `GHSA-86j7-9j95-vpqj`, high, patched in 1.6.13). Maintenance is active and responsive, which is why it was the first candidate; the surface is what disqualifies it |
| `@fastify/session` + `@fastify/passport` + `passport-local` | 11.1.2, 4.0.2, 1.0.0 | `@fastify/session` (MIT, two dependencies, Fastify organisation) keys its store by the raw session id (`store.set(session.sessionId, …)` in `lib/session.js`) and signs the cookie with a server secret of 32 or more characters, so hashing at rest needs a custom store wrapper and a secret needs managing; the default store leaks memory and a Kysely store must be written. `@fastify/passport` adds serialisation and strategy plumbing but no password hashing, CSRF or tenant resolution. `passport-local` 1.0.0 was published on 2014-03-08 and has had no release since (registry `time`). The chain would replace about sixty lines of the spike with three packages and a secret, while still requiring all the custom code |
| Lucia | 3.2.2 | Deprecated on the registry ("This package has been deprecated"); excluded, not evaluated as a serious candidate |
| Auth.js (`@auth/core` 0.41.3) | — | No Fastify package exists on the registry (`@auth/fastify` returns 404); credentials flows are secondary to OAuth in its design; excluded |
| `@fastify/secure-session` 8.3.0 | — | Stateless encrypted-cookie sessions (`sodium-native` native dependency); server-side expiry and revocation (`AUTH-207`, `AUTH-219`) are not representable; D-17 already rejects stateless sessions |
| `argon2` (node-argon2) 0.45.1 | — | Sound and maintained, but carries an `install` script (`node-gyp-build`) and a native addon where the runtime already provides Argon2id; superseded by `crypto.argon2`, with `@node-rs/argon2` as the script-free fallback |
| Third-party identity SaaS | — | Excluded by the evaluation brief (no mandatory identity SaaS) and by D-17's rejection of hosted-identity tokens used as sessions |

**Security boundaries.** The `auth` schema is the only read that happens before tenant
context exists, and it is reachable by the runtime role with DML only. A token exists in
plaintext only in the browser's cookie jar and in the memory of the request that presents it;
a password only in the sign-in request. Nothing in the cookie is data. The seller origin is
configuration (`Q-09`), never hard-coded. Failure responses are fixed strings (`AUTH-215`).
The audit summary guard and the logger redaction list of `backend/` apply unchanged.

**Upgrade policy.** The Node.js line stays pinned by `backend/.node-version` and, once hosting
exists, by image digest (`SEC-385`); `crypto.argon2` requires a Node.js build with OpenSSL 3.2
or later, which the official 24.x binaries carry. Every verifier records its own parameters,
and `needsRehash` re-derives on the next successful sign-in when the policy changes, so a
parameter change is a configuration change. `@fastify/cookie` follows Fastify majors per its
compatibility table. Any new dependency is reviewed by the second founder (`SEC-381`) and
scanned in CI (`SEC-382`).

**Reconsideration triggers.** `crypto.argon2` is absent from the deployed runtime (use the
fallback and record it); an unpatched advisory against `@fastify/cookie` or Fastify; a
requirement for federation, single sign-on, organisation accounts or passkeys beyond a
first-party TOTP second factor (`AUTH-213`), at which point a framework is re-evaluated; a
second seller-facing application needing shared sessions; the `AUTH-203` timing-distribution
test failing against the first-party implementation.

**Evidence.** `spikes/authentication/` (a disposable spike, not product code; its README
carries the procedure and the claim table): 23 tests in 3 files passing twice with shuffled
order and once more after `npm ci --ignore-scripts` from the committed lockfile; the Argon2
reference implementation's known-answer vectors (`P-H-C/phc-winner-argon2` `src/test.c`)
reproduced raw and PHC-encoded; sign-in, generic failure, cookie attributes, hash-only
storage, server-side expiry, rotation, revocation, revoke-all, origin and anti-forgery
refusal, tenant resolution under the production migrations 0001 to 0006 with row-level
security, denial without a session, and a corpus scan of rows, audit events, logs and error
bodies for every secret the suite produced; `npm audit` with no findings; 73 production
packages, all MIT, BSD-3-Clause or ISC, none deprecated, none with an install script or a
native addon.

**Not decided here.** Password-reset and verification delivery, notification providers
(`Q-11`), hosting and hostname (`Q-09`), social login, second factor, buyer authentication.
Accepting this entry authorises the production implementation scope above and nothing else;
D-18's private-alpha boundaries apply unchanged.

**Acceptance.** Accepted on 2026-09-04 by founder decision, on the evidence of
`spikes/authentication/` at commit `1979dd01d28f6742056188b759d1107bd2883e53` (23 of 23 tests in
3 files, three runs, `npm audit` with no findings) and on the decisive claims re-verified at
acceptance: `crypto.argon2` is present on Node.js 24.20.0 (documented "Added in: v24.7.0";
the v24.19.0 changelog marks it stable) and reproduces the reference implementation's
Argon2id vectors; `@fastify/cookie` 11.1.2 is MIT with two dependencies and declares Fastify
`^5.x` compatibility; better-auth 1.7.2 persists `session.token` as generated
(`token: generateId(32)` in `internal-adapter.ts`, documented as "The session token. Which is
also used as the session cookie") and looks sessions up by that raw value. `Q-12` is resolved
by this entry. Together with D-17 this entry is the approved seller-authentication baseline.

**The accepted approach.**

- A narrow first-party Identity & Auth module (`architecture/ARCHITECTURE.md` §3 module 1).
- Node.js built-in `crypto.argon2` with the Argon2id variant for password verifiers.
- `@fastify/cookie` for cookie parsing and serialisation.
- PostgreSQL and Kysely-owned account and opaque-session storage in the forward-only ledger.
- Only SHA-256 hashes of session tokens stored.
- Transaction-scoped seller resolution followed by the row-level-security context.
- No general authentication framework. No external identity SaaS.

**Acceptance conditions.** Mandatory implementation conditions, not follow-ups. Each is a
blocking test or build check under `engineering/SYSTEM_REQUIREMENTS.md` conventions, and a
change that weakens one requires a superseding entry.

| # | Area | Condition |
|---|---|---|
| 1 | Runtime baseline | Pin a Node.js version that provides the proven `crypto.argon2` API. Production startup fails closed when the required Argon2id capability is unavailable. No silent fallback to another password library. Adding `@node-rs/argon2` or any other fallback requires a separate dependency and security review (`SEC-381`). |
| 2 | Password security | Argon2id parameters stay policy-controlled. A fresh CSPRNG salt of at least 16 bytes per verifier. Bounded PHC parsing and `needsRehash` behaviour preserved as proven in the spike. The asynchronous Argon2 API on request paths. Passwords, salts, verifiers and derived keys are never logged or audited (`AUTH-201`, `OPS-567`, `OPS-783`). |
| 3 | Session security | Opaque 32-byte CSPRNG tokens. Only SHA-256 token hashes stored; raw tokens never stored or logged (`AUTH-205`, `OPS-712`). Idle and absolute expiry decided server-side (`AUTH-207`). Rotation, single-session revocation and revoke-all (`AUTH-206`, `AUTH-208`, `AUTH-209`, `AUTH-219`). Authentication establishes the seller identity before the transaction-local RLS context is set, in the same transaction (`SEC-101`). No seller identity from a request body, query parameter or user-controlled header (`AUTH-220`, `AUTH-223`). |
| 4 | Cookie security | A `__Host-` cookie: `HttpOnly`; `Secure` outside an explicitly permitted loopback-only `local` environment; `SameSite=Lax` unless a later accepted decision changes it; `Path=/`; no `Domain` attribute. The opaque token needs no signed-cookie secret because the server validates its high-entropy hash; no signing secret is introduced without review. |
| 5 | CSRF and origin protection | Every state-changing authenticated seller route requires canonical `Origin`/`Referer` validation and the per-session anti-forgery value (`SEC-310`, `SEC-311`). If any anti-forgery secret is ever stored, only its hash is persisted. Failures are fixed, generic responses that expose no validation detail (`AUTH-215`). |
| 6 | Mandatory pre-route gates | Before any sign-in route is considered complete: the `AUTH-203` timing-distribution test implemented and passing; `AUTH-204` per-account and per-client progressive delay and rate limiting implemented; trusted-proxy behaviour defined; client identifiers not spoofable through untrusted forwarding headers; client identifiers hashed before audit storage (`SEC-043`, `AUTH-217`); concurrent session rotation and revocation tested; transaction rollback and pooled-connection context reset tested; the log-corpus and database scans (`OPS-571`, `OPS-790`) extended to authentication secrets. |
| 7 | Product boundaries | No open registration during the private alpha (D-18). Only founder-controlled synthetic accounts are provisioned initially. Password-reset and email-verification delivery stay unbound until the notification-provider decision (`Q-11`) is resolved. No social login, no second factor (`AUTH-213` stays a GA requirement) and no buyer authentication (`D-03`, `AUTH-216`). Hosting (`Q-09`), email and notification-provider (`Q-11`) decisions are not resolved by this entry. |
| 8 | Spike retention | `spikes/authentication/` is not deleted because this entry is Accepted. It is retained as reproducible evidence until production authentication implements and passes equivalent or stronger tests. It is deleted only in or after the production implementation commit that proves that parity, with the deletion clearly reported, and its history stays in Git. This supersedes the "disposable, delete on acceptance" wording above and in the spike's README at the evidence commit. |

**Still open after this entry.** `Q-09` hosting and hostname, `Q-10` model provider, `Q-11`
notification providers and therefore reset and verification delivery; social login is not a
requirement; `AUTH-213` second factor remains a GA requirement; buyer authentication does not
exist by design. D-17 and D-18 are unchanged. Slice 0 remains deferred, incomplete and
unpassed (D-18).

**First production task authorised by this entry.** The seller-authentication foundation
of Slice 1, behind non-public access on synthetic accounts: the forward-only `auth` schema
migration; the Identity & Auth module carrying the spike's password, token, cookie, CSRF and
session service behind its `index.ts`; the seller route tree's sign-in, sign-out,
sign-out-all, rotation and session-list routes with deny-by-default authorization
declarations (`AUTH-222`) and the origin hook; founder-controlled synthetic account
provisioning; the six audit event types added to the §12 catalogue, the TypeScript list and
the database enum; and every gate in condition 6 implemented and passing in the same change.
Nothing in condition 7 is part of it.
