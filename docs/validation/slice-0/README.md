# Slice 0 — Concierge validation execution kit

**Status:** Validation-planning package. Not product scope, not a requirement document,
not evidence. It operationalises Slice 0 of `planning/MVP_ROADMAP.md` and Tests 1 and 2 of
`business/RISK_REGISTER.md` §4 so that two founders can run the validation by hand.

**Nothing in this directory is evidence.** Every file here is a template, a script or a
procedure. A template with no participant data in it proves nothing; a filled scorecard in
the protected store, hashed in the evidence manifest and summarised in a signed decision
memo, is evidence. Until that memo exists, Slice 0 has not produced a decision and
`PLAN-007` part (b) blocks public beta and general availability.

**Status (D-18, 2026-09-03): deferred, incomplete, unpassed.** `decisions/DECISION_LOG.md`
D-18 authorizes private-alpha implementation without this validation and leaves this kit
canonical and unchanged in substance. No evidence exists. Nothing here has been run.

---

## 1. Purpose

Answer, with real resellers and real buyers and no production software, the twelve
questions below before any production code is written. Each question is a hypothesis in
`HYPOTHESIS_AND_REQUIREMENTS_MATRIX.md`, traced to the canonical requirement or risk it
tests.

| # | Question | Hypothesis |
|---|---|---|
| 1 | Do active resellers experience the problem strongly enough? | H-01 |
| 2 | Will sellers provide item facts and photos to produce a listing? | H-02 |
| 3 | Does the enhanced listing materially save the seller time? | H-03 |
| 4 | Can the seller manually publish the result successfully? | H-04 |
| 5 | Can the seller share an external buyer URL or six-digit code through the marketplace workflow? | H-05 |
| 6 | Will buyers trust and use the separate buyer experience? | H-06 |
| 7 | Can the concierge answer buyer questions using only seller-provided facts? | H-07 |
| 8 | Will buyers submit offers through the workflow? | H-08 |
| 9 | Does the seller value the offer summary and approval process? | H-09 |
| 10 | Will sellers use the workflow again? | H-10 |
| 11 | Is there credible willingness to pay? | H-11 |
| 12 | Are marketplace-policy, trust, privacy or usability problems fatal to the concept? | H-12 |

## 2. Scope

**In scope.** A human-operated concierge (Wizard-of-Oz) run of the primary loop in
`product/MASTER_PRODUCT_SPEC.md` §6: seller facts → hand-improved copy → manual
marketplace publication by the seller → buyer URL and 6-digit code → a person answering
buyers from seller facts only → offers relayed to the seller → explicit seller decision →
seller handoff. Real items, real listings, real buyers.

**Out of scope, and prohibited in this validation:**

- any production software, database, backend, API, authentication or AI call;
- scraping any marketplace, automating any marketplace account, listing or message
  (`INT-060`, `D-07`);
- impersonating a participant, a seller or a buyer;
- collecting a password, session token or marketplace credential from anyone
  (`INT-060` credential handling);
- accepting or committing to an offer without the seller's explicit approval
  (`AUTH-INV-04`, `D-13`);
- any pricing, valuation or "what it is worth" statement to any participant (`D-09`);
- stating a product fact the seller did not supply (`D-10`, `INV-12`).

The founders may perform by hand every function the future system would perform,
inside those limits.

## 2a. Cohorts and minimum sample

Five cohorts take part. They are recorded with different identifiers, serve different
hypotheses and feed different denominators. A person may belong to two cohorts only
where the table allows it, and then carries two linked identifiers; their evidence is
counted once in each cohort's own metrics and never twice within one denominator.

| Cohort | Identifier | Minimum count | Eligibility | Purpose | Evidence produced | Metrics affected | Overlap allowed | Enters the primary workflow denominator |
|---|---|---|---|---|---|---|---|---|
| Structured seller interviews | `SI-###` | 20 completed interviews (`BIZ-092`) | Active seller per `RECRUITMENT_PLAN.md` §1 E-1, E-3, E-5 and no exclusion rule; not a founder, team member or immediate family (their interviews as workflow sellers are recorded and reported separately, never among the 20); items to list are not required | Seller pain (H-01), attitude to the approval step (H-09 attitude), stated reuse intent (H-10 stated), credible willingness to pay (H-11) | Interview record (I) per `SELLER_INTERVIEW_SCRIPT.md` | M-02, M-17, IV coding | Yes: a workflow seller is also interviewed once and holds a linked `SI-###`; moderated buyers and real contacts never | No |
| Workflow sellers | `SW-###` | 5 enrolled, of whom at least 3 are not founders, team members or immediate family | E-1 to E-6 | Behavioural test of the seller side (H-02 to H-05, H-09 behaviour, H-10 behaviour) | Workflow rows (W), stopwatch logs, copy versions | M-01, M-03 to M-06, M-08, M-13, M-16, M-22 | Yes: every workflow seller is a subset of the interview cohort (interviewed once, before the first workflow); not a moderated buyer; not a real contact | Through their workflows |
| Listing workflows | `WF-###` | 10 non-excluded, at least 2 per workflow seller | A real item the workflow seller intends to sell, not a founder-experiment item | The primary success unit (`SLICE_0_SCORECARD.md` §2) | W rows | Workflow success rate, M-03 to M-08, M-13 | An item is either a `WF-###` or an `FI-###`, never both | **Yes: this is the denominator** |
| Founder-item marketplace experiment | `FI-###` | 15 to 20 real founder-owned items across the three canonical arms | Items the founders own and will sell | The canonical Slice 0 experiment: channel verification (Test 1), the real-buyer funnel (Test 2), arm comparison | Channel rows (C), real-contact events | M-08, M-18, M-19, M-09, M-20, M-21 | Founders may separately enrol as workflow sellers (`SW-###`, `relationship = founder`) on other items; a founder-experiment item never becomes a workflow | No |
| Moderated buyer sessions | `BM-###` | 20 completed sessions | `RECRUITMENT_PLAN.md` §3 | Comprehension, trust, URL and code entry, questions, unknown-fact handling, offer submission, the *why* behind the funnel (H-06 to H-08) | Buyer rows with `population = moderated` (B), post-task answers | M-10, M-11, M-12 moderated split, trust and AI-reaction codes | No: not an interview, not a real contact, not a seller cohort in this run | No |
| Real buyer contacts | `RC-####` (events, no identity) | 100 confirmed exposed contacts | An unrecruited person who contacted a live validation listing (`WF-###` or `FI-###`) | The canonical link-open and code-entry funnel; conversation volume; real questions and offers | Buyer rows with `population = real` (B): funnel events only | M-09, M-19, M-20, M-21, M-10 and M-12 real split | No: a contact is never recruited into any other cohort during the run | No |

Twenty moderated buyer sessions and twenty structured seller interviews are two
different cohorts with two different scripts; one never counts toward the other. One
hundred real contacts are events in a funnel, not interviews; nobody is interviewed by
contacting a listing. Full definitions of a confirmed contact and a confirmed exposure
are in `SLICE_0_SCORECARD.md` §1a. Recruitment buffers that make the minimums reachable
are in `RECRUITMENT_PLAN.md` §0.

**BIZ-092 reading used here.** `business/BUSINESS_MODEL.md` `BIZ-092` states the
assumption about "target sellers", its falsifier as "willingness-to-pay interviews"
clustering below CAD 20, and its test as "20 structured interviews before pricing is
fixed". The test cell does not repeat the word "sellers", but the assumption it tests is
about sellers, the falsifier is a willingness-to-pay figure, and `BIZ-001` states that the
subscription buyer is the seller and the item buyer is never a customer. The kit
therefore reads the requirement as 20 structured interviews of active sellers, records
that the test cell alone is not explicit, and adopts that reading as the conservative
default for this run. Buyer sessions do not count toward it. `BIZ-094` places
`BIZ-092` last in the dependency order; the interviews run alongside Slice 0 for
efficiency, and the memo reads their result only in the light of the earlier gates.

## 3. Preconditions

Before the first session:

1. Both founders have read `CLAUDE.md`, `planning/MVP_ROADMAP.md` Slice 0,
   `business/RISK_REGISTER.md` §4, `product/BUYER_ACCESS_FLOW.md`,
   `integrations/MARKETPLACE_STRATEGY.md` §3 to §6, `security/DATA_AND_PRIVACY.md` §1,
   §4 and §5, and every file in this directory.
2. A protected store exists: an access-controlled location outside Git, restricted to the
   two founders, for raw evidence, the participant-ID map and unredacted screenshots
   (`CONSENT_AND_PRIVACY_SCRIPT.md` §6). Nothing raw is ever committed.
3. `MARKETPLACE_FEASIBILITY_PROTOCOL.md` step 1 (policy reading) is complete for every
   channel the validation will use, with a dated evidence row per channel. No listing is
   published for the validation on a channel with an empty row.
4. The static buyer page for each listing exists (`SELLER_CONCIERGE_TEST.md` §5): a
   hand-made page showing the item above a 6-digit code gate, the disclosure banner and
   the pilot notice. It is not product code and lives outside this repository.
5. The open validation-design questions in §7 have a recorded default chosen by both
   founders for this run. A default chosen for the run is not a product decision.
6. The pilot session in `EXECUTION_SCHEDULE.md` has been run and its fixes applied.

## 4. How to run the validation

| Step | Do | With |
|---|---|---|
| 1 | Recruit and screen sellers and buyer participants to the buffered targets; assign cohort identifiers | `RECRUITMENT_PLAN.md` §0, §8 |
| 2 | Run 20 structured seller interviews (`SI-###`); every workflow seller is interviewed once before their first workflow | `SELLER_INTERVIEW_SCRIPT.md` |
| 3 | Run each seller/listing workflow end to end, timed and observed | `SELLER_CONCIERGE_TEST.md`, `CONCIERGE_OPERATOR_PLAYBOOK.md` |
| 4 | Read policy, publish, and observe each channel used | `MARKETPLACE_FEASIBILITY_PROTOCOL.md`, `MARKETPLACE_EVIDENCE_TEMPLATE.csv` |
| 5 | Answer real inbound buyer contacts (`RC-####`) on live listings and run 20 moderated buyer sessions (`BM-###`) | `BUYER_TEST_SCRIPT.md`, `CONCIERGE_OPERATOR_PLAYBOOK.md` |
| 6 | Record every field, every day | `SELLER_SCORECARD_TEMPLATE.csv`, `BUYER_SCORECARD_TEMPLATE.csv`, `INCIDENT_LOG_TEMPLATE.csv`, `DAILY_OPERATOR_CHECKLIST.md` |
| 7 | Register and hash every piece of evidence | `EVIDENCE_MANIFEST_TEMPLATE.md` |
| 8 | Compute the scorecard | `SLICE_0_SCORECARD.md`, `DATA_DICTIONARY.md` |
| 9 | Write and sign the decision memo | `DECISION_MEMO_TEMPLATE.md` |

Sequence and dates are in `EXECUTION_SCHEDULE.md`. Consent is obtained before any
session using `CONSENT_AND_PRIVACY_SCRIPT.md`.

## 5. File guide

| File | What it is |
|---|---|
| `HYPOTHESIS_AND_REQUIREMENTS_MATRIX.md` | Every hypothesis, its canonical source, test, evidence, metric, pass rule, risk and the decision it affects |
| `RECRUITMENT_PLAN.md` | Recruitment targets and buffers, eligibility, exclusions, channels, scripts, screening, bias controls, cohort identifiers |
| `SELLER_INTERVIEW_SCRIPT.md` | Structured seller interview (`SI-###`), non-leading; also run once per workflow seller |
| `SELLER_CONCIERGE_TEST.md` | Moderator procedure for one seller/listing workflow |
| `BUYER_TEST_SCRIPT.md` | Moderated buyer session procedure |
| `CONCIERGE_OPERATOR_PLAYBOOK.md` | How a founder plays the future system, and what they may never do |
| `MARKETPLACE_FEASIBILITY_PROTOCOL.md` | Per-channel policy reading and live observation, one evidence row each |
| `CONSENT_AND_PRIVACY_SCRIPT.md` | Participant disclosure, human-concierge disclosure, minimisation, withdrawal, deletion |
| `DATA_DICTIONARY.md` | Every field collected, its type, stage, sensitivity, storage, retention and metric |
| `SELLER_SCORECARD_TEMPLATE.csv` | One row per seller/listing workflow |
| `BUYER_SCORECARD_TEMPLATE.csv` | One row per moderated buyer session (`BM-###`) or real buyer contact event (`RC-####`) |
| `MARKETPLACE_EVIDENCE_TEMPLATE.csv` | One row per channel and placement surface tested |
| `INCIDENT_LOG_TEMPLATE.csv` | One row per incident, near miss or hard-stop candidate |
| `DAILY_OPERATOR_CHECKLIST.md` | Before, during and after every session |
| `EVIDENCE_MANIFEST_TEMPLATE.md` | Register of every evidence item with hash, location and redaction status |
| `SLICE_0_SCORECARD.md` | Success formula, metrics, denominators, exclusions, hard stops, bands, fictional worked example |
| `DECISION_MEMO_TEMPLATE.md` | The document Slice 0 produces; signed by both founders |
| `EXECUTION_SCHEDULE.md` | Five weeks plus contingency for two founders |

## 6. Decision process

Slice 0 produces exactly one of four decisions, recorded in a signed
`DECISION_MEMO_TEMPLATE.md`: **STOP**, **REWORK**, **RERUN** or **PASS**.

The decision is taken in this order, and a later step cannot reverse an earlier one:

1. **Hard stops.** If any condition in `SLICE_0_SCORECARD.md` §4 occurred and is
   confirmed, the decision is STOP or REWORK regardless of any percentage.
2. **Canonical gate.** The bands of `planning/MVP_ROADMAP.md` Slice 0 and
   `business/RISK_REGISTER.md` Test 1 and Test 2 are applied to the real-buyer funnel and
   the channel evidence. They are binding because they are what `PLAN-007` refers to.
3. **Workflow success rate.** The kit's primary success unit (§4 of the scorecard) is
   applied to the seller/listing workflows with the same 50% and 80% bands.
4. **Evidence completeness and bias review.** If the evidence cannot support a decision,
   the decision is RERUN, not PASS.

Where the canonical gate and the workflow rate disagree, the memo records both and the
lower result governs. A PASS requires both to pass.

**Two success units exist, and the discrepancy is deliberate and reported.** The
canonical documentation defines Slice 0 success on the buyer funnel: page-open rate and
code-entry completion as a share of page opens, across at least 100 real buyer contacts,
plus at least one verified placement surface on at least two primary channels. This kit
adds a seller/listing **workflow** success unit because the twelve questions above are
mostly seller-side and the funnel alone cannot answer them. The canonical definition is
preserved unchanged and remains the gate `PLAN-007` names; the workflow unit is
additional. Neither replaces the other.

## 7. Open validation-design questions

Recorded, with a recommended default for this run. **A default is not an accepted
product decision**, and none of the product's open questions is resolved by it: launch
jurisdiction (`Q-07`), hosting (`Q-09`), model provider (`Q-10`), notification providers
(`Q-11`), buyer email collection (`Q-05`), cross-device continuation (`Q-04`) and
buyer-code pre-filling (`Q-03`) all stay open. The authentication library (`Q-12`) is no
longer open: it is resolved by Accepted decision D-19 (2026-09-04), the approved
seller-authentication approach; production authentication is not yet implemented and D-19's
mandatory pre-route security conditions still apply. Nothing in D-19 changes this kit or the
status above: Slice 0 remains deferred, incomplete and unpassed (D-18).

| ID | Question | Why it matters | Recommended default for this run |
|---|---|---|---|
| OVQ-01 | How is the assistant disclosed to buyers when a person, not an AI, is answering? | `D-15` requires unconditional AI disclosure in the product; a hard stop forbids misleading anyone about human versus automated interaction; canonical Slice 0 says "disclosing that an assistant is answering" | Disclose truthfully: "a sales assistant acting for [seller]; during this pilot the assistant is a person from the pilot team, not the seller; only [seller] can accept an offer". Never claim AI; never deny being human when asked. Reaction to AI specifically is asked afterwards (`BUYER_TEST_SCRIPT.md` §7). Recorded as a limitation. |
| OVQ-02 | How does a buyer who arrives through the URL and code receive replies without product software? | The canonical page is "a form"; replies need a return path; the product collects no buyer email (`Q-05`, `DATA-260`) | The pilot page offers a free-text question form and an **optional** reply channel chosen by the buyer (the marketplace thread they came from, or a pilot-only contact they type), stated as pilot-only and deleted per §6 of the consent script. This does not resolve `Q-05`. |
| OVQ-03 | Which channels are "primary" for Test 1? | `INT-091` is open; Test 1 requires two primary channels | The two channels the recruited sellers already use most, recorded in the memo. Not a launch-channel decision. |
| OVQ-04 | Is the pre-filled code variant tested? | `Q-03` is open; canonical Test 2 says run both variants "if volume permits" | Run the two-part form as default; run the pre-filled variant only on founder-owned listings if at least 100 contacts on the default variant are already secured. Not a `Q-03` decision. |
| OVQ-05 | What counts as a "link exposure" for the link-open denominator when a marketplace surface hides the link? | Denominator integrity for the canonical gate | The definitions in `SLICE_0_SCORECARD.md` §1a: a contact is exposed only on a recorded basis (the link was in a listing body confirmed visible at the time of contact, or was sent to that person in a reply). Unconfirmed contacts are logged and excluded from the denominator. |
| OVQ-06 | How is "time saved" estimated without a production tool? | H-03 needs a baseline | Seller self-reports their usual time for a comparable listing, before the session, on the interview; the session time is measured. The difference is labelled an estimate from a self-reported baseline, never a finding. |
| OVQ-07 | May a founder reply inside a seller's marketplace thread? | Credential and impersonation prohibitions | No. The founder drafts; the seller sends from their own device and account, or the buyer moves to the pilot page. |
| OVQ-08 | How is a page open attributed to a specific real contact? | Per-contact attribution is only possible when the link was sent to that person | On the reply-only arm the link sent to a contact carries a pseudonymous reference (`?r=RC-####`) read from the founder-controlled host's access log; on the listing-body arm attribution is by the contact's own statement or a code submission, otherwise `not_attributable`, and the memo reports listing-level opens beside contact-level opens (`SLICE_0_SCORECARD.md` §1a). The reference identifies an event, never a person. |

## 8. Warnings that apply to every file

- Templates are not evidence. Example rows are fictional and marked so.
- No result may be pre-filled, projected or inferred. A blank is a blank.
- A failed workflow stays in the denominator. Exclusion needs a documented reason
  unrelated to the concept, recorded before the outcome is known wherever possible.
- No marketplace permits or forbids anything until a dated evidence row says so
  (`INT-022`).
- Nothing here is legal advice; consent wording is plain language pending counsel
  (`DATA-248`, `Q-07`).
- Slice 0 writes no production code. Accepting D-17 did not change that.
