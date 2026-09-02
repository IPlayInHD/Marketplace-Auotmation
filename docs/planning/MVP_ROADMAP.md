# MVP Roadmap

**Status:** Canonical for build sequencing.
**Requirement ID block:** `PLAN-001`–`PLAN-099`.

Build in **vertical slices** that each produce a user-visible outcome. Do not build
horizontal infrastructure phases — "the database layer", "the auth system", "the AI
layer" — because they defer all learning to the end and none of them can be shown to a
seller.

Sequencing is driven by two things: dependency, and how early a slice can kill a bad
assumption. Those pull in the same direction here, which is fortunate.

---

## The sequencing rule

`PLAN-001` **Validate demand before building supply.** The three highest-risk
assumptions in this business are not engineering assumptions. They are:

| Assumption | Risk if wrong |
|---|---|
| `ASM-01` Buyers will follow a link and enter a code | The product cannot work at all |
| `ASM-02` Marketplaces permit a link and code somewhere seller-controlled | The channel closes |
| `ASM-03` Sellers will type facts rather than expect inference | The listing flow is wrong |

None of them requires software to test. Slice 0 tests all three for approximately
nothing, and the answer changes what gets built next. **Do not skip it.**

---

## Slice 0 — Concierge validation (no product)

**Outcome.** A real answer to "will buyers actually do this?", from your own data,
before any engineering investment.

**What you do.** List 15–20 real items yourself across two or three marketplaces and a
spread of price points. Stand up one static page per item — photos, title, price, an AI
disclosure banner, a 6-digit code box, and a form. No backend, no model, no database. An
afternoon of hand-written HTML. Answer every buyer yourself, by hand, in the persona the
agent would use.

**Run three arms.** Link in the listing body · link sent only in a reply after the buyer
messages · a phone number instead of a link, answered manually. The third arm is the
control: if buyers convert far better on a number than on a link, the product's transport
layer is wrong and you have learned that in ten days rather than six months.

**Measure.** Link sent → page opened · page opened → code entered · code entered →
conversation started · messages per conversation · share that mention a price · "is this
a scam?" incidents per hundred replies · any marketplace enforcement (ad removals,
warnings, reduced reach).

**Decision gate.**

| Result | Action |
|---|---|
| Page-open rate above 40% | Proceed as specified |
| 20–40% | Proceed, but treat higher-value items as the launch segment |
| Below 20% | Stop. Re-open the transport decision (D-02) before building |
| Code-entry rate below 80% of page opens | The gate design is wrong; fix `BUYER-004`/`BUYER-009` before building it |

**Out of scope.** Everything. This slice writes no production code.

---

## Slice 1 — A listing exists and can be shared

**Outcome.** A seller signs up, creates a listing from their own facts, sets a price and
a minimum, and receives a URL, a 6-digit code and a copy block ready to paste into a
marketplace. No AI yet.

| Layer | Work |
|---|---|
| Backend | Identity and seller account; `InventoryItem` and `Listing`; `ListingContentVersion` with provenance; image upload and storage; `SellerPolicy` versioning; `PublicListingAccess` with an opaque public id; `ListingAccessCode` issue, hash, rotate, revoke; audit events |
| Frontend | Sign-up, listing creation form, policy configuration, the ready-to-publish copy block |
| AI | None |
| Security | Tenant isolation at the data layer; access codes hashed; no sequential ids in URLs; secrets handling |
| Tests | Listing lifecycle transitions; code issue and rotate; tenant isolation; ownership checks |
| Evals | None |

**Acceptance.** A seller can go from nothing to a pasteable marketplace block in under
five minutes. The minimum price is stored on a policy version and appears in no response
the buyer surface can produce.

**Out of scope.** Enhancement, conversation, offers, notifications, analytics.

---

## Slice 2 — A buyer can reach a listing

**Outcome.** A buyer opens the URL, sees the item immediately, enters the code, and
lands in a conversation surface — which, at this point, delivers their message to the
seller and nothing more. The riskiest flow in the product is now real and instrumented.

| Layer | Work |
|---|---|
| Backend | Buyer-safe projection as a computed type; code validation with rate limiting and lockout; `BuyerSession` creation and scoping; `Conversation` and `Message` with per-conversation ordering and idempotency |
| Frontend | Buyer landing page with the listing rendered above the gate; code entry; a plain conversation view; the AI disclosure banner as fixed text |
| AI | None. A human seller answers. |
| Security | Every control in `security/PUBLIC_ACCESS_SECURITY.md` §3–§7. This slice is where they must exist, not later. |
| Tests | The full required-test table in `PUBLIC_ACCESS_SECURITY.md` §8, all blocking |
| Evals | None |

**Acceptance.** Two buyers on one listing cannot see each other. A buyer session gets
404 on every seller route. The projection type cannot structurally hold a protected
field. Timing for a wrong code and an unknown listing is indistinguishable.

**Out of scope.** Any model call.

---

## Slice 3 — The agent answers

**Outcome.** The agent answers factual questions from seller-approved information, and
says plainly when it does not have something. No negotiation yet.

| Layer | Work |
|---|---|
| Backend | Context assembly from the buyer-safe projection; structured proposed action; the guardrail engine with the answering subset of checks (G-05, G-06, G-07, G-08, G-09, G-14); egress redaction; `AIInteraction` cost recording |
| Frontend | Live conversation, holding states, escalation notice |
| AI | Answering and intent extraction on a cheap model tier |
| Security | Prompt injection layering; buyer text delimited as data |
| Tests | Guardrail unit tests; grounding refusal path |
| Evals | The CONVERSATION suite in `ai/EVAL_STRATEGY.md`, blocking in CI |

**Acceptance.** Asked for an unstated specification, the agent says it does not have it
confirmed and offers to ask the seller. It never infers. Injection attempts produce
denials, and every denial is logged as a fixture candidate.

**Out of scope.** Prices, counters, offers, approval.

---

## Slice 4 — Enhancement

**Outcome.** The seller writes roughly, requests enhancement, and reviews original and
enhanced side by side with accept, edit, reject and restore.

| Layer | Work |
|---|---|
| Backend | Enhancement call; the deterministic post-validator (`LISTING_ENHANCEMENT.md` V-01–V-12) running before the seller sees anything; version creation and approval |
| Frontend | Side-by-side review with a visible diff |
| AI | Enhancement on a cheap tier, once per content version |
| Tests | Version state machine; validator unit tests |
| Evals | The LISTING ENHANCEMENT suite, blocking |

**Acceptance.** No enhanced output containing a numeric token, model-like token or
escalated condition word absent from the seller's input ever reaches the seller as an
accepted suggestion. Validation failure is a visible recoverable state.

**Out of scope.** Image-derived facts, of any kind, ever.

---

## Slice 5 — Negotiation and offers

**Outcome.** The agent negotiates inside policy, and conversation becomes structured
offers with history. Still nothing is accepted.

| Layer | Work |
|---|---|
| Backend | Permitted counter range derivation; full guardrail set including G-01, G-02, G-03, G-04, G-12, G-13, G-15; `Offer` and `OfferVersion`; supersession; offer state machine |
| Frontend | Offer view per conversation |
| AI | Negotiation with escalate-on-price-mention routing |
| Security | Concession bounds; monotonic concession; no fabricated pressure |
| Tests | ≥200 guardrail unit tests before this slice ships |
| Evals | The NEGOTIATION suite, blocking |

**Acceptance.** The minimum price appears in no prompt, no log and no response. An offer
below the permitted range produces an engine-chosen outcome, not a model-chosen one.

**Out of scope.** Approval, acceptance, handoff.

---

## Slice 6 — Seller decides

**Outcome.** The action-required dashboard, the four decisions, and correct approval
integrity under concurrency. This is the slice where the product becomes the product.

| Layer | Work |
|---|---|
| Backend | `SellerApproval` with material-terms hash; execution transaction with row lock and conditional update; invalidation; idempotency; competing-offer resolution; notifications through a transactional outbox |
| Frontend | Action-required queue; offers comparison; approval confirmation restating exact material terms |
| AI | Communication of the authorized decision, gated on `EXECUTED` |
| Security | Every `AUTH-INV` invariant enforced and tested |
| Tests | Simultaneous approvals produce exactly one winner; stale approval rejected; retry is idempotent |
| Evals | The APPROVAL suite, blocking |

**Acceptance.** Two sellers-side approvals racing on one listing sell it once. A changed
offer invalidates a pending approval. A retried request never creates a second
authorization.

**Out of scope.** Payments, escrow, shipping.

---

## Slice 7 — Handoff and sales record

**Outcome.** An approved deal moves to seller-controlled fulfilment and is recorded.

| Layer | Work |
|---|---|
| Backend | `Deal` and `Handoff`; permitted logistics collection; completion; listing to `SOLD`; sales record |
| Frontend | Deal card; completion confirmation; sales history |
| AI | Availability gathering only, within `SM-D-01`/`SM-D-02` |
| Tests | No path discloses a precise address |
| Evals | Location-disclosure cases |

**Out of scope.** Anything touching money movement.

---

## Slice 8 — Make it operable

**Outcome.** You can run this without watching it.

Analytics from `product/INVENTORY_AND_SALES.md`; the observability, alerting, runbooks
and cost controls in `engineering/OPERATIONS.md`; per-seller cost budgets and the
circuit breaker; the eval scoreboard; shadow mode and kill switches.

`PLAN-002` Shadow mode runs for the first 500 real buyer conversations: the agent
proposes every reply and a human approves before it sends. It is tedious for a week and
it shows you the true failure distribution before a customer finds it.

---

## What is deliberately not on this roadmap

Payments · escrow · shipping · marketplace APIs · cross-listing · scraping · buyer risk
scoring · team accounts · CRM · storefronts · pricing or valuation of any kind · image
intelligence. See `product/MASTER_PRODUCT_SPEC.md` §13 and §14.

---

## Gates

`PLAN-003` No slice ships without its evals passing in CI.
`PLAN-004` No slice ships without its security tests passing.
`PLAN-005` Slice 5 does not start until the guardrail engine has ≥200 unit tests.
`PLAN-006` Slice 2 does not ship until every test in `PUBLIC_ACCESS_SECURITY.md` §8 passes.
`PLAN-007` Slice 1 does not start until Slice 0 has produced a decision.
