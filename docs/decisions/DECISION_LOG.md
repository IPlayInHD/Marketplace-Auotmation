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
