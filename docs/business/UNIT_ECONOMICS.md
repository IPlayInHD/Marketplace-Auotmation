# Unit Economics

**Status:** Canonical for the cost model and for the metering and cost-control
requirements that follow from it. Prices and tiers are set by
`business/BUSINESS_MODEL.md` and are used here, not decided here.

**Reserved requirement-ID blocks:** `BIZ-250` – `BIZ-299` for economic statements, and
`OPS-400` – `OPS-449` for the metering and cost-control requirements in §9. No other
document may issue identifiers in either range. (`OPS-001` – `OPS-314` are already in use
by `EVAL_STRATEGY.md`, `PRD.md`, `INVENTORY_AND_SALES.md` and `UX_FLOWS.md`.)

---

## 1. Purpose, scope and honesty statement

`BIZ-250` **Every rate in this document is an ILLUSTRATIVE PLACEHOLDER. No provider has
been chosen (`D-08`; D-17 keeps the provider open as `Q-10`), no rate has been negotiated, and no number below is a quotation, a
forecast or a commitment.** The document's value is the *structure* - the work units, the
formulas and the levers - which stays correct when the placeholders are replaced.

`BIZ-251` There is **no pricing engine** and no valuation capability (`D-09`, `R-01`-`R-03`).
Nothing in this document models the cost of one, and no cost line here may be repurposed
to justify building one.

`BIZ-252` Modelled work units, and only these:

| # | Work unit | Trigger | Frequency | Cost driver |
|---|---|---|---|---|
| 1 | Listing content enhancement | Explicit seller request only (`LIST-003`, `LIST-066`) | Once per content version | Model, cheap tier |
| 2 | Buyer conversation turn | Every buyer message | Per turn, per conversation | Model; grows with history |
| 3 | Negotiation turn | A turn containing a price or condition | Subset of turns | Model, escalated tier |
| 4 | Offer extraction | A turn containing offer terms | A few per negotiation | Model, cheap, structured |
| 5 | Conversation summarisation | Batched, off critical path (`AI-031`) | Once per conversation | Model, cheap, batched |
| 6 | Image storage and serving | Upload, then every buyer preview | Per listing, then per view | Storage and egress |
| 7 | Database and compute | Continuous | Amortised | Fixed infrastructure |
| 8 | Notifications | Escalation, offer, approval, digest | Per event | Per-message delivery fee |

`BIZ-253` Excluded from the model, and why: payment processing (none - `BIZ-031`); shipping
(none); marketplace API costs (none - `D-07`); market-data licensing (none - `D-09`);
salaries and overhead (not unit economics); customer support (not modelled at MVP, and a
known gap).

## 2. Illustrative placeholder rates

`BIZ-254` **ILLUSTRATIVE ONLY.** Chosen to be plausible in shape and in the ratio between
tiers, which is what the conclusions depend on. They are not any vendor's prices.

| Rate | Symbol | ILLUSTRATIVE value | Unit |
|---|---|---|---|
| Cheap tier input | `P_in(cheap)` | CAD 0.40 | per 1M tokens |
| Cheap tier output | `P_out(cheap)` | CAD 1.60 | per 1M tokens |
| Mid tier input | `P_in(mid)` | CAD 4.00 | per 1M tokens |
| Mid tier output | `P_out(mid)` | CAD 16.00 | per 1M tokens |
| Premium tier input | `P_in(prem)` | CAD 20.00 | per 1M tokens |
| Premium tier output | `P_out(prem)` | CAD 80.00 | per 1M tokens |
| Cached input multiplier | `k_cache` | 0.10 | fraction of input rate |
| Object storage | `P_store` | CAD 0.030 | per GB-month |
| Egress / serving | `P_egress` | CAD 0.120 | per GB |
| Notification delivery | `P_notif` | CAD 0.0004 | per message |
| Fixed infrastructure, paid tiers | `P_infra` | CAD 3.00 | per active seller-month, amortised |
| Fixed infrastructure, free tier | `P_infra_free` | CAD 1.00 | per active seller-month, amortised |

`BIZ-255` Tier names `cheap`, `mid`, `premium` are the names already in use in
`AI_AGENT_SPEC.md` §10. `premium` is reserved and is **not routed to at MVP** (`AI-033`);
it is modelled here only as a sensitivity bound.

## 3. Token assumptions and formulas

`BIZ-256` **All quantities in this section are assumptions.** They are the numbers most
likely to be wrong, and the first thing to replace with measurement.

| Symbol | Meaning | ILLUSTRATIVE value | Assumption |
|---|---|---|---|
| `T_base` | Per-turn base context: system prompt, approved facts, policy-derived permitted action space, permitted counter range, disclosure text | 1,200 tokens | Assumption |
| `T_buy` | One buyer message | 60 tokens | Assumption |
| `T_ag` | One agent reply | 120 tokens | Assumption |
| `T_grow` | History added per completed turn = `T_buy + T_ag` | 180 tokens | Derived |
| `T_triage_in` / `T_triage_out` | Intent extraction and price-mention pre-pass, per turn | 400 / 40 tokens | Assumption |
| `T_extr_in` / `T_extr_out` | Offer extraction call | 2,500 / 150 tokens | Assumption |
| `T_summ_in` / `T_summ_out` | Conversation summarisation, once per conversation | 4,000 / 250 tokens | Assumption |
| `T_enh_in` / `T_enh_out` | Listing enhancement | 900 / 400 tokens | Assumption |
| `r_enh` | Enhancement retry and validation multiplier | 1.5 | Assumption |
| `s_esc` | Share of negotiation turns escalated to `mid` by the price-mention rule (`AI-032`) | 0.40 | Assumption |
| `f_late` | Escalated turns carry more context because they occur later | 1.4 | Assumption |
| `n_extr` | Extraction calls per negotiation | 4 | Assumption |

### 3.1 Formulas

Recompute everything from these when real rates are chosen.

```
Input tokens on turn n of a conversation:
  T_in(n) = T_base + T_grow x (n - 1) + T_buy

Total for an N-turn conversation:
  T_in_total(N) = N x (T_base + T_buy) + T_grow x N x (N - 1) / 2
  T_out_total(N) = T_ag x N

  Note the N^2 term. This is the superlinearity in §5.

Cost of a set of tokens at tier t:
  C(t, i, o) = i / 1e6 x P_in(t) + o / 1e6 x P_out(t)

Auxiliary model cost for an N-turn conversation:
  C_aux(N) = C(cheap, T_triage_in x N,  T_triage_out x N)     [triage, every turn]
           + C(cheap, T_extr_in x k,    T_extr_out x k)        [extraction, k calls]
           + C(cheap, T_summ_in,        T_summ_out)            [summarisation, once]

Routed-tier split for a negotiation:
  mid_in    = T_in_total x s_esc x f_late
  cheap_in  = T_in_total - mid_in
  mid_out   = T_out_total x s_esc
  cheap_out = T_out_total - mid_out
  C_routed  = C(mid, mid_in, mid_out) + C(cheap, cheap_in, cheap_out) + C_aux(N)

Enhancement:
  C_enh = C(cheap, T_enh_in, T_enh_out) x r_enh

Image serving per listing:
  C_img = images_per_listing x bytes_per_image x views_per_listing / 1e9 x P_egress
        + images_per_listing x bytes_per_image / 1e9 x P_store
```

## 4. Cost per unit of work

`BIZ-257` Computed from §2 and §3. **Illustrative arithmetic on assumptions.**

### 4.1 Model work units

| Work unit | Tokens (in / out) | Cheap tier | Routed tier | Premium tier |
|---|---|---|---|---|
| Listing enhancement (1 content version, incl. retry factor) | 1,350 / 600 | **CAD 0.0015** | 0.0015 (never escalates - `LISTING_ENHANCEMENT.md` §10) | 0.0075 |
| Short conversation, 3 turns, no price mention | 4,320 / 360 (+ triage) | **CAD 0.0030** | **CAD 0.0030** (defaults cheap, no escalation trigger) | CAD 0.1159 |
| Negotiation, 15 turns, 4 extractions, 1 summary | 37,800 / 1,800 (+ aux) | CAD 0.0283 | **CAD 0.1149** | CAD 0.9103 |
| Offer extraction, per call | 2,500 / 150 | CAD 0.0012 | CAD 0.0012 | - |
| Summarisation, per conversation | 4,000 / 250 | CAD 0.0020 | CAD 0.0020 | - |
| Triage pre-pass, per turn | 400 / 40 | CAD 0.00022 | CAD 0.00022 | - |

`BIZ-258` The headline ratios, which are the durable findings and survive any rate change
that preserves the tier spread:

| Ratio | Value | Meaning |
|---|---|---|
| Negotiation : short conversation (routed) | **39 : 1** | A conversation is not a unit of cost. The metering unit deliberately ignores this (`BIZ-052`). |
| Negotiation : enhancement | **77 : 1** | Enhancement is rounding error. `LIST-068` is confirmed by the model. |
| Routed : all-cheap negotiation | **4.1 : 1** | The price of correctness on money turns. |
| All-premium : routed negotiation | **7.9 : 1** | Why `premium` is reserved and not routed to (`AI-033`). |
| All-premium : all-cheap negotiation | **32 : 1** | Tier routing is the single largest cost lever in the system. |

### 4.2 Non-model work units

| Work unit | Assumption | ILLUSTRATIVE cost |
|---|---|---|
| Image storage | 6 images per listing, 400 KB per served derivative, 2.4 MB per listing | CAD 0.00007 per listing-month - negligible |
| Image serving | 30 buyer previews per listing, full image set each | **CAD 0.0084 per listing** - comparable to 3 short conversations |
| Database and compute | Amortised fixed infrastructure at MVP scale | CAD 3.00 per paid seller-month, CAD 1.00 per free seller-month |
| Notifications | ~3 per negotiation, ~0.5 per short conversation | CAD 0.0004 each |

`BIZ-259` Image serving is not negligible and is frequently overlooked. Unresized
originals - 3 MB rather than 400 KB per image - raise serving from CAD 0.0084 to roughly
CAD 0.063 per listing, a **7.5x** increase on a line item that at PRO cap sits at the same
order of magnitude as the entire enhancement spend. Derivative generation and dimension
caps are a cost control, not a nicety (§6).

## 5. Cost grows superlinearly within a conversation

`BIZ-260` Conversation history is resent on every turn. Turn *n* carries the whole
conversation before it, so the marginal cost of a turn rises linearly with turn index and
the total cost of a conversation rises with the **square** of its length.

Marginal cost of turn *n*, cheap tier, illustrative:

| Turn | Input tokens | Marginal cost (CAD) | Relative to turn 1 |
|---|---|---|---|
| 1 | 1,260 | 0.000696 | 1.00x |
| 5 | 1,980 | 0.000984 | 1.41x |
| 10 | 2,880 | 0.001344 | 1.93x |
| 15 | 3,780 | 0.001704 | 2.45x |
| 25 | 5,580 | 0.002424 | 3.48x |
| 40 | 8,280 | 0.003504 | **5.03x** |

`BIZ-261` Total conversation cost, cheap tier, illustrative:

| Conversation length | Total input tokens | Cheap-tier cost | Cost per turn |
|---|---|---|---|
| 3 turns | 4,320 | CAD 0.0023 | 0.00077 |
| 15 turns | 37,800 | CAD 0.0180 | 0.00120 |
| 40 turns | 190,800 | CAD 0.0840 | 0.00210 |

Doubling the turns roughly quadruples the cost. **A single pathological conversation - a
buyer who will not stop, or an adversary who will not stop deliberately - is the tail risk
the whole cost-control design exists to bound** (`T-04`, `RISK-07`, `BIZ-061`).

### 5.1 The three levers

`BIZ-262` Modelled against the 15-turn negotiation baseline of 37,800 input tokens.

| Lever | Mechanism | Assumption | Input-token saving | Notes |
|---|---|---|---|---|
| **Prompt caching** | The per-turn base context is stable within a conversation, so a cached prefix is billed at `k_cache` | 80% of `T_base` cacheable, cached portion at 10% of the input rate | **-34%** (37,800 to 24,840) | Largest single lever. Requires the prompt to be built prefix-stable: fixed content first, volatile content last. That is an architectural constraint on context assembly, not a runtime optimisation. Availability is provider-dependent (`Q-10`). |
| **History truncation** | Keep the last K turns verbatim plus a rolling summary; drop the middle | K = 8 turns, 250-token rolling summary | -6% at 15 turns, **-43% at 40 turns** | Converts the N^2 term into a linear one beyond turn K. Worth almost nothing on short conversations and decisive on long ones - exactly the tail that matters. Constrained by `AI-002` and `G-05`: a dropped fact must not become an invented one. Summaries must preserve every stated offer and condition, or offer extraction degrades. |
| **Image resizing** | Serve bounded derivatives, never originals | 400 KB vs 3 MB per served image | 7.5x on serving, not on tokens | Independent of the model entirely. Also improves `NFR-001` and the mobile-first requirement (`BUYER-020`). |
| Caching + truncation together | | | **-40% at 15 turns** | Not additive; caching acts on the base, truncation on the history. |

`BIZ-263` A fourth lever exists and is already the largest: **tier routing** (`AI-031`,
`AI-032`). It is not listed above because it is a design decision already taken rather than
an optimisation still available. Its magnitude is in `BIZ-258`: 32x between an all-cheap
and an all-premium negotiation.

## 6. Worked gross-margin table

`BIZ-264` Tiers, prices and allowances from `business/BUSINESS_MODEL.md` §5. **Every
number in this section is illustrative arithmetic on assumptions, at placeholder rates, for
a product with no customers.** It shows whether the model has a plausible shape, nothing
more.

### 6.1 Usage profiles

Assumptions. "Typical" is the target persona's expected month; "cap" is the included
allowance fully consumed.

| Tier | Profile | Active listings | Conversations | of which negotiations |
|---|---|---|---|---|
| FREE | typical | 3 | 12 | 2 |
| RESELLER | typical | 20 | 60 | 10 |
| RESELLER | cap | 40 | 150 | 30 |
| PRO | typical | 70 | 220 | 40 |
| PRO | cap | 150 | 600 | 120 |
| BUSINESS (future) | typical | 250 | 800 | 150 |
| BUSINESS (future) | cap | 500 | 2,000 | 400 |

### 6.2 Margins at the routed tier

Routed tier: cheap by default, escalating to `mid` on a price mention or a rule trigger.
This is the MVP configuration (`AI-031`, `AI-033`).

| Tier / profile | Price (CAD) | Model cost | Image serving | Notifications | Infrastructure | **Total cost** | **Gross margin** |
|---|---|---|---|---|---|---|---|
| FREE typical | 0.00 | 0.264 | 0.025 | 0.004 | 1.00 | **1.29** | **-CAD 1.29 per free seller-month** |
| RESELLER typical | 34.00 | 1.328 | 0.168 | 0.022 | 3.00 | **4.52** | **86.7%** |
| RESELLER cap | 34.00 | 3.864 | 0.336 | 0.060 | 3.00 | **7.26** | **78.6%** |
| PRO typical | 69.00 | 5.236 | 0.588 | 0.084 | 3.00 | **8.91** | **87.1%** |
| PRO cap | 69.00 | 15.441 | 1.260 | 0.240 | 3.00 | **19.94** | **71.1%** |
| BUSINESS typical (future) | 124.00 | 19.543 | 2.100 | 0.310 | 3.00 | **24.95** | **79.9%** |
| BUSINESS cap (future) | 124.00 | 51.469 | 4.200 | 0.800 | 3.00 | **59.47** | **52.0%** |

`BIZ-265` Readings:

1. **Typical usage is comfortable at every tier**, 80-87%, which is where a subscription
   business needs to be.
2. **Cap usage is survivable but not comfortable**, and it degrades as the tier grows: 79%
   at RESELLER, 71% at PRO, **52%** at BUSINESS. The included allowances, not the prices,
   are the variable to revisit first.
3. **BUSINESS at cap is the weakest cell in the table** and the reason that tier stays
   future and unapproved. A tier whose worst case is 52% needs either a lower allowance, a
   higher price, or mandatory overage.
4. **The free tier costs roughly CAD 1.29 per active seller-month.** A converted RESELLER
   contributes CAD 29.48 a month, which funds about 23 free sellers, so **break-even
   free-to-paid conversion is roughly 4.2%**. Below that, freemium is a cost centre and the
   time-limited-trial alternative in `BIZ-073` applies. The 4.2% figure is arithmetic on
   assumptions; the conversion rate itself has no basis at all.
5. **Infrastructure dominates typical usage and model cost dominates cap usage.** At
   RESELLER typical, fixed infrastructure is 66% of cost; at BUSINESS cap it is 5%. The two
   ends of the range have entirely different cost structures and should not be reasoned
   about with one mental model.

### 6.3 Tier sensitivity at PRO cap

The same usage profile, run at each routing strategy. This is the strongest argument in the
document.

| Routing strategy | Model cost | Total cost | Gross margin |
|---|---|---|---|
| All cheap tier | 5.05 | 9.55 | **86.2%** |
| **Routed (MVP configuration)** | 15.44 | 19.94 | **71.1%** |
| All premium tier | 165.08 | 169.58 | **-145.8%** |

`BIZ-266` Routing everything to a premium tier turns a 71% gross margin into a loss of more
than twice the subscription price. **Tier routing is not an optimisation. It is the
difference between a business and a subsidy**, and `AI-033` - premium is reserved and
requires scoreboard evidence before it is routed to - is therefore a commercial control as
well as an engineering one.

### 6.4 Break-even sensitivity

`BIZ-267` How far the placeholder rates can be wrong before a tier stops working, at the
routed tier and cap usage:

| Tier | Total cost at cap | Model cost at cap | Rate multiple at which gross margin reaches 0% |
|---|---|---|---|
| RESELLER | 7.26 | 3.86 | **~7.9x** the placeholder model rates |
| PRO | 19.94 | 15.44 | **~4.2x** |
| BUSINESS (future) | 59.47 | 51.47 | **~2.3x** |

`BIZ-268` RESELLER and PRO tolerate real rates being several times the placeholders.
BUSINESS at cap tolerates less than a doubling. That asymmetry, not the absolute margins,
is the finding that should drive the allowance decision.

## 7. Which numbers are assumptions

`BIZ-269` Stated plainly, because a table of two-decimal figures reads as knowledge when it
is not.

| Category | Status | Confidence | Replace with |
|---|---|---|---|
| All model rates (§2) | **Assumption. Placeholder.** | None - no provider chosen (`D-08`, `Q-10`) | Contracted rates |
| Storage, egress, notification, infrastructure rates | **Assumption. Placeholder.** | Low | Actual invoices |
| Token counts (§3) | **Assumption.** Most likely to be wrong. | Low | Measured `AIInteraction` rows |
| `s_esc` = 0.40 escalation share | **Assumption.** | Low | Measured from the price-mention pre-pass |
| `f_late` = 1.4 | **Assumption**, and a modelling convenience rather than a measurement | Very low | Per-turn tier and token logging |
| Conversation length distribution (3 typical, 15 negotiation, 40 tail) | **Assumption.** | Low | Real conversation histogram |
| Usage profiles (§6.1) | **Assumption.** | Low | Real per-seller usage |
| Image counts, sizes, views per listing | **Assumption.** | Low | Real telemetry |
| Free-to-paid conversion (5%) | **Assumption.** No basis. | None | Cohort data |
| Cacheable fraction (80%) and `k_cache` (0.10) | **Assumption.** Provider-dependent; caching may not exist. | None | Provider terms |
| Truncation savings (§5.1) | **Derived** from token assumptions | Structure high, magnitude low | Recompute on measured tokens |
| Ratios in `BIZ-258` | **Derived**, and robust to rate changes that preserve the tier spread | Moderate | Recompute |
| Prices and allowances (§6.1) | **Hypothesis** (`BIZ-040`), not validated with a customer | None | Willingness-to-pay research (`BIZ-092`) |

`BIZ-270` The whole model must be recomputed, not adjusted, at each of these points: when
a provider and tier are chosen (`Q-10`); when the first 100 real conversations exist; when
prices are set; before any allowance is published; and at each provider rate change.
`BIZ-093` makes this a precondition for the negotiation slice.

## 8. Cost-control design consequences

`BIZ-271` Consequences that fall out of the model above and are already reflected in the
architecture:

| Finding | Consequence | Anchor |
|---|---|---|
| A conversation's cost varies ~40x, and the customer pays a flat rate | The operator carries the spread; metering must be internal and continuous | `BIZ-052`, `NFR-006` |
| Cost grows with the square of conversation length | Turn caps and history truncation are correctness features, not tuning | `G-13`, `BIZ-262` |
| Premium routing destroys the margin | Tier degradation before service degradation, service degradation before failure | `AI-034`, `ARCH-014` |
| An adversary can drive conversation length at will | Budgets are a security control, layered per session, listing and seller | `T-04`, `SEC-010` |
| The buyer surface is public and enumerable-adjacent | Cheap static preview must be separable from expensive chat | `SEC-012`, `T-03` |
| Enhancement is 1/77th of a negotiation | Do not spend engineering effort optimising enhancement cost | `LIST-068` |
| Image serving rivals conversation cost per listing | Derivatives and dimension caps are required, not optional | `BIZ-259` |

## 9. Metering and cost-control requirements

`OPS-400` – `OPS-449`. These are product requirements. A cost control that exists only in
an infrastructure dashboard is not a control.

### 9.1 Measurement

| ID | Requirement |
|---|---|
| `OPS-400` | Every model call writes an `AIInteraction` row: purpose, tier, model identifier, input tokens, cached input tokens, output tokens, computed cost, latency, outcome, listing id, conversation id, seller id, policy version. |
| `OPS-401` | Cost is attributable per seller, per listing, per conversation and per work unit from `BIZ-252`, without a join through log aggregation (`NFR-006`). |
| `OPS-402` | Cached and uncached input tokens are recorded separately, so cache hit rate is a first-class metric and the `BIZ-262` lever is measurable rather than assumed. |
| `OPS-403` | Non-model costs - image storage bytes, served bytes, notification counts - are attributed per seller and per listing on the same cadence. |
| `OPS-404` | Cost per conversation, per negotiation, per active listing and per seller-month is on an operator dashboard from the first day a buyer conversation is possible, not added later. |
| `OPS-405` | The conversation-length distribution is recorded, not just the mean. The tail is the cost, and a mean conceals it. |
| `OPS-406` | Escalation share (`s_esc`) is measured per seller and in aggregate, since it is the assumption with the largest unmeasured effect on the model. |
| `OPS-407` | Recorded costs reconcile against the provider's invoice monthly. Unexplained variance above 5% is an incident, because it means the meter is wrong and every figure derived from it is wrong. |

### 9.2 Budgets and enforcement

| ID | Requirement |
|---|---|
| `OPS-410` | Budgets are enforced at every layer of `SEC-010`: per buyer session, per conversation, per listing, per seller-month, and globally. All of them, not the most convenient one. |
| `OPS-411` | A per-conversation turn cap and a per-conversation cost ceiling exist and are enforced by the guardrail engine (`G-13`), not by the model and not by a prompt instruction. |
| `OPS-412` | Budget checks run **before** the model call, never after. A call that has already been billed cannot be prevented. |
| `OPS-413` | On budget breach the order is fixed and non-negotiable: degrade the tier, then enter holding mode, then hand the conversation to the seller (`AI-034`, `ARCH-014`). The system never fails closed on a buyer and never silently drops a message (`NFR-003`). |
| `OPS-414` | A global cost circuit breaker exists, is testable, and is exercised in CI (`PUBLIC_ACCESS_SECURITY.md` §8, "Cost breaker"). |
| `OPS-415` | Plan allowances (`BIZ-040`) are enforced in code as entitlements, with the cap behaviour of `BIZ-042`: warn at 80% and 100%, never terminate an in-flight negotiation, never open a new conversation past a hard stop. |
| `OPS-416` | Overage is opt-in, never retroactive, never silent, and always subject to an absolute ceiling (`BIZ-044`, `BIZ-045`). |
| `OPS-417` | An anomalous single conversation - turn count or cost beyond a configured multiple of the median - raises an operator alert independently of whether any budget was breached. This is the abuse tripwire (`RISK-07`). |
| `OPS-418` | Budget state is per tenant. One seller's spend can never degrade another seller's service (`NFR-007`, `SEC-030`). |

### 9.3 Cost-reducing implementation requirements

| ID | Requirement |
|---|---|
| `OPS-420` | Context assembly builds a prefix-stable prompt: fixed system content and approved facts first, volatile conversation content last, so a cache prefix is possible at all. This is an architectural requirement on Module 10 and cannot be retrofitted cheaply. |
| `OPS-421` | Conversation history is truncated beyond a configured turn count and replaced with a rolling summary that preserves every stated offer, condition and commitment. Truncation must never cause the agent to lose a fact and invent a replacement (`G-05`, `AI-002`). |
| `OPS-422` | Truncation and summarisation changes are AI behaviour changes and require evals before merge (`EVAL_STRATEGY.md`). A cost optimisation that degrades offer extraction is a defect, not a saving. |
| `OPS-423` | Images are stored and served as bounded derivatives with dimension and byte caps. Originals are never served to the buyer surface (`BIZ-259`). |
| `OPS-424` | Identical enhancement input for the same listing and tone returns the stored result rather than re-calling (`LISTING_ENHANCEMENT.md` §10). |
| `OPS-425` | Summarisation and other non-interactive work uses the provider's batch path where one exists, and never runs on a buyer's critical path (`AI-031`). |
| `OPS-426` | Tier routing is deterministic and pre-model (`AI-032`). Tier selection is never itself a model decision, so it can be reasoned about, budgeted and tested. |
| `OPS-427` | The static listing preview is served independently of the conversation backend, with its own generous rate limit, so the cheap surface does not carry the expensive surface's cost or limits (`SEC-012`). |

### 9.4 Governance

| ID | Requirement |
|---|---|
| `OPS-440` | This model is recomputed, not adjusted, at every trigger in `BIZ-270`. |
| `OPS-441` | A provider rate change, a tier change, a routing-rule change or a prompt change that alters token volume requires the affected §4 and §6 tables to be regenerated in the same change. |
| `OPS-442` | Gross margin at cap usage is reported monthly per tier against the §6.2 model. Sustained divergence beyond 10 points is treated as a pricing or allowance defect, not a cost surprise. |
| `OPS-443` | No allowance or price is published externally until it has been recomputed against real rates (`BIZ-093`). |
| `OPS-444` | Per-seller cost is not exposed on any seller-facing surface at FREE, RESELLER or PRO (`BIZ-021`, `BIZ-022`). Operator dashboards are internal. |
