# Data dictionary

Every field collected during Slice 0. Sensitivity classes follow
`security/DATA_AND_PRIVACY.md` §2 (P0 public, P1 internal, P2 confidential, P3
protected, P4 secret). Storage: **PS** = protected store only; **PS→R** = protected
store, and a redacted or aggregated copy may be committed; **R** = repository template.
Retention codes: **A** = deleted within 90 days after the memo is signed;
**B** = study record, kept. A field not listed here is not collected (consent script
DM-1).

## 1. Recruitment log (PS)

| Field | Type | Allowed values | Stage | Required | Sensitivity | Storage | Retention | Metric |
|---|---|---|---|---|---|---|---|---|
| contact_ref | text | free (name or handle) | recruitment | yes | P2 | PS (ID map only) | A | M-01 |
| outreach_channel | enum | network / community_in_person / forum / prior_purchase_contact / creator / other | recruitment | yes | P1 | PS→R (aggregate) | B | M-01 |
| outreach_date | date | ISO date | recruitment | yes | P1 | PS→R | B | M-01 |
| replied | bool | yes / no | recruitment | yes | P1 | PS→R | B | M-01 |
| screening_completed | bool | yes / no | screening | yes | P1 | PS→R | B | M-02 |
| SQ-1 … SQ-8 | text / enum | per `RECRUITMENT_PLAN.md` §6 | screening | yes | P2 | PS | A | M-02, H-01 |
| eligible | bool | yes / no | screening | yes | P1 | PS→R | B | M-02 |
| exclusion_rule | enum | X-1 … X-6 / none | screening | if not eligible | P1 | PS→R | B | M-02 |
| enrolled | bool | yes / no | consent | yes | P1 | PS→R | B | M-01 |
| participant_id | id | S-nn / B-nn | consent | yes | P1 | PS→R | B | all |
| relationship | enum | none / founder / family / team | consent | yes | P1 | PS→R | B | B-1 |
| notice_version | text | version tag | consent | yes | P1 | PS→R | B | HS-06 |
| audio_consent | bool | yes / no | consent | yes | P1 | PS | A | — |
| screenshot_consent | bool | yes / no | consent | yes | P1 | PS | A | DM-8 |
| gesture_stated | bool | yes / no | consent | yes | P1 | PS | A | — |

## 2. Seller interview record (PS; coded fields PS→R)

| Field | Type | Allowed values | Stage | Required | Sensitivity | Storage | Retention | Metric |
|---|---|---|---|---|---|---|---|---|
| IV-01 … IV-32 | text | verbatim notes | interview | yes | P2 (may contain P3 in free text) | PS | A | H-01, H-09, H-10 |
| conversations_per_month | int | ≥ 0 (coded from IV-07, IV-09) | interview | yes | P1 | PS→R | B | H-01 |
| message_load_top_two | bool | yes / no (coded from IV-10 to IV-12) | interview | yes | P1 | PS→R | B | H-01 |
| baseline_prepare_min | int | minutes (from IV-08) | interview | yes | P1 | PS→R | B | M-05 |
| asked_auto_accept | bool | yes / no | interview or workflow | yes | P1 | PS→R | B | H-09 |
| wtp_amount_named | int | CAD per month, or blank | interview | no | P2 | PS→R (banded: <20, 20–28, 29–39, 40–59, 60–79, 80+) | B | M-17, `BIZ-092` |
| tier_selected | enum | none / FREE / RESELLER / PRO | interview | no | P1 | PS→R | B | M-17 |
| commitment_level | int | 0 … 5 | interview | yes | P1 | PS→R | B | M-17 |
| commitment_evidence_ref | id | EV-nnnn (signed note, scheduled date) | interview | if level ≥ 3 | P2 | PS (raw) / R (hash) | A raw, B hash | M-17 |
| interview_completed | bool | yes / no | interview | yes | P1 | PS→R | B | — |
| interview_deviation | text | free | interview | no | P1 | PS→R | B | B-5 |

## 3. Seller scorecard (`SELLER_SCORECARD_TEMPLATE.csv`; PS→R)

| Field | Type | Allowed values | Stage | Required | Sensitivity | Storage | Retention | Metric |
|---|---|---|---|---|---|---|---|---|
| workflow_id | id | WF-nn | start | yes | P1 | PS→R | B | all |
| seller_id | id | S-nn | start | yes | P1 | PS→R | B | all |
| relationship | enum | none / founder / family / team | start | yes | P1 | PS→R | B | B-1 |
| category | text | seller's category word (e.g. electronics, clothing, furniture, tools, kids, other) | start | yes | P1 | PS→R | B | B-6 |
| channel_key | enum | `INT-052` keys | ST-04 | yes | P1 | PS→R | B | M-08, M-18 |
| placement_surface | enum | listing_body / reply_message / profile_field / own_landing_page / qr_image / manual_share / code_only / none | ST-04 | yes | P1 | PS→R | B | M-08 |
| price_band | enum | <50 / 50–149 / 150–499 / 500+ (listing currency, asking price) | ST-01 | yes | P1 | PS→R | B | B-9 |
| started_date | date | ISO | start | yes | P1 | PS→R | B | — |
| stage_reached | int | 0 … 10 | ongoing | yes | P1 | PS→R | B | M-03 |
| fact_fields_populated | int | 0 … 14 | ST-01 | yes | P1 | PS→R | B | M-22 |
| photos_supplied | int | ≥ 0 | ST-01 | yes | P1 | PS→R | B | H-02 |
| asked_inference | bool | yes / no | ST-01 | yes | P1 | PS→R | B | H-02 |
| t_prepare_min | int | minutes | ST-03 | yes | P1 | PS→R | B | M-04, M-05 |
| baseline_prepare_min | int | minutes (copied from interview) | ST-03 | yes | P1 | PS→R | B | M-05 |
| t_draft_min | int | minutes | ST-02 | yes | P1 | PS→R | B | — |
| draft_check_findings | text | count plus V-codes, e.g. `2: V-01, V-04` or `0` | ST-02 | yes | P1 | PS→R | B | M-07 |
| seller_action | enum | accept / edit / restore / none | ST-03 | yes | P1 | PS→R | B | M-06 |
| edits_made | int | ≥ 0 | ST-03 | yes | P1 | PS→R | B | M-06 |
| seller_flagged_addition | bool | yes / no | ST-03 | yes | P1 | PS→R | B | M-07 |
| seller_copy_rating | int | 1 … 5 | ST-03 | yes | P1 | PS→R | B | H-03 |
| published | enum | yes / rejected / simulated / not_attempted | ST-04 | yes | P1 | PS→R | B | M-03, M-08 |
| t_publish_min | int | minutes | ST-04 | if attempted | P1 | PS→R | B | H-04 |
| url_code_visible_48h | enum | yes / no / unknown / not_applicable | ST-05 | yes | P1 | PS→R | B | M-08 |
| buyer_access_tested | bool | yes / no | ST-05 | yes | P1 | PS→R | B | ST-05 |
| buyer_interaction_completed | bool | yes / no | ST-06 | yes | P1 | PS→R | B | ST-06 |
| invented_fact_found | bool | yes / no | ST-07 review | yes | P1 | PS→R | B | M-07, HS-04 |
| offer_occurred | bool | yes / no | ST-08 | yes | P1 | PS→R | B | M-12 |
| commitment_before_approval | bool | yes / no | ST-08 review | yes | P1 | PS→R | B | HS-05 |
| summary_delivered | bool | yes / no / not_applicable | ST-09 | yes | P1 | PS→R | B | M-13 |
| t_offer_to_decision_min | int | minutes, or blank | ST-09 | if summary delivered | P1 | PS→R | B | M-13, `ASM-05` |
| seller_decision | enum | approve / decline / counter / ignore / none | ST-09 | if summary delivered | P1 | PS→R | B | M-13 |
| seller_summary_rating | int | 1 … 5, or blank | ST-09 | if summary delivered | P1 | PS→R | B | ST-09 |
| asked_auto_accept | bool | yes / no | any | yes | P1 | PS→R | B | H-09 |
| critical_incident | bool | yes / no | ST-10 review | yes | P1 | PS→R | B | ST-10 |
| st01 … st10 | enum | pass / fail / not_reached | ST-10 review | yes | P1 | PS→R | B | workflow success |
| workflow_completed | bool | yes / no | close | yes | P1 | PS→R | B | M-03 |
| excluded | bool | yes / no | close | yes | P1 | PS→R | B | §6 exclusions |
| exclusion_reason | text | per `SLICE_0_SCORECARD.md` §6 | close | if excluded | P1 | PS→R | B | §6 |
| exclusion_decided_before_outcome | bool | yes / no | close | if excluded | P1 | PS→R | B | §6 |
| withdrawn | bool | yes / no | any | yes | P1 | PS→R | B | consent §5 |
| notes_ref | id | EV-nnnn of the observation notes | close | no | P1 | PS→R | B | — |

Stopwatch log (PS): `t0`, `t_facts_start`, `t_facts_end`, `t_review_end`, `t_publish_*`
timestamps — P1, retention A, source of every `t_*` field.

## 4. Buyer scorecard (`BUYER_SCORECARD_TEMPLATE.csv`; PS→R)

| Field | Type | Allowed values | Stage | Required | Sensitivity | Storage | Retention | Metric |
|---|---|---|---|---|---|---|---|---|
| contact_id | id | R-nnnn / B-nn | entry | yes | P1 | PS→R | B | all |
| population | enum | real / moderated | entry | yes | P1 | PS→R | B | denominators |
| workflow_id | id | WF-nn | entry | yes | P1 | PS→R | B | M-21 |
| channel_key | enum | `INT-052` keys | entry | yes for real | P1 | PS→R | B | B-7 |
| session_date | date | ISO | entry | yes | P1 | PS→R | B | — |
| exposure_confirmed | bool | yes / no | entry | yes for real | P1 | PS→R | B | M-19 (OVQ-05) |
| opened_url | enum | yes / no / helped | entry | yes | P1 | PS→R | B | M-19 |
| t_to_open_s | int | seconds | entry | moderated | P1 | PS→R | B | H-06 |
| preview_noticed | text | verbatim or none | entry | moderated | P2 | PS (verbatim) / R (coded yes/no) | A / B | H-06 |
| code_attempts | int | ≥ 0 | gate | yes | P1 | PS→R | B | H-06 |
| code_entered | enum | yes / no / helped | gate | yes | P1 | PS→R | B | M-09 |
| helped | bool | yes / no | any | moderated | P1 | PS→R | B | B-2 |
| t_to_code_s | int | seconds | gate | moderated | P1 | PS→R | B | H-06 |
| first_message_sent | bool | yes / no | conversation | yes | P1 | PS→R | B | M-20 |
| buyer_messages | int | ≥ 0 | conversation | yes | P1 | PS→R | B | M-21 |
| operator_messages | int | ≥ 0 | conversation | yes | P1 | PS→R | B | M-14, M-15 |
| questions_asked | int | ≥ 0 | conversation | yes | P1 | PS→R | B | M-10 |
| questions_answered_fact | int | ≥ 0 | conversation | yes | P1 | PS→R | B | M-10 |
| questions_unknown | int | ≥ 0 | conversation | yes | P1 | PS→R | B | M-10, H-07 |
| unknown_prompted | bool | yes / no | conversation | moderated | P1 | PS→R | B | B-5 |
| unknown_asked_seller | bool | yes / no / not_applicable | conversation | yes | P1 | PS→R | B | H-07 |
| question_completion_ok | int | ≥ 0 (questions completed per M-10) | review | yes | P1 | PS→R | B | M-10 |
| confusion_markers | text | codes: code_purpose / scam / login / buy_on_page / stopped_gate / other / none | any | yes | P1 | PS→R | B | M-11 |
| scam_mention | bool | yes / no | any | yes | P1 | PS→R | B | `RISK-05` |
| asked_human | bool | yes / no | conversation | yes | P1 | PS→R | B | OVQ-01 |
| asked_is_deal | bool | yes / no | conversation | yes | P1 | PS→R | B | HS-05 watch |
| offer_made | bool | yes / no | conversation | yes | P1 | PS→R | B | M-12 |
| offer_amount_band | enum | <70 / 70–89 / 90–99 / asking / above / none (share of asking) | conversation | if offer | P1 | PS→R | B | M-12 |
| offer_conditions | text | codes: pickup / delivery / include_item / hold / other / none | conversation | if offer | P1 | PS→R | B | M-12 |
| manual_interventions | int | ≥ 0 | review | yes | P1 | PS→R | B | M-14 |
| safety_interventions | int | ≥ 0 | review | yes | P1 | PS→R | B | M-15 |
| trust_signal | enum | positive / neutral / negative / not_asked | after | moderated | P1 | PS→R | B | H-06 |
| ai_reaction | enum | positive / neutral / negative / no_change / not_asked | after | moderated | P1 | PS→R | B | H-06, OVQ-01 |
| stopped_by_participant | bool | yes / no | any | yes | P1 | PS→R | B | M-11 |
| session_complete | bool | yes / no | close | yes | P1 | PS→R | B | denominators |
| incident_ref | id | INC-nnn or none | any | no | P1 | PS→R | B | HS review |
| notes_ref | id | EV-nnnn | close | no | P1 | PS→R | B | — |

Raw conversation transcript (PS): P2, treated as P3 (`DATA-268`), retention A. Optional
pilot reply channel (OVQ-02): P2, PS only, deleted with the transcript, never in any row.

## 5. Marketplace evidence (`MARKETPLACE_EVIDENCE_TEMPLATE.csv`; PS→R)

Procedure and meaning of each field are in `MARKETPLACE_FEASIBILITY_PROTOCOL.md` §2.
All rows are retention B; raw screenshots they reference are A. Metrics: M-08, M-18,
Test 1, HS-01.

| Field | Type | Allowed values | Stage | Required | Sensitivity | Storage | Retention | Metric |
|---|---|---|---|---|---|---|---|---|
| channel_key | enum | `INT-052` keys | policy reading | yes | P1 | PS→R | B | M-18 |
| surface | enum | listing_body / reply_message / profile_field / own_landing_page / qr_image / manual_share / code_only | policy reading | yes | P1 | PS→R | B | M-08 |
| policy_source_url | text | the marketplace's own page address | policy reading | yes | P0 (public page) | PS→R | B | Test 1 |
| policy_source_date | date | ISO retrieval date | policy reading | yes | P1 | PS→R | B | Test 1 |
| policy_quote | text | exact quoted text, or `no explicit statement found` | policy reading | yes | P0 (quotation) | PS→R | B | Test 1 |
| policy_page_last_updated | text | as shown on the page, or `unknown` | policy reading | no | P0 | PS→R | B | `INT-025` Q9 |
| urls_permitted | enum | stated_yes / stated_no / not_addressed / unknown | policy reading | yes | P1 | PS→R | B | Test 1 |
| codes_or_text_permitted | enum | stated_yes / stated_no / not_addressed / unknown | policy reading | yes | P1 | PS→R | B | `INT-025` Q5 |
| messages_permit_flow | enum | stated_yes / stated_no / not_addressed / unknown | policy reading | yes | P1 | PS→R | B | `INT-025` Q2 |
| distinguishes_link_types | text | what the policy says, or `not_addressed` | policy reading | yes | P1 | PS→R | B | `INT-025` Q4 |
| stated_enforcement | enum | removal / warning / restriction / suspension / not_stated | policy reading | yes | P1 | PS→R | B | `INT-025` Q6 |
| visibility_test_listing | text | WF-nn, or `founder-owned:<item>` | live test | yes if tested | P1 | PS→R | B | M-08 |
| visibility_test_date | date | ISO | live test | yes if tested | P1 | PS→R | B | M-08 |
| visible_after_24h | enum | yes / no / altered / not_checked | observation | yes | P1 | PS→R | B | M-08 |
| visible_after_48h | enum | yes / no / altered / not_checked | observation | yes | P1 | PS→R | B | M-08 |
| visible_after_7d | enum | yes / no / altered / not_checked | observation | yes | P1 | PS→R | B | classification |
| mobile_behavior | enum | link_tappable / plain_text / hidden / truncated / unknown | observation | yes | P1 | PS→R | B | H-06 |
| desktop_behavior | enum | link_tappable / plain_text / hidden / truncated / unknown | observation | yes | P1 | PS→R | B | H-06 |
| moderation_outcome | enum | none_observed / removed / altered / warned / restricted / suspended (with date) | observation | yes | P1 | PS→R | B | M-18 |
| region_or_category_note | text | free, or `none` | observation | no | P1 | PS→R | B | `INT-025` Q8 |
| evidence_refs | ids | EV-nnnn list | observation | yes | P1 | PS→R | B | manifest |
| classification | enum | VERIFIED SUPPORTED / VERIFIED RESTRICTED / UNCLEAR - REQUIRES RESEARCH / NOT REQUIRED FOR MVP | classification | yes | P1 | PS→R | B | Test 1, HS-01 |
| classification_basis | text | one line naming the evidence | classification | yes | P1 | PS→R | B | Test 1 |
| reviewer | text | initials of both founders | classification | yes | P1 | PS→R | B | — |
| next_recheck_date | date | ISO, per `INT-033` | classification | yes | P1 | PS→R | B | `INT-034` |
| row_status | text | empty in a real row; holds the FICTIONAL marker in template example rows only | template | no | P1 | R | B | — |

Raw screenshots referenced by `evidence_refs` are P2 in the protected store and P1 once
masked. The `row_status` column exists in every CSV template for the same purpose and is
never filled in a real row.

## 6. Incident log (`INCIDENT_LOG_TEMPLATE.csv`; PS→R)

| Field | Type | Allowed values | Required | Sensitivity | Storage | Retention | Metric |
|---|---|---|---|---|---|---|---|
| incident_id | id | INC-nnn | yes | P1 | PS→R | B | HS review |
| date_time | datetime | ISO | yes | P1 | PS→R | B | — |
| reported_by | enum | founder_1 / founder_2 / participant | yes | P1 | PS→R | B | — |
| workflow_id, contact_id | id | WF-nn, R-nnnn / B-nn / none | yes | P1 | PS→R | B | — |
| category | enum | HS-01 … HS-09 / marketplace_enforcement / abuse / playbook_deviation / participant_complaint / other | yes | P1 | PS→R | B | M-15, HS |
| severity | enum | critical / major / minor | yes | P1 | PS→R | B | HS |
| what_happened | text | free, IDs only, no personal data | yes | P2 | PS (full) / R (redacted) | A / B | — |
| what_was_sent | text | the message text if any, redacted of personal data | if applicable | P2 | PS / R redacted | A / B | HS-04, HS-05 |
| reached_whom | enum | nobody / buyer / seller / marketplace / public | yes | P1 | PS→R | B | HS |
| immediate_action | text | free | yes | P1 | PS→R | B | — |
| participant_told | bool | yes / no / not_applicable | yes | P1 | PS→R | B | — |
| hard_stop_candidate | bool | yes / no | yes | P1 | PS→R | B | HS |
| review_date, reviewer_1, reviewer_2 | date, initials | — | yes | P1 | PS→R | B | HS |
| confirmed | enum | confirmed / not_confirmed / disputed | yes | P1 | PS→R | B | HS |
| resolution | text | free | yes | P1 | PS→R | B | — |
| evidence_refs | ids | EV-nnnn list | no | P1 | PS→R | B | — |

## 7. Evidence manifest (`EVIDENCE_MANIFEST_TEMPLATE.md`; PS→R)

Fields per that file: evidence_id (EV-nnnn), participant_id, workflow_id, evidence_type
(policy_capture / listing_screenshot / page_screenshot / draft_original /
draft_tidied / approved_copy / transcript_summary / stopwatch_log / interview_notes /
audio / commitment_note / incident_attachment / other), date, storage_location
(protected-store reference, never a public URL), sha256, redaction_status (raw /
redacted / aggregated), reviewer, notes. All P1 except storage references that reveal a
person (none permitted). Retention B for the manifest; raw items A.

## 8. Fields that must never exist

Passwords, tokens, credentials; payment details; identity documents; buyer names,
emails, phones or handles in any row; seller minimum price in any row; exact addresses;
any valuation or "worth" figure; any field marked "estimated by the founders" for a
result.
