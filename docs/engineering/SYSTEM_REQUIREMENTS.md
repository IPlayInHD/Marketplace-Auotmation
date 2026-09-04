# System Requirements

**Status:** Canonical for testable system-level requirements.

**Authority.** Scope is set by `product/MASTER_PRODUCT_SPEC.md` §12–§14.
`ai/POLICY_AND_AUTHORIZATION.md` wins on AI authority and on who may authorize.
`security/PUBLIC_ACCESS_SECURITY.md` wins on the public buyer surface; §8 of this
document references it and does not restate it. Lifecycles are defined once in
`architecture/STATE_MACHINES.md`. Entity responsibilities are in
`architecture/DOMAIN_MODEL.md`. Module boundaries are in
`architecture/ARCHITECTURE.md`. Vocabulary is `GLOSSARY.md`.

**Binding prohibitions.** No pricing engine, no valuation, no market data, no
comparable-sales retrieval, no automatic product identification, no listing generation
from photographs, no marketplace scraping or messaging automation, no autonomous
acceptance (`R-01` to `R-09`, `D-09` to `D-14`). No requirement below may be read as
permitting any of them. `AI-220` makes their absence itself testable.

**Stack baseline.** The backend baseline is recorded in `decisions/DECISION_LOG.md`
D-17 (Accepted 2026-09-03; supersedes D-08). Requirements below still describe
capabilities and observable behaviour, never a product, so they hold whatever implements
them. Hosting and cloud provider remain undecided (`Q-09`).

---

## 1. Requirement ID blocks used by this document

To avoid renumbering published identifiers, this document uses a reserved block in each
prefix it touches. Identifiers outside these blocks belong to other documents and are
cited here, never redefined.

| Prefix | Block used here | Area | Blocks already taken elsewhere |
|---|---|---|---|
| `OPS-` | **700–799** | Backend and data, idempotency and concurrency, performance, reliability, auditability, observability | 001–034 `ai/EVAL_STRATEGY.md` · 100–129 `product/PRD.md` · 200–314 `product/INVENTORY_AND_SALES.md` · 400–449 `business/UNIT_ECONOMICS.md` · 500–699 `engineering/OPERATIONS.md` |
| `AUTH-` | **200–299** | Authentication, session management, authorization, offer and approval integrity | 001–008 `ai/POLICY_AND_AUTHORIZATION.md` · 100–129 `product/PRD.md` |
| `SEC-` | **100–199** | Tenant isolation, buyer session isolation, the public interface | 001–043 `security/PUBLIC_ACCESS_SECURITY.md` · 300–399 `security/THREAT_MODEL.md` · 500–599 `security/AI_THREAT_MODEL.md` |
| `AI-` | **200–299** | AI behaviour boundaries | 001–006 `product/MASTER_PRODUCT_SPEC.md` · 010–034 `ai/AI_AGENT_SPEC.md` · 100–119 `product/PRD.md` |
| `INT-` | **100–199** | Integrations and external dependencies | 001–099 `integrations/MARKETPLACE_STRATEGY.md` |
| `DATA-` | **100–149** | Data retention as a system property | 200–399 `security/DATA_AND_PRIVACY.md` |

## 2. How to read these requirements

`OPS-700` Every requirement in this document is written so that a test can fail it. A
statement that cannot fail is not a requirement and does not belong here.

| Rule | Statement |
|---|---|
| Observable | Each requirement names behaviour observable at an interface, in the database, in a log, in a metric or in a build step. |
| Single assertion | One requirement, one thing that can break. Compound statements are split. |
| Verification named | Every requirement carries a verification column stating the kind of test that proves it. |
| Cited, not copied | Where a canonical document already states a rule, the requirement cites it and adds only what makes it testable here. |
| Gate | `MVP` blocks the MVP scope of `MASTER_PRODUCT_SPEC.md` §12. `GA` blocks general availability. Nothing here is optional. |

Verification kinds used below: **unit**, **integration**, **contract** (a type- or
schema-level assertion), **build** (a check that fails the build or startup), **eval**
(`ai/EVAL_STRATEGY.md`), **load**, **manual** (a recorded exercise, not an opinion).

---

## 3. Backend and data

| ID | Requirement | Verification | Gate |
|---|---|---|---|
| OPS-701 | One deployable application and one relational database. A second deployable, broker beyond a simple work queue, or datastore requires a superseding decision (`D-01`, `ARCH-001`). | build: dependency manifest scanned for additional datastore or broker drivers | MVP |
| OPS-702 | No module reads another module's tables. Cross-module access is through an explicit interface (`ARCH` §3). | build: schema-ownership map checked against query call sites | MVP |
| OPS-703 | Monetary amounts are stored as integer minor units with an explicit ISO 4217 currency (`DM-07`). No floating-point money column exists. | build: schema scan rejects float or decimal-typed money columns; unit: fractional input rejected | MVP |
| OPS-704 | An arithmetic or comparison operation between two amounts of different currency raises rather than coerces. | unit | MVP |
| OPS-705 | Messages, offers, offer versions, approval headers, approval status events and audit events are append-only. No update or delete path exists for them in application code or in the granted database role. Current approval status is derived from the status events; the approval header is never mutated (`SM-A-06`, `DM-11`). | build: role privileges asserted; integration: update attempt fails | MVP |
| OPS-706 | Listing content, seller policy and offer terms are versioned and immutable; a change appends a version (`DM-06`). | integration | MVP |
| OPS-707 | A lifecycle transition not drawn in `architecture/STATE_MACHINES.md` is rejected at the data layer, not only in application code. | integration: each illegal transition attempted per state machine | MVP |
| OPS-708 | `Message.sequence_number` is unique per conversation and strictly increasing. Ordering is by sequence, never by timestamp. | integration: concurrent inserts produce no gap-free duplicate; unit for ordering | MVP |
| OPS-709 | Every entity except `User` carries a seller id (`DM-01`). | build: schema scan for tenant column presence | MVP |
| OPS-710 | Access codes are stored as a salted hash produced by a slow key-derivation function. Plaintext is never persisted, and is displayed to the seller once at issue (`DM-08`, `ACCESS-013`). | contract: no plaintext column; integration: issue-then-read returns no plaintext | MVP |
| OPS-711 | The opaque public listing id carries at least 64 bits of entropy from a CSPRNG and is non-sequential (`SEC-003`, `BUYER-002`). | unit: entropy and alphabet; integration: two consecutive issues are not adjacent under any ordering | MVP |
| OPS-712 | Buyer and seller session tokens carry at least 128 bits of CSPRNG entropy and are stored hashed. | unit; contract | MVP |
| OPS-713 | Timestamps are stored with an explicit time zone in UTC. | build: schema scan | MVP |
| OPS-714 | Schema migrations are forward-only and run in CI against a database loaded with production-shaped volumes before they may run in production. | build | MVP |
| OPS-715 | No personal data and no secret appears in a primary key, a URL path or a query string. | build: route inventory reviewed against a forbidden-field list | MVP |
| OPS-716 | The application database role cannot create, alter or drop schema objects, owns no table, and cannot bypass the data-layer tenant isolation of `SEC-100`. Migrations, including queue-library installation and upgrades, run under a separate role or a controlled CLI step, under the pg-boss operating rule of `engineering/OPERATIONS.md` §2.1 (`OPS-522` to `OPS-524`; D-17). | build: privilege assertion | MVP |
| OPS-717 | Data is encrypted at rest in the database and in object storage, and in transit on every hop including internal ones. | integration: connection asserts TLS; manual: storage configuration recorded | MVP |
| OPS-718 | Object storage is private by default. Images are served through signed, expiring URLs or an authenticated proxy, never from a world-readable path. | integration: direct unsigned fetch is refused | MVP |
| OPS-719 | Conversation transcripts live in their own store — a dedicated schema or ownership boundary inside the single relational database of `OPS-701`, never a second datastore — with their own retention, separate from application logs (`SEC-042`, `DATA-104`, D-17). | contract; integration | MVP |
| OPS-720 | Every write to a consequential entity records the request id that caused it. | integration | MVP |
| OPS-721 | Every list endpoint paginates with a hard maximum page size and a server-side query timeout. | integration: oversized page request is clamped, not honoured | MVP |
| OPS-722 | Notifications and buyer-visible agent messages are emitted through a transactional outbox; nothing is sent for a transaction that rolled back (`ARCH-011`). | integration: forced rollback emits nothing | MVP |
| OPS-723 | No model call occurs inside a database transaction or inside a request handler holding a database connection (`ARCH-010`). | build: static check on call sites; integration | MVP |
| OPS-724 | The buyer-safe projection is a distinct constructed type, not a filtered copy of the listing record, and cannot structurally hold a protected field (`SEC-020`, `SEC-021`). | contract | MVP |
| OPS-725 | No column, field, computed value or export anywhere in the system holds an estimated value, market price, comparable, demand figure or suggested price (`D-09`, `OPS-211`). | build: schema and API scan against a forbidden-name list; manual review at each release | MVP |
| OPS-726 | The seller display name is the only seller identity field present in any buyer-facing payload. | contract: projection type; integration: payload diff | MVP |
| OPS-727 | Fixed text (`FT-01` to `FT-06`) is an application constant. No seller, buyer or runtime configuration can alter it (`AI-025`). | build: constants are not read from a mutable store | MVP |
| OPS-728 | A reconciliation job detects any listing in `PENDING_SALE` with no `EXECUTED` approval, any `EXECUTED` approval with no listing transition, and any offer `APPROVED` on a listing that is not `PENDING_SALE` or `SOLD`. Each finding alerts. | integration: injected inconsistency is detected within one job interval | MVP |
| OPS-729 | Database and object-storage credentials are read from a secret store at runtime and never appear in source, images, environment dumps or logs. | build: secret scan in CI | MVP |

---

## 4. Authentication and session management

| ID | Requirement | Verification | Gate |
|---|---|---|---|
| AUTH-200 | Sellers authenticate with an email address and a password meeting a policy stated inline at sign-up (`PROD-100`). | integration | MVP |
| AUTH-201 | Passwords are stored with a memory-hard key-derivation function and a per-user salt. No code path can recover a password. | build: no reversible encryption of credentials; unit: verifier only | MVP |
| AUTH-202 | The password policy is enforced server-side. A request bypassing the client is rejected. | integration | MVP |
| AUTH-203 | Sign-in failure returns one generic message for unknown account and wrong password, and the two are statistically indistinguishable in response time. | integration: timing distributions compared over n samples | MVP |
| AUTH-204 | Sign-in is rate-limited per account and per client with progressive delay. The mechanism cannot permanently lock a legitimate seller out of their own account. | integration: threshold reached, then recovery after the window | MVP |
| AUTH-205 | The seller session token is opaque, at least 128 bits, delivered in an httpOnly, Secure, SameSite cookie, stored hashed server-side, and never present in a URL, log, analytics payload or error message (`SEC-041`). | contract; integration: log scrape asserts absence | MVP |
| AUTH-206 | A new session identifier is issued on authentication and on any privilege change. A pre-authentication identifier is never carried forward. | integration | MVP |
| AUTH-207 | Both an idle timeout and an absolute lifetime are enforced server-side. Expiry is authoritative on the server, not on the cookie. | integration: expired token rejected after clock advance | MVP |
| AUTH-208 | A seller can list and revoke their active sessions. Revocation takes effect on the next request. | integration | GA |
| AUTH-209 | A password change or an email change invalidates every other session for that account and notifies the account address. | integration | MVP |
| AUTH-210 | Password reset tokens are single-use, short-lived, stored hashed, and invalidated on use or on any password change. The reset flow does not disclose whether an account exists. | integration | MVP |
| AUTH-211 | An email change requires re-authentication and confirmation at both the old and the new address. | integration | GA |
| AUTH-212 | A seller session presented to a buyer route is not honoured, and a buyer session presented to a seller route is not honoured. The two are separate route trees with separate middleware (`ARCH-002`, `SEC-032`). | integration: cross-presentation matrix | MVP |
| AUTH-213 | A second authentication factor is available to sellers. **Not in the MVP list of `MASTER_PRODUCT_SPEC.md` §12**; recorded here as a general-availability requirement. | integration | GA |
| AUTH-214 | Consequential account changes — password, email, revoke-all-sessions, account deletion — require re-authentication within a short window. | integration | GA |
| AUTH-215 | No error message, stack trace or response header discloses credential material, a session token, an access code or an internal identifier. | integration: error-path scrape | MVP |
| AUTH-216 | A `BuyerSession` is not authentication and never carries seller identity, tenancy or entitlement (`GLOSSARY`, `BUYER-013`). | contract: session types are distinct and non-convertible | MVP |
| AUTH-217 | Sign-in, sign-out, failure, lockout, reset and second-factor events are audited with a hashed client identifier rather than a raw address (`SEC-043`). | integration | MVP |
| AUTH-218 | No API key, personal access token or machine credential is issued at MVP. Introducing one requires a decision entry in `decisions/DECISION_LOG.md`. | build: no such issuance route exists | MVP |
| AUTH-219 | Sign-out invalidates the session server-side. Clearing the cookie alone is not sufficient. | integration: captured token replayed after sign-out fails | MVP |

---

## 5. Authorization

| ID | Requirement | Verification | Gate |
|---|---|---|---|
| AUTH-220 | Ownership for every seller-scoped read and write is derived from the authenticated session, never from a request parameter, header or body field. | integration: parameter-tampering matrix | MVP |
| AUTH-221 | A valid identifier belonging to another seller returns exactly the response a non-existent identifier returns. Existence is not disclosed by status code, body, header or timing. | integration | MVP |
| AUTH-222 | Authorization is deny-by-default. A route with no explicit authorization declaration fails closed and fails the build. | build: route inventory versus declaration inventory | MVP |
| AUTH-223 | No client-supplied role, tenant id, plan, entitlement or feature flag is trusted. All are re-derived server-side. | integration | MVP |
| AUTH-224 | Approval endpoints are reachable only by an authenticated seller who owns the listing. The Seller Approval module has no caller other than an authenticated seller action (`ARCH` §3 module 14, `AUTH-INV-04`). | build: call-site inventory; integration | MVP |
| AUTH-225 | Buyer-supplied listing, conversation, offer and message identifiers are never trusted. Scope is re-derived server-side from the session token on every request (`SEC-031`). | integration | MVP |
| AUTH-226 | Plan and entitlement limits are enforced server-side at the point of effect, not only in the interface. | integration | GA |
| AUTH-227 | Every authorization failure is logged with the route, the requirement id and a hashed actor identifier, and is exposed as a metric that can be alerted on. | integration | MVP |
| AUTH-228 | No support or operator impersonation of a seller exists at MVP. If introduced it must be consented, time-boxed, audited, visible to the seller, and structurally incapable of creating a `SellerApproval` (`AUTH-INV-04`). | build: no impersonation route; contract if introduced | MVP |
| AUTH-229 | No query, export, report, notification or analytics surface can return another seller's conversations, offers, approvals, audit events or analytics. | integration: cross-tenant probe across the full route inventory | MVP |

---

## 6. Tenant isolation

| ID | Requirement | Verification | Gate |
|---|---|---|---|
| SEC-100 | Tenant isolation is enforced at the data layer in addition to application filtering. A query that omits its tenant predicate fails rather than returning another seller's rows (`NFR-007`, `SEC-030`). The enforcement fails closed: with no tenant context present, no seller-owned row is readable or writable. | integration: for each seller-owned table, an unpredicated query errors | MVP |
| SEC-101 | The tenant context is established once per request or per job from the authenticated principal, and is not passed as a mutable argument through the call stack. Where database connections are pooled, the context is transaction-scoped and is reset before a connection is reused. | build: single construction site | MVP |
| SEC-102 | Every background job carries a tenant context. A job with none cannot touch a tenant-owned table. | integration: injected contextless job fails | MVP |
| SEC-103 | Analytics are computed per tenant. No cross-tenant aggregate, benchmark, ranking or comparison reaches a seller surface. | contract: analytics query shape; integration | MVP |
| SEC-104 | Object-storage keys are unguessable and every read is access-checked against the tenant. Knowing a key is not sufficient to read an object. | integration: cross-tenant key fetch refused | MVP |
| SEC-105 | Cache keys include the tenant id. A test asserts that no cached response crosses tenants. | integration: warm cache as seller A, read as seller B | MVP |
| SEC-106 | A seller export contains that tenant's rows only, asserted by identifier set and row count, not by inspection. | integration | GA |
| SEC-107 | No list, search or filter parameter can widen a query beyond the tenant. | integration: fuzz over query parameters | MVP |
| SEC-108 | A tenant-isolation failure detected in production is a highest-severity incident with an immediate page (`engineering/OPERATIONS.md` §8). | manual: alert injection exercise | MVP |

---

## 7. Buyer session isolation

| ID | Requirement | Verification | Gate |
|---|---|---|---|
| SEC-110 | A `BuyerSession` is bound to exactly one `PublicListingAccess` at creation and the binding is immutable (`SM-S-01`, `DM-02`). | contract; integration: rebinding attempt rejected | MVP |
| SEC-111 | Two buyers entering the same code receive two distinct sessions and two distinct conversations (`BUYER-015`). | integration | MVP |
| SEC-112 | A buyer session cannot read another buyer's messages, offers, conditions, summary or identity through any route, and cannot obtain them through the agent (`T-06`, eval `PA-08`, `PA-11`). | integration; eval | MVP |
| SEC-113 | A conversation is keyed by session. No client-supplied conversation identifier is trusted. | integration | MVP |
| SEC-114 | Every seller route returns the not-found response to a buyer session (`SEC-032`, eval `PA-09`). | integration: full seller route inventory exercised with a buyer session | MVP |
| SEC-115 | Buyer sessions expire on idle and on an absolute limit, and are revoked when the listing sells, is cancelled or archived, or when the seller blocks that buyer (`BUYER-017`, `STATE_MACHINES.md` §3). | integration | MVP |
| SEC-116 | `BLOCKED` and `EXPIRED` sessions produce the generic mismatch response and never an explanation (`SM-S-02`). | integration: body and status compared byte for byte with the wrong-code response | MVP |
| SEC-117 | A new session created by a returning buyer who lost their cookie does not expose the previous conversation (`BUYER-016`, `EC-06`). | integration | MVP |
| SEC-118 | The agent's context for a turn contains that conversation only — no other conversation, offer, buyer or listing (`AI-012`, `AI-200`). | contract; eval fixture context assertion | MVP |
| SEC-119 | Use of one buyer session token from many clients at once is detectable and produces a metric that can be alerted on (`T-07`). | integration | GA |

---

## 8. The public interface

`security/PUBLIC_ACCESS_SECURITY.md` is canonical for this surface. The requirements
below are the system-level obligations that document implies and does not itself state.
Nothing here restates its controls, its rate-limit design, its projection rules or its
test list.

| ID | Requirement | Verification | Gate |
|---|---|---|---|
| SEC-130 | The public buyer surface conforms to `security/PUBLIC_ACCESS_SECURITY.md`. Where this document and that one touch, that one wins. | manual: conformance review recorded per release | MVP |
| SEC-131 | The static listing preview is served independently of the conversation backend and stays available when that backend is degraded or disabled (`BUYER-021`, `T-11`). | integration: conversation backend stopped, preview still returns 200 | MVP |
| SEC-132 | Buyer pages send a strict content-security policy, deny framing, set a referrer policy that does not leak the public id to third parties, and are marked `noindex` (`T-02`, `T-12`). | integration: header assertions | MVP |
| SEC-133 | The buyer surface exposes no endpoint that accepts a file, an attachment or an arbitrary URL from a buyer (`BUYER_ACCESS_FLOW.md` §9). | build: route inventory carries no such endpoint | MVP |
| SEC-134 | Buyer-facing errors are generic and constant in body and in timing across wrong code, revoked code, expired code, unknown listing and blocked session (`BUYER-010`, `SM-C-03`). | integration: byte comparison and timing distribution | MVP |
| SEC-135 | The AI disclosure `FT-01` is rendered server-side by the surface before the first message and persistently during the conversation, and is never model-generated (`D-15`, `BUYER-006`, `AI-025`). | integration: markup assertion; eval `PA-01` | MVP |
| SEC-136 | No email, SMS or push message is sent to a buyer. Introducing one requires closing `Q-05` with a decision entry. | build: no buyer-addressed delivery route | MVP |
| SEC-137 | The buyer surface is usable on a mobile browser with no app install and no account, verified on a throttled connection (`NFR-005`, `BUYER-020`, `BUYER-022`). | integration: automated mobile-viewport run under bandwidth constraint | MVP |
| SEC-138 | Every buyer-facing response is produced from the buyer-safe projection type. No handler on the public route tree can reach the listing record directly. | build: import and call-site restriction on the public tree | MVP |

---

## 9. AI behaviour boundaries

| ID | Requirement | Verification | Gate |
|---|---|---|---|
| AI-200 | The agent-context type cannot structurally hold a protected field. This is a type-level guarantee, not a runtime filter (`ARCH-008`, `AI-012`, `SEC-021`). | contract | MVP |
| AI-201 | The minimum acceptable price, target price, maximum autonomous concession and auto-decline threshold are absent from every prompt sent to a model (`D-04`). | contract; eval: every conversation fixture asserts `must_not_contain_values` (`OPS-007`) | MVP |
| AI-202 | The model emits only the structured proposed action of `ai/POLICY_AND_AUTHORIZATION.md` §6. No free prose reaches a buyer without passing the guardrail engine (`D-05`, `AI-027`). | contract: response schema; integration | MVP |
| AI-203 | There is always a deterministic evaluation between the model and any effect on a buyer or on the database. The path buyer message to model to effect does not exist (`ARCH-006`). | build: call-site inventory; integration | MVP |
| AI-204 | The guardrail engine performs no I/O, no clock access and no network access (`ARCH-004`). | build: the module's dependency set is empty of I/O; unit: determinism under fixed inputs | MVP |
| AI-205 | At least 200 guardrail unit tests exist before the negotiation slice ships (`D-05`, `POLICY_AND_AUTHORIZATION.md` §7). | build: test count assertion | MVP |
| AI-206 | No `ACCEPT` intent exists in the proposed-action schema. A response containing one is a schema violation, not a policy violation (`AUTH-003`, `D-13`). | contract | MVP |
| AI-207 | Every product claim in an agent reply cites a `ProductFact` with `SELLER_PROVIDED_FACT` provenance; an uncited claim is denied by `G-05`. | unit; eval `CV-02`, `CV-03`, `CV-04` | MVP |
| AI-208 | Enhanced copy passes the deterministic validator before the seller sees it, and there is no override that lets failing output through (`LIST-053`, `LIST-057`, `LIST-058`). | unit; integration; eval `LE-03` to `LE-07`, synthetic mode | MVP |
| AI-209 | No image is passed to any model call. No image-derived statement can appear in listing copy or in an agent reply (`LIST-035`, `D-11`). | build: call-site inventory carries no image payload; contract | MVP |
| AI-210 | No model call reads another listing, another seller's content, another conversation, market data or any external source (`LIST-032`, `AI-012`). | contract; integration | MVP |
| AI-211 | Buyer text enters the prompt delimited and labelled as untrusted data. Nothing inside the delimiter is treated as an instruction, a system message, a policy change, a fact, a permission or a record of prior agreement (`AI-014`, `ARCH-003`, `AUTH-INV-01`). | integration: prompt assembly asserts delimiting; eval `CV-08`, `NG-10` | MVP |
| AI-212 | Egress redaction runs over outbound text after an `allow` verdict and before send (`AI-029`, `T-08`). | unit; integration | MVP |
| AI-213 | Fixed text is emitted verbatim from the application constant. Paraphrase is a failure, not a variation (`AI-025`, `G-10`). | eval: `must_match` byte-for-byte | MVP |
| AI-214 | Agent memory can hold tone and phrasing preference only. It cannot hold a price, a permission, an approval, a disclosure right or any consequential value (`AUTH-008`, `AUTH-INV-03`). | contract: memory record type; integration | MVP |
| AI-215 | Tier selection is deterministic. Price-mention detection is a code pre-pass that runs before tier selection, so tier choice is never itself a model decision (`AI-031`, `AI-032`). | unit | MVP |
| AI-216 | Turn and cost budgets are enforced outside the model. A breach degrades tier, then degrades to holding mode, and never removes the buyer's ability to send a message (`G-13`, `AI-034`, `ARCH-014`). | integration; eval: cost-breaker case (`PUBLIC_ACCESS_SECURITY.md` §8) | MVP |
| AI-217 | Every turn persists the message, the proposed action, the guardrail decision, the policy version in force and the cost, so any past reply can be explained against the rules that applied when it was generated (`AI-030`). | integration | MVP |
| AI-218 | The blocking eval suite runs and passes before any change to a prompt, a response schema, a model, a tier, a routing rule, a validator or a guardrail check merges (`EVAL_STRATEGY.md` §6). | build: CI gate | MVP |
| AI-219 | The eval suite loader rejects a fixture whose suite name is not one of the five defined suites (`OPS-034`). | unit | MVP |
| AI-220 | No component estimates value, retrieves comparables, recommends a price from market data, identifies a product from an image, generates a listing from photographs, verifies authenticity, scores a buyer, or reads or writes any marketplace (`R-01` to `R-09`). Their absence is asserted, not assumed. | build: schema, route and dependency scan; eval: no fixture exists for any of them (`OPS-033`) | MVP |
| AI-221 | The first 500 real conversations run in shadow mode: the agent generates and the guardrail engine evaluates, and nothing reaches a buyer (`OPS-028`). | manual: shadow-mode exit criteria recorded before the run begins | MVP |
| AI-222 | Two kill switches exist — per seller and global — both deterministic, both effective on the next turn, neither requiring a model call, a deploy or a migration (`OPS-030`, `OPS-031`). | integration: activation under load; manual: quarterly exercise | MVP |
| AI-223 | Every guardrail denial and every escalation in production emits a candidate eval fixture, redacted and paraphrased before it enters the repository (`OPS-022`, `OPS-023`). | integration; manual: queue reviewed on the cadence of `OPS-027` | MVP |
| AI-224 | A model, provider or validator failure produces a holding reply and a seller notification. It never produces an invented answer, a silent drop or a fabricated fact (`ARCH-014`, `NFR-003`, `SM-CV-02`). | integration: fault injection on the provider boundary | MVP |

---

## 10. Offer and approval integrity

| ID | Requirement | Verification | Gate |
|---|---|---|---|
| AUTH-240 | A `SellerApproval` references exactly one `OfferVersion` and stores a hash of the material terms captured at approval time (`D-06`, `AUTH-INV-05`, `DM-05`). | contract; integration | MVP |
| AUTH-241 | The material-terms hash covers exactly amount, currency, included items, delivery or pickup mode, and every condition attached to the offer (`GLOSSARY` Material Terms, `NEG-017`). Changing any one changes the hash; changing a non-material field does not. | unit: hash coverage matrix over every field | MVP |
| AUTH-242 | The hash stored with the approval is computed from the same terms rendering that was displayed to the seller, not from a re-read of the row. | integration: interposed mutation between render and submit is detected | MVP |
| AUTH-243 | The approval header is written before execution is attempted, so an interrupted execution is recoverable (`SM-A-01`). | integration: crash injected between write and execute; recovery completes or invalidates, never silently drops | MVP |
| AUTH-244 | Execution asserts, inside one transaction: the listing is available, the approval is `PENDING_EXECUTION`, and the material-terms hash still matches (`SM-A-02`, `AUTH-INV-10`). | integration: each assertion violated in turn | MVP |
| AUTH-245 | Any failed assertion aborts the transaction, records an `INVALIDATED` status event with a reason, and tells the seller why. The agent is never told to accept (`SM-A-03`, `AUTH-005`). | integration; eval `AP-02`, `AP-05`, `AP-06`, `AP-09` | MVP |
| AUTH-246 | A new offer version supersedes the previous one and invalidates any approval against it (`SM-O-02`, `AUTH-INV-06`). | integration; eval `AP-05` | MVP |
| AUTH-247 | `AWAITING_SELLER` is the only state from which an approval may be requested (`SM-O-04`). | integration: approval attempted from every other state | MVP |
| AUTH-248 | An offer below the minimum price never reaches `AWAITING_SELLER` through agent action alone. The seller may still view and accept it explicitly (`SM-O-05`). | eval `NG-03`; integration | MVP |
| AUTH-249 | At most one offer per listing is `APPROVED` (`SM-O-03`). | integration: database constraint asserted under concurrency | MVP |
| AUTH-250 | Listing availability is enforced by a conditional update inside the acceptance transaction, not by an application-level check before it (`ARCH-007`, `AUTH-006`). | build: call-site inspection; integration | MVP |
| AUTH-251 | Two simultaneous approvals on one listing produce exactly one winner. The loser receives an explicit "just sold" outcome, never a silent failure (`AUTH-INV-11`, eval `AP-07`). | integration: concurrent execution repeated under contention | MVP |
| AUTH-252 | The agent's acceptance message is enqueued only through the outbox and only after the approval reaches `EXECUTED` (`SM-A-04`, `AUTH-INV-07`). | integration; eval `OPS-015` | MVP |
| AUTH-253 | No agent message containing commitment language exists in a conversation before an `EXECUTED` approval covers it (`G-09`). | eval: `must_not_match` commitment set on every conversation case (`OPS-004`) | MVP |
| AUTH-254 | An approval that is not executed within its window receives an `EXPIRED` status event and cannot execute afterwards (`STATE_MACHINES.md` §6). | integration | MVP |
| AUTH-255 | A seller may reverse an approval before execution; the reversal is audited and the agent communicates nothing. | integration | MVP |
| AUTH-256 | Every approval records the seller id, the authenticated session reference, the offer version id, the terms hash, the policy version in force and the idempotency key (`DOMAIN_MODEL.md` SellerApproval). | contract; integration | MVP |
| AUTH-257 | The offer amount is taken from the structured extraction and re-parsed and validated deterministically. It is never read from prose (`AI-031` offer-extraction row). | unit; integration | MVP |
| AUTH-258 | Extraction confidence is recorded on the offer version and surfaced to the seller when low (`OFFER-100` AC3). | integration | MVP |
| AUTH-259 | Offer history is complete and immutable: every version is retrievable in order with its material terms and timestamps, and nothing is overwritten (`OFFER-002`, `SM-O-01`, `OFFER-101`). | integration | MVP |
| AUTH-260 | A `Deal` reaches `COMPLETED` only by an authenticated seller action, which moves the listing to `SOLD` (`SM-D-03`, `SM-L-04`). | integration | MVP |
| AUTH-261 | The final sale price is seller-entered and may differ from the approved amount; the approved amount is retained alongside it (`OPS-213`). | integration | MVP |
| AUTH-262 | An approval cannot be created against a listing that is not in an active negotiating state (`G-15`, `SM-L`). | integration | MVP |
| AUTH-263 | An in-flight agent action validates against the policy version under which it was generated; a mid-negotiation policy change never retroactively re-counters (`NEG-003`, `NEG-005`, `ARCH-014`). | eval `NG-05`; integration | MVP |
| AUTH-264 | Decline, counter and ignore are recorded as first-class decisions with their own audit events, not as the absence of an approval (`AUTH-001`, `POLICY_AND_AUTHORIZATION.md` §12). | integration | MVP |

---

## 11. Idempotency and concurrency

| ID | Requirement | Verification | Gate |
|---|---|---|---|
| OPS-730 | Every consequential action requires a client-supplied idempotency key (`CLAUDE.md` engineering rules). A request without one is rejected. | integration: full consequential-route inventory | MVP |
| OPS-731 | The key is stored with the outcome. A retry with the same key returns the original outcome and creates no second effect (`AUTH-007`, `SM-A-05`, eval `AP-04`, `AP-08`). | integration | MVP |
| OPS-732 | A key reused with a different payload is an error, not a silent replay and not a second effect. | integration | MVP |
| OPS-733 | Idempotency records are retained for at least the client retry horizon, and that horizon is stated in configuration rather than implied. | build: configuration present; integration | MVP |
| OPS-734 | Duplicate inbound buyer message deliveries are a no-op through an idempotency key plus the unique per-conversation sequence (`ARCH` §9). | integration | MVP |
| OPS-735 | A per-conversation lock serialises turns, so two buyer messages in one conversation cannot produce two concurrent model calls or two out-of-order replies (`POLICY_AND_AUTHORIZATION.md` §5). | integration: concurrent submission produces ordered, single-threaded turns | MVP |
| OPS-736 | The acceptance transaction takes a row lock on the listing before asserting availability (`POLICY_AND_AUTHORIZATION.md` §9.2). | integration | MVP |
| OPS-737 | Code rotation is atomic: the old code becomes `ROTATED` and the new code becomes `ACTIVE` in one transaction, and at most one `ACTIVE` code exists at any instant (`SM-C-01`, `SM-C-02`, `DM-09`). | integration: concurrent rotations produce one `ACTIVE` code | MVP |
| OPS-738 | Mutable rows carry a version column and are updated with an optimistic-concurrency predicate. A lost update is impossible rather than unlikely. | integration: interleaved writers, one fails | MVP |
| OPS-739 | Outbox delivery is at-least-once with a delivery dedupe key, so a buyer never sees a duplicated acceptance message and a seller never sees a duplicated notification. | integration: forced redelivery produces one visible message | MVP |
| OPS-740 | Every queued job is idempotent, retried with backoff, and moved to a dead-letter queue with an alert when retries are exhausted. A buyer message whose job fails still receives a holding reply (`ARCH-013`). | integration: fault injection | MVP |
| OPS-741 | Ordering decisions never depend on wall-clock comparison between hosts. Sequence numbers and database-assigned ordering are authoritative. | build: review of ordering call sites; unit | MVP |
| OPS-742 | Scheduled timers — hold expiry, session expiry, follow-ups — are jobs whose non-execution is detectable by a heartbeat, not sleeping processes (`ARCH-012`). | integration: suppressed scheduler raises an alert within one interval | MVP |

---

## 12. Performance and latency targets

Targets are p95 over a rolling one-hour window unless stated. Each is a metric in
`engineering/OPERATIONS.md` §4 and each has an alert in §7.

| ID | Requirement | Target | Verification | Gate |
|---|---|---|---|---|
| OPS-750 | Buyer listing preview responds, excluding model latency (`NFR-001`) | p95 < 1s, p99 < 2.5s | load; synthetic client from a mobile network profile | MVP |
| OPS-751 | Agent reply reaches the buyer (`NFR-002`) | p95 < 8s | load; production metric | MVP |
| OPS-752 | A holding reply is sent when the agent reply target is exceeded, by a deterministic timer that fires even if the model call never returns (`NFR-002`, `SM-CV-02`) | fires within 8s ± 1s | integration: model call stalled indefinitely | MVP |
| OPS-753 | Seller action-required queue loads | p95 < 1s at 500 listings and 5,000 conversations for one seller | load | MVP |
| OPS-754 | Access-code validation responds | p95 < 300ms, and constant with respect to correctness (`PA-04`) | load; timing-distribution test | MVP |
| OPS-755 | Image upload of a 10MB file is accepted and derivative generation runs asynchronously; readiness of the listing never waits on derivatives | accept p95 < 5s | integration; load | MVP |
| OPS-756 | Hot-path queries — code validation, conversation read, turn persistence, action-required queue — use an index and perform no sequential scan at target row counts | zero sequential scans | integration: query plans asserted against a seeded database | MVP |
| OPS-757 | System sustains the MVP scale posture of `ARCHITECTURE.md` §10 | hundreds of sellers, thousands of concurrent conversations | load, before GA | GA |
| OPS-758 | Each stage of the turn pipeline carries a latency budget recorded as a trace span, so a regression is attributable to a stage rather than to the whole | every stage instrumented | integration: trace shape asserted | MVP |
| OPS-759 | A release that worsens any p95 target by more than 20% against the previous release does not ship | blocking | build: release comparison against recorded baselines | GA |

---

## 13. Reliability and degradation

| ID | Requirement | Verification | Gate |
|---|---|---|---|
| OPS-765 | No buyer message is ever silently dropped. Every accepted message is persisted before any downstream work is attempted (`NFR-003`, `SM-CV-01`). | integration: failure injected at every stage after acceptance | MVP |
| OPS-766 | The system degrades toward seller-handled conversation. It never fails closed on a buyer and never invents its way past an error (`NFR-008`, `ARCH-014`). | integration: each dependency failed in turn, conversation remains open | MVP |
| OPS-767 | Model provider unavailability produces retry, then a secondary provider if configured, then a holding reply plus a seller notification (`ARCH` §9). | integration: provider fault injection | MVP |
| OPS-768 | Malformed model output produces at most two deterministic retries and then an escalation (`ARCH` §9, `AI-028`). | unit; integration | MVP |
| OPS-769 | A cost-budget breach degrades tier before it degrades service, and degrades service to holding mode before it fails (`AI-034`, `T-04`). | integration | MVP |
| OPS-770 | The buyer listing preview remains available when the conversation backend, the model provider or the worker pool is unavailable (`SEC-131`). | integration | MVP |
| OPS-771 | The availability objective for the buyer surface is 99.5% monthly at MVP, measured by external synthetic checks against the preview and the code gate, not by internal health checks. | manual: monthly report from synthetic-check data | MVP |
| OPS-772 | Recovery objectives are RPO ≤ 15 minutes and RTO ≤ 4 hours, proven by the tested restore of `engineering/OPERATIONS.md` §11, not by configuration review. | manual: quarterly restore exercise with recorded timings | MVP |
| OPS-773 | Deployment drains in-flight turns before terminating a worker; a turn interrupted by a deploy is retried, not lost. | integration: deploy simulated under load | MVP |
| OPS-774 | Kill switches and feature flags take effect without a deploy or a migration (`OPS-031`). | integration | MVP |
| OPS-775 | Every degraded mode is visible to the seller in plain language, and every degraded mode is a metric. A silent degradation is a defect. | integration; manual | MVP |

---

## 14. Auditability

| ID | Requirement | Verification | Gate |
|---|---|---|---|
| OPS-780 | Every consequential action writes an `AuditEvent` (`AUTH-INV-09`, `NFR-004`). | integration: each event type triggered from its cause | MVP |
| OPS-781 | Every event type listed in `ai/POLICY_AND_AUTHORIZATION.md` §12 is emitted by its trigger, and no consequential action exists that emits none. | integration: coverage matrix over the event list and over the consequential-route inventory | MVP |
| OPS-782 | Audit events are append-only. No update or delete path exists in application code or in the granted database role (`OPS-705`). | build; integration | MVP |
| OPS-783 | Audit payloads carry no access code, session token, credential, prompt, transcript body or unnecessary personal data (`POLICY_AND_AUTHORIZATION.md` §12, `ARCH` module 19). | integration: payload scanned against a forbidden-pattern set on every event type | MVP |
| OPS-784 | Every audit event records event type, actor, subject entity, policy version, request id and timestamp (`DOMAIN_MODEL.md` AuditEvent). | contract; integration | MVP |
| OPS-785 | An approval is reconstructable end to end from audit alone: the terms shown, the decision taken, the assertions that passed, the state changes, and what the agent then said to the buyer. | integration: reconstruction test over a scripted deal | MVP |
| OPS-786 | Audit retention outlives conversation retention and is defined in `security/DATA_AND_PRIVACY.md`. | build: configured retention compared against that document | MVP |
| OPS-787 | An audit write failure aborts the transaction it belongs to. A consequential action never commits without its audit event. | integration: audit write failure injected | MVP |
| OPS-788 | Operator access to audit data is itself audited, in a record the operator cannot alter. | integration | GA |

---

## 15. Observability

| ID | Requirement | Verification | Gate |
|---|---|---|---|
| OPS-790 | Application logs never contain a prompt, a model completion, a conversation transcript, an access code or a session token (`SEC-040` to `SEC-042`, `ARCH` module 21). | integration: log corpus from a full end-to-end run scanned against a forbidden-pattern set | MVP |
| OPS-791 | Every request carries a request id, propagated to queued jobs, model calls and audit events, so one buyer turn is traceable end to end. | integration | MVP |
| OPS-792 | AI cost is measured and attributable per seller, per listing and per conversation (`NFR-006`, `AIInteraction`). | integration: recorded cost reconciles to provider-reported usage within a stated tolerance | MVP |
| OPS-793 | The metrics of `engineering/OPERATIONS.md` §4 exist and are populated before the first buyer conversation. | manual: dashboard review | MVP |
| OPS-794 | Traces cover each stage of the turn pipeline: context assembly, model call, guardrail evaluation, redaction, persistence, send (`OPS-758`). | integration | MVP |
| OPS-795 | Every alert in `engineering/OPERATIONS.md` §7 is wired and has been fired at least once by deliberate injection before it is relied on. | manual: injection exercise recorded per alert | MVP |
| OPS-796 | Guardrail denial rate, escalation rate, fact-violation rate and protected-disclosure rate are emitted as production metrics, not only as eval outputs (`EVAL_STRATEGY.md` §7). | integration | MVP |
| OPS-797 | A protected-disclosure detection in production opens an incident automatically. It is never only a counter on a dashboard. | integration: injected detection opens an incident | MVP |
| OPS-798 | Log volume per request is bounded and sampled per `engineering/OPERATIONS.md` §5. A single request cannot emit unbounded log lines. | integration: log-line count asserted per request class | MVP |

---

## 16. Integrations and external dependencies

`integrations/MARKETPLACE_STRATEGY.md` is canonical for channel policy and for what may
be said about any named marketplace. The requirements below are the system-level
constraints that hold whatever that document concludes.

| ID | Requirement | Verification | Gate |
|---|---|---|---|
| INT-100 | No component reads from, writes to, scrapes or automates any marketplace. The only coupling is a human seller copying text and a human buyer following a link (`ARCH-009`, `D-07`). | build: outbound host allowlist contains no marketplace domain; manual review per release | MVP |
| INT-101 | The Marketplace Abstractions module holds channel labels, per-channel access codes and copy formatting only, and performs no network call (`ARCH-005`). | build: the module has no network dependency | MVP |
| INT-102 | The external dependencies at MVP are a model provider, object storage, and email and push delivery (`MASTER_PRODUCT_SPEC.md` §16). Any addition requires a decision entry. | build: dependency inventory compared against this list | MVP |
| INT-103 | Every outbound call has an explicit timeout, a bounded retry budget and a circuit breaker. A hanging dependency cannot hold a request or a worker open indefinitely. | integration: dependency stalled, caller returns within budget | MVP |
| INT-104 | Outbound HTTP is restricted to an allowlist of hosts. No user-, seller- or buyer-supplied value can cause a request to an arbitrary host (`security/THREAT_MODEL.md` SSRF boundary). | integration: attempted fetch of an off-list host is refused | MVP |
| INT-105 | The model provider is behind an internal interface, so a second provider is a configuration change rather than a code change (`ARCH` §9). | build: single integration point; integration: provider swapped in a test environment | MVP |
| INT-106 | Provider and infrastructure credentials are held in a secret store, injected at runtime, rotatable without a code change, and never present in source, container images or logs (`OPS-729`). | build: secret scan; manual: rotation exercise | MVP |
| INT-107 | The model provider is engaged under terms that make them a processor acting on instruction, with no independent right to train on, retain beyond the processing purpose, or otherwise use the data sent to them (`security/DATA_AND_PRIVACY.md` §8). | manual: contract review recorded before the first real seller | MVP |
| INT-108 | Escalation notifications are deliverable through at least one channel that does not depend on the failing subsystem. A seller is never unreachable because the thing that failed is the thing that notifies. | integration: primary channel failed, notification still delivered | MVP |
| INT-109 | No inbound webhook, callback or third-party push endpoint exists at MVP. Introducing one requires signature verification, replay protection and a decision entry. | build: route inventory | MVP |
| INT-110 | No payment, escrow, shipping or courier integration exists (`MASTER_PRODUCT_SPEC.md` §8, §13, `D-14`). | build: dependency and route inventory | MVP |
| INT-111 | Provider usage records are reconciled against internal `AIInteraction` cost records on a schedule, and a divergence beyond a stated tolerance alerts (`OPS-792`). | integration; manual: monthly reconciliation | GA |

---

## 17. Data retention as a system property

`security/DATA_AND_PRIVACY.md` is canonical for classification, lawful purpose,
retention periods and deletion behaviour. The requirements below make those decisions
enforceable rather than documented.

| ID | Requirement | Verification | Gate |
|---|---|---|---|
| DATA-100 | Retention periods are configuration read at runtime and enforced by a scheduled job. The values are the ones in `security/DATA_AND_PRIVACY.md` §3. | build: configuration compared against that document; integration: job deletes on schedule | MVP |
| DATA-101 | Every data category has a retention period and a deletion behaviour. A category with neither fails a startup check. | build | MVP |
| DATA-102 | Deletion is verifiable end to end: a test creates a record, requests deletion, and asserts absence in the primary store, in object storage, in derived caches, in search or index structures and in exports. | integration | MVP |
| DATA-103 | Backups have their own stated retention. A deletion request is satisfied on live systems within the stated window and on backups by backup expiry, and both windows are disclosed to the requester (`security/DATA_AND_PRIVACY.md` §10). | manual: restore exercise confirms expiry behaviour | MVP |
| DATA-104 | Transcripts are stored separately from application logs and from audit events, with their own retention (`SEC-042`, `OPS-719`). | contract; build | MVP |
| DATA-105 | Audit events survive a deletion request and are minimised rather than deleted, per `security/DATA_AND_PRIVACY.md` §10. The minimisation is itself a recorded, auditable operation. | integration | MVP |
| DATA-106 | An access code is not recoverable in plaintext after issue by any route, including support tooling and database access (`ACCESS-013`, `OPS-710`). | build; integration | MVP |
| DATA-107 | A seller data export is machine-readable and contains that tenant's data only (`SEC-106`). | integration | GA |
| DATA-108 | A buyer can reach a deletion and access request route from the code gate and from the conversation, without creating an account (`BUYER-007`, `BUYER-014`). | integration | MVP |
| DATA-109 | Application log retention is bounded and shorter than transcript retention. | build | MVP |
| DATA-110 | Eval fixtures and any production-derived test data carry no real seller or buyer data and no amount traceable to a real listing (`OPS-012`, `OPS-023`). | build: fixture scan in CI | MVP |

---

## 18. Traceability: the eleven authorization invariants

`ai/POLICY_AND_AUTHORIZATION.md` §2 is canonical for the invariants themselves. The
table below names the requirements that enforce each one, so a change that weakens an
invariant fails a specific, findable test rather than a general principle.

| Invariant | Statement (abridged) | Enforcing requirements | Primary test |
|---|---|---|---|
| AUTH-INV-01 | Buyer text can never create seller authorization | `AI-211`, `AI-203`, `AUTH-224`, `AUTH-225`, `AUTH-240`, `SEC-114` | eval `NG-09`, `CV-11`; integration: approval route unreachable by a buyer session |
| AUTH-INV-02 | AI output can never create seller authorization | `AI-202`, `AI-203`, `AI-206`, `AUTH-224`, `AUTH-252` | eval `NG-10`, `AP-01` negative assertion (`OPS-015`) |
| AUTH-INV-03 | Agent memory can never create seller authorization | `AI-214`, `AI-200`, `AUTH-224` | contract: memory record type cannot hold a price, permission or approval |
| AUTH-INV-04 | Only an authenticated seller action creates seller authorization | `AUTH-220`, `AUTH-224`, `AUTH-228`, `AUTH-256`, `AUTH-264` | build: Seller Approval module call-site inventory; integration: every non-seller actor refused |
| AUTH-INV-05 | Approval applies to one exact offer version and its material terms | `AUTH-240`, `AUTH-241`, `AUTH-242`, `AUTH-256` | unit: hash coverage matrix; eval `AP-02`, `AP-03` |
| AUTH-INV-06 | A material change invalidates or supersedes any approval against it | `AUTH-241`, `AUTH-244`, `AUTH-245`, `AUTH-246`, `AUTH-259` | eval `AP-02`, `AP-03`, `AP-05`, `AP-09` |
| AUTH-INV-07 | The agent may not communicate acceptance until backend authorization succeeds | `AUTH-252`, `AUTH-253`, `AI-212`, `AI-213`, `OPS-722` | eval `OPS-015`; `must_not_match` commitment set (`OPS-004`) |
| AUTH-INV-08 | Protected seller information is not disclosed on buyer request or claim | `AI-200`, `AI-201`, `AI-212`, `OPS-724`, `OPS-726`, `SEC-118`, `SEC-138` | eval `PA-10`, `CV-09`; contract: projection and context types |
| AUTH-INV-09 | Consequential actions are auditable | `OPS-780` to `OPS-787`, `AUTH-256`, `AUTH-264` | integration: event coverage matrix and approval reconstruction (`OPS-785`) |
| AUTH-INV-10 | Listing availability is revalidated inside the acceptance transaction | `AUTH-244`, `AUTH-250`, `OPS-736`, `OPS-728` | eval `AP-06`; integration: sold-between-approve-and-execute |
| AUTH-INV-11 | Concurrent approvals cannot sell one listing to two buyers | `AUTH-249`, `AUTH-250`, `AUTH-251`, `OPS-736`, `OPS-738` | eval `AP-07`; integration: repeated concurrent execution under contention |

`OPS-799` A change that removes or weakens any test named in this table requires a
superseding entry in `decisions/DECISION_LOG.md`. The tests are the invariants; the
prose is a summary of them.

---

## 19. Open questions

| ID | Question | Where it bites |
|---|---|---|
| `Q-01` | Technology stack — backend baseline recorded in D-17 (Accepted 2026-09-03) | The concrete form of `OPS-701` to `OPS-717` and the mechanism behind `SEC-100` (PostgreSQL row-level security) follow D-17. Hosting (`Q-09`), model provider (`Q-10`), notification providers (`Q-11`) remain open; the authentication library (`Q-12`) is resolved by D-19 (Accepted 2026-09-04) |
| `Q-03` | Whether the access code is pre-filled from the URL | Changes the abuse-control assumptions behind `SEC-134` |
| `Q-04` | Cross-device buyer session resume | Would add requirements under `SEC-110` to `SEC-119`; any mechanism must not become a bearer credential (`BUYER-016`) |
| `Q-05` | Whether any buyer-facing email is ever sent | Blocks `SEC-136` and `INT-102` from changing |
| `Q-06` | Free-tier limits | Fixes the thresholds behind `AUTH-226` and the per-seller budgets of `engineering/OPERATIONS.md` §10 |
| `Q-07` | Jurisdictions at launch | Fixes the retention periods `DATA-100` enforces (`security/DATA_AND_PRIVACY.md` §12) |
| `Q-09` | Hosting provider and region | Fixes the concrete form of `OPS-717`, `OPS-772`, `SEC-333` and `SEC-350`, and the region recorded under `DATA-324` |
| `Q-10` | Model provider | Fixes `INT-105` and `INT-107`, and the rates behind `business/UNIT_ECONOMICS.md` |
| `Q-11` | Seller-notification providers | Fixes the delivery side of `INT-102` and `INT-108` |
| `Q-12` | Authentication library — **RESOLVED** by `decisions/DECISION_LOG.md` D-19 (Accepted 2026-09-04): a narrow first-party Identity & Auth module on Node.js `crypto.argon2` (Argon2id), `@fastify/cookie`, PostgreSQL/Kysely-owned accounts and opaque sessions stored only as SHA-256 hashes, and transaction-scoped seller resolution before the RLS context; no authentication framework, no identity SaaS | `AUTH-200` to `AUTH-219` are implemented under the D-19 acceptance conditions. The `AUTH-203` timing-distribution test, the `AUTH-204` progressive-delay limiter and a trusted-proxy policy are mandatory before any sign-in route is complete. Reset and verification delivery wait on `Q-11`; `AUTH-213` stays GA; no buyer authentication exists |
| `Q-AG-02` | Default turn and cost budget per conversation (`G-13`) | Fixes the thresholds behind `AI-216` |
