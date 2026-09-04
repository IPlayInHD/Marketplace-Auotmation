# Slice 0 decision memo — TEMPLATE

**Status of this file:** template. It contains no result. Slice 0 has not produced a
decision until a completed copy of this memo, with both signatures, exists. That
completed memo is the artefact `PLAN-007` refers to. Fill every section; a section that
cannot be filled is a finding for §3.

Write §3 (evidence completeness) and §8 (bias and limitations) **before** §4 to §7 are
filled, and date them, so the completeness judgement is not made with the result in
view.

---

**Memo date:** ____ · **Study window:** ____ to ____ · **Notice version used:** ____
**Evidence manifest integrity check:** passed / failed on ____ (attach the record)

## 1. Executive summary

Three sentences at most: the decision (§11), the single number for each success unit
with its fraction, and whether any hard stop occurred.

## 2. Sample description

| Count | Number | Notes |
|---|---|---|
| Sellers recruited (received outreach) | | |
| Sellers screened | | |
| Sellers eligible | | |
| Structured seller interviews completed (`SI-###`, `relationship = none`) | | of which also workflow sellers ____ (linked `SW-###`); each person once; no buyer session counted; founder and family interviews ____ reported separately, not in this count |
| Workflow sellers enrolled (`SW-###`) | | of which non-founder ____, founder ____, family ____; every row has one linked `SI-###` |
| Workflows started (`WF-###`) | | |
| Workflows completed | | |
| Workflows excluded | | every exclusion listed in §2.1 |
| Workflows successful | | |
| Founder items published (`FI-###`) | | arms: listing_body ____ / reply_only ____ / phone_control ____; none in the workflow denominator |
| Categories represented | | list |
| Channels used | | keys and counts |
| Real buyer contacts logged (`RC-####`) | | events on listings, not people; no identity held |
| Real buyer contacts, confirmed exposed (M-19 denominator) | | by basis: body_visible ____ / sent_in_reply ____ (`SLICE_0_SCORECARD.md` §1a) |
| Real buyer contacts, exposure unconfirmed (excluded from M-19) | | of which phone_control ____, not_unrecruited ____ |
| Moderated buyer sessions completed (`BM-###`) | | booked ____; of which family ____ (reported separately); none counted as an interview or a real contact |

### 2.1 Excluded workflows

| Workflow | Reason (per `SLICE_0_SCORECARD.md` §6) | Decided before outcome known | Decided by | Date |
|---|---|---|---|---|
| | | | | |

## 3. Evidence completeness (write before results)

| Requirement | Met | Evidence |
|---|---|---|
| At least 10 non-excluded workflows (`WF-###`) | | |
| At least 5 workflow sellers (`SW-###`), at least 3 non-founder, with completed workflows | | |
| At least 2 workflows per workflow seller | | |
| At least 20 completed structured seller interviews (`SI-###`) with `relationship = none`, each person once, none of them a buyer session (`BIZ-092`) | | |
| 15 to 20 founder items (`FI-###`) with arms recorded before publication, none in the workflow denominator | | |
| At least 3 categories | | |
| At least 100 confirmed exposed real buyer contacts (`RC-####`, `SLICE_0_SCORECARD.md` §1a) | | |
| At least 20 completed moderated buyer sessions (`BM-###`) | | |
| No participant counted twice within one denominator; every `SW-###` carries one linked `SI-###`; no cohort re-labelling (B-11) | | |
| Channel evidence rows for every channel used, each with a policy source and date | | |
| Manifest complete; hashes verified | | |
| Every metric's missing-data count stated | | |
| Incident log reviewed; every critical and major row confirmed or not | | |

If any row is "no", HS-09 is under consideration; state in §9 whether it applies.

## 4. Result by hypothesis

One row per hypothesis in `HYPOTHESIS_AND_REQUIREMENTS_MATRIX.md`. "Result" is pass /
fail / inconclusive with the metric value as a fraction and a percentage.

| Hypothesis | Metric(s) | Value (fraction and %) | Missing-data count | Result | Evidence refs |
|---|---|---|---|---|---|
| H-01 | M-02, IV coding over `SI-###` | | | | |
| H-02 | M-22 | | | | |
| H-03 | M-04, M-05, M-06 | | | | |
| H-04 | ST-04, M-03 | | | | |
| H-05 | M-08, M-18, Test 1 | | | | |
| H-06 | M-19, M-09, M-11 | | | | |
| H-07 | M-10, M-07 | | | | |
| H-08 | M-12, M-21 | | | | |
| H-09 | M-13 | | | | |
| H-10 | M-16 over `SW-###` (behaviour); IV-31 coding over `SI-###` beside it | | | | |
| H-11 | M-17 over `SI-###` (levels; amounts banded); inconclusive below 20 completed | | | | |
| H-12 | M-15, M-18, hard stops | | | | |

### 4.1 Canonical funnel

| Measure | Fraction | % | Band |
|---|---|---|---|
| Page-open rate (M-19) | | | above 40 / 20–40 / below 20 |
| Code-entry completion of opens (M-09) | | | 80+ / 50–79 / below 50 |
| Conversation-start rate (M-20) | | | reported |
| Median conversations per listing; median messages per conversation (M-21) | | | `ASM-04` floor 3 |
| Listing-level opens on the listing-body arm (`SLICE_0_SCORECARD.md` §1a), beside the contact-level figure | | | which figure the band used |
| Per-channel breakdown | | | table attached |
| Per-arm breakdown (listing_body / reply_only / phone_control) | | | table attached |

### 4.2 Workflow success

```
successful / (started − excluded) = ____ / ____ = ____ %   → band: ____
```

Stage failure counts: ST-01 __ ST-02 __ ST-03 __ ST-04 __ ST-05 __ ST-06 __ ST-07 __
ST-08 __ ST-09 __ ST-10 __. Results by relationship group: non-founder __/__, founder
__/__, family __/__.

## 5. Marketplace feasibility

One line per channel and surface from `MARKETPLACE_EVIDENCE_TEMPLATE.csv`, with its
classification and basis. Then: Test 1 result (pass / fail / unclear) and which two
channels were treated as primary (OVQ-03). No statement about a marketplace appears here
that is not a row's quote or observation with a date.

## 6. Safety incidents

Every incident row of severity critical or major: ID, category, what reached whom,
confirmation status, resolution. State the counts for M-14 and M-15. State explicitly
whether any HS-01 to HS-08 condition is confirmed, disputed or not confirmed.

## 7. Threshold calculation

Show the arithmetic from `SLICE_0_SCORECARD.md` §7 with the actual numbers:

```
hard stops confirmed: ____
HS-09 (evidence incomplete): ____
canonical band: ____ (from M-19 = __/__, M-09 = __/__, Test 1 = ____)
workflow band:  ____ (from __/__)
decision = ____
```

## 8. Bias and limitations (write before results)

Address each control in `RECRUITMENT_PLAN.md` §7: relationship mix; moderated versus
real separation; operator over-performance (M-14 value); exclusions; leading questions
(deviations logged); category and channel concentration; timing integrity; the
human-not-AI disclosure (OVQ-01) and what it means for H-06; the self-reported baseline
for M-05; cohort integrity (every `SW-###` linked to one `SI-###`, no re-labelling, no
buyer session counted as an interview, no founder item in the workflow denominator);
anything else either founder believes weakened the evidence.

## 9. Hard-stop review

| Condition | Occurred | Confirmed by both | Evidence refs | Effect on decision |
|---|---|---|---|---|
| HS-01 primary marketplace prevents the flow | | | | |
| HS-02 buyers cannot access or understand the flow | | | | |
| HS-03 private information exposed | | | | |
| HS-04 material fabrication | | | | |
| HS-05 commitment without seller approval | | | | |
| HS-06 participant misled about human vs automated | | | | |
| HS-07 sensitive data without necessity or consent | | | | |
| HS-08 scraping, prohibited automation or credentials required | | | | |
| HS-09 evidence incomplete or biased | | | | |

## 10. Open validation-design questions and product questions touched

List every OVQ default used in this run and state that none is a product decision. State
that `Q-03`, `Q-04`, `Q-05`, `Q-07`, `Q-09`, `Q-10` and `Q-11` remain open, and that `Q-12` is
resolved by Accepted decision D-19 (2026-09-04), the approved seller-authentication approach;
production authentication is not yet implemented and D-19's mandatory pre-route security
conditions still apply. This memo does not change that Slice 0 remains deferred, incomplete
and unpassed until a PASS is recorded here (D-18). If the
evidence bears on D-02 (page-open below 20% or code-entry below 50%), say that D-02 is
to be reopened with this evidence, not decided here.

## 11. Decision

One of: **STOP** · **REWORK** · **RERUN** · **PASS**

Justification in the order of `README.md` §6: hard stops, canonical gate, workflow unit,
completeness. If PASS: this memo is the Slice 0 decision `PLAN-007` part (b) requires,
and a public release may be considered subject to the D-17 follow-ups (`PLAN-009`) and
every other gate; private-alpha implementation was separately authorized by D-18 and
does not wait for this memo. If RERUN or REWORK: what changes
before the next run, and which hypotheses are re-tested. If STOP: what is reconsidered.

## 12. Sign-off by both founders

| Founder | Role in the study | I confirm the evidence in the manifest supports this memo and that no result was pre-filled or adjusted | Signature | Date |
|---|---|---|---|---|
| | Product | | | |
| | Engineering | | | |

A memo with one signature is not a decision.
