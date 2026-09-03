# Recruitment plan

How sellers and buyer-test participants are found, screened, identified and protected
from bias. Nothing here contacts anyone through a marketplace's own messaging on the
founders' behalf, buys traffic, or promises any outcome (`INT-060`, `BIZ-072`,
`BIZ-160`). The cohorts are defined in `README.md` §2a.

## 0. Recruitment targets and buffers

Recruiting exactly the minimum does not produce the minimum completed sample. The
targets below add a buffer on stated planning assumptions. The assumptions are
placeholders to be replaced by the run's own counts at the week-3 checkpoint
(`EXECUTION_SCHEDULE.md`); they are not findings. When a target is missed, extend
outreach; never lower eligibility, never re-label a participant into another cohort, and
never drop a completed record.

| Cohort | Minimum completed | Planning assumption (placeholder) | Recruit or plan for | Rule |
|---|---|---|---|---|
| Structured seller interviews `SI-###` | 20 completed | About 1 in 3 outreach contacts reply; about half of those screened are eligible; about 5 in 6 booked interviews complete | 70 to 80 outreach contacts → about 24 booked → 20 completed | Stop booking only when 20 interviews are complete per `SELLER_INTERVIEW_SCRIPT.md` §12 |
| Workflow sellers `SW-###` | 5 enrolled with 2 completed workflows each; at least 3 non-founder | About 3 in 5 eligible interviewees with items agree to workflows; about 4 in 5 complete both | Enrol 7 workflow sellers, at least 5 non-founder, from the interview cohort | A workflow seller who completes only one workflow stays enrolled and their one workflow stays in the denominator |
| Listing workflows `WF-###` | 10 non-excluded | 7 sellers × 2 = 14 started; a few excluded or abandoned | Plan 14 workflows | Exclusion only per `SLICE_0_SCORECARD.md` §6 |
| Founder-item experiment `FI-###` | 15 to 20 items | Canonical; founders' own items | 20 items, arms assigned before publication | Not a workflow; never a `WF-###` |
| Moderated buyer sessions `BM-###` | 20 completed | About 1 in 4 booked participants do not attend or do not complete | Book 26 to 28 sessions | A session stopped by the participant is complete for M-11 and counts |
| Real buyer contacts `RC-####` | 100 confirmed exposed | Unknown; the placeholder is 3 to 8 contacts per live listing over its window | 25 to 30 live listings (10 to 14 workflow listings plus 15 to 20 founder items); week-3 checkpoint adds founder items if the pace is short | Exposure and attribution per `SLICE_0_SCORECARD.md` §1a; unconfirmed contacts are logged, not counted |

## 1. Seller eligibility

A seller is **eligible for a structured interview** (`SI-###`) when E-1, E-3 and E-5 hold
and no exclusion rule in §2 applies. A seller is **eligible as a workflow seller**
(`SW-###`) when all of E-1 to E-6 hold. Every workflow seller is interviewed once with
the full script before their first workflow, and that interview counts toward the 20 as
their linked `SI-###`; an interviewee without items to list is an `SI-###` only.

| # | Criterion | Why | Source |
|---|---|---|---|
| E-1 | Has sold at least 10 items on an online marketplace in the last 3 months, from their own account | Targets the side-hustle and full-time segments; excludes the casual declutterer | `MASTER_PRODUCT_SPEC.md` §3, `BIZ-002` |
| E-2 | Has at least 2 real items they intend to sell during the study window | Two real listing workflows per seller | Sample design |
| E-3 | Currently answers buyer messages themselves | The problem must be theirs to have | `PROD-001` |
| E-4 | Is willing to publish from their own account, on their own device, without sharing any credential | Credential prohibition | `INT-060` |
| E-5 | Is an adult and gives consent per `CONSENT_AND_PRIVACY_SCRIPT.md` | Ethics | `DATA-200` |
| E-6 | Sells in a category the study still needs to reach three categories, or any category once three are covered | At least 3 categories | Sample design |

**Non-founder requirement.** At least 3 enrolled workflow sellers are not founders, team
members, or immediate family of either. Founders and their households may enrol as
additional workflow sellers, labelled `relationship = founder` or `family`, on items that
are **not** part of the founder-item experiment; their workflows are reported separately
as well as in the total. A founder or family member enrolled as a workflow seller is
interviewed once like any other workflow seller (their linked `SI-###` supplies the
workflow baseline), but that interview is reported separately and is never one of the 20
structured interviews or in the M-17 denominator. If the non-founder count is under 3 at
the decision meeting, HS-09 applies.

## 2. Exclusion rules

| Rule | Exclude when | Reason |
|---|---|---|
| X-1 | The person sells primarily through a business storefront with staff who answer buyers | Different segment; not MVP |
| X-2 | The person expects the study to price their items or tell them what items are worth, after the disclosure that it will not | `D-09`; the study cannot deliver it and the expectation biases every answer |
| X-3 | The person cannot publish from their own account (shared or managed account) | E-4 |
| X-4 | The person is under 18, or consent cannot be given plainly | E-5 |
| X-5 | The person works for a marketplace, a competitor category in `POSITIONING.md` §4, or an investor in the company | Conflict of interest |
| X-6 | The person was recruited by promising a benefit the product will not deliver | Any such recruitment is itself an incident (`BIZ-160`) |

Exclusions are logged with the rule ID in the recruitment log (protected store). A person
excluded after enrolment keeps their participant ID; their rows are marked
`excluded = yes` with the rule, and their data is deleted per the consent script.

## 3. Buyer-test participant eligibility

Moderated buyer participants (`BM-###`, 20 completed) must: have bought a secondhand
item through an online marketplace in the last 12 months; own a phone they can use in the
session; not be a founder, team member or immediate family (buyer sessions run by family
are `relationship = family` and reported separately, never counted toward the 20); not
have seen the buyer page before the session; not be an interviewed or workflow seller in
this run. A moderated buyer session is not a structured interview and is never counted
as one.

Real buyer contacts (`RC-####`) are not recruited, not screened and not interviewed.
They are people who contacted a live listing on their own. They receive the pilot notice
on the page and nothing else is asked of them. Nobody is invited from a real contact into
any other cohort during the run.

## 4. Recruitment channels, low-cost

Ordered by expected yield for two founders with no budget. Every channel respects the
rules of the venue it uses; promotional posting where the venue forbids it is not
recruitment, it is an incident.

| # | Channel | How | Cost | Constraint |
|---|---|---|---|---|
| 1 | Founders' own network, second degree | Ask people who know resellers to make an introduction; never enrol the introducer's household as a non-founder | Time | Bias control B-1 |
| 2 | Local reseller and flea-market communities, in person | Attend, listen, ask for a conversation later | Time, travel | Do not pitch; ask about the problem first |
| 3 | Reseller forums and community groups, where their rules permit research requests | One post using the script in §5, in the venue's designated place for requests | Time | Read the venue's rules first and record that you did |
| 4 | Sellers the founders have themselves bought from, contacted **outside** the marketplace after a completed purchase, only where the seller shared an off-platform contact voluntarily | Direct message via the contact the seller chose to share | Time | Never through the marketplace's messaging for recruitment (`INT-060`) |
| 5 | Reseller creators, asking for an introduction to their audience rather than paid promotion | Email | Time | No affiliate or payment |

**Do not:** pay participants beyond a small thank-you gesture stated up front (see
consent script §7); advertise; message strangers inside a marketplace to recruit; recruit
buyers by contacting people who messaged a validation listing.

## 5. Outreach scripts

Plain text. No claim from `BIZ-160`: no "sells faster", no "knows what it is worth", no
"works with [marketplace]", no "AI closes the deal", no "hands-free".

**Seller outreach (message or in person)**

> Hi [name], I'm [founder]. Two of us are studying how people who sell regularly on online
> marketplaces handle buyer messages and offers, before we build anything. It is not a
> sales pitch and there is nothing to buy. If you sell at least ten items a month and
> answer your own buyer messages, I'd like to spend about an hour with you: a short
> conversation about how you sell today, and then trying a hand-run version of a workflow
> on two real items you are selling anyway. You keep full control of your listings and
> your account; we never ask for a password or post on your behalf. If you're open to it,
> reply and I'll send the details and a plain-language consent note.

**Community post (only where the venue allows research requests)**

> Research request, not a promotion. Two founders are looking for people who sell 10+
> items a month on online marketplaces and answer their own buyer messages, for a
> one-hour study on how buyer conversations and offers are handled today. No product to
> buy, no account to create, no marketplace login ever requested. Reply or DM me here if
> you're interested and I'll share the details.

**Buyer-test participant outreach**

> Hi [name], I'm [founder]. We're testing whether a page that a marketplace seller links
> to is clear and trustworthy for buyers. It takes about 25 minutes on your phone, you use
> a real listing, and you can stop at any time. Nothing is bought or paid for. A person,
> not a computer, answers the messages during the test, and I'll tell you exactly what we
> record before we start.

## 6. Screening questions

Asked before consent, answers recorded in the recruitment log. Open questions first,
categorical questions last, so the answer to E-1 is not suggested by the question.

| # | Question | Purpose |
|---|---|---|
| SQ-1 | Where do you sell online at the moment, and roughly how much have you sold in the last three months? | E-1, channel mix |
| SQ-2 | Who answers buyer messages for your listings? | E-3 |
| SQ-3 | What kinds of items do you usually sell? | E-6, categories |
| SQ-4 | Do you have two or more items you plan to list in the next few weeks? | E-2 |
| SQ-5 | Would you be comfortable publishing a listing from your own account, on your own phone or computer, with one of us watching? We never ask for your login. | E-4 |
| SQ-6 | What are you hoping to get out of taking part? | X-2 detection; do not correct expectations yet, record them |
| SQ-7 | Do you work for, or have an interest in, an online marketplace or a tool for resellers? | X-5 |
| SQ-8 | Are you over 18? | E-5 |

After SQ-6, the founder states plainly: "To be clear about what this is not: nobody will
tell you what an item is worth or what to price it, and nothing will be sold for you
without your explicit decision." A participant who then withdraws is logged as X-2, not
as a refusal.

## 7. Bias controls

| ID | Bias | Control |
|---|---|---|
| B-1 | Friendly-sample bias: founders' friends over-report satisfaction | Relationship field on every seller; non-founder minimum of 3 workflow sellers; founders and family never counted among the 20 interviews; results reported by relationship group; a PASS cannot rest on founder or family rows alone (HS-09) |
| B-2 | Moderated buyers complete because they were asked to | Moderated sessions are never counted in the canonical funnel (M-09, M-19, M-20) and are never counted as interviews |
| B-3 | Founder as operator over-performs against the future system | Operator uses only the fact sheet and the playbook's allowed responses; improvisation is logged as M-14 manual intervention; the second founder reviews a sample of every conversation |
| B-4 | Survivorship: failed workflows dropped | `SLICE_0_SCORECARD.md` §6 exclusion rules; every exclusion listed in the memo |
| B-5 | Leading questions | Interview and buyer scripts use open, past-behaviour questions; hypotheticals come last and are labelled |
| B-6 | Category concentration | At least three categories; category recorded per workflow |
| B-7 | Channel concentration | Channel recorded per placement; the memo reports the share of contacts per channel |
| B-8 | Founder expectation | Scorecard fields are filled during the session, not reconstructed after; timings from a stopwatch log, not memory |
| B-9 | Seasonal or item-value effects | Item asking price band recorded (`price_band`), never a valuation |
| B-10 | Reporting bias in the memo | Both founders sign; the memo's evidence-completeness section is written before the result section |
| B-11 | Cohort drift: a participant re-labelled to fill a shortfall | Cohort is fixed at consent and recorded in the ID map; a change of cohort is an incident, not an edit; linked identifiers are the only permitted relationship |

## 8. Cohort identifiers and double-counting rules

1. Identifiers are assigned at consent (or at first contact for real buyers), in order
   within each series:

   | Series | Cohort | One per |
   |---|---|---|
   | `SI-001`, `SI-002`, … | Structured seller interview | Completed or attempted interview of one person |
   | `SW-001`, `SW-002`, … | Workflow seller | Enrolled seller running workflows |
   | `WF-001`, `WF-002`, … | Listing workflow | One real item of one workflow seller |
   | `FI-001`, `FI-002`, … | Founder-item experiment | One founder-owned item, with its arm |
   | `BM-001`, `BM-002`, … | Moderated buyer session | One participant's session |
   | `RC-0001`, `RC-0002`, … | Real buyer contact | One contact event on one live listing; no identity |
   | `EV-0001`, …; `INC-001`, … | Evidence item; incident | As before |

   Channels use the keys in `MARKETPLACE_STRATEGY.md` `INT-052`.
2. **Linked identifiers.** A workflow seller holds one `SW-###` and one linked `SI-###`
   (their single interview). The link is recorded once, in the ID map and in the
   `linked_si_id` field of their workflow rows. No other links exist: a moderated buyer is
   never a seller in this run; a real contact is never linked to any person.
3. **Counted once per denominator.** An interview enters interview metrics (M-02, M-17)
   once under its `SI-###`. A workflow enters workflow metrics once under its `WF-###`.
   A workflow seller's second workflow is the reuse observation for M-16 and is not a
   second seller. A founder-experiment item is never a workflow, so it never enters the
   workflow denominator; its contacts enter the real-buyer funnel like any other listing.
4. **Never moved.** A participant's cohort is fixed at consent. An interviewee who later
   agrees to run workflows receives a new `SW-###` linked to the existing `SI-###`; the
   interview record is not re-created. A workflow seller who withdraws before any
   workflow keeps their `SI-###` and their `SW-###` is marked `withdrawn = yes`. Nobody
   is re-labelled to fill a shortfall (B-11).
5. **Never excluded for the result.** An unfavourable interview, session or workflow is
   evidence. Exclusion follows `SLICE_0_SCORECARD.md` §6 only.
6. The **ID map** (identifier ↔ name, contact route, relationship, cohort, links) lives
   only in the protected store, in one file, readable by the two founders. It is never
   committed, never attached to a scorecard, never pasted into a memo. Every artefact
   that leaves the protected store carries identifiers only.
7. A real buyer contact `RC-####` is never linked to a name, a marketplace handle, a
   contact route or a device in any file. The row holds funnel events and nothing
   identifying. The optional pilot reply channel (OVQ-02) stays with the raw transcript
   only.
8. Deleting a participant means deleting their ID-map entry and their raw evidence; the
   scorecard row keeps its aggregate fields and gains `withdrawn = yes` (consent script
   §5).
