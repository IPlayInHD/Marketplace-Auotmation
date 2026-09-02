# Risk Register

**Status:** Canonical for identified business, product, security and organisational risks
and for what is being done about each. Mitigations are cited, not invented here: where a
control is described in another document, that document is authoritative for how it works.

**Reserved requirement-ID block:** `BIZ-200` – `BIZ-249`. No other document may issue a
`BIZ-` identifier in this range. Register rows use `RISK-nn` identifiers, which are
register row ids and **not** requirement IDs. `RISK-nn` ids are stable once published;
retire a row by setting its status to `CLOSED`, never by renumbering.

---

## 1. How this register works

`BIZ-200` Scoring. Likelihood and impact are assessed for the **next 12 months**, on the
assumption that the MVP in `MASTER_PRODUCT_SPEC.md` §12 ships.

| Likelihood | Meaning |
|---|---|
| High | Expected to occur, or already occurring |
| Medium | Plausible within 12 months |
| Low | Possible but not expected |

| Impact | Meaning |
|---|---|
| Critical | The business does not work, or the harm is irreversible |
| High | A core capability, a channel, or trust is lost; recovery is expensive |
| Medium | Material cost, churn or rework; recovery is routine |
| Low | Contained; absorbed in normal operation |

| Severity | Derivation |
|---|---|
| Critical | Critical impact at Medium or High likelihood |
| High | Critical impact at Low likelihood, or High impact at Medium or High likelihood |
| Medium-High | High impact at Low likelihood, or Medium impact at High likelihood |
| Medium | Medium impact at Medium likelihood, or Low impact at High likelihood |
| Low | Everything else |

`BIZ-201` Owners. The team is two people. Owner names a role, and the role is
accountable for the early-warning signal being watched, not merely for the risk being
listed.

| Owner | Role |
|---|---|
| Product | Founder responsible for product, research, positioning, pricing and channel policy |
| Engineering | Founder responsible for architecture, security, AI behaviour and cost controls |
| Both | Requires both, and is therefore a scheduling risk in itself |
| Counsel | External. Flagged for qualified legal advice; **nothing in this register is legal advice.** |

`BIZ-202` Status values: `OPEN` (identified, mitigation in place or planned),
`MONITORED` (accepted, watched), `TESTING` (an active experiment is running against it),
`CLOSED` (no longer applicable; reason recorded).

`BIZ-203` A risk whose early-warning signal is not instrumented is not mitigated, however
good its mitigation column reads. Signals marked *not yet instrumented* are themselves
outstanding work.

`BIZ-204` Review cadence: the whole register monthly; every Critical row weekly until it
leaves Critical; any row immediately on a triggering event.

## 2. Register

Sorted by severity, then by likelihood.

| ID | Risk | Category | Likelihood | Impact | Severity | Current mitigation | Owner | Early-warning signal | Status |
|---|---|---|---|---|---|---|---|---|---|
| `RISK-01` | Marketplaces restrict external links in the surfaces sellers control, so the buyer cannot be routed to us at all (`ASM-02`) | Market dependency | High | Critical | **Critical** | None available - this is a dependency, not a controllable. Verification procedure defined (`integrations/MARKETPLACE_STRATEGY.md` §5); six alternative placement surfaces enumerated, each separately unverified (`INT-040`); no document or marketing asset may assert permission (`INT-022`); seller told rules vary and are their responsibility (`BUYER-024`) | Product | Every channel row is `UNCLEAR - REQUIRES RESEARCH`; seller reports of removed listings; per-channel link-open rate at or near zero (`INT-035`) | `OPEN` - **test first** (§4) |
| `RISK-02` | Buyers will not leave the marketplace to follow a link and enter a code (`ASM-01`) | Adoption / demand | High | Critical | **Critical** | Listing renders before the gate so the page is not a bare code box (`BUYER-004`, `D-02`); gate on the conversation not the page (`BUYER-005`); optional code pre-fill (`BUYER-009`, `Q-03`); mobile-first, no app, no account (`BUYER-020`-`BUYER-022`); day-one funnel instrumentation (`BUYER_ACCESS_FLOW.md` §12) | Product | Link-open rate below ~40%; code-entry completion below ~50% of opens; conversation-start rate collapsing per channel | `OPEN` - **test first** (§4) |
| `RISK-03` | A marketplace changes policy or enforcement without notice, closing a working channel overnight | Market dependency | High | Critical | **Critical** | Never depend on one channel (`BIZ-081`); scheduled re-check with automatic reversion to `UNCLEAR` when overdue (`INT-033`, `INT-034`); per-channel conversion as the detective control (`INT-035`); multiple surfaces per channel (`INT-040`) | Product | Sudden per-channel conversion drop with no product change; a cluster of seller reports; any visible platform product announcement | `OPEN` |
| `RISK-16` | Sellers do not adopt or do not activate - they sign up, never publish a listing, and never receive a buyer | Business / adoption | High | Critical | **Critical** | Onboarding aimed at first listing published, not at account created; copy block with one-tap copy (`BUYER-023`); enhancement as a visible first-run win (`BIZ-111`); free tier removes the money barrier (`BIZ-030`); target segments explicitly exclude the casual seller (`BIZ-002`) | Product | Signup-to-first-listing rate; first-listing-to-first-buyer-conversation rate; both are activation gates and neither is a vanity metric | `OPEN` |
| `RISK-04` | Entering a 6-digit code is enough added friction to lose buyers even when the link is followed | Adoption | High | High | **High** | Numeric keyboard, paste support (`BUYER-008`); optional pre-fill (`BUYER-009`); generic non-punitive errors (`BUYER-010`); progressive bot controls rather than a challenge for every buyer (`BUYER-012`) | Product | Preview-to-code-entry rate; abandonment at the code field specifically, separated from abandonment at the preview | `OPEN` - measured by the same test as `RISK-02` |
| `RISK-05` | The buyer surface is mistaken for phishing, by buyers or by a marketplace's enforcement | Trust / adoption | Medium | High | **High** | Listing renders before any input is asked for, which is the entire reason `D-02` chose Option C; single stable domain; consistent visual identity; never ask a buyer for credentials or payment details, so a clone has nothing to steal that we ever request (`T-14`); AI disclosure and privacy notice at the gate (`BUYER-006`, `BUYER-007`) | Product | Buyer messages expressing suspicion; abandonment concentrated at the preview rather than the code; any listing removal citing a link | `OPEN` |
| `RISK-06` | AI operating cost exceeds subscription revenue on a tier, at cap or in the tail | Financial | Medium | High | **High** | Cheap-first tier routing with deterministic pre-model tier selection (`AI-031`, `AI-032`); `premium` reserved and not routed to (`AI-033`); budgets at every layer (`SEC-010`, `OPS-410`); tier degradation before service degradation (`AI-034`); modelled margins of 71-87% at the routed tier (`UNIT_ECONOMICS.md` §6.2) | Engineering | Cost per conversation above model; escalation share above the 0.40 assumption; monthly margin per tier diverging more than 10 points (`OPS-442`) | `OPEN` - **test first** (§4) |
| `RISK-07` | Cost-exhaustion abuse: an adversary burns model spend through the public buyer surface | Security / financial | Medium | High | **High** | Public code assumed known to an adversary (`SEC-001`, `D-03`); layered token buckets (`SEC-010`); per-session, per-listing and per-seller budgets; turn and cost ceilings enforced by the guardrail engine (`G-13`); global circuit breaker with a blocking CI test (`T-04`, `OPS-414`); anomalous-conversation alerting (`OPS-417`) | Engineering | Cost per listing anomalies; conversation-length outliers; new-session rate per listing; failed-attempt spikes | `OPEN` |
| `RISK-08` | An approval is created that the seller did not intend, or is executed against terms the seller did not see | Product / legal | Low | Critical | **High** | Only an authenticated seller action creates authorization (`AUTH-INV-04`); approval binds to one offer version plus a material-terms hash (`D-06`, `AUTH-INV-05`); material change invalidates (`AUTH-INV-06`); hash re-asserted inside the acceptance transaction; idempotency on a client key (`AUTH-007`); agent may not communicate acceptance before backend authorization succeeds (`AUTH-INV-07`); every approval audited (`AUTH-INV-09`) | Engineering | `APPROVAL_INVALIDATED` rate; seller-reported disputes; any approval executed against a stale hash | `OPEN` |
| `RISK-10` | The agent states a product fact the seller never supplied | Product / legal | Medium | High | **High** | Seller is the sole source of product facts (`INV-12`, `D-10`); enhancement transforms and never adds (`INV-13`, `D-12`); guardrail `G-05` requires every product claim to cite a `SELLER_PROVIDED_FACT`; "I don't have that confirmed" is a designed first-class answer (`AI-002`); no fact inference from images (`D-11`); blocking evals before merge (`EVAL_STRATEGY.md`) | Engineering | `G-05` denial rate; eval regressions on fact grounding; seller corrections of agent statements | `OPEN` |
| `RISK-14` | A seller pastes protected information - typically the minimum price - into a buyer-visible field | Privacy / product | Medium | High | **High** | Validation warning when a listing field contains a value matching the minimum price (`T-13`); content scanning at approval time; seller education copy; the buyer-safe projection is computed, never filtered (`SEC-020`) | Both | Scan hits at approval; support reports; any minimum price appearing in an approved content version | `OPEN` |
| `RISK-15` | Scam behaviour by buyers or sellers using the platform - fraudulent offers, misdescribed goods, meetup harm | Trust / legal | Medium | High | **High** | The platform never holds money, never processes payment, never arranges the exchange (`D-14`, `BIZ-031`); fulfilment and location stay with the seller (`PROD-021`); no exact location disclosure (`G-07`); the agent never invents urgency or competing interest (`G-08`); AI disclosure (`D-15`). **Note: buyer risk scoring is deliberately not a mitigation** (`D-16`, `R-09`) | Both | Reported incidents; blocked-buyer rate; conversations escalated for abusive content | `OPEN` - `RISK-21` L2/L3 apply |
| `RISK-18` | A marketplace ships native buyer negotiation, absorbing the core of the product | Competitive | Medium | Critical | **High** | Response plan defined and sequenced (`POSITIONING.md` §6): do not compete on the overlapping feature; move to the cross-channel position; lean on the operational record and consistent policy. **The unavailable response is building marketplace automation** (`INT-060`, `BIZ-153`) | Product | Per-channel conversion falling on one channel with no policy change; any platform announcement; seller reports of a native feature | `MONITORED` |
| `RISK-19` | Buyers distrust or dislike dealing with an AI agent and disengage | Adoption | Medium | High | **High** | Unconditional, persistent, plainly worded disclosure, as fixed text and never model-generated (`D-15`, `BUYER-006`); the agent states plainly what it cannot decide (`G-10`); no fabricated pressure or scarcity (`G-08`); escalation to the seller always available (`AUTH-004`) | Product | Drop-off after the first agent reply; buyer messages asking for a human; conversation-to-offer rate versus a seller-handled baseline | `OPEN` - partially measured by the §4 concierge test |
| `RISK-20` | Key-person risk: two people, no redundancy on any capability | Organisational | Medium | Critical | **High** | Documentation set is deliberately specification-grade so the system is reconstructable from it; modular monolith keeps the system comprehensible by one person (`D-01`); decisions recorded with reasoning, not just outcomes (`DECISION_LOG.md`); no undocumented operational knowledge permitted | Both | Any capability only one person can perform; documentation drifting behind the build; bus-factor-1 modules | `MONITORED` |
| `RISK-21` | Legal and regulatory uncertainty on AI disclosure, agent authority and consumer protection | Legal / regulatory | Medium | High | **High** | Unconditional disclosure (`D-15`); no valuation or worth claim (`D-09`); no autonomous acceptance (`D-13`); seller owns product facts (`D-10`); privacy notice at the gate (`BUYER-007`); six questions raised for counsel (`INT-080` L1-L6). **This register is not legal advice and does not substitute for counsel.** | Counsel | Regulatory publications in launch jurisdictions; `Q-07` remaining unresolved as launch approaches | `OPEN` - depends on `Q-07` |
| `RISK-22` | Model provider availability, pricing or terms change adversely | Dependency / financial | Medium | High | **High** | No provider is a requirement anywhere in the documentation (`D-08`, `LIST-067`); secondary provider in the failure posture (`ARCHITECTURE.md` §9); tiers are named roles (`cheap`, `mid`, `premium`), not products; evals make a provider swap measurable rather than a leap of faith (`EVAL_STRATEGY.md`); cost model recomputed on any rate change (`OPS-441`) | Engineering | Provider pricing announcements; latency or error-rate drift; eval scoreboard movement after a provider-side model update | `MONITORED` |
| `RISK-23` | Breach or leak of conversation transcripts and buyer personal data | Security / privacy | Low | Critical | **High** | Tenant isolation at the data layer as well as the application layer (`NFR-007`, `SEC-030`); transcripts in their own store with their own retention (`SEC-042`); no prompts or transcripts in logs (module 21); codes and session tokens never logged (`SEC-040`, `SEC-041`); buyer text treated as data and escaped on render (`T-12`); separate route trees for public and seller applications (`SEC-032`) | Engineering | Authorization-failure alerting; CSP violation reports; any cross-tenant query reaching production | `OPEN` |
| `RISK-09` | Double-selling: one listing sold to two buyers through concurrent approvals | Product | Low | High | **Medium-High** | Availability revalidated inside the acceptance transaction by conditional update, not by a prior check (`AUTH-INV-10`, `AUTH-006`, `ARCH-007`); exactly one winner under concurrency (`AUTH-INV-11`); loser reported as "just sold", never as a silent failure; blocking test in CI | Engineering | Any occurrence at all - this is a zero-tolerance row; simultaneous-approval attempts in audit | `OPEN` |
| `RISK-11` | Prompt injection through buyer messages | Security | High | Medium | **Medium-High** | The minimum price is never in model context, so it cannot be extracted (`D-04`); the guardrail engine validates the structured action regardless of what the model was persuaded to draft, and is the actual control (`POLICY_AND_AUTHORIZATION.md` §10 layer 4); buyer text delimited and labelled untrusted (`ARCH-003`); claims of prior authorization checked against `SellerApproval` rows a buyer cannot create; denials become eval fixtures | Engineering | Guardrail denial patterns; injection-shaped inputs in logs; eval regressions on the injection suite | `OPEN` - likelihood is High and impact is Medium precisely because the mitigation is structural |
| `RISK-13` | Seller misconfigures the link or code - wrong code in the ad, code rotated after publication, wrong listing | Product / operations | High | Medium | **Medium-High** | URL and code independently revocable (`BUYER-003`); rotation does not require reprinting the URL; copy block with one-tap copy reduces transcription error (`BUYER-023`); expiry off by default because a dead code on a live ad is a lost sale (`ACCESS-012`); per-channel codes isolate a mistake to one channel (`INT-055`) | Product | Code-entry failure rate concentrated on one listing; rotation events followed by a conversion drop; support contacts | `OPEN` |
| `RISK-17` | A competitor replicates the product | Competitive | Medium | Medium | **Medium** | The moat is the complete workflow and the seller's accumulated operational record, not any prompt (`POSITIONING.md` §5); seven components enumerated, of which the record cannot be copied at all (`BIZ-140`, `BIZ-141`) | Product | Competitor launches in the same category; feature-comparison questions from prospects | `MONITORED` |
| `RISK-12` | Access code brute forcing | Security | Medium | Low | **Low** | The code is public by design and nothing sensitive sits behind it, so the prize is a public conversation surface (`D-03`, `SEC-001`); 5 attempts then a 60-minute per-client lock (`BUYER-011`); per-IP and per-listing buckets; identical error body and timing; the unguessable component is the ≥64-bit public id, not the code (`SEC-003`) | Engineering | Failed-attempt spikes per listing and per IP (`T-01`) | `MONITORED` |

## 3. Severity summary

| Severity | Count | IDs |
|---|---|---|
| Critical | 4 | `RISK-01`, `RISK-02`, `RISK-03`, `RISK-16` |
| High | 14 | `RISK-04`, `RISK-05`, `RISK-06`, `RISK-07`, `RISK-08`, `RISK-10`, `RISK-14`, `RISK-15`, `RISK-18`, `RISK-19`, `RISK-20`, `RISK-21`, `RISK-22`, `RISK-23` |
| Medium-High | 3 | `RISK-09`, `RISK-11`, `RISK-13` |
| Medium | 1 | `RISK-17` |
| Low | 1 | `RISK-12` |

`BIZ-205` Three of the four Critical risks - `RISK-01`, `RISK-02`, `RISK-03` - are external
dependencies with **no available preventive control**. That is the honest shape of this
business and follows directly from `D-07`, which remains correct. The response to an
uncontrollable risk is to test it early and cheaply, not to plan around it.

`BIZ-206` The Critical rows are concentrated at the **front of the funnel**. Nothing in the
product's design - the guardrails, the approval model, the isolation - matters if a buyer
never arrives. Engineering risk is well controlled; demand risk is not controlled at all.

## 4. The three risks to test before significant engineering investment

`BIZ-210` These three are ordered by dependency, not by severity. Each is cheap, each is
testable **before** the corresponding code exists, and each can invalidate work that would
otherwise be built on an assumption. Testing them out of order wastes the cheap evidence
(`BIZ-094`).

### Test 1 - `RISK-01` / `ASM-02`: can a link and code exist on the channels at all?

| | |
|---|---|
| **Why first** | If no surface on the primary channels can carry a link or a code, `RISK-02` is untestable and the product as specified has no path to a buyer. This gates everything. |
| **The test** | The three-step procedure in `integrations/MARKETPLACE_STRATEGY.md` §5, run on the P0 channels. (1) Read each marketplace's current published policy and record the URL, the retrieval date and the **exact quoted text**. (2) Publish genuine listings for items actually owned and actually for sale, one placement variant per listing - listing body, direct-message reply, profile field - and observe whether each is published, altered or removed, and whether the account is warned. (3) Record every result with its date and a screenshot, and set a `next_recheck_date`. |
| **Constraints** | Real items, real listings, company or consenting-participant accounts only, never a customer's account (`INT-031`). A surviving listing is an observation on a date, not a permission (`INT-032`). |
| **Cost** | Days of founder time. No engineering. |
| **Passes if** | At least one verified surface exists on at least two primary channels. |
| **Fails if** | Every candidate surface on the primary channels is restricted. Then the buyer-access flow as specified does not reach buyers, and the product must be reconsidered before, not after, the negotiation slice is built. |
| **Owner** | Product |

### Test 2 - `RISK-02` / `ASM-01`: will buyers actually follow the link and enter the code?

| | |
|---|---|
| **Why second** | It is the single highest-risk assumption in the business (`BUYER_ACCESS_FLOW.md` §1) and it needs no product. Building the agent, the guardrails and the approval model before knowing this is building on an untested premise. |
| **The test** | A manual concierge run. Publish real listings on a channel verified by Test 1. Point the ad at a hand-built static preview page - photos, title, price, seller name, seller-approved summary, exactly as `BUYER-004` specifies - with a 6-digit code field. A **human** answers every buyer as the assistant, disclosing that an assistant is answering (`D-15`). Instrument the full `BUYER_ACCESS_FLOW.md` §12 funnel: link opens, preview-to-code-entry, code-entry success, conversation start, messages per conversation, offer rate. Run both URL variants and both pre-fill variants (`Q-03`) if volume permits. |
| **What it also measures, free** | `RISK-04` (friction at the code field, isolated from friction at the preview), `RISK-05` (suspicion expressed in buyer messages), `RISK-19` (reaction to a disclosed assistant), and `ASM-04` (conversations per listing and messages per conversation, which the metering unit and the value hypothesis both depend on). |
| **Cost** | Days to weeks of founder time. A static page. No agent, no guardrails, no database. |
| **Passes if** | Link-open rate above ~40% and code-entry completion above ~50% of opens, across at least 100 real buyer contacts. |
| **Fails if** | Either threshold is missed. The response is to redesign the entry flow - pre-fill, URL shape, preview content, disclosure wording - and re-run, **not** to build the product and hope. |
| **Owner** | Product |

### Test 3 - `RISK-06` / `BIZ-093`: does the cost model survive real rates?

| | |
|---|---|
| **Why third** | It gates the negotiation slice specifically, which is the most expensive thing to build and the thing whose cost profile is worst. It is cheap to run and cannot be run before a provider is chosen. |
| **The test** | (1) Replace every placeholder rate in `UNIT_ECONOMICS.md` §2 with the chosen provider's real rates and recompute §4 and §6 in full - recompute, not adjust (`OPS-440`). (2) Script a realistic 15-turn negotiation and a 40-turn tail conversation against the real prompt, measure actual input, cached-input and output tokens per turn, and replace the §3 token assumptions with measurements. (3) Measure the real escalation share `s_esc` from the price-mention pre-pass on those transcripts. (4) Re-derive gross margin at typical and at cap for every tier. |
| **Cost** | Under a day once a provider is chosen. A scripted conversation, not a product. |
| **Passes if** | Every tier holds above ~60% gross margin at cap usage at the routed tier. |
| **Fails if** | Any tier falls below that. The response is to change allowances first, then prices, then routing - and to revisit the BUSINESS tier's existence, since it is already the weakest cell in the table at 52% (`BIZ-265`). |
| **Owner** | Engineering, with Product on the allowance and price consequences |

`BIZ-211` What is deliberately **not** on this list, and why: `RISK-08`, `RISK-09`,
`RISK-10` and `RISK-11` are severe but they are **engineering-controlled**. Their
mitigations are structural, already specified, and verified by blocking tests and evals
rather than by market experiments. They need building correctly, not testing for
viability. The three tests above are the ones where the answer might be "stop".

`BIZ-212` Sequencing rule, binding: **no significant engineering investment in the
negotiation, offer or approval slices until Tests 1 and 2 have run and reported.**
Test 3 gates the negotiation slice specifically. This is the same conclusion `BIZ-072`
reaches for acquisition spend, for the same reason.
