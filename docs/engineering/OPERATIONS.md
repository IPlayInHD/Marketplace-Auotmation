# Operations and Observability

**Status:** Canonical for how the system is run, watched, alerted on and recovered.

**Authority.** `engineering/SYSTEM_REQUIREMENTS.md` states the requirements this
document operationalises; where the two touch, that document states the obligation and
this one states the practice. `security/PUBLIC_ACCESS_SECURITY.md` §7 is canonical for
logging rules on the public surface and is referenced here, not restated.
`ai/EVAL_STRATEGY.md` is canonical for pre-merge AI testing; this document covers what
happens after merge.

**No cloud provider is named.** Hosting, managed services and regions are undecided
(`D-08`, `Q-09`; the backend baseline D-17 defers hosting). This document describes
required **capabilities** — a managed relational
database with point-in-time recovery, an object store, a scheduler, a log store, a
metrics store, a secret store — and the cost-control practices that apply to any of
them. The first implementation slice records the choice as a superseding decision.

**Team assumption.** Two people, both of whom also build the product. Every practice
below is sized for two people and is rejected if it needs a third.

**Requirement IDs.** This document uses the `OPS-` prefix in a reserved
**500-block** (`OPS-500` - `OPS-699`). Blocks already taken: `OPS-001` to `OPS-034`
`ai/EVAL_STRATEGY.md` - `OPS-100` to `OPS-129` `product/PRD.md` - `OPS-200` to `OPS-314`
`product/INVENTORY_AND_SALES.md` - `OPS-400` to `OPS-449` `business/UNIT_ECONOMICS.md` -
`OPS-700` to `OPS-799` `engineering/SYSTEM_REQUIREMENTS.md`. `business/UNIT_ECONOMICS.md`
§9 is canonical for the metering and cost-model requirements; §10 below operationalises
them and does not redefine them.

---

## 1. Environments

| Environment | Purpose | Data | Who reaches it | Model provider |
|---|---|---|---|---|
| `local` | Development | Synthetic fixtures only | The developer | Stubbed by default; live behind an explicit flag |
| `ci` | Automated tests and the blocking eval suite | Synthetic fixtures only | Nobody interactively | Stubbed or a pinned live tier, per `Q-EV-02` |
| `staging` | Pre-release verification, load tests, restore drills | Synthetic and redacted data only | Both operators | Live, on a separate key with its own budget |
| `production` | Real sellers and buyers | Real data | Both operators, audited | Live |

`OPS-500` Production data is never copied into any other environment. Staging is seeded
from a generator, and from redacted, paraphrased production derivatives only where a
fixture requires realism (`OPS-012`, `OPS-023`, `DATA-110`).
`OPS-501` Each environment has its own credentials, its own model-provider key, its own
budget and its own object storage. No credential is shared across environments.
`OPS-502` Staging is a smaller shape of production, not a different shape. A capability
absent from staging cannot be relied on in production.
`OPS-503` Every environment is reproducible from version-controlled configuration. An
environment that exists only as a sequence of console clicks is a defect.
`OPS-504` Production access by a person is through short-lived credentials, is audited
(`OPS-788`), and is never a shared account.
`OPS-505` There is no fourth environment. A two-person team that maintains four
environments maintains three of them badly.

## 2. Deployment posture

`OPS-510` One deployable, deployed as a whole (`D-01`). Workers and web processes run
the same build with different entry points.

| Rule | Statement |
|---|---|
| OPS-511 | Deploys are automated from the default branch. A manual deploy path exists for recovery and is exercised in the restore drill (§11). |
| OPS-512 | The blocking eval suite and the unit and integration suites gate the deploy (`AI-218`). A red default branch is not deployed. |
| OPS-513 | Schema migrations are forward-only, run before the new code, and must be compatible with the previous release still running. Two-phase changes: add, backfill, switch reads, stop writes, drop — each a separate deploy. |
| OPS-514 | Rollback is by deploying the previous build. A migration is never rolled back; it is compensated by a new forward migration. |
| OPS-515 | Deploys drain in-flight turns (`OPS-773`). A turn interrupted by a deploy is retried, never lost. |
| OPS-516 | Every deploy is announced to the metrics store as an annotation, so a graph shows what changed and when. |
| OPS-517 | Behaviour changes ship behind a flag when they can. The kill switches of `OPS-030` are the two flags that must always exist and must never depend on a deploy. |
| OPS-518 | Deploy during the working day, both operators awake, never on a Friday evening, and never while the other operator is unreachable. This is a rule, not a preference: a two-person team has no second responder. |
| OPS-519 | A release records: the build id, the migrations included, the prompt and prompt-version changes included, the model or tier changes included, and the eval scoreboard delta (`EVAL_STRATEGY.md` §7). |
| OPS-520 | A change to a prompt, a tier or a routing rule is a release like any other. It is not configuration to be edited in a console. |
| OPS-521 | The smallest reliable deployment is at least one `web` process and one `worker` process. Replica counts are not fixed in advance; they follow measured demand (D-17). |

### 2.1 pg-boss operating rule

The job queue is pg-boss (D-17, accepted on the evidence of `spikes/backend-foundation/`).
It is a single-maintainer dependency (`RISK-24`) that installs its own schema, so it is
operated under one rule, enforced in the build and in the database rather than by habit.

| ID | Rule |
|---|---|
| OPS-522 | **Pinned and reviewed.** pg-boss is pinned to an exact version in the dependency manifest and the lockfile is committed (`SEC-380`); builds install from the lockfile only. No automatic dependency upgrade — by bot, by version range or through a transitive dependency — may change the pg-boss version. A candidate upgrade is a reviewed change: its changelog and every schema migration it carries are read before it is proposed, and the change record cites both. The dependency's health — release activity, open security issues, maintainer responsiveness — is reviewed at least monthly with the risk register (`BIZ-204`, `RISK-24`) and again before every upgrade. |
| OPS-523 | **Migration and runtime separation.** The pg-boss schema is installed and upgraded only by the migration/owner role, through the pg-boss CLI (`create`, `migrate`, with `plans --dry-run` for review) or an equivalent controlled migration step, never by a running `web` or `worker` process. Runtime instances start with schema migration disabled (`migrate: false`), so an instance that meets a pending migration refuses to start instead of migrating. Runtime roles own no pg-boss object and hold no DDL privilege (`OPS-716`); their access is DML only, and the schema-version table is read-only to them. Queue topology — creating, deleting or repartitioning a queue, and changing a queue's retry, expiry, heartbeat or retention policy — is a migration under this rule: applied by the migration role and reviewed like any other. Before a schema upgrade runs: a backup exists and its recovery has been planned (`OPS-695` to `OPS-699`); a rollback or forward-recovery plan has been written and tested against a copy; and the complete foundation spike suite (`spikes/backend-foundation/`, 54 tests) has passed against the candidate version on the production PostgreSQL major version. |
| OPS-524 | **Reconsideration triggers.** pg-boss is reconsidered as a decision, not patched around, when any of these occurs: maintenance stops or security fixes go unmerged; an unresolved security issue stands against the pinned version; PostgreSQL coupling becomes an operational bottleneck (`OPS-543`, `OPS-757`); upgrade safety can no longer be demonstrated by the procedure in `OPS-523`; or a queue behaviour the system relies on — transactional enqueue, retry with backoff, expiry and heartbeat redelivery, dead-lettering — stops being supported. The response is a superseding entry in `decisions/DECISION_LOG.md`. The queue sits behind one internal interface so that a replacement PostgreSQL-backed queue is a bounded change (`ARCH-001`, `OPS-701`). |

## 3. What the operator sees first

`OPS-525` One dashboard, one screen, answering four questions in this order: **is the
buyer surface up, is the agent behaving, what is it costing, and is anyone attacking
it.** Everything else is a drill-down. A dashboard that needs scrolling to answer those
four is not the first dashboard.

---

## 4. Metrics that matter

Metric names below are logical. Every metric carries the labels `env`, and where
meaningful `seller_id`, `listing_id`, `tier` and `reason_code`. High-cardinality labels
(`listing_id`, `seller_id`) are recorded on aggregates and on exemplars, not on every
series (§5 log-volume rules apply equally to metric cardinality).

### 4.1 Product

| ID | Metric | Definition | Why it is watched |
|---|---|---|---|
| OPS-526 | `link_opens` | Buyer preview page loads per listing | The numerator of `ASM-01`, the assumption the business rests on |
| OPS-527 | `code_entry_rate` | Code submissions / preview loads | Measures whether the gate is survivable |
| OPS-528 | `code_success_rate` | Successful validations / submissions | A fall means confusing copy, a rotated code on a live ad, or an attack |
| OPS-529 | `conversation_start_rate` | Conversations with at least one buyer message / sessions created | Distinguishes a session from a real conversation |
| OPS-530 | `messages_per_conversation` | Distribution, not mean | A long tail is a cost signal and a confusion signal |
| OPS-531 | `offer_rate` | Conversations producing at least one `OfferVersion` / conversations | The product's core conversion |
| OPS-532 | `seller_actions_per_listing` | Action-required items raised per listing | The noise-reduction claim, and lower is better (`MASTER_PRODUCT_SPEC.md` §15) |
| OPS-533 | `time_to_seller_decision` | Offer reaching `AWAITING_SELLER` to seller decision, p50 and p90 | Measures whether the dashboard works |
| OPS-534 | `unattended_resolution_rate` | Buyer messages answered with no seller involvement / buyer messages | The core value claim, stated as one number |
| OPS-535 | `per_channel_breakdown` | Every metric above, split by per-channel access code (`BUYER-025`) | Per-marketplace conversion, free |

### 4.2 Agent health

| ID | Metric | Definition | Alarm direction |
|---|---|---|---|
| OPS-536 | `guardrail_denial_rate` | Turns with a `deny` verdict / agent turns, by check id | Watched in both directions. A sharp fall can mean the prompt learned to route around a check (`EVAL_STRATEGY.md` §7) |
| OPS-537 | `escalation_rate` | Conversations escalating at least once / conversations, by reason code | A rise means the agent's space is too narrow or a policy is misconfigured |
| OPS-538 | `regeneration_rate` | Turns needing at least one regeneration | Cost and latency leading indicator |
| OPS-539 | `fact_violation_rate` | Replies containing a product claim with no cited `ProductFact` (`G-05` denials, plus post-hoc sampling) | Target zero. Non-zero is a release blocker (`EVAL_STRATEGY.md` §7) |
| OPS-540 | `protected_disclosure_detections` | Egress redaction or post-hoc scan matched a protected pattern | Target zero. Any occurrence is an incident (`OPS-797`) |
| OPS-541 | `injection_suspected_rate` | Turns coded `INJECTION_SUSPECTED` | Feeds the fixture flywheel (`OPS-022`); a spike is an abuse signal |
| OPS-542 | `mean_concession_share` | `(asking - final agent counter) / asking`, per listing and in aggregate | The metric that catches an agreeable model. Watched in both directions (`OPS-020`, `OPS-021`) |
| OPS-543 | `holding_reply_rate` | Turns answered with a holding reply / turns | The degradation signal a buyer actually feels |
| OPS-544 | `schema_invalid_rate` | Model responses failing the proposed-action schema | Provider or prompt regression, before it becomes a latency problem |
| OPS-545 | `kill_switch_state` | Per-seller and global switch state, as a gauge | So an operator can see at a glance that the agent is off |

### 4.3 Cost

| ID | Metric | Definition |
|---|---|---|
| OPS-546 | `cost_per_conversation` | Sum of `AIInteraction` cost for a conversation, p50 and p95 |
| OPS-547 | `cost_per_active_listing` | Rolling 24h and 30d, per listing (`MASTER_PRODUCT_SPEC.md` §15) |
| OPS-548 | `cost_per_seller` | Rolling 24h and 30d, against that seller's budget (`NFR-006`) |
| OPS-549 | `tokens_by_purpose` | Input and output tokens split by `AIInteraction.purpose` and by tier |
| OPS-550 | `cache_hit_rate` | Prompt-cache hits / model calls, by prompt version (§10.5) |
| OPS-551 | `tier_mix` | Share of turns by tier, with the escalation trigger that caused each escalation |
| OPS-552 | `provider_reconciliation_delta` | Internal recorded cost versus provider-reported usage (`INT-111`) |
| OPS-553 | `storage_bytes` | Object storage total and monthly growth, split by originals and derivatives |
| OPS-554 | `log_bytes_per_day` | Log volume, because logs are the second bill after the model (§10.8) |

### 4.4 Abuse

| ID | Metric | Definition |
|---|---|---|
| OPS-555 | `code_failures_per_listing` | Failed code attempts per listing per hour |
| OPS-556 | `code_failures_per_client` | Failed attempts per hashed client identifier per hour (`SEC-043`) |
| OPS-557 | `lockouts` | Lockouts applied, per listing and in total (`BUYER-011`) |
| OPS-558 | `public_id_404_rate` | Not-found responses on the public route tree per client — the enumeration signal (`T-02`) |
| OPS-559 | `session_creation_rate` | New buyer sessions per listing per hour, and the same per client |
| OPS-560 | `messages_per_session_rate` | Buyer messages per session per minute — the cost-abuse signal (`T-04`) |
| OPS-561 | `authz_failures` | Authorization denials by route (`AUTH-227`) — the IDOR probing signal |
| OPS-562 | `signin_failures` | Failed sign-ins per account and per client — the credential-stuffing signal |

---

## 5. Structured logging

`OPS-563` Logs are structured records with a fixed field set, not sentences. A log line
that has to be read by a human to be understood cannot be aggregated, alerted on or
sampled.

### 5.1 What is never logged

| ID | Rule |
|---|---|
| OPS-564 | **Never** a prompt, a system prompt, a model completion, or any fragment of either (`ARCH` module 21). |
| OPS-565 | **Never** a conversation transcript or any buyer message body. Transcripts live in their own store with their own retention (`SEC-042`, `OPS-719`). |
| OPS-566 | **Never** an access code, in any field, including error messages, analytics and audit payloads (`SEC-040`). |
| OPS-567 | **Never** a session token, a password, a reset token or a provider key. Not in a URL, not in a header dump, not in an exception (`SEC-041`). |
| OPS-568 | **Never** a raw client IP beyond the short window rate limiting needs; a hashed client identifier is stored instead (`SEC-043`). |
| OPS-569 | **Never** the minimum price, target price, concession limit or auto-decline threshold. They are protected wherever they appear, including in an operator's log (`AUTH-INV-08`). |
| OPS-570 | **Never** a seller's exact address, contact details or acquisition cost. |

`OPS-571` A single automated test scrapes the log corpus produced by a full end-to-end
run against the forbidden-pattern set above and fails the build on a match (`OPS-790`).
This is the control. The rules above are how the control is satisfied, not a substitute
for it.

### 5.2 What is logged instead

| Instead of | Log this |
|---|---|
| The buyer message | `conversation_id`, `sequence`, `length_bucket`, `contains_price_mention` (the deterministic pre-pass of `AI-032`), `language_detected` |
| The prompt | `prompt_version`, `context_block_ids`, `token_count_in`, `permitted_intents`, `range_width` — never the range values |
| The completion | `intent`, `proposed_price_present` (boolean), `cited_fact_id_count`, `token_count_out` |
| The guardrail decision | `verdict`, `check_id`, `reason_code`, `regeneration_index` |
| The access code | `access_code_version`, `result` (`ok`, `mismatch`, `locked`), never the digits |
| The client | `client_hash`, `user_agent_class`, `country_code` if available |
| The seller | `seller_id`; never name, email or address |

`OPS-572` Every log record carries `request_id`, `env`, `release`, `module` and
`severity`. `request_id` is the join key between logs, traces, jobs, model calls and
audit events (`OPS-791`).
`OPS-573` Exceptions log a type, a message with no interpolated data, a stack trace and
a `request_id`. Interpolating data into an exception message is how transcripts end up
in logs.

### 5.3 Sample, do not log everything

`OPS-574` The default is to sample. Logging every event at two people's scale produces a
bill and a haystack, not evidence.

| Class | Policy |
|---|---|
| Errors and exceptions | 100% |
| Guardrail `deny`, `escalate`, `substitute` | 100% — these are the highest-information events in the system (`OPS-022`) |
| Authorization failures, lockouts, kill-switch changes, tenant-isolation errors | 100% |
| Consequential actions (approval, code lifecycle, deal state) | 100%, and they are audit events as well as logs |
| Successful agent turns | 5%, head-based, sampled by `request_id` so a sampled turn keeps its whole trace |
| Buyer preview page loads | 1%, plus a counter at 100% |
| Successful reads on the seller dashboard | 1%, plus a counter at 100% |
| Job success | Counter only; log on retry and on dead-letter |

`OPS-575` Sampling is head-based and consistent: a decision made once per `request_id`
and honoured by every component, so a sampled request is never half-recorded.
`OPS-576` A per-request log-line budget is enforced. A request that would exceed it logs
a single truncation record instead (`OPS-798`). Unbounded logging is a denial-of-service
vector against the operator's budget and attention.
`OPS-577` Log retention is 30 days hot and 90 days cold, shorter than transcript
retention (`DATA-109`). Audit events are not logs and follow
`security/DATA_AND_PRIVACY.md`.

## 6. Tracing

`OPS-578` Every buyer turn is one trace, spanning: request accepted, idempotency and
lock, context assembly, policy evaluation, model call, guardrail evaluation, egress
redaction, persistence, outbox enqueue, send (`OPS-794`).

| ID | Rule |
|---|---|
| OPS-579 | Span attributes carry the same fields as logs and obey the same prohibitions. A trace is a log with a shape; §5.1 applies to it in full. |
| OPS-580 | The model call is its own span with `tier`, `prompt_version`, `token_count_in`, `token_count_out`, `cache_hit`, `retry_index` and `latency_ms`. |
| OPS-581 | Traces propagate into queued jobs. A turn that completes asynchronously is one trace, not two. |
| OPS-582 | Sampling is 100% for any trace containing an error, a `deny`, an `escalate` or a latency over the `NFR-002` target, and 5% otherwise, consistent with `OPS-575`. |
| OPS-583 | Every stage has a latency budget, so a `NFR-002` breach is attributable to a stage rather than to the system (`OPS-758`). |
| OPS-584 | The approval execution transaction is a trace with a span per assertion, so an `INVALIDATED` outcome names the assertion that failed without a code read. |

---

## 7. Alerting

`OPS-590` Every alert states three things in its own text: what is happening, what it
means, and what to do. An alert that requires a person to work out its meaning at 3am
will be ignored at 3am.

`OPS-591` Two severities only. **Page** wakes a human. **Ticket** waits for the working
day. There is no third severity, because a two-person team cannot maintain the
discipline of one.

### 7.1 Page — wakes a human

| ID | Alert | Threshold | What it means | First action |
|---|---|---|---|---|
| OPS-592 | Buyer surface down | External synthetic check fails from two locations for 3 consecutive minutes | Buyers cannot reach any listing. Every seller's live ads are dead links. | §9.1 if provider-related; otherwise check the preview path first — it must survive everything else (`OPS-770`) |
| OPS-593 | Protected disclosure detected | Any single occurrence | Egress redaction or a post-hoc scan matched a protected pattern in buyer-visible text. This is a breach of `AUTH-INV-08`. | Global kill switch, then §9.4 |
| OPS-594 | Tenant isolation failure | Any single occurrence | A query returned or nearly returned another seller's data (`SEC-108`) | Take the affected route out of service; treat as a data incident (§9.7 notification path) |
| OPS-595 | Approval integrity anomaly | Any reconciliation finding from `OPS-728` | A listing is in `PENDING_SALE` without an executed approval, or an approval executed without its state change. Money is involved. | §9.5 |
| OPS-596 | Double-sell detected | Two `APPROVED` offers on one listing, any occurrence | `AUTH-INV-11` has failed | §9.5, and stop approvals globally until understood |
| OPS-597 | Cost circuit breaker tripped globally | Global spend crosses the daily ceiling | The platform is in holding mode for everyone; buyers are getting holding replies | §9.2 |
| OPS-598 | Model provider fully unavailable | Error rate above 50% for 5 minutes across both providers, or 100% for 3 minutes on the only configured provider | Every conversation is degrading to holding replies | §9.1 |
| OPS-599 | Database unavailable or replication broken | Connection failures for 2 minutes, or replica lag above 5 minutes | Everything is at risk, including the ability to record what happened | Restore posture (§11); do not deploy |
| OPS-600 | Sustained abuse on the public surface | Code failures above 500/hour platform-wide, or session creation above 10× the trailing 7-day peak | An attack in progress, with cost consequences | §9.3 |

### 7.2 Ticket — waits until morning

| ID | Alert | Threshold | What it means |
|---|---|---|---|
| OPS-601 | Per-seller budget breached | A seller crosses their daily budget | That seller's agent is degrading; they need to hear from a person, not at 3am |
| OPS-602 | Per-listing cost outlier | A listing exceeds 5× the 7-day median cost per listing | Usually a long conversation; occasionally abuse |
| OPS-603 | Guardrail denial rate moved | Rate changes by more than 50% relative, week over week, in either direction | Either the model is drifting or a check stopped firing (`OPS-536`) |
| OPS-604 | Escalation rate rise | Above 25% of conversations, sustained for 24 hours | Policy is too narrow, or a prompt regression |
| OPS-605 | Fact-violation detected | Any occurrence found by post-hoc sampling | Release blocker for the next release; fixture within the week (`OPS-025`) |
| OPS-606 | Dead-letter queue non-empty | Any message older than 1 hour | Work is being lost silently unless someone looks |
| OPS-607 | Latency target missed | p95 above `NFR-002` for 30 minutes | Buyers are getting holding replies that a faster system would not need |
| OPS-608 | Brute force on one listing | Above 50 failed attempts on one listing in an hour | One listing under attack; the prize is a public conversation surface (`T-01`), so this is not a page |
| OPS-609 | Backup or restore drill failure | Any failed backup, or a drill missing its RPO/RTO | The recovery story is fiction until proven (§11) |
| OPS-610 | Nightly eval failure | Any failing case tagged `blocking` | The default branch is treated as broken (`OPS-017`) |
| OPS-611 | Provider reconciliation drift | Above 5% between internal and provider-reported cost | Metering is wrong, and unit economics are built on it (`OPS-552`) |

`OPS-612` An alert that fires more than twice in a month without an action being taken
is deleted or its threshold is changed. Alert fatigue in a two-person team is a
security control failure, not an annoyance.
`OPS-613` Every alert is tested by deliberate injection before it is relied on
(`OPS-795`), and the injection is repeated after any change to its query.

## 8. On-call, honestly, for two people

`OPS-614` There is no on-call rotation, because two people cannot sustain one. There is
a **primary for the week** who is expected to be reachable, and a stated agreement that
the other is not.

| Reality | Consequence |
|---|---|
| Nobody is awake at 3am reliably | The page list in §7.1 is short on purpose, and every page must be actionable by one tired person with a phone |
| There is no escalation tier | A page that cannot be handled by the person who receives it is a design failure, not a staffing problem |
| Both people also write the product | Interrupt cost is the real cost. A ticket that could have been a dashboard is a bad trade |
| Vacations happen | Before either person is unreachable for more than a day, the global kill switch procedure is rehearsed by the other |

`OPS-615` **The 3am test.** A condition pages only if all three hold: it is losing money
or leaking data right now, it will not self-heal, and there is an action a single person
can take from a phone in under ten minutes. Everything else is a ticket.

| Pages | Waits |
|---|---|
| Buyer surface down | One seller's listing behaving oddly |
| Protected disclosure | A rising escalation rate |
| Tenant isolation failure | A cost outlier on one listing |
| Approval or double-sell integrity | A dead-letter message |
| Global cost breaker tripped | A per-seller budget breach |
| Total model provider outage | A degraded but working provider |
| Database down | Slow queries |
| Platform-wide abuse | Brute force against one listing |

`OPS-616` The action available from a phone is, in nearly every case, one of four:
activate the global kill switch, activate a per-seller kill switch, tighten a rate limit,
or roll back the last release. All four work without a deploy (`OPS-774`, `OPS-514`).
`OPS-617` Every page writes an incident record with: what fired, what was seen, what was
done, what the customer impact was, and one follow-up action. Five sentences is a
complete incident record at this scale. A postmortem nobody writes is worse than a short
one somebody does.
`OPS-618` The follow-up action from an incident is scheduled in the next working week or
it is explicitly dropped with a reason. A backlog of unscheduled follow-ups is how a
two-person team stops learning from incidents.

---

## 9. Runbooks

Each runbook states the signal, the immediate action, the investigation, the
communication, and what to fix afterwards. They assume one person acting alone.

### 9.1 Model provider outage

| Step | Action |
|---|---|
| Signal | `OPS-598`; `schema_invalid_rate` or provider error rate rising; `holding_reply_rate` climbing |
| Confirm | Check the provider's status surface and one manual call from a shell. Distinguish total outage, elevated latency, and a change in the response shape — the third looks like an outage and is a release problem |
| Immediate | The system already degrades on its own (`ARCH` §9, `OPS-767`): retry, then secondary provider, then holding reply plus seller notification. Confirm the degradation happened rather than assuming it |
| If a secondary provider is configured | Switch routing to it. Then check `mean_concession_share` and `guardrail_denial_rate` within the hour — a different model on the same prompt is a behaviour change, not a drop-in (`EVAL_STRATEGY.md` §6 pre-release) |
| If not | Activate the global kill switch (`OPS-030`). Conversations move to `SELLER_HANDLING`; buyers see `FT-05` then the seller. No message is dropped (`OPS-765`) |
| Communicate | Sellers with active conversations are notified in-product that the agent is paused and their buyers are being told the seller will reply. Buyers are told nothing beyond `FT-05` — they are not our audience for an incident |
| Do not | Do not lower the tier to a model that has not passed the pre-release suite. Do not disable the guardrail engine to "get replies out". Do not let the agent answer from a degraded provider without validation |
| Afterwards | If the outage exceeded one hour, `Q-EV-02`-style provider redundancy stops being optional; record a decision |

`OPS-625` A provider outage never justifies bypassing the guardrail engine. The engine
is deterministic and local; it is not the thing that failed.

### 9.2 Cost spike

| Step | Action |
|---|---|
| Signal | `OPS-597` (global) or `OPS-601`/`OPS-602` (scoped); `cost_per_conversation` p95 rising |
| Classify in this order | (1) Abuse — one listing or one client driving volume; (2) Regression — `regeneration_rate` or `tokens_by_purpose` up after a release; (3) Genuine growth; (4) Metering error (`OPS-552`) |
| Abuse | Apply §9.3. Tighten the per-session message limit and the per-listing session limit first; they are the cheapest levers (`SEC-010`) |
| Regression | Compare `tokens_by_purpose` and `tier_mix` against the last release annotation (`OPS-516`). A prompt that grew, a cache that stopped hitting, or a routing rule that escalates too eagerly are the three usual causes. Roll back if it maps to one release |
| Growth | Confirm against `link_opens` and `conversation_start_rate`. Growth that shows in cost but not in conversations is not growth |
| Metering error | Reconcile against provider-reported usage before acting on a number that may be wrong |
| Immediate ceiling | The circuit breaker already degrades tier, then degrades to holding mode (`AI-216`, `OPS-769`). Confirm it engaged at the level expected |
| Communicate | A seller whose agent degraded is told plainly what happened and what it means for their listings |
| Afterwards | Adjust the budget or the limit deliberately, and record why. A budget quietly raised after every spike is not a budget |

### 9.3 Brute-force attack on a listing

| Step | Action |
|---|---|
| Signal | `OPS-608` (one listing) or `OPS-600` (platform-wide); `code_failures_per_listing`, `lockouts`, `public_id_404_rate` |
| Frame it correctly | The prize is a **public conversation surface** (`SEC-001`, `D-03`). The code is not a secret. This is a cost and noise problem, not a confidentiality breach — unless it is paired with `OPS-593` or `OPS-594`, which is a different incident |
| Immediate | Confirm the layered limits engaged: per-IP, per-listing, per-session, per-listing session creation (`SEC-010`). Tighten the per-listing bucket for the affected listing |
| If the code is circulating | Rotate the code (`ACCESS-010`). Tell the seller their marketplace ad needs the new code, and that the URL is unchanged (`BUYER-003`) |
| If the attacker has the code | Rotation still helps: it invalidates the copies already circulating. Revocation closes the surface and costs the seller their live ad, so it is the seller's choice (`ACCESS-011`) |
| Watch for the real objective | Enumeration of public ids (`OPS-558`), cost burn (`OPS-560`), or an injection campaign (`OPS-541`). The code attempts may be noise around one of those |
| Communicate | The seller is told what was seen, what was done, and that nothing behind the code was sensitive |
| Do not | Do not reveal remaining attempts, lockout state or whether a code exists, in any response (`SEC-011`, `BUYER-010`) |

### 9.4 A seller reports a wrong agent answer

| Step | Action |
|---|---|
| Signal | Seller report, in-product or by email. Also `OPS-605` when found by sampling |
| Reconstruct first | Pull the turn by `conversation_id` and `sequence`: the persisted proposed action, the guardrail decision, the policy version, the cited fact ids and the cost (`AI-217`). Every past reply is explicable against the rules that applied when it was generated (`AI-030`) |
| Classify | (1) **Fabricated fact** — a claim with no cited `ProductFact`. (2) **Policy breach** — something `G-01` to `G-15` should have caught. (3) **Correct but unwelcome** — the agent followed policy and the seller dislikes the policy. (4) **Stale content** — the approved content version is out of date |
| Fabricated fact | This is the most serious class (`INV-12`, `D-10`). Check whether `G-05` denied and the denial was mis-routed, or whether the citation was present but wrong. Open an incident, add a fixture the same day (`OPS-025`), and consider a per-seller kill switch until the fixture passes |
| Policy breach | Determine whether the check exists, whether it fired, and whether the reply was substituted. A check that exists and did not fire is a defect in the engine — the highest-priority class of defect in this system |
| Correct but unwelcome | Show the seller the policy version that produced it and the setting that would change it. Do not change behaviour by editing a prompt to satisfy one seller |
| Stale content | Point at the content version. The fix is a new approved version, not a prompt change |
| Always | The reported turn becomes a candidate fixture regardless of class (`OPS-022`). Reply to the seller with what happened, in plain language, naming the specific turn |

`OPS-626` The seller is never told "the AI made a mistake" as an explanation. They are
told which layer failed and what changed as a result. The product's claim is that
deterministic code, not the model, holds the boundaries; an incident is where that claim
is tested in public.

### 9.5 A disputed approval

| Step | Action |
|---|---|
| Signal | Seller says they did not approve, or approved different terms; or a buyer claims an acceptance that does not exist |
| Reconstruct | The approval record carries the offer version, the material-terms hash, the actor, the authenticated session reference, the policy version and the idempotency key (`AUTH-256`). The audit trail reconstructs what was shown, what was approved, what executed and what the agent then said (`OPS-785`) |
| The three answers | (1) An `EXECUTED` approval exists with a matching hash — the terms are what the seller approved, byte for byte (`D-06`). (2) An approval exists but was `INVALIDATED` — the reason is recorded, and no acceptance was communicated (`AUTH-245`). (3) No approval exists — no acceptance can have been communicated, because `AUTH-252` gates it |
| If the buyer claims acceptance with no approval | Check the conversation for commitment language before the approval timestamp. `AUTH-253` asserts none exists; if one does, that is an `AUTH-INV-07` failure and an incident, not a dispute |
| If the hash mismatches what the seller remembers | The seller saw a rendering; the hash was computed from it (`AUTH-242`). A mismatch means the rendering and the hash diverged, which is a defect |
| Communicate | Give the seller the reconstruction, not a summary of it: the terms, the timestamp, the actor and the state changes |
| Afterwards | Every dispute becomes an integration test with the exact sequence that produced it |

`OPS-627` The dispute runbook is the reason for the audit requirements. If a dispute
cannot be answered from audit alone, the gap is a defect in `OPS-780` to `OPS-787`, not
in the runbook.

### 9.6 A stuck deal

| Step | Action |
|---|---|
| Signal | `OPS-595`, or a seller report, or a `Deal` in `DEAL_PENDING` or `LOGISTICS_GATHERING` beyond the seller's hold window |
| Identify the stuck shape | (a) Listing `PENDING_SALE`, approval not `EXECUTED`; (b) approval `EXECUTED`, listing not transitioned; (c) offer `APPROVED`, no `Deal`; (d) `Deal` progressing, no acceptance message delivered; (e) everything correct, the buyer went quiet |
| (a) to (c) | These are integrity anomalies, not workflow states. The reconciliation job finds them (`OPS-728`). Resolve forward by completing the transaction where safe, or by invalidating with a recorded reason. Never resolve by editing a row by hand without an audit event (`OPS-782`) |
| (d) | Check the outbox. An undelivered acceptance message is a delivery failure, not an authorization failure — the authorization stands (`OPS-722`, `OPS-739`) |
| (e) | Not stuck; waiting. The seller cancels the deal, which returns the listing to `ACTIVE_CONVERSATIONS` and may reopen other offers at their choice (`SM-D-04`) |
| Do not | Do not move a listing out of `PENDING_SALE` while an `EXECUTED` approval stands, without cancelling the deal through the state machine |
| Afterwards | Any occurrence of (a) to (d) is a defect with an integration test, and a candidate page threshold review |

### 9.7 Data-deletion request

| Step | Action |
|---|---|
| Signal | A seller request in-product, or a buyer request from the code gate or the conversation (`DATA-108`) |
| Identify the requester | A seller is authenticated. A buyer is pseudonymous, so identity is established by possession of the session, or by the conversation reference they were shown — never by a claim about identity, and never by asking a buyer for identity documents we have no lawful reason to hold |
| Scope it | Determine the categories in scope from `security/DATA_AND_PRIVACY.md` §3. Some categories are deleted, some are minimised, and audit events are retained and minimised rather than removed (`DATA-105`) |
| Execute | Deletion runs through the same code path the retention job uses. A one-off manual deletion is not permitted, because it is not the path that was tested (`DATA-102`) |
| Backups | Live systems are satisfied within the stated window; backups are satisfied by backup expiry. Both windows are disclosed to the requester (`DATA-103`) |
| Record | The request, the scope, the execution and the completion are recorded as audit events. The record of a deletion is not itself deleted |
| Communicate | Confirm what was deleted, what was retained and why, and when the backup window closes. Do not assert what any statute requires (`security/DATA_AND_PRIVACY.md` §12) |
| Escalate to counsel | Any request that is contested, that comes from a third party, or that conflicts with an open dispute where a transcript is the seller's defence (§6 of `security/DATA_AND_PRIVACY.md`) |

---

## 10. AI cost control

`business/UNIT_ECONOMICS.md` §9 is canonical for the metering and cost-control
**requirements** (`OPS-400` to `OPS-449`). This section states the **operational
practice** that satisfies them and does not redefine them; where the two touch, that
document wins.

`OPS-660` Model spend is the first line item that grows faster than revenue at this
scale (`ARCH` §10). The controls below are ordered by leverage: the cheapest call is the
one not made, then the one made at a smaller tier, then the one that hits a cache.

### 10.1 Budgets

| ID | Budget | Default shape | Effect on breach |
|---|---|---|---|
| OPS-661 | Per conversation | A token and turn ceiling (`G-13`) | Escalate to the seller; the conversation stays open (`AUTH-004`) |
| OPS-662 | Per listing | A rolling 24-hour cost ceiling | Degrade tier for that listing, then holding mode; notify the seller |
| OPS-663 | Per seller | A rolling 24-hour and 30-day ceiling tied to plan (`Q-06`) | Degrade tier across that seller's listings, then holding mode; notify the seller and the operator (`OPS-601`) |
| OPS-664 | Global | A daily platform ceiling | Global degradation to holding mode; page (`OPS-597`) |

`OPS-665` Budgets are enforced by deterministic code outside the model, before the call
is made (`INV-14`, `AI-216`). A budget checked after the spend is a report, not a
control.
`OPS-666` A budget breach degrades tier before it degrades service, and degrades service
to holding mode before it fails (`AI-034`, `ARCH-014`). A buyer can always still send a
message (`NFR-003`).
`OPS-667` Budgets are visible to the seller before they are hit, not only when they are.

### 10.2 The circuit breaker

`OPS-668` One breaker, three states, evaluated per scope (conversation, listing, seller,
global):

| State | Trigger | Behaviour |
|---|---|---|
| `CLOSED` | Below 80% of budget | Normal routing |
| `DEGRADED` | 80–100% of budget, or provider error rate above 20%, or p95 latency above the `NFR-002` target for 5 minutes | Force the cheap tier; disable optional calls (summarisation, non-interactive work) |
| `OPEN` | Budget exceeded, or provider error rate above 50% | Holding mode: no model calls in that scope; buyers receive `FT-05`; the seller is notified and the conversation moves to `ESCALATED` |

`OPS-669` The breaker closes on a schedule (budget window rollover) or by explicit
operator action, never automatically on a single successful probe.
`OPS-670` Breaker state is a metric (`OPS-545` sits beside it) and every transition is an
audit event.

### 10.3 Model routing

`OPS-671` Routing is the rule set of `ai/AI_AGENT_SPEC.md` §10, which is canonical. The
operational obligations are:

| ID | Obligation |
|---|---|
| OPS-672 | Cheap-first. A turn escalates tier only on a defined, deterministic trigger — never on a model's judgment (`AI-031`, `AI-032`). |
| OPS-673 | Price mentions escalate to the mid tier, because money makes a turn expensive to get wrong. This is the one routing rule worth paying for. |
| OPS-674 | `premium` is not routed to by default. Introducing it needs scoreboard evidence that a mid-tier failure mode exists and that a larger model fixes it (`AI-033`). |
| OPS-675 | `tier_mix` is reviewed weekly. A drift toward the expensive tier without a change in `mean_concession_share` or `fact_violation_rate` is spend with no return. |
| OPS-676 | Any tier or model change runs the pre-release suite, including the 100-conversation replay, before it reaches production (`EVAL_STRATEGY.md` §6). |

### 10.4 Context discipline

| ID | Rule |
|---|---|
| OPS-677 | The prompt carries the buyer-safe projection and the permitted action space, and nothing else (`AI-012`, `AI-200`). Context minimalism is a security property first and a cost property second. |
| OPS-678 | Conversation history is summarised on a cadence, off the critical path, at the cheap tier and in batch (`AI-031`). A growing raw history in every turn is the most common cause of a cost curve that bends upward. |
| OPS-679 | The running summary replaces older turns beyond a configured window; the full transcript stays in its own store and is never re-sent to a model to "remind" it. |
| OPS-680 | Prompt size per turn is a metric with a ceiling. A prompt that grows release over release is a regression even when quality holds. |

### 10.5 Prompt caching

| ID | Rule |
|---|---|
| OPS-681 | The prompt is ordered stable-prefix first: system instruction, fixed-text references, listing content, product facts — then the volatile suffix: permitted action space, conversation tail, the current buyer message. Only this ordering makes a provider-side cache useful. |
| OPS-682 | `cache_hit_rate` is a first-class metric (`OPS-550`). A prompt-version change resets it; a drop with no version change means the prefix stopped being stable. |
| OPS-683 | Cached content is subject to the same prohibitions as any context. Nothing protected becomes cacheable by being static (`AI-201`). |
| OPS-684 | Cache behaviour is provider-specific and is therefore behind the provider interface (`INT-105`). No routing or correctness decision depends on a cache hit. |

### 10.6 Images

`OPS-685` **No vision call exists in this product.** Images are presentational; nothing
derives a product fact from them (`D-11`, `LIST-035`, `AI-209`). There is therefore no
per-turn image cost, which is a deliberate architectural saving as well as a correctness
decision.

`OPS-686` If a vision call is ever introduced under a superseding decision — content
safety screening of seller uploads is the only plausible candidate, and it is not in MVP
scope — then, before any image reaches a model:

| ID | Rule |
|---|---|
| OPS-687 | The image is resized to the smallest dimension that serves the purpose, from a stored derivative, never from the original upload. Vision cost scales with pixels, and originals are the wrong input by an order of magnitude. |
| OPS-688 | The call is made once per image and the verdict is persisted against the image. Re-screening on every read is the failure mode to avoid. |
| OPS-689 | The call runs in the worker pool at upload time, in batch, never on a buyer's critical path. |
| OPS-690 | It remains true that no product fact may be derived from the result (`D-11`). A safety verdict is not a fact about the goods. |

### 10.7 Batching non-interactive work

`OPS-691` Anything not blocking a buyer runs in batch on the provider's batch path,
where latency is irrelevant and cost is not (`OPS-018`):

| Work | Cadence |
|---|---|
| Conversation summarisation | On a cadence, not per turn (`AI-031`) |
| Nightly eval suite | Scheduled, batch (`EVAL_STRATEGY.md` §6) |
| Pre-release replay of 100 redacted transcripts | Per release candidate, batch |
| Candidate-fixture triage assistance | Batch, and advisory only (`OPS-003`) |

`OPS-692` Interactive work is the buyer turn and nothing else. If a feature needs a model
call inside a seller's click, it is examined before it is built.

### 10.8 Log and telemetry volume

`OPS-693` Logs, traces and high-cardinality metrics are the second bill. §5.3 sampling,
the per-request log budget (`OPS-576`), the 30/90-day retention (`OPS-577`) and trace
sampling (`OPS-582`) are cost controls as much as they are privacy controls.
`OPS-694` `log_bytes_per_day` and metric series count are reviewed monthly against
`cost_per_active_listing`. Observability that costs more than the thing it observes is a
failure of proportion.

---

## 11. Backup and restore

`OPS-695` Capabilities required, without naming a product:

| Capability | Requirement |
|---|---|
| Relational database | Continuous or point-in-time recovery with a recovery point no worse than 15 minutes (`OPS-772`) |
| Object storage | Versioning enabled, deletion protection on, and a lifecycle policy that matches the retention in `security/DATA_AND_PRIVACY.md` |
| Transcript schema | Part of the relational database and covered by its point-in-time recovery; called out because it holds the dispute-defence record (`SM-S-03`, `OPS-719`) |
| Secret store | Backed up separately, with its own access control. A restore that cannot decrypt is not a restore |
| Configuration | In version control; an environment is reproducible without a backup (`OPS-503`) |

| ID | Rule |
|---|---|
| OPS-696 | Backups are encrypted at rest, and the key is not stored with them. |
| OPS-697 | Backup credentials are separate from application credentials and cannot be used to delete backups. A compromise of the application must not be able to destroy the recovery path. |
| OPS-698 | Backup retention is stated per store and is reconciled against deletion obligations (`DATA-103`). A backup that outlives its retention obligation is a liability, not a safety net. |
| OPS-699 | **Tested restore.** Once per quarter, and before general availability, a full restore is performed into a clean staging environment from backups alone, with no access to production. The drill records: wall-clock time to a serving system (against RTO ≤ 4 hours), the data loss window achieved (against RPO ≤ 15 minutes), and every manual step that was needed. A restore that has not been performed is a belief, not a capability, and the drill fails the release if it misses either objective (`OPS-609`). |

### 11.1 The drill

| Step | What is proven |
|---|---|
| 1. Provision a clean environment from version-controlled configuration | `OPS-503` |
| 2. Restore the database to a point in time 15 minutes before a chosen incident moment | RPO |
| 3. Restore object storage to the same point as the database, which already contains the transcript schema | Cross-store consistency |
| 4. Restore secrets and confirm the application starts and can decrypt | `OPS-696` |
| 5. Run the integration suite against the restored system | Correctness, not just liveness |
| 6. Verify a sample: one listing, one conversation, one approval, one audit chain reconstructs (`OPS-785`) | The data that matters survived |
| 7. Record timings and every manual step | RTO, and the list of steps to automate before the next drill |

`OPS-699` closes this document's block. Further operations requirements take a new
reserved block, recorded in this header before use.
