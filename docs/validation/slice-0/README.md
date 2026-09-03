# Slice 0 — Concierge validation execution kit

**Status:** Validation-planning package. Not product scope, not a requirement document,
not evidence. It operationalises Slice 0 of `planning/MVP_ROADMAP.md` and Tests 1 and 2 of
`business/RISK_REGISTER.md` §4 so that two founders can run the validation by hand.

**Nothing in this directory is evidence.** Every file here is a template, a script or a
procedure. A template with no participant data in it proves nothing; a filled scorecard in
the protected store, hashed in the evidence manifest and summarised in a signed decision
memo, is evidence. Until that memo exists, Slice 0 has not produced a decision and
`PLAN-007` blocks Slice 1.

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
| 1 | Recruit and screen sellers; assign participant IDs | `RECRUITMENT_PLAN.md` |
| 2 | Interview each seller before their first workflow | `SELLER_INTERVIEW_SCRIPT.md` |
| 3 | Run each seller/listing workflow end to end, timed and observed | `SELLER_CONCIERGE_TEST.md`, `CONCIERGE_OPERATOR_PLAYBOOK.md` |
| 4 | Read policy, publish, and observe each channel used | `MARKETPLACE_FEASIBILITY_PROTOCOL.md`, `MARKETPLACE_EVIDENCE_TEMPLATE.csv` |
| 5 | Answer real inbound buyers and run moderated buyer sessions | `BUYER_TEST_SCRIPT.md`, `CONCIERGE_OPERATOR_PLAYBOOK.md` |
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
| `RECRUITMENT_PLAN.md` | Eligibility, exclusions, channels, scripts, screening, bias controls, participant IDs |
| `SELLER_INTERVIEW_SCRIPT.md` | Pre-workflow interview, non-leading |
| `SELLER_CONCIERGE_TEST.md` | Moderator procedure for one seller/listing workflow |
| `BUYER_TEST_SCRIPT.md` | Moderated buyer session procedure |
| `CONCIERGE_OPERATOR_PLAYBOOK.md` | How a founder plays the future system, and what they may never do |
| `MARKETPLACE_FEASIBILITY_PROTOCOL.md` | Per-channel policy reading and live observation, one evidence row each |
| `CONSENT_AND_PRIVACY_SCRIPT.md` | Participant disclosure, human-concierge disclosure, minimisation, withdrawal, deletion |
| `DATA_DICTIONARY.md` | Every field collected, its type, stage, sensitivity, storage, retention and metric |
| `SELLER_SCORECARD_TEMPLATE.csv` | One row per seller/listing workflow |
| `BUYER_SCORECARD_TEMPLATE.csv` | One row per moderated buyer session or real buyer contact |
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
(`Q-11`), authentication library (`Q-12`), buyer email collection (`Q-05`), cross-device
continuation (`Q-04`) and buyer-code pre-filling (`Q-03`) all stay open.

| ID | Question | Why it matters | Recommended default for this run |
|---|---|---|---|
| OVQ-01 | How is the assistant disclosed to buyers when a person, not an AI, is answering? | `D-15` requires unconditional AI disclosure in the product; a hard stop forbids misleading anyone about human versus automated interaction; canonical Slice 0 says "disclosing that an assistant is answering" | Disclose truthfully: "a sales assistant acting for [seller]; during this pilot the assistant is a person from the pilot team, not the seller; only [seller] can accept an offer". Never claim AI; never deny being human when asked. Reaction to AI specifically is asked afterwards (`BUYER_TEST_SCRIPT.md` §7). Recorded as a limitation. |
| OVQ-02 | How does a buyer who arrives through the URL and code receive replies without product software? | The canonical page is "a form"; replies need a return path; the product collects no buyer email (`Q-05`, `DATA-260`) | The pilot page offers a free-text question form and an **optional** reply channel chosen by the buyer (the marketplace thread they came from, or a pilot-only contact they type), stated as pilot-only and deleted per §6 of the consent script. This does not resolve `Q-05`. |
| OVQ-03 | Which channels are "primary" for Test 1? | `INT-091` is open; Test 1 requires two primary channels | The two channels the recruited sellers already use most, recorded in the memo. Not a launch-channel decision. |
| OVQ-04 | Is the pre-filled code variant tested? | `Q-03` is open; canonical Test 2 says run both variants "if volume permits" | Run the two-part form as default; run the pre-filled variant only on founder-owned listings if at least 100 contacts on the default variant are already secured. Not a `Q-03` decision. |
| OVQ-05 | What counts as a "link exposure" for the link-open denominator when a marketplace surface hides the link? | Denominator integrity for the canonical gate | Count a contact as exposed only when the founder confirms the URL and code were actually shown to that buyer (in the listing body or in a reply). Unconfirmed contacts are excluded and counted separately. |
| OVQ-06 | How is "time saved" estimated without a production tool? | H-03 needs a baseline | Seller self-reports their usual time for a comparable listing, before the session, on the interview; the session time is measured. The difference is labelled an estimate from a self-reported baseline, never a finding. |
| OVQ-07 | May a founder reply inside a seller's marketplace thread? | Credential and impersonation prohibitions | No. The founder drafts; the seller sends from their own device and account, or the buyer moves to the pilot page. |

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
