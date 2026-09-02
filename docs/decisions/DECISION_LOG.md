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
**Date** 2026-09-02 · **Status** Open

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
**Date** 2026-09-02 · **Status** Proposed · **Supersedes** D-08 on acceptance

**Decision.** The backend is built in TypeScript with strict compiler settings on
Node.js 24 LTS, as one modular monolith shipped as one container image with two entry
points, `web` and `worker`, from the same codebase. Fastify is the HTTP framework.
PostgreSQL is the single relational source of truth, accessed through Kysely, with
explicit SQL migrations and row-level security on seller-owned data. pg-boss is the
provisional PostgreSQL-backed job queue. The authenticated seller dashboard is React
with Vite; the public buyer pages are server-rendered. Exact runtime and dependency
versions are pinned during implementation, not here.

Acceptance is conditional: this entry moves from Proposed to Accepted only when a
technical spike has proved pg-boss's transactional enqueueing, retry behaviour,
redelivery and restricted-role operation. Until then D-08 stands and no document may
assume more than this entry states.

| Area | Baseline |
|---|---|
| Language and runtime | TypeScript, `strict` compiler settings; Node.js 24 LTS. Exact versions pinned at implementation. |
| Application structure | Modular monolith (`D-01`). One deployable container image. Two entry points from one codebase: `web` and `worker` (`OPS-510`). Separate buyer-facing and seller-facing route trees with separate middleware (`ARCH-002`). Module boundaries enforced by tooling, not convention. No microservices for the MVP. |
| Backend framework | Fastify. Zod schemas at every untrusted input and output boundary. Domain modules expose no unrestricted internal object to a public route. Buyer responses are produced only from explicit buyer-safe projections (`SEC-020`, `OPS-724`, `SEC-138`). |
| Database | PostgreSQL, the single relational source of truth (`OPS-701`). Kysely for typed access. Explicit, forward-only SQL migrations (`OPS-714`). Row-level security for seller-owned data (`SEC-100`). Separate migration/owner role and runtime role: the runtime role owns no table, cannot bypass row-level security and holds no schema-changing permission (`OPS-716`). Row-level security fails closed when tenant context is missing. Tenant context is transaction-scoped and is reset before a pooled connection is reused (`SEC-101`). |
| Background jobs | pg-boss, provisionally. Jobs are enqueued in the same transaction as the domain write they belong to (`OPS-722`). pg-boss installation and upgrades run only through the migration role or a controlled CLI step; the runtime role performs no DDL. The dependency version is pinned. Its single-maintainer risk is `RISK-24`. |
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
spike. The pg-boss spike is a precondition of acceptance. `RISK-24` is added to
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

**Reconsideration triggers.** The pg-boss spike fails any of its four proofs. Slice 0
returns a stop decision and D-02 is reopened. The `OPS-757` load test or the `OPS-756`
plan assertions show row-level security or the queue cannot meet the p95 targets at
target row counts. `Q-07` resolves with a localisation requirement that forces a
regional split (`DATA-325`). Any proposal for a second deployable, a broker or a second
datastore.
