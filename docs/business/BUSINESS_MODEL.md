# Business Model

**Status:** Canonical for target customer, value hypothesis, monetization and the
commercial assumptions the business rests on. Product scope is set by
`product/MASTER_PRODUCT_SPEC.md` and is not restated or extended here.

**Reserved requirement-ID block:** `BIZ-001` – `BIZ-099`. No other document may issue a
`BIZ-` identifier in this range. `business/POSITIONING.md` holds `BIZ-100` – `BIZ-199`,
`business/RISK_REGISTER.md` holds `BIZ-200` – `BIZ-249`, and
`business/UNIT_ECONOMICS.md` holds `BIZ-250` – `BIZ-299` plus `OPS-400` – `OPS-449`.

**Every price, allowance and quantity in this document is a hypothesis, not a
commitment.** Nothing here has been tested with a paying customer. Numbers exist so the
model can be argued with and recomputed, not because they are known.

---

## 1. Target customer

Segments are set by `MASTER_PRODUCT_SPEC.md` §3 and personas by `PRD.md` §2. This section
adds only the commercial reading of them.

| Segment | Persona | Volume | Willingness to pay | Why | Priority |
|---|---|---|---|---|---|
| Side-hustle reseller | `P-01` Marcus | 10-40 items/month | Moderate. Time is the scarce resource; revenue is not yet large. | Message volume is disproportionate to revenue, so the pain is felt before the income justifies it | Primary |
| Full-time small reseller | `P-02` Priya | 100-400 items/month | Highest. This is her income and the tool touches her margin directly. | Volume makes conversation unmanageable and inconsistent negotiation costs real money | Primary |
| Small business / estate or clearance seller | `P-03` Dale | Batches of 50+ varied items | Moderate to high, project-shaped rather than continuous | Values a durable record and a professional buyer experience more than per-message savings | Secondary |
| Casual declutterer | - | A few items a year | None | Will not pay for a subscription to sell a couch. Explicitly not targeted. | Not targeted |

`BIZ-001` The buyer of the subscription is the **seller**. The buyer of the item is a
user of the product but never a customer, never an account holder, and never charged
(`BUYER-014`, `BUYER-022`).

`BIZ-002` The casual declutterer is not a mistargeted segment to be converted later. Any
feature justified by "it would help someone selling one item" is out of scope by default.

### 1.1 The job being hired for

| Job (as the seller would state it) | What the product actually does | What it does not do |
|---|---|---|
| "Stop me answering the same five questions thirty times a day" | Agent answers from seller-approved facts (`AI-001`) | Answer anything the seller has not supplied (`INV-12`) |
| "Negotiate for me the way I would, every time, even when I am tired" | Deterministic policy, consistent concessions (`AI-003`, `G-01`-`G-15`) | Decide what the item is worth (`D-09`) |
| "Tell me which of these thirty threads actually needs me" | Action-required queue replacing an inbox (`PROD-015`) | Rank buyers by quality or risk (`D-16`) |
| "Do not let me lose an offer in a chat scroll" | Structured offers with versions and history (`PROD-014`) | Accept anything on the seller's behalf (`D-13`) |
| "Give me a record of my business that does not vanish with the thread" | Durable listing, conversation, offer and sales history (`PROD-018`, `PROD-005`) | Estimate profit from market data; profit uses seller-entered costs only (`PROD-023`) |

`BIZ-003` The job is **operational load reduction**, not revenue increase. The product
must never be sold on the promise of higher sale prices, faster sales, or better
outcomes, because none of those can be substantiated (`business/POSITIONING.md` §7).

## 2. Value hypothesis

`BIZ-010` **Hypothesis, unvalidated.** For a seller handling more than roughly 20 buyer
conversations a month, the product removes a majority of the messages that currently
require the seller, and replaces an inbox with a short decision queue.

Stated as a model so it can be tested rather than believed:

```
hours_saved_per_month
  = conversations_per_month
    x messages_per_conversation_handled_by_agent
    x minutes_per_message_including_context_switch
    / 60
```

| Input | Illustrative placeholder | Status | How it gets measured |
|---|---|---|---|
| `conversations_per_month` | 60 (RESELLER), 220 (PRO) | Assumption | Product telemetry from day one |
| `messages_per_conversation_handled_by_agent` | 4 | Assumption | "Share of buyer messages resolved without seller involvement" (`MASTER_PRODUCT_SPEC.md` §15) |
| `minutes_per_message_including_context_switch` | 1.5 | Assumption. The context-switch cost, not the typing time, is the dominant term. | Seller diary study; cannot be measured from telemetry |

At those placeholders a RESELLER-tier seller saves roughly 6 hours a month and a PRO-tier
seller roughly 22. **These are arithmetic on assumptions, not findings.**

`BIZ-011` The second value component is **variance reduction**: the same negotiation
executed the same way regardless of the seller's mood, hour or fatigue. This is real and
is stated qualitatively. It must not be quantified into a money figure, because doing so
requires knowing what the item was worth (`D-09`).

`BIZ-012` The third component is the **durable operational record** (`PROD-005`,
`PROD-018`). It has no monthly time value but raises switching cost over time, and is the
part of the product a competitor cannot copy by copying a feature
(`business/POSITIONING.md` §5).

`BIZ-013` The value hypothesis fails outright below a conversation-volume floor. A seller
with three conversations a month cannot perceive a saving, whatever the product does.
This is why the casual declutterer is not targeted and why the free tier is an
acquisition surface rather than a viable end state (`BIZ-030`).

## 3. What the customer thinks they are buying

`BIZ-020` The customer is buying **an AI selling assistant that handles their buyers**.
They are not buying model access, tokens, credits, or capacity.

| Framing | Consequence |
|---|---|
| Sold as an assistant with a monthly price | Purchase decision is made once. Usage is unmonitored by the customer. Cost anxiety is absent. The unit of value is "my buyers get handled". |
| Sold as tokens or credits | Every conversation becomes a spending decision. The seller rations the product, uses it on high-value items only, and the value hypothesis - which depends on volume - collapses. |

`BIZ-021` **Design consequence, not a marketing preference.** Because the customer must
not think about tokens, allowances must be generous enough that a normal month never
touches them (`BIZ-041`), the interface must never display token counts or model costs to
a seller, and no seller-facing surface may use the words token, credit, prompt or context.

`BIZ-022` Whether per-seller AI cost is ever exposed to a seller is a plan-design
question left open in `INVENTORY_AND_SALES.md`. This document's position is **no** for
FREE, RESELLER and PRO. A future BUSINESS tier may expose usage as an administrative
report, never as a spending meter.

`BIZ-023` The corollary is that the operator absorbs cost variance. That is what
`business/UNIT_ECONOMICS.md` exists to size, and it is the reason metering must exist
internally even though it is invisible externally (`NFR-006`).

## 4. Monetization model

`BIZ-030` Five components:

| # | Component | Purpose | Notes |
|---|---|---|---|
| 1 | Freemium acquisition | Remove the trust barrier for a seller who has never heard of us and is being asked to route their buyers through a stranger's domain | Free tier is deliberately usable, deliberately limited, and deliberately not a viable end state for a target segment |
| 2 | Tiered monthly subscription | The revenue line. Priced by seller scale, not by usage. | Tiers in §5 |
| 3 | Generous included AI usage | Protects `BIZ-020`. The allowance is a fair-use ceiling, not a budget the seller manages. | Sized so a typical month uses well under half the allowance (§5.2) |
| 4 | Optional heavy-usage overage | Contains the tail without forcing a tier upgrade on a seller having one unusual month | Opt-in, never automatic, never silent (`BIZ-044`) |
| 5 | Annual discount | Cash flow and churn reduction | Two months free, ~17%, applied to RESELLER and PRO. Assumption. |

`BIZ-031` There is no transaction fee, no commission, no take rate and no payment
processing. The platform does not touch the money (`MASTER_PRODUCT_SPEC.md` §8,
`D-14`). A commission model would require knowing the sale completed, which the platform
only knows because the seller says so.

`BIZ-032` There is no per-listing charge. Reasoning in §6.

`BIZ-033` No tier may unlock a removed feature. Pricing intelligence, valuation,
comparables, automatic identification and autonomous acceptance are not premium
capabilities held back for a higher tier; they do not exist (`D-09`, `D-11`, `D-13`).

## 5. Tier table

`BIZ-040` **All prices and allowances below are hypotheses for testing. None is a
commitment, none has been validated with a customer, and all are expected to change.**
Free-tier limits specifically remain an open question (`Q-06`).

| | FREE | RESELLER | PRO | BUSINESS |
|---|---|---|---|---|
| Status | Hypothesis | Hypothesis | Hypothesis | **Future. Not MVP. Not currently approved.** |
| Price (CAD/month, monthly billing) | 0 | 29-39 | 59-79 | 99-149+ |
| Modelled midpoint used in `UNIT_ECONOMICS.md` | 0 | 34 | 69 | 124 |
| Annual price | n/a | 10 x monthly | 10 x monthly | TBD |
| Active listings included | 3 | 40 | 150 | 500+ |
| Buyer conversations included / month | 20 | 150 | 600 | 2,000+ |
| Listing content enhancement | Included | Included | Included | Included |
| Negotiation | Included | Included | Included | Included |
| Offer extraction and history | Included | Included | Included | Included |
| Action-required queue | Included | Included | Included | Included |
| Per-channel access codes (`BUYER-025`) | No | Yes | Yes | Yes |
| Sales history retention | 90 days | Full | Full | Full |
| Analytics (`PROD-023`) | Basic counts | Operational | Operational + per-channel | Operational + per-channel + export |
| Overage available | No - hard stop | Optional, opt-in | Optional, opt-in | Optional, opt-in |
| Target persona | Trial / evaluation | `P-01` Marcus | `P-02` Priya | `P-03` Dale, multi-seller |

`BIZ-041` Allowances are sized so a **typical** month for the target persona consumes
roughly 30-40% of the included conversations. A seller who regularly reaches the cap is
on the wrong tier, and the product should say so rather than charging overage
indefinitely.

`BIZ-042` **What happens at the cap** is a product requirement, not a billing detail:

| Tier | At the included limit |
|---|---|
| FREE | New buyer conversations do not open. Existing conversations continue to completion. The seller is told, and is shown the upgrade. No conversation in flight is ever cut off mid-negotiation. |
| Paid, overage off | Same behaviour, plus a notification at 80% and at 100%. |
| Paid, overage on | Conversations continue and are billed per block (`BIZ-043`). A hard ceiling still applies (`BIZ-045`). |

`BIZ-043` Overage is sold in **blocks of buyer conversations**, not per message and not
per token, so the seller's mental model stays "conversations handled" (`BIZ-020`).
Illustrative: CAD $10 per block of 100 conversations. Assumption.

`BIZ-044` Overage is never enabled by default, never enabled silently, and never enabled
retroactively. A seller who has not opted in cannot be billed for overage.

`BIZ-045` Every tier, including overage-enabled tiers, has an absolute monthly ceiling
enforced in code. This is a **security control**, not a commercial one: it is the
customer-facing half of the cost-exhaustion defence (`T-04`, `SEC-010`, `RISK-07`). The
ceiling degrades to holding mode and seller handover (`ARCH-014`), never to silent
unbounded spend.

## 6. Why metering is on buyer conversations, not listings

`BIZ-050` The metered unit is the **buyer conversation**: one `Conversation` between one
`BuyerSession` and the agent for one `Listing`, counted once, at the moment the first
agent reply is generated.

| Candidate unit | Why not |
|---|---|
| Active listings | A listing costs one enhancement call and some storage. A listing with 40 interested buyers costs 40 times a listing with one. Metering listings prices the cheap thing and gives away the expensive one. |
| Messages or turns | Correct on cost, wrong on comprehension. The seller cannot predict or perceive turns, and a per-turn meter reintroduces the token mindset `BIZ-020` exists to prevent. |
| Sales | Aligns beautifully with value and not at all with cost. The platform's cost is incurred on every conversation, including the 90% that never become a sale, and the platform only learns a sale happened because the seller says so. |
| Seats | There is one seat. Team accounts are future scope. |
| **Buyer conversations** | **Chosen.** Tracks cost within an order of magnitude, tracks delivered value closely, is countable by the seller, and is expressible in the customer's own language: "the AI handled 74 buyers for you this month." |

`BIZ-051` Listings still carry an included allowance, because an unbounded listing count
would let a single account consume image storage and enhancement calls without ever
opening a conversation. The listing allowance is an **abuse bound**, not a pricing lever,
and should be set generously enough that no legitimate seller notices it.

`BIZ-052` A conversation is counted once regardless of how long it runs. A 40-turn
negotiation and a 2-turn question count identically to the customer, and differ by roughly
an order of magnitude in cost (`UNIT_ECONOMICS.md` §4). The operator carries that spread
deliberately, and it is the single largest reason cost control is a product requirement
rather than an infrastructure concern.

## 7. Conversation volume is buyer-driven

`BIZ-060` The seller controls how many listings they publish. **The seller does not
control how many buyers message them, how many turns each buyer takes, or how many of
those buyers are serious.**

| Driver | Controlled by | Effect on cost |
|---|---|---|
| Number of listings | Seller | Linear, small |
| Number of interested buyers per listing | Marketplace demand, item, price, season, luck | Linear, large, unpredictable |
| Turns per conversation | The buyer's temperament | Superlinear within a conversation (`UNIT_ECONOMICS.md` §5) |
| Negotiation length | The buyer's persistence | Superlinear |
| Adversarial usage | An attacker, not a customer | Unbounded without controls (`T-04`) |

`BIZ-061` Consequences, all of them binding:

1. **Usage cannot be left uncapped.** A single popular listing, one seasonal spike, or one
   adversary can move a seller from a typical month to a cap month without the seller
   doing anything differently (`RISK-06`, `RISK-07`).
2. **The cap cannot be a surprise.** The seller did not cause the overage, so the product
   must warn early (`BIZ-042`) and must never terminate an in-flight negotiation.
3. **Degradation is preferable to denial.** Tier degradation, then holding mode, then
   seller handover (`AI-034`, `ARCH-014`). Cutting a buyer off is a lost sale for the
   customer and a churn event for us.
4. **The distribution matters more than the mean.** Pricing must survive the tail, not the
   average. `UNIT_ECONOMICS.md` models both typical and cap usage for exactly this reason.

## 8. Acquisition

`BIZ-070` The acquisition problem is harder than the product problem, and is compounded by
a specific difficulty: **the product asks a seller to route their buyers through a domain
neither the seller nor the buyer has heard of.** Trust must be established before value can
be demonstrated.

| Barrier | Why it bites |
|---|---|
| Unknown domain in the buyer path | The seller risks their own conversion to try us. The cost of trying is borne in lost sales, not in dollars. |
| Marketplace link policy uncertainty | The seller may not be able to use the product on their main channel at all, and we cannot currently tell them (`integrations/MARKETPLACE_STRATEGY.md` §4) |
| No network effect | Nothing about the product improves as more sellers join. Growth is entirely paid or earned, never compounding. |
| No marketplace-native distribution | We cannot advertise inside the marketplaces where the customers are, and must not attempt to (`INT-060`) |
| Value is invisible until volume | A seller must publish several listings and receive real buyers before anything happens (`BIZ-013`) |

`BIZ-071` Candidate channels, in order of expected efficiency. **All are hypotheses; none
has been tested.**

| # | Channel | Why it might work | Why it might not | Cost shape |
|---|---|---|---|---|
| 1 | Reseller communities and forums | The customers are already gathered and already complain about exactly this problem | Promotional posting is usually against community rules; requires genuine participation over months | Time |
| 2 | Reseller creators on video platforms | Creators demonstrate tools to precisely the target audience; a demo shows the value that copy cannot | Expensive relative to our ACV; creators favour tools with affiliate revenue | Cash or revenue share |
| 3 | Content and search on the operational problem | "How to stop answering the same marketplace questions" is a real query with commercial intent | Slow; 6-12 months before it produces anything | Time |
| 4 | Direct outreach to visibly high-volume sellers | Highest intent; they feel the pain daily | Does not scale past the founders; contacting sellers through marketplace messaging is prohibited (`INT-060`) and must be done through channels they publish themselves | Time |
| 5 | Seller referral | Resellers talk to resellers, and the tool is visible in their workflow | No product-side network effect to lean on; requires a satisfied base to exist first | Discount |
| 6 | Paid social and search | Fast to test, fast to measure | Small ACV against broad targeting; likely uneconomic before positioning is proven | Cash |

`BIZ-072` Acquisition sequencing is a consequence of the risk register, not a marketing
choice: **do not spend on acquisition until `ASM-01` has cleared its threshold**
(`RISK-02`, `RISK_REGISTER.md` §4). Buying traffic into an unvalidated buyer-follow-through
assumption converts cash into evidence we could have obtained for free.

`BIZ-073` Free-to-paid conversion is the metric that decides whether freemium was correct.
It has no baseline. If the free tier produces sellers who never publish a listing, the free
tier is a cost centre and should be replaced with a time-limited trial.

## 9. Marketplace dependency as a structural business risk

`BIZ-080` The business depends on external platforms it has no relationship with, no
agreement with, no notice from, and no recourse against. This is **structural**, not
incidental: it follows directly from `D-07`, and `D-07` is correct.

| Dependency | Failure mode | Our leverage |
|---|---|---|
| Marketplaces permit a link or code in some seller-controlled surface (`ASM-02`) | Product is unreachable on that channel | None |
| Policy stays stable | Silent change removes a working channel overnight (`RISK-03`) | None |
| Buyers follow links (`ASM-01`) | Funnel collapses at step one | Only design |
| Marketplaces do not ship equivalent native negotiation (`RISK-18`) | Category is absorbed | None |
| Marketplaces keep buyer traffic worth acquiring | Sellers migrate, we follow at their pace | None |

`BIZ-081` Structural mitigations - none of which removes the dependency:

1. **Channel diversification.** Never let one channel exceed a majority of conversations.
   Per-channel measurement (`INT-053`) makes concentration visible before it is fatal.
2. **Surface diversification.** Multiple placement surfaces per channel, each separately
   verified (`INT-040`).
3. **Value that survives the link.** Listing records, copy, policy, offer history and sales
   history retain value even if the buyer conversation had to happen elsewhere. A seller
   whose channel closes should lose a feature, not their business record.
4. **Early detection.** Per-channel conversion is the tripwire for a silent policy change
   (`INT-035`).
5. **Honesty with sellers.** Tell sellers the rules vary and are their responsibility
   (`BUYER-024`). A seller surprised by a removed listing churns and tells others.

`BIZ-082` This dependency is not insurable, hedgeable or negotiable at our size. It is
accepted, monitored, and disclosed to anyone evaluating the business.

## 10. What must be true for this business to work

`BIZ-090` The assumptions from `MASTER_PRODUCT_SPEC.md` §17, each with what would falsify
it and how that evidence is obtained. **An assumption with no falsification test is a
belief, and belief is not a plan.**

| ID | Assumption | What would falsify it | Test | Cost to test | Status |
|---|---|---|---|---|---|
| `ASM-01` | Buyers will follow a link and enter a code in sufficient numbers | Link-open rate below ~40%, or code-entry completion below ~50% of opens, across at least 100 real buyer contacts on the primary channel | Manual concierge test: real listings, a hand-built static preview page, a code, and a human answering as the assistant. **Requires no product build.** Measures `BUYER_ACCESS_FLOW.md` §12 metrics directly. | Days of founder time | **Unvalidated. Highest risk.** Blocks everything. |
| `ASM-02` | Target marketplaces permit a link and code in some seller-controlled surface | Every candidate surface on the primary channels is restricted | The three-step procedure in `integrations/MARKETPLACE_STRATEGY.md` §5: read current policy, test with real listings, record dated quotes | Days of founder time | **Unvalidated.** Every channel row is `UNCLEAR - REQUIRES RESEARCH`. |
| `ASM-03` | Sellers will supply factual fields rather than expecting inference | Median listing submitted with fewer than ~4 populated fact fields; sellers abandon the form; sellers ask where the photo-to-listing button is | Instrument field completion in the first 50 real listings; watch 10 sellers create a listing unaided | Low, but requires product | **Unvalidated.** Falsification would not restore `D-10`/`D-11`; it would mean the form design is wrong. |
| `ASM-04` | Conversation volume per listing is high enough that automation is felt | Median conversations per listing below ~3, or median buyer messages per conversation below ~3 | Observable in the `ASM-01` concierge test at zero extra cost | Free, alongside `ASM-01` | **Unvalidated.** Falsification breaks the value hypothesis (`BIZ-013`) and the metering unit (`BIZ-050`). |
| `ASM-05` | Sellers accept an approval step rather than wanting full autonomy | Sellers repeatedly ask for auto-accept; approval latency so long that offers expire; sellers approve without reading | Direct interview plus time-from-offer-to-decision telemetry (`MASTER_PRODUCT_SPEC.md` §15) | Low | **Unvalidated.** Falsification does **not** reopen `D-13`; it means the approval surface is too slow or too heavy. |

`BIZ-091` Two further commercial assumptions, not in §17, which this document owns:

| ID | Assumption | What would falsify it | Test |
|---|---|---|---|
| `BIZ-092` | Target sellers will pay CAD $29-79/month for operational load reduction with no revenue claim | Willingness-to-pay interviews cluster below CAD $20; free-to-paid conversion under ~3% | 20 structured interviews before pricing is fixed; then a live price test |
| `BIZ-093` | Gross margin holds at cap usage on real model rates | Any tier's modelled margin at cap falls below ~60% once real rates replace placeholders | Recompute `UNIT_ECONOMICS.md` §4 with real rates, and replay a scripted 15-turn negotiation, **before** the negotiation slice is built |

`BIZ-094` Dependency order. `ASM-02` gates `ASM-01`, which gates `ASM-04`, which gates the
value hypothesis, which gates `BIZ-092`. Testing them out of order wastes the cheap
evidence. The three to test first are named in `RISK_REGISTER.md` §4.
