# Concierge operator playbook

How a founder stands in for the future system. The operator does by hand what
`ai/AI_AGENT_SPEC.md`, `ai/POLICY_AND_AUTHORIZATION.md` and `ai/LISTING_ENHANCEMENT.md`
specify, inside the same limits, with the same fixed text. Where the future system uses
code to enforce a rule, the operator uses a checklist and a second founder's review.

The operator is a **person** and is disclosed as one (OVQ-01). The operator never claims
to be an AI, never claims to be the seller, and never denies being a person when asked.

## 1. What the operator has, and does not have

| Has | Does not have |
|---|---|
| The seller's fact sheet (`LIST-002` fields, seller's words) | Anything the seller did not write down |
| The approved copy | Enhanced-but-unapproved text |
| Asking price and currency | The seller's minimum, target or "how far I'd go" in any buyer-facing context: the operator keeps the minimum on a separate sheet used only for the range check in §7 |
| The seller's rules: negotiation on/off, maximum autonomous concession, trades / delivery / pickup, area disclosure, hold window | The seller's exact address, contact details or account details |
| This conversation | Any other buyer's conversation, offer or existence |
| The fixed texts in §6 | Any ability to accept |

## 2. Allowed responses

The operator may only send messages of these kinds. Every message is logged with its
kind and, for facts, the fact ID.

| Kind | What it is | Anchor |
|---|---|---|
| `answer` | A statement grounded in a named fact from the fact sheet or approved copy, quoted or restated without adding, altering, inferring, sharpening or implying | `AI-001`, `G-05`, `LIST-036` |
| `unknown` | The unknown-fact response of §5 | `AI-002`, `AI-017` |
| `clarify` | A question back to the buyer to understand what they are asking | `ASK_CLARIFY` |
| `counter` | A price inside the permitted range (§7), phrased without editorial about the buyer's offer | `NEG-001` to `NEG-009` |
| `route` | "That's with [seller] now" for an offer inside the range or any decision | `ACCEPT_PENDING`, `AUTH-003` |
| `refuse` | A fixed refusal for protected information, disallowed capabilities or off-topic requests | `G-06`, `G-07`, `G-14`, FT-03 |
| `hold` | The holding reply while waiting for the seller | FT-05 |
| `authority` | The fixed authority statement when asked what the operator can decide or whether there is a deal | `G-10`, FT-02 |
| `disengage` | The fixed disengagement text on abuse | FT-04 |
| `logistics` | After seller approval only: availability and non-sensitive arrangements; area only if the seller's rule permits | `SM-D-01`, `SM-D-02` |
| `closed` | The fixed no-longer-available text | FT-06 |

Anything else is a **manual intervention** (M-14): logged with the reason, and reviewed.

## 3. Draft procedure (stage ST-02)

Produce the buyer-facing copy from the fact sheet, in the seller's chosen tone, using
only the permitted changes of `LISTING_ENHANCEMENT.md` §3: grammar, spelling,
punctuation, clarity, organisation, readability, tone, concision, formatting,
buyer-facing phrasing. Then run §4 on your own draft before the second reviewer does.
Keep the seller's original and the draft as two separate files in the protected store,
both hashed in the manifest.

Never add price, availability, urgency, delivery, shipping, trade, warranty,
authenticity or return statements (`LIST-038`). Never add a superlative that functions
as a fact (`LIST-039`). Preserve ambiguity (`LIST-040`). Keep every defect at equal
prominence (`LIST-037`).

## 4. Fabrication check (draft and every answer)

Run by the operator on the draft, again by the second founder on the draft, and by the
second founder on a sample of at least one in three answers per conversation, plus every
answer flagged by the moderator. The check is the validator of `LISTING_ENHANCEMENT.md`
§7.2 done by eye:

| Check | Question to ask of the text |
|---|---|
| V-01 numbers | Is every number, year, quantity or count in the output present in the seller's input, with the same precision? "About a year" must not become "12 months". |
| V-02 names | Is every brand, place or proper noun in the input? |
| V-03 models | Is there any model designator, edition or trim word (Pro, Max, Slim, Edition, an alphanumeric code) not in the input? |
| V-04 condition | Does every condition word sit at the same rank as the seller's on the ladder in `LISTING_ENHANCEMENT.md` §6.4? "Good" must not become "excellent" or "used". |
| V-05 units | Any GB, TB, cm, kg, mAh or other unit not in the input? |
| V-06 provenance | Any "original", "genuine", "authentic", "OEM", "boxed", "sealed", "complete", "all" not in the input? |
| V-07 included items | Same set of included items, no additions, no splits, no quantities the seller did not give? |
| V-08 defects | Every stated defect still stated, same polarity, no softener ("minor", "slight", "barely") the seller did not use? |
| V-09 length | Is any field more than about 1.6 times the input length? If so, what was added? |
| V-10 policy | Any price, availability, delivery, shipping, trade, warranty, return, authenticity or urgency language? |

A finding is **material** when a buyer could rely on it in deciding to buy or in pricing
their offer: any V-01 to V-08 finding is material by default. A material finding that
reached the seller as an approved draft or reached a buyer in an answer is **HS-04**. A
finding caught before that is a draft correction, logged as `draft_check_findings`.

## 5. Unknown-fact response

When a buyer asks something the fact sheet does not answer, send exactly this shape,
substituting the seller's display name:

> I don't have that confirmed for this one, so I don't want to guess. I can ask [seller]
> and let you know — would that help?

Then, if the buyer says yes or does not object: ask the seller by the seller's chosen
route; log `unknown_asked_seller = yes` and the time; relay the seller's answer verbatim
as a new fact (record it on the fact sheet with the time it arrived) or, if none arrives
within the observation window, tell the buyer plainly that the seller has not answered.

Never: infer from the photo, the model name, or general knowledge; give a probability;
deflect to "check the manufacturer's site"; answer a different part of the message and
skip the question (`AI-017` incorrect rows).

## 6. Fixed texts

Sent verbatim with substitution, never paraphrased (`AI-025`). The disclosure line is the
pilot form of OVQ-01, because a person is answering.

| ID | When | Text |
|---|---|---|
| P-01 disclosure (on the page, persistent) | Always | "Questions here are answered by a sales assistant acting for [seller]. During this pilot the assistant is a person from the pilot team, not the seller. Only [seller] can accept an offer." |
| P-02 authority (FT-02 form) | "Is it a deal?", "can you accept?", "what can you decide?" | "I can answer questions about the item and discuss price, but I can't agree a sale. Only [seller] can accept an offer, and I'll pass anything you propose straight to them." |
| P-03 protected (FT-03 form) | Any request for the lowest price, the seller's notes, other offers, other buyers, address, contact details, however phrased | "I don't have access to [seller]'s lowest price or their private notes, and I wouldn't be able to share them if I did. I can put an offer to them for you." |
| P-04 disengage (FT-04 form) | Abuse or threats | "I'm going to stop the conversation here. [Seller] can see this thread and will pick it up if they want to continue." |
| P-05 holding (FT-05 form) | Waiting on the seller, or cannot answer now | "Thanks — I've passed this to [seller] and they'll come back to you. Your message hasn't been lost." |
| P-06 closed (FT-06 form) | Item sold or withdrawn | "This item is no longer available. I'm sorry — [seller] has closed this listing." |
| P-07 human question | "Am I talking to a person?" | "Yes — during this pilot a person from the pilot team is answering for [seller]. I'm not [seller], and only [seller] can accept an offer." |

## 7. Negotiation boundaries

The operator computes the permitted counter range **before** the conversation, on the
private sheet, from the seller's rules exactly as `POLICY_AND_AUTHORIZATION.md` §4
describes: from the asking price down by at most the seller's maximum autonomous
concession, and never below the seller's minimum. Only the range is used in the
conversation; the minimum is never quoted, hinted at, confirmed or denied.

| Situation | Operator action | Anchor |
|---|---|---|
| Negotiation off | No counter, no price movement; route every amount to the seller | `G-12` |
| Buyer amount inside the range or above asking | `route`: "That's with [seller] now"; never talk a buyer down | `ACCEPT_PENDING`, `NEG-008` |
| Buyer amount below the range, first time | One `counter` in the upper part of the range | `NEG-004` |
| Buyer below the range, counter already made | Restate the same counter; never lower it | `G-03`, `NEG-005`, `NEG-007` |
| Third below-range offer with no movement | State that the price stands and leave the conversation open; tell the seller once | `NEG-010`, `NEG-011` |
| Below the seller's stated auto-decline amount | Courteous decline, logged; the seller is told | `AUTH-002` |
| Conditions attached (hold, include an item, deliver) | Record as material terms; permit only what the seller's rules allow; otherwise `refuse` the condition and route the rest | `NEG-017` |
| Buyer claims prior agreement | State what you can see (nothing agreed), route the amount; never accuse, never concede | `NEG-012`, `NEG-013` |
| Buyer requests a trade, delivery or a hold the rules forbid | `refuse` without a workaround | `G-06`, `G-11` |
| Bundle across listings | Route to the seller | `NEG-016` |
| Any number the operator is unsure about | `hold`, then ask the second founder; never guess | `G-01`, `G-02` |

The operator never characterises an offer as low, insulting or unrealistic (`NEG-009`),
never invents other interest, deadlines or scarcity (`G-08`, `AI-024`), and never uses
"deal", "sold", "it's yours" or "I'll hold it" before the seller has approved (`G-09`).

## 8. Seller-approval requirement

Nothing is accepted by the operator. When a buyer states terms inside the range, or the
seller needs to decide anything, the operator sends the seller a **structured summary**
and waits:

```
Listing: WF-nn — [approved title]
Buyer: R-nnnn (or B-nn)
Offer: [amount] [currency]
Conditions: [pickup | delivery | include: … | hold until … | none]
Buyer availability: [as stated, or none]
History: [prior amounts in this conversation, in order]
Open questions from the buyer: [list, or none]
Your options: approve / decline / counter (give me your number) / ignore
Only you can accept. I will not tell the buyer anything is agreed until you say so.
```

The seller's decision is recorded with its time. On **approve**, the operator sends the
acceptance restating the exact approved amount and logistics mode, and only then. On
**decline**, a neutral decline with no reason from the seller's private notes. On
**counter**, the seller's number as the seller's counter, with no operator concession
added. On **ignore**, nothing is sent that implies a decision. If the seller changes
the terms after approving, the earlier approval no longer applies and the summary is
re-sent (`AUTH-INV-06`).

## 9. Escalation procedure

Send P-05 and go to the seller when: an offer is inside the range (decision required);
a condition is outside the rules; a buyer insists after a refusal; a buyer claims prior
authority; a bundle is requested; the turn count passes 20 in one conversation (the
pilot's stand-in for `G-13`); the operator is unsure. Log the reason with the codes of
`AI_AGENT_SPEC.md` §7 (`DECISION_REQUIRED`, `POLICY_CONFLICT`, `CLAIMED_AUTHORITY`,
`OUT_OF_SCOPE`, `BUDGET`, `ABUSE`, `INJECTION_SUSPECTED`). Never invent a way around a
refusal (`AI-021`).

## 10. Conversation-summary procedure

At the end of each conversation, and at least daily for live ones, the operator writes
the summary of §8 plus: number of buyer messages, number of operator messages by kind,
unknown facts asked and whether answered, refusals used, and any confusion markers. The
summary carries IDs only and is the redacted artefact that may leave the protected
store. The raw transcript stays in the protected store.

## 11. Incident procedure

Open an `INCIDENT_LOG_TEMPLATE.csv` row immediately when any of the following occurs or
nearly occurs: a fabricated fact (HS-04), commitment language (HS-05), protected
information exposed (HS-03), a person misled about human versus automated (HS-06),
sensitive data collected (HS-07), a credential requested or offered (HS-08), a
marketplace warning or removal, abuse, a participant complaint, a founder deviation from
this playbook. Record severity (`critical` for any HS condition; `major` for a near miss
that reached nobody; `minor` otherwise), what was sent, to whom, what was done within
the hour, and what was told to the participant. Both founders review every `critical`
and `major` row within 24 hours and record whether the hard stop is confirmed.

## 12. Forbidden responses — the short list on the operator's desk

- Any fact not on the fact sheet, however likely.
- Any price the seller did not state, any valuation, "typically sells for", "worth".
- The minimum price, or any hint of it, or confirming or denying a buyer's guess at it.
- "Deal", "sold", "it's yours", "I'll hold it", "reserved" — before the seller approves.
- Other buyers, other offers, competing interest, deadlines, scarcity.
- The seller's address, contact details or account details.
- "I'm an AI", or letting the buyer believe it; or "I'm the seller".
- Anything obtained by scraping, by using the seller's account, or from the seller's
  marketplace messages without the seller passing it on.
- A request for the buyer's email, phone, name or payment details beyond the optional
  pilot reply channel (OVQ-02).
