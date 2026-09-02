# Data and Privacy Specification

**Status:** Canonical for data classification, retention, deletion, consent and notice.

**Authority.** `engineering/SYSTEM_REQUIREMENTS.md` §17 states the requirements that
enforce this document; `DATA-100` to `DATA-110` there are the enforcement hooks for the
classifications below. `product/BUYER_ACCESS_FLOW.md` is canonical for the buyer entry
experience; `security/PUBLIC_ACCESS_SECURITY.md` for the public surface;
`ai/POLICY_AND_AUTHORIZATION.md` for what the agent may disclose.

**This document is not legal advice and states none.** It describes categories of
obligation — notice, lawful purpose, minimisation, retention limitation, access,
deletion, processor contracting, cross-border transfer, breach notification — in generic
terms. It does **not** state what any named statute, regulation or authority requires,
because the applicable regime depends on unresolved question `Q-07`. Every place where a
specific statutory obligation would attach is marked **[confirm with counsel]**. See §12.

**Requirement IDs.** This document uses the `DATA-` prefix in a reserved **200-block**.
`DATA-100` to `DATA-149` belong to `engineering/SYSTEM_REQUIREMENTS.md`.

---

## 1. Principles

| ID | Principle |
|---|---|
| DATA-200 | Collect the least data that makes the product work. The buyer surface is the test case: a person can complete an entire negotiation with no name, no email, no phone number and no account (`BUYER-014`, `UX-101`). |
| DATA-201 | Every category has one stated purpose. A category used for a second purpose is a new decision, not an optimisation. |
| DATA-202 | Retention is a deliberate number with a reason, not a consequence of never deleting anything. |
| DATA-203 | Sensitivity drives access. Access to the most sensitive categories is audited even for operators (`SEC-370`). |
| DATA-204 | Nothing sensitive sits behind the access code, because the code is public by design (`SEC-001`, `D-03`). This is a data-classification rule before it is a security rule. |
| DATA-205 | The seller can read their buyers' conversations. Buyers are told this plainly at the gate (`BUYER-007`). A privacy model that hides this from buyers is dishonest and would fail the first time a seller quoted a message back. |
| DATA-206 | Where a control can be structural, it is preferred over a policy. The minimum price is not in model context (`D-04`); the buyer-safe projection cannot hold a protected field (`SEC-021`); access codes are not recoverable in plaintext (`ACCESS-013`). |

## 2. Classification scheme

| Class | Meaning | Handling |
|---|---|---|
| **P0 Public** | Intended to be seen by anyone with the link | No access control beyond rate limiting. Nothing in P0 may be sensitive |
| **P1 Internal** | Operational data about the system, not about a person | Standard access control; aggregate freely within a tenant |
| **P2 Confidential** | A seller's commercial data, or pseudonymous buyer data | Tenant-scoped; never crosses a tenant; never reaches a buyer |
| **P3 Protected** | Disclosure directly harms a person or a seller's position | Structural controls, audited access, never in logs, never in model context |
| **P4 Secret** | Authentication material and keys | Hashed or in a secret store; never retrievable in plaintext; never logged |

`DATA-207` A category's class determines its handling by default. An exception requires
an entry in this document, not a decision in code.

---

## 3. Data categories

Retention periods below are the values `DATA-100` enforces. They are stated so they can
be argued with and changed deliberately. **[confirm with counsel]** applies to every
period once `Q-07` resolves: a statutory minimum or maximum may override any of them.

### 3.1 Seller data

| Category | Class | Lawful purpose | Who can see it | Retention | On deletion request |
|---|---|---|---|---|---|
| **Seller account data** — email, display name, plan, preferences, notification settings | P2 | Operate the account, authenticate, contact the seller about their own business | The seller; operators with audited access (`OPS-504`, `SEC-370`) | Life of the account, then 30 days | Deleted. Display name is retained on completed sale records in de-identified form only where an audit event requires an actor reference (`DATA-105`) |
| **Seller authentication material** — password verifier, reset tokens, session tokens, second-factor secrets | P4 | Authenticate the only actor who can create authorization (`AUTH-INV-04`) | Nobody. Verifiers are one-way; tokens are stored hashed (`AUTH-201`, `AUTH-205`) | Session lifetimes per `AUTH-207`; reset tokens minutes; verifier for the life of the account | Deleted with the account. Never exportable, never included in a data export |
| **Product information** — seller-supplied facts, content versions, titles, descriptions, structured details | P2, and P0 once approved and published to the buyer surface | Present the item to buyers; ground every agent answer (`INV-12`) | The seller; buyers see only the approved version (`SM-CT-03`); the agent sees approved content and `ProductFact` rows | Life of the listing plus 24 months, so relisting and sales history stay coherent (`OPS-201`, `OPS-205`) | Deleted with the listing, subject to the dispute-defence hold of §6 |
| **Product images** | P2 originals, P0 derivatives once the listing is live | Show the item. Never a source of inferred fact (`D-11`, `LIST-035`) | The seller; buyers see derivatives only; originals are never served (`SEC-342`) | With the listing plus 24 months | Deleted, originals and derivatives together. Metadata was already stripped at upload (`SEC-346`) |
| **Seller policy and minimum price** — asking, target, minimum, concession limit, auto-decline threshold, capability flags, hold window | **P3** for the minimum, target, concession limit and auto-decline threshold; P2 for the rest | Compute the permitted counter range and decide every consequential outcome outside the model (`INV-14`) | The seller; the policy engine. **Never a buyer, never a model** (`D-04`, `AI-201`) | All versions for the life of the listing plus 24 months, because a past agent decision must remain explicable against the rules that applied (`AI-030`) | Retained while the dispute-defence window of §6 is open, then deleted. Never exported to a buyer under any request |
| **Internal notes** — seller's private notes on an item, acquisition cost, acquisition date | **P3** | The seller's own record-keeping and profit calculation from figures they entered (`D-09`) | The seller only | With the item plus 24 months | Deleted |
| **Analytics** — operational counts, conversion rates, cost attribution, seller-entered cost and profit | P2 | Show the seller their own operation; measure unit economics (`NFR-006`) | The seller for their own tenant; operators in aggregate | Aggregates 36 months; per-event rows 24 months | Per-event rows deleted; aggregates retained in a form that identifies no listing, buyer or conversation |

### 3.2 Buyer data

| Category | Class | Lawful purpose | Who can see it | Retention | On deletion request |
|---|---|---|---|---|---|
| **Buyer session data** — opaque token, listing scope, timestamps, optional display name, hashed client identifier | P2 | Scope and isolate one conversation; enforce rate limits and abuse controls | The system; the seller sees a session reference, not an identity | Session lifetime, then the session record for 12 months alongside its conversation. Hashed client identifiers for rate limiting: 30 days (`SEC-043`) | Session record deleted; the conversation follows the buyer-message rule below |
| **Buyer messages** — the transcript | P2, and **P3 in effect** because a buyer may disclose anything in free text | Answer the buyer, negotiate, extract offers, and defend a dispute (§6) | The seller for their own listing; the agent for that one conversation only (`SEC-118`); operators only under an audited access (`SEC-370`) | 12 months from the last message, then deleted. A conversation attached to an executed approval is held under §6 for 24 months from the deal's terminal state | Deleted, unless the §6 hold applies, in which case the buyer is told the hold exists, its basis and when it ends |
| **Offers and offer versions** — amounts, conditions, logistics terms | P2 | Structure the negotiation; give the seller a decision surface; record what was proposed | The seller; the buyer sees their own offer restated in conversation, never another buyer's (`AI-012`) | 24 months from the terminal state of the offer | Amounts and terms are retained under §6 where an approval exists; where none exists, deleted with the conversation |
| **Approvals** — decision, offer version, terms hash, actor, policy version, idempotency key | P2, and the actor reference is P3 | The authorization record. The only thing that permits acceptance (`AUTH-INV-04`) | The seller; operators under audited access | 7 years, as the record of a transaction between two people **[confirm with counsel]** | **Not deleted.** Minimised: buyer-identifying content is removed, the authorization record and its hash remain (`DATA-105`) |
| **Meetup and logistics information** — buyer availability, pickup window, area-level location, non-sensitive arrangements | **P3** — this describes where a person will physically be, at a time | Complete a handoff the seller then executes (`PROD-020`, `SM-D-01`) | The seller; the agent within the permitted disclosure mode. The exact address is never disclosed by the agent and is never in context (`SM-D-02`, `D-14`) | 90 days after the deal reaches a terminal state — much shorter than the conversation, because its usefulness ends when the meeting does | Deleted on request without a §6 hold; a dispute about a completed meeting is defended by the conversation, not by the availability record |

### 3.3 System records

| Category | Class | Lawful purpose | Who can see it | Retention | On deletion request |
|---|---|---|---|---|---|
| **Audit events** — actor, subject, policy version, request id, before/after summary | P2, actor references P3 | Reconstruct any consequential action and answer a disputed approval (`AUTH-INV-09`, `OPERATIONS.md` §9.5) | Operators under audited access (`OPS-788`); the seller sees a derived history of their own actions | 7 years for approval, sale and policy events; 24 months for the rest **[confirm with counsel]** | **Not deleted.** Minimised in place: personal content removed, the event, its actor reference and its integrity preserved (`DATA-105`). The record of the deletion is itself an audit event |
| **AI interaction records** — purpose, model, prompt version, token counts, cost, latency, guardrail decision, retry count | P1 | Metering, unit economics, cost attribution, incident reconstruction (`NFR-006`) | Operators; the seller sees cost aggregates for their own tenant | 24 months | Retained. They contain no prompt, no completion and no message content by construction (`OPS-564`, `OPS-565`) — only counts and decisions |
| **Access codes** | P4 by storage rule, P0 by design in the primary flow | Route a buyer to one listing; provide an abuse-control and revocation handle (`D-03`) | Nobody, after issue. Stored hashed; plaintext shown to the seller once and thereafter only by rotation (`ACCESS-013`, `OPS-710`) | Hash for the life of the access record plus 12 months for abuse forensics | Deleted with the listing. Never appears in a log, an audit payload, an export or an error (`SEC-040`, `OPS-566`) |
| **Application logs and traces** | P1, with a hard prohibition on the content of P2 to P4 categories | Operate and debug the system | Operators | 30 days hot, 90 days cold (`OPS-577`) | Not individually deletable, which is precisely why they may not contain personal content (`OPS-564` to `OPS-570`). This is the trade the logging rules exist to make |
| **Eval fixtures and test data** | P1 | Regression-test AI behaviour | Anyone with repository access | Indefinite | Not applicable: fixtures carry no real seller or buyer data and no amount traceable to a real listing (`OPS-012`, `OPS-023`, `DATA-110`) |

`DATA-210` A category not listed above does not exist. Introducing one requires an entry
here with all six columns filled, and a startup check fails without them (`DATA-101`).
`DATA-211` The two retention shapes are **delete** and **minimise**. Minimise means the
record survives with its personal content removed and its integrity intact. Only audit
events and approvals are minimised; everything else is deleted.
`DATA-212` No category is retained "until we decide", and no category has an indefinite
retention except fixtures, which contain no real data.

---

## 4. The buyer who never signed up

The buyer is a person who follows a stranger's link, enters a code, and talks to an AI
about a secondhand item. They will never create an account (`BUYER-022`), never verify
an email, and in most cases never return. Every consent and notice obligation has to be
discharged in that one moment.

`DATA-240` **The code gate is the consent and notice surface.** It is the only reliable
point at which a person who will never hold an account is present, attentive and about
to begin (`BUYER-007`).

| ID | Requirement at the gate |
|---|---|
| DATA-241 | The notice appears **before** the first message is sent, not after, and not only in a linked policy. |
| DATA-242 | It states: who operates the service; that an AI conducts the conversation and acts for the named seller; that only the seller can accept an offer; what is stored; for how long; that the seller can read the conversation; and how to request deletion (`BUYER-007`, `BUYER-006`). |
| DATA-243 | It is short enough to read. A notice nobody reads discharges nothing in substance, whatever it discharges in form. The full policy is one link away for the person who wants it. |
| DATA-244 | The AI disclosure is fixed text (`FT-01`), rendered by the surface, never model-generated, and persistent above the conversation for its whole life (`AI-025`, `SEC-135`). |
| DATA-245 | Proceeding past the gate is recorded as an event with the notice version in force, so it is later possible to say which text a given buyer saw. The record holds the notice version and a timestamp, not an identity. |
| DATA-246 | The notice is presented in the same place for every listing and every seller. A seller cannot alter, shorten or suppress it. |
| DATA-247 | The deletion route is reachable from the gate and from inside the conversation, without an account (`DATA-108`). |

`DATA-248` **Whether "consent" is the right basis is a question for counsel**
**[confirm with counsel]**. A person who must pass a gate to speak to a seller is not
freely consenting to anything in a meaningful sense, and several plausible regimes would
treat operating the conversation as necessary to a service the person requested rather
than as consent-based. The design does not depend on the answer: the notice is given
either way, the data collected is minimal either way, and the deletion route exists
either way. This is deliberate — the product should not need to be re-architected when
`Q-07` resolves.

`DATA-249` No separate marketing consent is sought, because no marketing is sent. No
buyer-facing email, SMS or push exists (`SEC-136`, `Q-05`).

## 5. Data minimisation for buyers

| ID | Rule |
|---|---|
| DATA-260 | No account, no email address, no phone number, no name is required to converse (`BUYER-014`). The optional display name exists so a seller can address someone politely, and nothing depends on it. |
| DATA-261 | Buyer identity is a session, not a person. The system does not link two sessions from the same person, on the same device or across devices, and does not attempt to (`EC-06`, `Q-04`). |
| DATA-262 | No buyer profile, no cross-listing buyer history, no repeat-buyer identification exists at MVP (`MASTER_PRODUCT_SPEC.md` §13). |
| DATA-263 | No buyer risk, trust or scam score is produced (`D-16`). Scoring a person on thin evidence with no appeal path is a privacy harm before it is a fairness problem. |
| DATA-264 | Raw client IP addresses are not retained beyond the short window rate limiting needs; a hashed client identifier is stored instead (`SEC-043`, `OPS-568`). |
| DATA-265 | No third-party analytics, advertising or session-recording script runs on the buyer surface. The content-security policy makes this enforceable rather than aspirational (`SEC-322`). |
| DATA-266 | The buyer surface asks for nothing a phishing clone could profitably steal: no payment details, no credentials, no identity documents. This is a privacy decision and an anti-phishing one (`T-14`). |
| DATA-267 | Buyers cannot upload files or attachments, so the system never holds buyer-supplied media (`SEC-133`). |
| DATA-268 | Free text is the one place a buyer can disclose anything about themselves, and the system cannot prevent it. It is therefore handled as though it contains sensitive content: never logged (`OPS-565`), stored in its own store with its own retention (`OPS-719`), and never sent to a model outside its own conversation (`SEC-118`). |

## 6. Minimisation against dispute defence

The tension is real and cannot be resolved by preferring one principle.

| Force | Argument |
|---|---|
| Minimisation | A transcript between a stranger and a machine, about a used bicycle, has no ongoing purpose once the conversation ends. Holding it for years is holding a liability |
| Dispute defence | The seller's protection against "your AI promised me X" is the transcript, the offer version, the approval and the audit chain. Deleting them leaves the seller undefended against the exact failure mode the product's design is meant to make impossible |

`DATA-275` **The resolution is a scoped hold, not a blanket retention.**

| Rule | Statement |
|---|---|
| DATA-276 | The default is deletion on the schedule in §3. Retention is the exception and must name its basis. |
| DATA-277 | A **dispute-defence hold** attaches only to a conversation that produced an executed `SellerApproval`, or that is the subject of an open dispute the platform has been told about. Nothing else is held. |
| DATA-278 | The hold runs 24 months from the terminal state of the deal, or 90 days after an open dispute closes, whichever is later **[confirm with counsel]**. |
| DATA-279 | A conversation that produced no approval and no dispute is deleted on the ordinary 12-month schedule, regardless of how interesting it was. Most conversations fall here, which is the point: the exception stays small. |
| DATA-280 | The hold is recorded on the conversation as an explicit flag with its basis and its end date, not implied by a query. A hold nobody can see is indistinguishable from a retention failure. |
| DATA-281 | A buyer who requests deletion during a hold is told plainly: what is held, why, and when it ends. They are not told nothing, and they are not told the request was honoured when it was not (`DATA-347`). |
| DATA-282 | The hold preserves the transcript, the offer versions and the approval. It does not preserve logistics information, which is deleted on its own 90-day schedule regardless (§3.2) — the meeting is not what a dispute is about. |
| DATA-283 | The approval record and the audit chain survive independently of the hold, minimised (`DATA-211`). They are the record of an authorization, not a record of a conversation. |
| DATA-284 | Holds are reviewed when the retention job runs. A hold whose end date has passed is released automatically, not by someone remembering. |

`DATA-285` This is a deliberate decision recorded here rather than an implicit
consequence of the schema: **the system retains the minimum that keeps a seller
defensible, and deletes everything else on time.** If counsel concludes the hold period
is wrong once `Q-07` resolves, the period changes; the shape does not.

## 7. AI disclosure to buyers

`DATA-290` Every buyer is told, plainly and before the conversation begins, that they
are talking to an AI assistant acting for the seller, and that only the seller can accept
an offer. This is decision `D-15`, **Accepted**, and is unconditional.

| ID | Requirement |
|---|---|
| DATA-291 | Disclosure is `FT-01`, fixed text rendered by the surface, never model-generated, never paraphrased (`AI-025`, `G-10`, `SEC-135`). |
| DATA-292 | It is persistent above the conversation, not a one-time banner that scrolls away (`BUYER-006`). |
| DATA-293 | It names the seller, so the buyer knows whose agent they are speaking to. |
| DATA-294 | The agent never claims to be the seller, never uses the seller's first person, and never claims ownership or personal experience of the item (`AI-023`). |
| DATA-295 | Where a buyer asks directly what the agent can decide, the answer is fixed text (`FT-02`), not generated (`G-10`). |
| DATA-296 | Disclosure is a blocking test, not a content decision (`AI-025`). A release that changes or removes it fails CI. |

`DATA-297` **Why unconditional.** It is honest. It sets expectations that reduce buyer
frustration and make the agent's refusals easier to accept. It removes any argument that
a person was misled about the nature of the communication or about the agent's authority
to settle terms — a category of unfair-practice exposure that exists in some form in most
consumer-protection regimes **[confirm with counsel]**. And it costs nothing: the product
is not better if the buyer is confused.

`DATA-298` **Note on `Q-08`.** `product/MASTER_PRODUCT_SPEC.md` §18 lists `Q-08`
("whether the agent is disclosed as AI in all cases") as open and points here for the
recommendation. `D-15` has since been accepted, which closes it. The question should be
marked resolved in the master spec; this document treats disclosure as settled and
unconditional.

## 8. What the model provider receives

`DATA-300` The provider receives the assembled prompt and returns a completion. What is
in that prompt is fully determined by `ai/AI_AGENT_SPEC.md` §3 and is enforced by a type
that cannot hold a protected field (`AI-200`, `ARCH-008`).

| Sent to the provider | Never sent |
|---|---|
| Approved listing content and `ProductFact` rows — information the seller already published | Minimum price, target price, concession limit, auto-decline threshold (`D-04`) |
| Asking price and currency | Internal notes, acquisition cost, analytics |
| The derived permitted counter range | Any other conversation, offer, buyer or listing |
| This conversation's messages and running summary | The seller's exact location, address, postal code or contact details |
| Buyer message text, delimited as untrusted data | Seller account, plan or billing data; access codes; audit contents |
| Capability statements and permitted intents, already resolved | Any image (`AI-209`) |
| The seller's display name and tone setting | Any credential, token or identifier that is not a listing-scoped fact id |

`DATA-301` Buyer free text reaches the provider. That is unavoidable — it is the message
being answered — and it is the reason the provider's contractual position matters more
than any other vendor's.

### 8.1 Required contractual position

`DATA-302` The provider is engaged as a **processor acting only on instruction**. The
following are contractual requirements, not preferences, and are confirmed before the
first real seller (`INT-107`, `THREAT_MODEL.md` §16.2). **[confirm with counsel]** for
the exact instrument and its terms.

| ID | Requirement |
|---|---|
| DATA-303 | No right to train, fine-tune or otherwise improve any model on data we send, in any aggregated or derived form. |
| DATA-304 | No right to use the data for any purpose other than returning the completion we requested. |
| DATA-305 | No retention beyond what is needed to serve the request, with a stated maximum, and no human review except under a defined abuse-investigation process we are told about. |
| DATA-306 | Sub-processors disclosed, and a right to be notified of changes. |
| DATA-307 | Deletion on termination, within a stated period, confirmed in writing. |
| DATA-308 | Security commitments at least equivalent to our own, including encryption in transit and at rest. |
| DATA-309 | Breach notification to us without undue delay, on a stated timeline, sufficient for us to meet §11. |
| DATA-310 | Transfer terms that permit the flows in §9. |
| DATA-311 | Audit or attestation rights proportionate to a two-person company: a current independent report is acceptable where an audit right is not. |

`DATA-312` A provider that cannot meet `DATA-303` to `DATA-305` is not used, whatever it
costs or however well it performs. This is the one vendor decision that is not a
trade-off.
`DATA-313` The same requirements apply to a secondary or fallback provider
(`ARCH` §9, `OPS-671`). A failover path that lands on a provider with different terms is
a privacy incident waiting for an outage.
`DATA-314` The provider position is re-confirmed on any provider change, model change
that crosses a provider boundary, or contract renewal, and the confirmation is recorded
(`AIT-75`).
`DATA-315` Prompt caching (`OPS-681`) means content may persist on the provider's side
for a cache lifetime. That is acceptable only under `DATA-305`, and nothing protected is
cacheable because nothing protected is sent (`OPS-683`).

## 9. Cross-border considerations

`DATA-320` Data will cross borders. The model provider, object storage, email and push
delivery and the hosting itself may each operate in a different jurisdiction from the
company, the seller and the buyer. This is a design fact, not an exception.

| ID | Consideration |
|---|---|
| DATA-321 | The relevant jurisdictions are at least: where the company is established, where the infrastructure runs, where the model provider processes, where the seller is, and where the buyer is. These can be five different places for one conversation. |
| DATA-322 | The transfer mechanisms that make such flows lawful vary by regime and by pair of jurisdictions, and are a matter for counsel once `Q-07` resolves **[confirm with counsel]**. This document does not name a mechanism. |
| DATA-323 | The system records, per data store and per processor, which region it operates in, so the actual flows can be described accurately when they need to be. A flow nobody can describe cannot be made lawful. |
| DATA-324 | Region selection for the database, object storage and the model provider is deferred to the hosting decision (`Q-09`; the backend baseline D-17 defers hosting), but is a **privacy decision as well as a latency one** and must be recorded as such in that decision. |
| DATA-325 | Localisation requirements — an obligation to keep certain data in a certain place — may apply in some target markets. Whether any do is part of `Q-07` **[confirm with counsel]**. The modular monolith with one database makes a regional split expensive, which is a reason to establish the answer before launch rather than after. |
| DATA-326 | Public notices state, in plain language, that data is processed in other countries and by named categories of processor. |

## 10. Access and deletion requests

`DATA-330` Two very different requesters, one process shape: identify, scope, execute
through the tested path, record, respond.

### 10.1 Sellers

| ID | Rule |
|---|---|
| DATA-331 | A seller is authenticated, so identity is established by their session plus re-authentication for a consequential request (`AUTH-214`). |
| DATA-332 | A seller may export their own data in a machine-readable form, containing that tenant's data only (`DATA-107`, `SEC-106`). |
| DATA-333 | The export includes their account data, listings, content versions, images, policy versions, offers, approvals, sales records and their own conversations. It excludes authentication material (class P4), other tenants' data, and system internals. |
| DATA-334 | A seller may delete their account. Deletion removes the categories marked deleted in §3 and minimises those marked minimised. |
| DATA-335 | Account deletion closes every listing's public access first, so no buyer reaches a surface for a seller who no longer exists (`SM-L-02`). |
| DATA-336 | A seller cannot delete a buyer's conversation selectively in order to remove a record of what the agent said. Deletion is by listing or by account, on the schedule, or by the buyer's own request. |
| DATA-337 | A seller cannot obtain another buyer's data, a buyer's identity beyond what the buyer typed, or any cross-tenant data, through any request (`AUTH-229`). |

### 10.2 Buyers

| ID | Rule |
|---|---|
| DATA-340 | A buyer is pseudonymous. Identity is established by possession of the session, or by the conversation reference shown to them in the interface. |
| DATA-341 | We do not ask a buyer for identity documents or any new personal data in order to process a request about data we hold pseudonymously. Collecting identity to prove identity would defeat the minimisation the whole design rests on. |
| DATA-342 | Where a request cannot be tied to a session or a conversation reference, we say so and explain what would let us act. We do not guess, and we do not act on an unverified claim about someone else's conversation. |
| DATA-343 | A buyer may request access to their conversation and the offers extracted from it, and may request deletion (`DATA-108`). |
| DATA-344 | A buyer request never returns seller-protected information: the minimum price, internal notes, policy internals, the exact address, other conversations or other offers (`AUTH-INV-08`). An access request is not a route around `G-14`. |
| DATA-345 | A buyer request is executed through the same code path the retention job uses. A manual deletion is not permitted, because it is not the path that was tested (`DATA-102`, `OPERATIONS.md` §9.7). |
| DATA-346 | Where a §6 dispute-defence hold applies, the buyer is told what is held, on what basis, and when it ends (`DATA-281`). |
| DATA-347 | We never tell a requester that data was deleted when it was held, minimised or merely scheduled. The response states what actually happened. |

### 10.3 Both

| ID | Rule |
|---|---|
| DATA-350 | Live systems are satisfied within the stated window; backups are satisfied by backup expiry, and both windows are disclosed (`DATA-103`, `OPS-698`). |
| DATA-351 | The target is to acknowledge within 5 working days and complete within 30 calendar days. Whether a shorter statutory period applies is `Q-07` **[confirm with counsel]**. |
| DATA-352 | Every request, its scope, its execution and its completion are recorded as audit events. The record of a deletion is not itself deleted (`DATA-105`). |
| DATA-353 | A contested request, a third-party request, or a request that conflicts with an open dispute is escalated to counsel before anything is executed (`OPERATIONS.md` §9.7). |
| DATA-354 | The request routes are tested end to end before general availability, by actually running one of each (`THREAT_MODEL.md` §16.3). A process that has never been exercised is a paragraph, not a capability. |

## 11. Breach response

`DATA-355` A breach is any unauthorised access to, disclosure of, alteration of or loss
of data in classes P2 to P4. Detection sources include the pages of
`engineering/OPERATIONS.md` §7.1 — protected disclosure (`OPS-593`), tenant isolation
failure (`OPS-594`) — a seller or buyer report, a provider notification (`DATA-309`), or
a researcher.

| Phase | Actions |
|---|---|
| **Contain** (first hour) | Activate the relevant kill switch or take the affected route out of service (`OPS-616`); revoke credentials or sessions if they are implicated; stop the bleeding before understanding it |
| **Preserve** | Snapshot logs, audit events and traces before retention expires them. A 30-day log retention is short relative to a breach investigation, and this is the step people forget (`OPS-577`) |
| **Assess** | What categories, what classes, how many people, what period, whether the data was accessible or actually accessed, and whether it is recoverable |
| **Notify** | Whom, when and in what form depends on the regime and is **[confirm with counsel]**. The engineering obligation is to be able to answer the assessment questions accurately and quickly; the legal obligation attaches to what that answer contains |
| **Communicate** | Affected sellers are told what happened, what data was involved, what was done and what they should do. Buyers are reachable only inside their conversation surface, which is a real constraint on any buyer-facing notification and must be raised with counsel alongside `Q-05` |
| **Remediate and record** | Fix, then write the incident record (`OPS-617`) and schedule the follow-up (`OPS-618`) |

| ID | Rule |
|---|---|
| DATA-356 | The assessment questions above are answerable from audit events and metrics, not from guesswork. If a plausible breach cannot be scoped from the audit trail, that is a defect in `OPS-780` to `OPS-787`. |
| DATA-357 | A protected-disclosure detection is treated as a breach until shown otherwise, not the reverse (`OPS-797`). |
| DATA-358 | A provider breach notification triggers the same process, with the added step of establishing what we actually sent that provider (§8) rather than assuming. |
| DATA-359 | The breach process is rehearsed once before general availability, as a tabletop exercise, and the rehearsal is recorded (`THREAT_MODEL.md` §16.3). |
| DATA-360 | Notification timelines are not stated in this document because they are regime-specific **[confirm with counsel]**. The internal target is to have the assessment complete within 24 hours of detection, so that whatever the external clock turns out to be, it is not us who consumed it. |

## 12. Jurisdiction note

`DATA-375` **The applicable privacy and consumer-protection regime is not yet
determined.** It depends on where the company is established, where it operates, where
its sellers are and where its buyers are — and buyers arrive from public marketplace
advertisements, so their location is not something the product controls.

`DATA-376` This is unresolved question **`Q-07`** in
`product/MASTER_PRODUCT_SPEC.md` §18. Until it resolves:

| ID | Rule |
|---|---|
| DATA-377 | No document in this set states what any named statute, regulation or authority requires. Obligations are described by category — notice, lawful purpose, minimisation, retention limitation, access, deletion, processor contracting, cross-border transfer, breach notification, disclosure of automated communication — and are flagged for confirmation. |
| DATA-378 | Every **[confirm with counsel]** marker in this document is a specific point where a statutory obligation would attach and where the generic description is not sufficient to act on. |
| DATA-379 | The design is built to be defensible under a strict regime rather than tuned to a permissive one: minimal collection, short default retention, a narrow and justified exception, unconditional AI disclosure, a processor position that forbids provider training, and a deletion route for a person who never signed up. This is a deliberate posture, chosen because retro-fitting minimisation is far more expensive than starting with it. |
| DATA-380 | Nothing in this posture should be read as a claim that it satisfies any particular law. It is a good-faith engineering position pending legal review. |
| DATA-381 | Before launch, counsel must confirm at minimum: the lawful basis for processing buyer conversation data (`DATA-248`); the retention periods in §3 and the dispute-defence hold in §6; the sufficiency of the gate notice in §4; the processor instrument and terms in §8; transfer mechanisms and any localisation requirement in §9; response deadlines in §10; breach notification obligations and timelines in §11; and the adequacy of the AI disclosure in §7 for consumer-protection purposes in each target market. |
| DATA-382 | Product decisions that would change the answers — a buyer-facing email channel (`Q-05`), cross-device session resume (`Q-04`), buyer accounts, payments, or any buyer profiling — are not made without revisiting this section. |

`DATA-383` The single most consequential open item is which markets are targeted at
launch, because it determines everything above. It is a business decision with a large
engineering consequence, and it should be made early rather than discovered late.
