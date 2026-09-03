# Slice 0 scorecard

How the evidence is turned into a decision. The arithmetic is fixed here so it cannot be
adjusted after the results are known. Fields are defined in `DATA_DICTIONARY.md`.

## 1. Units and counts

| Unit | Definition | Where recorded |
|---|---|---|
| Recruited seller | A person who received the outreach script and replied | `RECRUITMENT_PLAN.md` log (protected store) |
| Eligible seller | A recruited seller who passed screening (`RECRUITMENT_PLAN.md` §1) | recruitment log `eligible = yes` |
| Interviewed seller | A person in the structured-interview cohort (`SI-###`) whose interview reached `SELLER_INTERVIEW_SCRIPT.md` §12 with `interview_completed = yes`; never a buyer participant | interview record `si_id` |
| Workflow seller | An eligible seller who gave workflow consent and received an `SW-###` with one linked `SI-###` (`RECRUITMENT_PLAN.md` §8) | seller scorecard `seller_id`, `linked_si_id` |
| Started workflow | A seller/listing test (`WF-###`) in which stage ST-01 began | seller scorecard row exists with `stage_reached >= 1` |
| Completed workflow | A started workflow that reached ST-10 review, whatever the stage outcomes | `workflow_completed = yes` |
| Excluded workflow | A started workflow removed from the denominator for a documented reason in §6 | `excluded = yes` with `exclusion_reason` |
| Successful workflow | A completed, non-excluded workflow with every stage ST-01 to ST-10 = pass | computed, §2 |
| Founder item | A founder-owned item in the founder-item experiment (`FI-###`) with its arm recorded before publication; never a workflow | channel evidence `visibility_test_listing`; buyer scorecard `listing_id` |
| Real buyer contact | One contact event (`RC-####`) by an unrecruited person on a live validation listing, logged per §1a; an event, not a person | buyer scorecard `population = real` |
| Moderated buyer session | A recruited buyer participant (`BM-###`) run through `BUYER_TEST_SCRIPT.md`; never an interview | buyer scorecard `population = moderated` |

Counts are reported in this order in the memo: sellers recruited → screened → eligible →
interviews completed (`SI`) → workflow sellers enrolled (`SW`) → workflows started →
completed → excluded → successful; then founder items by arm (`FI`); then moderated
sessions booked → completed (`BM`); then real contacts logged → confirmed exposed (`RC`).
A count that falls between two others is explained, never omitted. The cohort table in
`README.md` §2a states which minimum each count is measured against.

## 1a. Confirmed contact and exposure definitions (real buyer cohort)

These definitions fix the real-buyer denominators before any contact is logged. They
apply to `RC-####` events only. A moderated session is never counted under any of them.

**Confirmed real contact.** One `RC-####` row is created when an unrecruited person
initiates contact about one live validation listing (`WF-###` or `FI-###`) through the
marketplace's own messaging or through the pilot page, and a founder logs it within 24
hours with `channel_key`, `listing_id`, `arm` and `session_date`. The same person
contacting the same listing again is the same row; the same person contacting a
different listing is a new row, because the row is an event on a listing, not a person.
Nobody is recruited, screened, interviewed or thanked with a gesture; the pilot notice
(`CONSENT_AND_PRIVACY_SCRIPT.md` §2) is the only disclosure. A contact by a recruited
participant, a founder, or a person the founders recognise as team or immediate family
is logged with `exposure_basis = not_unrecruited` and `exposure_confirmed = no`, and is
excluded from every real-funnel denominator.

**Confirmed exposure (M-19 denominator).** A contact is exposed on one recorded basis:

| `exposure_basis` | Condition | Arm |
|---|---|---|
| `body_visible` | The listing body containing the URL and code was confirmed visible on that marketplace at the time of contact: the 24h or 48h visibility check bracketing the contact date shows `yes` for that listing | `listing_body` |
| `sent_in_reply` | The URL and code were sent to that contact in a reply, and the reply was logged with its time | `reply_only` |
| `none` | Neither condition holds (link removed, hidden, truncated, or not yet sent); every `phone_control` contact | any |
| `not_unrecruited` | The contact was a recruited participant, a founder, or a person recognised as team or immediate family | any |

Only `body_visible` and `sent_in_reply` rows carry `exposure_confirmed = yes` and enter
the M-19 denominator. Contacts on the phone-number control arm are logged with
`arm = phone_control` and `exposure_confirmed = no`; they show whether the listing
attracts contact at all and are reported beside the funnel, never inside it (OVQ-05).

**Page open (M-19 numerator; M-09 denominator).** An open is counted from the
founder-controlled host's own counter or access log for that listing's page, which keeps
no IP address for longer than 7 days, sets no cookie and runs no third-party script
(consent script DM-7, DM-10). The row's `open_attribution` records how the open was tied
to that contact:

| `open_attribution` | Meaning |
|---|---|
| `reference_suffix` | The reply-only arm sent the link with `?r=RC-####`; the host log shows a request carrying that reference. The reference identifies an event, never a person (OVQ-08) |
| `code_submitted` | A valid code for this listing was submitted on the page during the conversation window and the contact continued in that conversation |
| `self_reported` | The contact said they opened the page, with no log match |
| `not_attributable` | The listing's page shows opens in the window, but none can be tied to this contact |

Contact-level M-19 is computed over every confirmed exposed contact, with
`not_attributable` counted as not opened (conservative). Because attribution on the
listing-body arm is weaker, the memo also reports, for that arm, listing-level opens
(page opens in the window divided by confirmed exposed contacts on that listing) beside
the contact-level figure, and states which figure the canonical band was applied to.

**Valid code entry (M-09 numerator).** A valid six-digit code for this listing submitted
on the page and recorded by the page log, giving `code_entered = yes`. `helped` never
applies to a real contact.

**Never counted.** Moderated sessions (`BM-###`); founder, team or participant test
opens; opens of a page whose listing had been removed at the time; any contact whose
row lacks `listing_id`, `arm` or `exposure_basis`.

## 2. Primary success unit: the workflow

One **successful workflow** is a real seller/listing test that passes all ten critical
stages. A stage is pass, fail or not-reached. Not-reached counts as fail for the workflow.

| Stage | Pass condition | Canonical anchor | Fail examples |
|---|---|---|---|
| ST-01 Facts and images | Seller supplied a title plus at least one photo and at least one other fact field, unaided, and every fact is the seller's own statement | `LIST-001`, `LIST-002`, `D-10` | Seller asks the founder to fill in facts; no photo; founder supplied a fact |
| ST-02 Compliant draft | The hand-improved draft passes the operator's fabrication check (`CONCIERGE_OPERATOR_PLAYBOOK.md` §4): no introduced, altered, inferred, sharpened or implied fact; defects intact; no price or policy language | `LIST-036` to `LIST-040`, V-01 to V-10 | Any check fails and is not corrected before the seller sees the draft |
| ST-03 Seller approval | Seller accepted, edited or restored, and explicitly approved one version | `LIST-007`, `LIST-008`, `SM-CT-01` | Seller never approves; founder approves for them |
| ST-04 Manual publication | Seller published from their own account and device, or credibly simulated publication where the channel is `VERIFIED RESTRICTED` (documented as simulation) | `D-07`, `INT-001`, `INT-031` | Founder touched the seller's account; listing rejected and not re-published |
| ST-05 Buyer access tested | At least one buyer (real or moderated) opened the URL and passed the code gate for this listing | `BUYER-004` to `BUYER-008` | No buyer reached the gate; the gate was bypassed by the founder |
| ST-06 Buyer interaction completed | At least one buyer conversation reached a reply and a buyer response, or a stated end | `SM-CV-01`, `NFR-003` | Buyer question left unanswered; conversation abandoned by the operator |
| ST-07 No invented facts | Every answer in every conversation on this listing cited a seller fact or used the unknown-fact response | `AI-002`, `G-05` | Any material fabrication (also **HS-04**) |
| ST-08 Offer subject to seller approval | Every offer was relayed as "subject to the seller"; no acceptance or commitment language before the seller decided; or no offer occurred (counts as pass for this stage) | `AUTH-INV-04`, `AUTH-INV-07`, `G-09` | Any acceptance, hold, or "deal" wording before seller approval (also **HS-05**) |
| ST-09 Useful summary | Seller received a structured conversation or offer summary and rated it useful (3 or more on the 1 to 5 item in the scorecard) | `PROD-014`, `PROD-015` | No summary delivered; rated 2 or less |
| ST-10 No critical failure | No confirmed privacy, authorization or marketplace-policy incident on this workflow | `RISK-23`, `RISK-08`, `RISK-01` | Any confirmed incident of severity `critical` |

**Formula.**

```
workflow_success_rate = successful_workflows / (completed_workflows + failed_workflows)
                      = successful_workflows / (started_workflows - excluded_workflows)
```

A workflow that failed a stage is in the denominator. A workflow that was abandoned by
the seller after ST-01 began is in the denominator unless §6 excludes it. Rounding is to
one decimal place and is never rounded up across a band boundary.

**Bands (canonical, D-17 C-09), applied to the rate.**

| Rate | Result |
|---|---|
| below 50% | STOP or REWORK |
| 50% to 79% | RERUN (revise and rerun Slice 0) |
| 80% or higher | clean pass on this unit |

**For exactly ten non-excluded workflows:** 0 to 4 successful (0% to 40%) = STOP/REWORK;
5 to 7 successful (50% to 70%) = RERUN; 8 to 10 successful (80% to 100%) = clean pass.
The boundaries are exact: 5 of 10 is 50.0% and falls in RERUN; 8 of 10 is 80.0% and
falls in pass. With a different denominator the same percentages apply; for example 7 of
9 is 77.8% and is RERUN, and 8 of 9 is 88.9% and is pass.

## 3. Diagnostic metrics

Every metric states numerator, denominator, missing-data rule, exclusion rule and success
direction. "Missing" means the field is blank or `unknown` in the scorecard.

| ID | Metric | Numerator | Denominator | Missing data | Exclusion | Direction |
|---|---|---|---|---|---|---|
| M-01 | Seller recruitment conversion | Recruited sellers who completed a structured interview (`SI-###`) and, reported beside it, recruited sellers who enrolled as workflow sellers (`SW-###`) | Sellers who received the outreach script | A contact with no reply after 7 days counts as not enrolled, never dropped | None | Higher is better; informational |
| M-02 | Eligible-seller rate | Sellers who passed screening | Sellers who completed screening | A screening left incomplete is counted as not eligible | None | Informational; a low rate questions the channel, not the concept |
| M-03 | Seller workflow completion | Completed workflows | Started workflows minus excluded | An unfinished workflow with no recorded stop reason is counted as not completed | §6 | Higher is better; target 90% or more |
| M-04 | Median time to prepare a listing | Median of `t_prepare` (start of ST-01 to seller approval at ST-03) over completed workflows | Completed workflows with a valid timing | A workflow with a missing timing is excluded from this metric only and the count is reported | §6 | Lower is better; reported with interquartile range |
| M-05 | Estimated time saved | Median over workflows of (seller's self-reported baseline minutes for a comparable listing − `t_prepare`) ÷ baseline | Completed workflows with both values | Missing baseline → workflow excluded from this metric; count reported | §6 | Higher is better; labelled estimate from self-report (OVQ-06) |
| M-06 | Seller correction rate | Workflows in which the seller edited or restored the draft before approving | Completed workflows reaching ST-03 | Missing → treated as corrected (conservative) | §6 | Lower is better; a correction is not a failure of ST-02 unless it removed a fabrication |
| M-07 | Material-fabrication rate | Answers or draft sentences containing an introduced, altered, inferred, sharpened or implied fact (`LIST-036`) found by the second-founder review | All operator answers plus all draft sentences reviewed | Unreviewed items are counted as reviewed-and-clean only if the review log shows they were sampled; otherwise they are reported as unreviewed and the metric is marked incomplete | None | Must be 0; any material instance is **HS-04** |
| M-08 | URL/code sharing success | Workflows in which the URL and code were visible to buyers on at least one surface for at least 48 hours without removal | Workflows that attempted publication (ST-04 attempted) | Unknown visibility → not success | §6 | Higher is better; per channel too |
| M-09 | Buyer access completion (canonical code-entry completion) | Real buyer contacts (`RC-####`) who entered a valid code (§1a) | Real buyer contacts who opened the page (§1a attribution) | An open with no code result recorded counts as not completed | Moderated sessions never counted here | Canonical bands 50% and 80% |
| M-10 | Buyer question completion | Buyer questions that received either a fact-grounded answer or the unknown-fact response and a buyer acknowledgement or continuation | Buyer questions asked | A question with no logged response is counted as not completed | None | Higher is better; target 80% or more |
| M-11 | Buyer confusion or abandonment | Contacts or sessions with a confusion marker (asked what the code is for, asked if this is a scam, stopped at the gate) | Contacts who opened the page (real) or sessions started (moderated), reported separately | Missing marker → counted as no confusion only when the session notes are complete; otherwise counted as confusion | None | Lower is better; report both populations |
| M-12 | Offer-submission rate | Conversations in which the buyer stated an amount | Conversations started | Missing → no offer | None | Higher is better; target 25% or more |
| M-13 | Seller-approval completion | Delivered offer summaries that received an explicit seller decision (approve, decline, counter, ignore) within the seller's stated hold window | Delivered offer summaries | No decision recorded by window end → not completed | None | Higher is better; target 80% or more |
| M-14 | Manual-intervention rate | Operator actions outside the playbook's allowed responses (a founder improvised, fetched a fact from the seller mid-conversation, or intervened in a buyer session) | Operator turns | Unlogged turns → metric marked incomplete | None | Lower is better; informational for the future queue design |
| M-15 | Safety-policy intervention rate | Turns in which the operator had to use a refusal, escalation, disengagement or protected-information response | Operator turns | As M-14 | None | Informational; each instance is also an incident row if severity is major or above |
| M-16 | Seller reuse (behavioural) | Workflow sellers who started a second workflow without re-recruitment | Enrolled workflow sellers (`SW-###`) | No second workflow recorded → not reuse | None | Higher is better; target 80% or more. Stated intent (IV-31 coded over `SI-###`) is reported beside this metric and never added to it |
| M-17 | Credible paid intent | Interviewed sellers at commitment level 3, 4 or 5 (see below) | Completed structured seller interviews (`SI-###`) with `relationship = none`, each person once; founder, team and family interviews reported separately | Missing → level 0 | None | Higher is better; target half or more; named amounts must not cluster below CAD 20 (`BIZ-092`). Fewer than 20 completed interviews → H-11 inconclusive, `BIZ-092` unmet, pricing stays unfixed (§5 rule 3) |
| M-18 | Marketplace-specific failure rate | Placements removed, suppressed, warned or rejected on that channel | Placements attempted on that channel | Unknown outcome after 48 hours → counted as failure for this metric and flagged | None | Lower is better; one row per channel and surface |
| M-19 | Link-open rate (canonical) | Real buyer contacts who opened the page (§1a attribution) | Real buyer contacts confirmed exposed to the URL and code (§1a, OVQ-05) | Unconfirmed exposure → excluded from the denominator and reported | Moderated never counted | Canonical bands 40% and 20% |
| M-20 | Conversation-start rate | Real contacts who sent a first message after the gate | Real contacts who entered a valid code | Missing → not started | Moderated never counted | Informational |
| M-21 | Conversation volume | Median conversations per live listing; median buyer messages per conversation | Live listings (`WF-###` and `FI-###`, reported together and by cohort); conversations | Missing → excluded from the median with count reported | None | `ASM-04` falsifier below 3 |
| M-22 | Fact fields per listing | Median count of populated fact fields (`LIST-002` list) at ST-01 | Started workflows | Missing → excluded with count reported | None | `ASM-03` falsifier below 4 |

**Credible paid-intent levels (M-17).** A verbal "sounds useful" is level 0 and is never
counted as intent.

| Level | Commitment | Counts as credible |
|---|---|---|
| 0 | Positive words only | No |
| 1 | Would "consider" a paid plan | No |
| 2 | Names a price they would pay, unprompted by a tier list | No, but the amount is recorded for `BIZ-092` |
| 3 | Agrees to run another real listing after the study, with a date | Yes |
| 4 | Joins a named pilot or schedules an onboarding session | Yes |
| 5 | Selects a proposed subscription tier and signs a non-binding pilot commitment | Yes |

No payment is collected in Slice 0. A commitment that involves money changing hands is
not requested and would be an incident.

## 4. Hard-stop conditions

A confirmed hard stop blocks production entry whatever the percentages say. "Confirmed"
means both founders reviewed the incident row and the evidence and agreed. A hard stop
that is disputed is reported as disputed and still blocks until resolved.

| ID | Condition | Protects | Detected by |
|---|---|---|---|
| HS-01 | The primary launch marketplace (OVQ-03) prevents the external buyer flow from being used reliably on every candidate surface | `ASM-02`, `RISK-01`, `RISK-03` | Channel evidence rows all `VERIFIED RESTRICTED` for that channel |
| HS-02 | Buyers cannot access or understand the URL/code flow: in moderated sessions a majority fail to reach the conversation, or real code-entry completion is below 50% | `ASM-01`, `RISK-02`, `RISK-04`, D-02 | M-09, M-11, moderated task failures |
| HS-03 | A buyer was able to see another listing's or another seller's private information, or another buyer's conversation | `BUYER-018`, `SEC-001`, `RISK-23`, `AUTH-INV-08` | Incident log; any occurrence |
| HS-04 | A product fact was materially fabricated in a draft the seller approved or in an answer a buyer received | `D-10`, `INV-12`, `G-05`, `RISK-10` | M-07 above 0 on material items |
| HS-05 | The workflow accepted or committed to an offer without the seller's explicit approval | `AUTH-INV-04`, `AUTH-INV-07`, `D-13`, `RISK-08` | Incident log; any occurrence |
| HS-06 | A participant was misled about whether they were interacting with a person or an automated system | `D-15` honesty rationale, `DATA-297`, `RISK-19` | Incident log; consent script deviation |
| HS-07 | Sensitive information was collected without necessity or consent | `DATA-200`, `DATA-260`, `DATA-266` | Data audit in `DAILY_OPERATOR_CHECKLIST.md`; incident log |
| HS-08 | The workflow required scraping, prohibited automation, or a seller's marketplace credentials to work | `D-07`, `INT-060`, `INT-061` | Incident log; playbook deviation |
| HS-09 | The evidence is too incomplete or biased to support a decision: fewer than 100 confirmed real contacts (§1a), fewer than 3 non-founder workflow sellers with completed workflows, fewer than 20 completed structured seller interviews, fewer than 20 completed moderated sessions, fewer than 15 founder items with arms recorded, fewer than 3 categories, missing manifest hashes, a participant counted twice within one denominator or re-labelled between cohorts (B-11), or an unresolved bias finding. Whatever the decision, fewer than 20 completed interviews leaves `BIZ-092` unmet and pricing unfixed | Decision integrity; `PLAN-007` | Memo §3 completeness review |

## 5. Denominator rules

1. The workflow denominator is started minus excluded. It is never "completed" alone.
2. Real buyer funnel denominators are real contacts only (`RC-####`, §1a); moderated
   sessions (`BM-###`) are a separate population and are reported separately. Interview
   metrics (M-02, M-17) are over `SI-###`; workflow-seller metrics (M-01, M-16) over
   `SW-###`; the workflow rate over `WF-###`; founder items (`FI-###`) never enter the
   workflow denominator. A person holding a linked `SI-###` and `SW-###` appears once in
   each and never twice in either.
3. A denominator under the sample minimum (10 non-excluded workflows; 5 workflow sellers
   with 3 non-founder; 20 completed structured seller interviews; 100 confirmed real
   contacts; 20 completed moderated sessions; 15 founder items) is reported as
   under-powered and triggers HS-09 unless the memo explains why the shortfall does not
   bias the result and both founders agree. An interview shortfall can never be waived
   for `BIZ-092`: pricing stays unfixed until 20 interviews are complete.
4. Percentages are shown with their fraction: "7/10 (70.0%)", never "70%" alone.

## 6. Missing-data and exclusion rules

**Missing data.** Every metric above states its rule. The general rule is conservative:
missing counts against the hypothesis, not for it. Where a metric excludes a row for
missing data, the number of excluded rows is printed next to the metric.

**Exclusion.** A workflow may be excluded from the denominator only for a reason that is
unrelated to the concept and, wherever possible, recorded before the outcome is known:

| Allowed reason | Example | Not allowed |
|---|---|---|
| Participant withdrew before ST-01 completed for a reason unrelated to the study | Family emergency | Withdrew because the intake felt like too much work (that is a finding) |
| Founder error invalidated the session | Wrong fact sheet used; disclosure omitted (also an incident) | Founder judged the seller "not serious" after a poor result |
| Duplicate or test row | A dry run mistakenly logged | Any row with real buyer contact |
| Item withdrawn from sale before publication for reasons outside the study | Item broke | Item did not sell |

Every exclusion is logged with `exclusion_reason`, the founder who decided it, the date,
and whether the outcome was known at the time. **A failed workflow is never excluded to
improve the rate.** The memo lists every excluded workflow and its reason.

## 7. Bands and decision logic, combined

```
if any hard stop confirmed:            decision = STOP or REWORK (memo states which and why)
else if evidence incomplete (HS-09):   decision = RERUN
else:
    canonical = band(M-19 page-open, M-09 code-entry, Test 1 channel result)
    workflow  = band(workflow_success_rate)
    decision  = the lower of canonical and workflow
```

Ordering of results, lowest to highest: STOP/REWORK < RERUN < PASS. PASS requires the
canonical gate and the workflow unit both to pass and no hard stop.

## 8. Worked example — FICTIONAL

**FICTIONAL. Every number below is invented to show the arithmetic. It is not a result,
not a projection and not a target. Delete this section from any real memo.**

Fictional run: 74 sellers contacted; 30 replied; 27 screened; 24 eligible; 21 non-founder
structured interviews completed (`SI`), plus 2 founder interviews recorded and reported
separately; 6 workflow sellers enrolled (`SW`: 2 founders, 4 non-founders, each holding
a linked `SI`; the 4 non-founders are among the 21, counted once each);
12 workflows started; 1 excluded (duplicate dry-run row logged by mistake, recorded before
any buyer contact); 11 in the denominator; 10 completed; 1 abandoned after ST-01 by a
seller who said the intake was too long (kept in the denominator as a failure). 18
founder items (`FI`) published across the three arms (6 / 6 / 6), none of them in the
workflow denominator. 22 moderated sessions completed (`BM`), reported separately.

Stage results for the 11: ST-07 failed once (an operator answered "it's the 128 GB model"
without a fact; found in review; recorded as an incident); ST-09 rated 2 twice; ST-04
simulated once on a `VERIFIED RESTRICTED` surface (documented). Successful workflows: 7.

```
workflow_success_rate = 7 / 11 = 63.6%   → RERUN band
```

Fictional funnel: 131 confirmed exposed real contacts (`RC`, across the 11 workflow
listings and 18 founder items; 9 further contacts logged with exposure unconfirmed and
excluded; 14 phone-control contacts reported beside the funnel); 58 opened the page
(M-19 = 58/131 = 44.3%, above 40%); 49 entered a valid code (M-09 = 49/58 = 84.5%, 80%
or higher band); 41 started a conversation; 12 stated an amount (M-12 = 12/41 = 29.3%).
Channel evidence: two primary channels each with one `VERIFIED SUPPORTED` surface
(Test 1 pass).

Canonical gate: pass. Workflow unit: RERUN. Hard stops: the ST-07 fabrication is HS-04 —
one material fabrication reached a buyer. **Decision in this fictional case: REWORK the
operator fact-handling procedure and RERUN**, because a confirmed hard stop blocks entry
even though the canonical funnel passed. Without the HS-04 event the decision would have
been RERUN on the workflow unit alone, and the memo would say the canonical gate passed
while the seller-side workflow did not.

**FICTIONAL — end of example.**
