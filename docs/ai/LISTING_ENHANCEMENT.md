# Listing Content Enhancement

**Status:** Canonical for the listing-content enhancement feature.
**Authority:** Subordinate to `product/MASTER_PRODUCT_SPEC.md` for scope and to
`ai/POLICY_AND_AUTHORIZATION.md` for anything concerning AI authority. Where this
document and `architecture/STATE_MACHINES.md` §8 touch, the state machine wins.

---

## 1. What this feature is, and what it replaces

This feature improves the **presentation** of copy the seller has already written. It
is the whole of the AI's involvement in listing content.

It **replaces** the earlier concept of automatic listing generation (`R-05`, superseded
by decision `D-12`). There is no path in this product by which a listing, a product
identity, a specification, a condition grade or a price is produced from photographs,
from a model's world knowledge, or from anything other than the seller's own input.

`LIST-030` Enhancement is a transformation of seller-supplied text. It is never a
source of product fact (`INV-12`, `INV-13`).
`LIST-031` Enhancement is optional. A seller may approve their original text unchanged
and reach `READY` without ever invoking the model (`SM-CT-01`, `SM-CT-04`).
`LIST-032` Enhancement operates on one listing's content at a time. It never reads
another listing, another seller's content, market data, or any external source.

## 2. What the seller supplies

The seller's input is the **only** source of product truth. Every field below is
optional except the title.

| Field | Required | Type | Notes |
|---|---|---|---|
| `title` | Yes | short text | The only mandatory field. A listing cannot exist without one. |
| `name` | No | short text | What the seller calls the item. |
| `brand` | No | short text | As the seller states it. Never normalised against a brand list. |
| `model` | No | short text | As the seller states it. Never expanded to a fuller designation. |
| `size` | No | short text | Free text: the seller's own units and phrasing. |
| `colour` | No | short text | |
| `condition` | No | enum + free text | Enum drawn from the ladder in §6.4. Free text is not overwritten by the enum. |
| `included_items` | No | list | What is in the box, as the seller lists it. |
| `defects` | No | list / free text | Faults, damage, wear, missing parts. |
| `age` | No | short text | "about a year", "bought 2023" — the seller's own precision. |
| `usage_history` | No | free text | How it was used. |
| `specifications` | No | key/value list | Only values the seller typed. |
| `summary` | No | free text | Short buyer-facing blurb. |
| `description` | No | free text | Long buyer-facing copy. |

`LIST-033` Each supplied value is persisted as a `ProductFact` with provenance
`SELLER_PROVIDED_FACT`. An unsupplied field produces no `ProductFact`; absence is a
first-class state, not a gap to be filled (`D-10`).
`LIST-034` Enhancement receives only the fields above plus the seller's tone preference.
It receives no price, no policy value, no image, no analytics and no other listing.
`LIST-035` Images are presentational (`LIST-009`, `D-11`). No image is passed to the
enhancement call and no image-derived statement may appear in enhanced copy.

## 3. What enhancement may change

| Permitted change | Meaning |
|---|---|
| Grammar | Agreement, tense, articles, sentence construction. |
| Spelling | Misspellings and typographic errors, subject to §6.2. |
| Punctuation and capitalisation | Sentence case, terminal punctuation, list punctuation. |
| Clarity | Rewording a sentence so it says the same thing more plainly. |
| Organisation | Ordering, grouping, splitting a wall of text into paragraphs or bullets. |
| Readability | Sentence length, removing repetition, removing filler. |
| Tone | Applying the seller's chosen tone (`neutral`, `friendly`, `professional`, `brief`). |
| Concision | Saying the same facts in fewer words. |
| Formatting | Headings, bullets, whitespace, consistent field labels. |
| Buyer-facing presentation | Turning notes-to-self phrasing into copy addressed to a reader. |

## 4. What enhancement may not do

`LIST-036` Enhancement may not **introduce, alter, infer, sharpen or imply** any product
fact. The five verbs are all prohibited and are distinct failure modes.

| Prohibited | Definition | Signature in output |
|---|---|---|
| Introduce | A fact appears that the seller never supplied. | New number, unit, capacity, size, dimension, year, brand, model, accessory. |
| Alter | A supplied fact is changed. | "2019" becomes "2020"; "seats six" becomes "seats eight". |
| Infer | A fact is derived from another fact or from world knowledge. | "PS5" becoming a specific hardware revision; a brand implying a model line. |
| Sharpen | A vague supplied fact becomes more precise. | "about a year" becoming "12 months"; "good" becoming "excellent"; "cables" becoming "original cables". |
| Imply | Wording suggests a fact without stating it. | "still under warranty" from an age; "barely used" from "used for around a year". |

`LIST-037` Enhancement may not soften, relocate or omit a supplied defect. A defect
stated by the seller must remain a defect statement of equal prominence.
`LIST-038` Enhancement may not add price, availability, urgency, scarcity, delivery,
shipping, trade, warranty, authenticity or return statements. Those are policy, not
copy, and are governed by `SellerPolicyVersion`.
`LIST-039` Enhancement may not add marketing superlatives that function as factual
claims ("rare", "collector's item", "hard to find", "mint", "flawless").
`LIST-040` Where the seller's input is ambiguous, enhancement preserves the ambiguity.
It does not resolve it, and it does not ask the model to guess.

## 5. Worked examples

### 5.1 The canonical example — games console

**Seller input**

> PS5 used for around a year. Good condition. Comes with controller and cables.

**Allowed output**

> PlayStation 5 in good condition, used for around a year. Comes with a controller and
> cables.

Every fact is unchanged: the item as the seller named it, the condition word the seller
chose, the age with the seller's own vagueness intact, the accessories as listed. Only
the prose improved.

**Forbidden output**

> 2023 PlayStation 5 Slim Disc Edition with 1TB SSD, used lightly for 12 months.
> Excellent condition. Includes the original DualSense controller and all cables.

| Fabrication | Class | Validator that catches it |
|---|---|---|
| "2023" | Introduce (year) | V-01 numeric token |
| "Slim", "Disc Edition" | Infer (model line) | V-03 model-like token |
| "1TB SSD" | Introduce (capacity + unit) | V-01, V-05 |
| "12 months" | Sharpen (vague age made precise) | V-01 |
| "Excellent" | Sharpen (condition escalation) | V-04 |
| "original", "DualSense", "all cables" | Sharpen + introduce | V-06, V-02, V-07 |

### 5.2 Clothing — an unstated size appears

**Seller input**

> Womens wool coat, camel colour, worn a couple of winters, no holes or stains.

**Allowed output**

> Women's wool coat in camel. Worn for a couple of winters. No holes or stains.

**Forbidden output**

> Women's camel wool coat, size M. Worn for two winters and still in excellent shape,
> with no holes or stains.

The violation is quiet. `size M` was never supplied — the model has inferred a plausible
size from nothing (V-02/V-05). "two winters" sharpens "a couple of" into a count
(V-01). "excellent shape" is a condition claim the seller never made (V-04).

### 5.3 Furniture — a defect softened and a material sharpened

**Seller input**

> Oak dining table, seats six, scratches on the top.

**Allowed output**

> Oak dining table that seats six. There are scratches on the top.

**Forbidden output**

> Solid oak dining table seating six to eight, with minor surface scratches on the top.

"Solid oak" upgrades an unqualified material word into a construction claim (V-02).
"six to eight" introduces a number the seller did not give (V-01). "minor surface"
downgrades a stated defect, which `LIST-037` forbids outright (V-08). None of the three
would be visible to a seller skim-reading an otherwise better-written paragraph — which
is the reason validation is code and not a matter of taste.

### 5.4 Bicycle — a brand upgraded to a model line

**Seller input**

> Trek hybrid bike, 2019, ridden lightly, comes with lights and a lock.

**Allowed output**

> Trek hybrid bike from 2019, lightly ridden. Comes with lights and a lock.

**Forbidden output**

> 2019 Trek FX 2 Disc hybrid, lightly ridden, in very good condition. Includes the
> original lights and a lock.

"FX 2 Disc" is a specific model line inferred from a bare brand (V-03). "very good
condition" invents a grade where the seller stated none (V-04). "original" attaches a
provenance claim to the accessories (V-06).

### 5.5 Phone — a capacity appears and accessories acquire provenance

**Seller input**

> iPhone, black, unlocked, battery still good, comes with cables.

**Allowed output**

> Unlocked iPhone in black. The battery is still good. Comes with cables.

**Forbidden output**

> Unlocked iPhone 13 Pro, 128GB, in black. Battery health is still excellent. Includes
> the original Apple charging cable.

"13 Pro" is an inferred model (V-03). "128GB" is an introduced capacity with a unit
(V-01, V-05). "Battery health" converts a colloquial statement into a device metric,
and "excellent" escalates it (V-04). "original Apple charging cable" turns "cables"
into a specific, first-party, singular accessory (V-06, V-07).

### 5.6 Reading of these examples

`LIST-041` The forbidden outputs above are all *better copy*. That is the point. The
feature is not defended by asking the model for restraint, and it is not defended by a
seller noticing. It is defended by §7.

## 6. Provenance and versioning

### 6.1 Versions

Enhancement produces a new `ListingContentVersion`. It never edits one.

| Version kind | Provenance | Buyer-visible |
|---|---|---|
| Original seller input | `SELLER_PROVIDED_FACT` | No |
| Model output | `AI_ENHANCED_COPY` | No |
| Seller-edited model output | `AI_ENHANCED_COPY` until approved | No |
| Approved copy | `SELLER_APPROVED_COPY` | Yes |

`LIST-042` Every version records `source_version_id`, so any approved copy can be traced
back to the exact seller input it came from.
`LIST-043` Restoring the original creates a **new version** carrying the original text.
It does not delete the enhanced version and does not mutate history (`SM-CT-02`).
`LIST-044` Exactly one version per listing is approved and buyer-visible at any time
(`SM-CT-01`). Only that version feeds the buyer-safe projection and the agent's context
(`SM-CT-03`, `DM-10`).
`LIST-045` `ProductFact` rows are derived from the seller's input version, never from
enhanced text. Enhanced text can never create a fact the agent may cite under `G-05`.

### 6.2 State

The content lifecycle is specified in `architecture/STATE_MACHINES.md` §8 and is not
restated here. The states this feature drives are `ENHANCEMENT_PENDING`, `ENHANCED`,
`ENHANCEMENT_FAILED`, `SELLER_EDITED`, `SELLER_DRAFT` (on restore) and `APPROVED`.

### 6.3 Diff

`LIST-046` The seller always sees a field-by-field diff of original against enhanced,
with insertions and deletions marked. Validator warnings are attached inline to the
span that produced them.

### 6.4 Condition vocabulary ladder

The ladder is data owned by deterministic code, not by the prompt. Ranks are ordered;
comparison is by rank, not by string.

| Rank | Terms |
|---|---|
| 0 | for parts, not working, spares or repair |
| 1 | poor, heavily worn, damaged |
| 2 | fair, well used, worn |
| 3 | used, pre-owned, second hand |
| 4 | good |
| 5 | very good |
| 6 | excellent, like new, as new, barely used, hardly used |
| 7 | mint, pristine, flawless, immaculate |
| 8 | new, brand new, unused, sealed, unopened |

`LIST-047` A term at rank *n* in the seller's input may be restated at rank *n* only.
Any output term of higher rank is a validation failure. Lower-rank restatement is also
a failure, because it alters a supplied fact in the other direction.

## 7. The enhancement call

### 7.1 Structured output contract

`LIST-048` The enhancement call uses structured output. Free prose is not an acceptable
return shape, because prose cannot be compared field-to-field against the input.

```
EnhancementResult {
  title:            string
  summary:          string | null
  description:      string | null
  detail_fields:    [ { key: string, value: string } ]
  changes:          [ { field: string,
                        kind: GRAMMAR | SPELLING | PUNCTUATION | CLARITY
                            | ORGANISATION | READABILITY | TONE | CONCISION
                            | FORMATTING,
                        note: string } ]
  dropped_input:    [ string ]     // seller text deliberately not carried through
  ambiguous_spans:  [ string ]     // input the model found unclear and left alone
}
```

Constraints enforced by the response schema itself:

| ID | Constraint |
|---|---|
| LIST-049 | `detail_fields` keys must be a subset of the keys the seller supplied. New keys are a schema violation. |
| LIST-050 | There is no confidence field, no `inferred` field and no `suggested_*` field. The shape offers nowhere to put a guess. |
| LIST-051 | Every entry in `changes` must name a `kind` from the permitted list in §3. There is no `kind` that describes adding information. |
| LIST-052 | `ambiguous_spans` is how the model reports uncertainty. Resolving an ambiguity is never permitted; reporting it is. |

### 7.2 Deterministic post-validation

`LIST-053` Before any enhanced text is shown to the seller, it passes through a
validator that is **ordinary deterministic code**: a pure function
`validate(original_input, enhancement_result) → { verdict, findings[] }`, with no model
call, no network and no clock.

This is the control. The prompt also states the rules, but a rule written into a prompt
is a suggestion, not a control (`CLAUDE.md` engineering rules, `D-05`). The validator is
what makes `INV-13` true.

| ID | Check | Rule | Verdict on breach |
|---|---|---|---|
| V-01 | Numeric token comparison | The multiset of normalised numeric tokens in the output must be a subset of the input's. Numerals and number words are normalised to one form, so "six" and "6" compare equal. | FAIL |
| V-02 | Named-entity comparison | Proper nouns and brand-like tokens in the output must appear in the input, case-insensitively, after removing sentence-initial capitalisation and an allowlist of ordinary capitalised English words. | FAIL |
| V-03 | New model-like token | No output token may match the model-designator shape (mixed letters and digits, e.g. `FX2`, `A2342`) or appear in the maintained trim/edition lexicon (`Pro`, `Max`, `Plus`, `Slim`, `Edition`, `Series`, `Mk`, `Gen`) unless that exact token is in the input. | FAIL |
| V-04 | Condition escalation | Every condition term in the output must sit at the same ladder rank (§6.4) as the corresponding input term. A condition term with no input counterpart is a breach. | FAIL |
| V-05 | Unit and measure insertion | No output token may carry a unit (`GB`, `TB`, `MB`, `mm`, `cm`, `m`, `in`, `"`, `ft`, `kg`, `lb`, `L`, `mAh`, `W`, `V`, `MP`, `Hz`) unless present in the input. | FAIL |
| V-06 | Provenance and completeness qualifiers | No output use of `original`, `genuine`, `authentic`, `OEM`, `official`, `boxed`, `sealed`, `complete`, `full set`, `all`, `every` unless present in the input. | FAIL |
| V-07 | Included-item set | The set of included items in the output must equal the input set. No addition, no split of one item into several, no quantity that was not supplied. | FAIL |
| V-08 | Defect integrity | Every input defect must have a corresponding output statement of the same polarity and no softening qualifier absent from the input (`minor`, `slight`, `barely`, `hardly`, `only`). Negations (`no holes`, `not working`) must survive intact. | FAIL |
| V-09 | Expansion bound | Output length per field must not exceed a configured multiple of the input length (default 1.6x, with a small absolute allowance for very short input). Unbounded expansion is the shape invention takes. | FAIL |
| V-10 | Policy-domain language | No output mention of price, availability, delivery, shipping, collection terms, trades, warranty, returns, authenticity or urgency. These belong to policy, not copy. | FAIL |
| V-11 | Coverage | Every input field carried into the output must still be represented; silent loss of a supplied fact is reported. | WARN |
| V-12 | Change-log consistency | Every span the diff shows as changed must be accounted for by an entry in `changes`. An unexplained rewrite is suspicious even when V-01 to V-10 pass. | WARN |

`LIST-054` Verdicts: `PASS` (no findings), `PASS_WITH_WARNINGS` (WARN only — shown to
the seller with the warnings attached to the relevant spans), `FAIL` (any FAIL finding).
`LIST-055` A `FAIL` triggers one automatic regeneration with the failing check ids and
the offending spans supplied as reason codes. At most two attempts in total. A second
`FAIL` moves the version to `ENHANCEMENT_FAILED`.
`LIST-056` The validator's findings are persisted against the `AIInteraction` row
whatever the verdict, including on `PASS`, so the false-negative rate can be measured
against production data rather than assumed.
`LIST-057` The validator is not advisory. There is no override that lets failing output
reach the seller as enhanced copy.

### 7.3 Why this ordering matters

`LIST-058` Validation runs **before the seller sees the result**, not after they approve
it. A seller shown a fluent, fabricated paragraph is being asked to spot a lie in text
that reads better than their own. Review is a second line of defence, never the first.

## 8. Seller review contract

`LIST-059` The seller has exactly four actions on an enhanced version.

| Action | Effect | Resulting state |
|---|---|---|
| Accept | Approves the enhanced text as written. | `APPROVED` |
| Edit | Seller modifies the enhanced text, then approves it. Seller edits are not validated against §7.2 — the seller is the source of truth and may state any fact they wish. | `SELLER_EDITED` → `APPROVED` |
| Reject | Discards the enhanced version for approval purposes; it remains in history. | `SELLER_DRAFT` |
| Restore original | Creates a new version carrying the original text (`LIST-043`). | `SELLER_DRAFT` |

`LIST-060` Only `SELLER_APPROVED_COPY` reaches the buyer surface, the marketplace copy
block (`BUYER-023`) or the agent's context (`LIST-008`, `SM-CT-03`).
`LIST-061` Enhanced-but-unapproved text is never buyer-visible, under any state, for any
reason, including while an approval is pending.
`LIST-062` Approving content writes `LISTING_CONTENT_APPROVED`; the enhancement call
itself writes `LISTING_CONTENT_ENHANCED`.

## 9. Failure handling

| Failure | System behaviour | What the seller sees |
|---|---|---|
| Model provider unavailable or times out | Retry with backoff, then fail the job | "We couldn't improve this text just now. Your original is saved and you can publish it as it is, or try again." |
| Malformed or schema-invalid output | Up to 2 deterministic retries, then fail | Same as above |
| Validator `FAIL` after regeneration | Version moves to `ENHANCEMENT_FAILED` | "The suggested version changed details that weren't in what you wrote, so we've discarded it. Your original is unchanged." Optionally, the specific finding: "It described the condition as *excellent* — you wrote *good*." |
| Validator `PASS_WITH_WARNINGS` | Result is shown with warnings inline | The diff, with a flag on the affected span |
| Cost or rate budget exceeded | Job queued or refused | "Enhancement is temporarily unavailable. You can publish your original text." |

`LIST-063` Enhancement failure never blocks the listing. The seller's original text is
always publishable (`LIST-031`).
`LIST-064` Failure is a **visible, recoverable state** (`SM-CT-04`). The system never
returns the seller's own unmodified text labelled as enhanced, and never silently skips
enhancement while reporting success.
`LIST-065` No buyer is ever affected by an enhancement failure, because nothing
unapproved is buyer-visible.

## 10. Cost posture

`LIST-066` Enhancement is a **cheap, low-frequency, non-interactive** call. It is not on
any buyer's critical path.

| Property | Value |
|---|---|
| Model tier | Cheap tier. Grammar, clarity and reorganisation of a few hundred words is not a frontier task. |
| Escalation | None. A cheap-tier failure is a validation failure and is handled by §9, not by retrying at a higher tier — the failure mode is fabrication, and a larger model fabricates more fluently, not less. |
| Frequency | Once per content version. Not per page view, not per buyer session, not per agent turn. |
| Trigger | Explicit seller request only. Never automatic on save, never on a timer. |
| Latency budget | Interactive but tolerant: a few seconds, run in the worker pool (`ARCH-010`) with a progress state, never blocking a request handler. |
| Batching | Bulk enhancement of several drafts uses the provider's batch path where available. There is no latency requirement for a queued bulk job. |
| Metering | Each call writes an `AIInteraction` row with purpose `enhancement`, tokens, cost and validator verdict, so per-seller cost is attributable (`NFR-006`). |
| Caching | Identical input for the same listing and tone returns the stored result rather than re-calling. |

`LIST-067` The specific model and tier are a later decision, recorded when the stack is
chosen (`D-08`). No document may name a provider as a requirement.
`LIST-068` Expected cost per listing is a fraction of the conversation cost for the same
listing. If it is not, the implementation is wrong: the prompt is carrying context it
does not need.

## 11. Required evals

Specified in `ai/EVAL_STRATEGY.md`, suite **LISTING ENHANCEMENT** (`LE-01` to `LE-12`).
Not duplicated here. Enhancement changes — prompt, schema, validator, tier — are covered
by the blocking suite and may not merge without it passing (`CLAUDE.md` engineering
rules).

## 12. Open questions

| ID | Question |
|---|---|
| `Q-LE-01` | Whether the seller may enhance a single field in isolation, or only the content version as a whole. |
| `Q-LE-02` | Whether the trim/edition lexicon in V-03 is maintained manually or derived from an allowlist per category, and who owns it. |
| `Q-LE-03` | Whether `PASS_WITH_WARNINGS` should require an explicit seller acknowledgement of each warning before approval. |
| `Q-LE-04` | The default expansion bound in V-09, which needs calibration against real seller input rather than a guess. |
