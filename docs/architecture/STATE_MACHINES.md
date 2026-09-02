# State Machines

**Status:** Canonical for lifecycle transitions. Any transition not drawn here is
illegal and must be rejected at the data layer.

---

## 1. Listing

```mermaid
stateDiagram-v2
  [*] --> DRAFT
  DRAFT --> READY : copy approved, price set, policy set
  READY --> DRAFT : seller edits
  READY --> LISTED : seller marks published, access issued
  LISTED --> ACTIVE_CONVERSATIONS : first buyer session created
  ACTIVE_CONVERSATIONS --> OFFER_PENDING : offer reaches AWAITING_SELLER
  OFFER_PENDING --> ACTIVE_CONVERSATIONS : all pending offers resolved without approval
  OFFER_PENDING --> PENDING_SALE : approval executed
  PENDING_SALE --> SOLD : seller confirms completion
  PENDING_SALE --> ACTIVE_CONVERSATIONS : deal cancelled, listing relisted
  LISTED --> CANCELLED
  ACTIVE_CONVERSATIONS --> CANCELLED
  OFFER_PENDING --> CANCELLED
  SOLD --> ARCHIVED
  CANCELLED --> ARCHIVED
  LISTED --> EXPIRED : optional
  EXPIRED --> LISTED : seller relists
  ARCHIVED --> [*]
```

| Rule | Statement |
|---|---|
| SM-L-01 | A listing cannot reach `READY` without approved copy, an asking price, a minimum price and a policy version. |
| SM-L-02 | Public access is issued on entry to `LISTED` and closed on `SOLD`, `CANCELLED`, `ARCHIVED` or `EXPIRED`. |
| SM-L-03 | `PENDING_SALE` is entered only inside the approval-execution transaction. |
| SM-L-04 | Only `PENDING_SALE` may transition to `SOLD`, and only by an authenticated seller action. |
| SM-L-05 | `SOLD` and `ARCHIVED` are terminal for negotiation. No new buyer session may be created. |
| SM-L-06 | Relisting from `EXPIRED` or a cancelled deal creates a new content version and may issue a new access code. |

## 2. Access code

```mermaid
stateDiagram-v2
  [*] --> ACTIVE : issued
  ACTIVE --> ROTATED : seller rotates
  ACTIVE --> REVOKED : seller revokes or listing closes
  ACTIVE --> EXPIRED : optional expiry reached
  ROTATED --> [*]
  REVOKED --> [*]
  EXPIRED --> [*]
```

| Rule | Statement |
|---|---|
| SM-C-01 | At most one `ACTIVE` code exists per public listing access at any time. |
| SM-C-02 | Rotation atomically marks the old code `ROTATED` and issues a new `ACTIVE` code. |
| SM-C-03 | A non-`ACTIVE` code always produces the same generic failure as an unknown code. |
| SM-C-04 | Lockout state is tracked per client against a code, and does not change the code's own status. |

## 3. Buyer session

```mermaid
stateDiagram-v2
  [*] --> ACTIVE : code validated
  ACTIVE --> IDLE : inactivity threshold
  IDLE --> ACTIVE : buyer returns with valid cookie
  ACTIVE --> CLOSED : listing sold, cancelled or archived
  ACTIVE --> BLOCKED : seller blocks this buyer
  IDLE --> EXPIRED : inactivity limit reached
  CLOSED --> [*]
  BLOCKED --> [*]
  EXPIRED --> [*]
```

| Rule | Statement |
|---|---|
| SM-S-01 | A session is bound to one listing at creation and the binding is immutable. |
| SM-S-02 | `BLOCKED` and `EXPIRED` sessions produce the generic mismatch response, never an explanation. |
| SM-S-03 | Closing a session preserves its conversation for the seller's record and for dispute defence. |

## 4. Conversation

```mermaid
stateDiagram-v2
  [*] --> OPEN
  OPEN --> AGENT_HANDLING : agent replying normally
  AGENT_HANDLING --> OPEN
  AGENT_HANDLING --> ESCALATED : guardrail escalation, budget breach, or agent unavailable
  ESCALATED --> AGENT_HANDLING : seller returns control
  ESCALATED --> SELLER_HANDLING : seller takes over the thread
  SELLER_HANDLING --> AGENT_HANDLING : seller returns control
  OPEN --> CLOSED : listing closed or buyer inactive
  ESCALATED --> CLOSED
  SELLER_HANDLING --> CLOSED
  CLOSED --> [*]
```

| Rule | Statement |
|---|---|
| SM-CV-01 | A buyer message is accepted in every non-`CLOSED` state. It is never dropped. |
| SM-CV-02 | In `ESCALATED` the buyer receives a neutral holding reply, not silence. |
| SM-CV-03 | Entering `ESCALATED` always creates a seller notification and an audit event. |

## 5. Offer

```mermaid
stateDiagram-v2
  [*] --> INTEREST
  INTEREST --> NEGOTIATING
  NEGOTIATING --> OFFER_MADE : buyer states terms
  OFFER_MADE --> COUNTERED : agent or seller counters
  COUNTERED --> OFFER_MADE : buyer revises
  OFFER_MADE --> AWAITING_SELLER : within policy or requires decision
  AWAITING_SELLER --> APPROVED : approval executed
  AWAITING_SELLER --> DECLINED : seller declines
  AWAITING_SELLER --> COUNTERED : seller counters
  OFFER_MADE --> SUPERSEDED : new version created
  AWAITING_SELLER --> SUPERSEDED : new version created
  COUNTERED --> SUPERSEDED
  OFFER_MADE --> WITHDRAWN : buyer withdraws
  AWAITING_SELLER --> WITHDRAWN
  AWAITING_SELLER --> EXPIRED : hold window elapses
  APPROVED --> [*]
  DECLINED --> [*]
  SUPERSEDED --> [*]
  WITHDRAWN --> [*]
  EXPIRED --> [*]
```

| Rule | Statement |
|---|---|
| SM-O-01 | Every state change writes a new `OfferVersion` or an offer event. Nothing is overwritten. |
| SM-O-02 | Creating a new version supersedes the previous one and invalidates any approval against it. |
| SM-O-03 | Only one offer per listing may be `APPROVED`. |
| SM-O-04 | `AWAITING_SELLER` is the only state from which approval may be requested. |
| SM-O-05 | An offer below the minimum price may never reach `AWAITING_SELLER` through agent action alone; it is auto-declined or escalated per policy. A seller may still choose to view and accept it explicitly. |

## 6. Approval

```mermaid
stateDiagram-v2
  [*] --> PENDING_EXECUTION : seller action recorded
  PENDING_EXECUTION --> EXECUTED : transaction succeeds
  PENDING_EXECUTION --> INVALIDATED : terms changed, listing unavailable, or offer superseded
  PENDING_EXECUTION --> EXPIRED : not executed within window
  EXECUTED --> [*]
  INVALIDATED --> [*]
  EXPIRED --> [*]
```

| Rule | Statement |
|---|---|
| SM-A-01 | The approval row is written before execution is attempted, so an interrupted execution is recoverable. |
| SM-A-02 | Execution asserts, inside one transaction: listing available, approval pending, material-terms hash unchanged. |
| SM-A-03 | Any failed assertion aborts and moves the approval to `INVALIDATED` with a reason. |
| SM-A-04 | The agent is permitted to communicate acceptance only after `EXECUTED`. |
| SM-A-05 | Execution is idempotent on the client-supplied key. A retry returns the original outcome. |

## 7. Deal and handoff

```mermaid
stateDiagram-v2
  [*] --> DEAL_PENDING : approval executed
  DEAL_PENDING --> LOGISTICS_GATHERING : agent collects permitted availability
  LOGISTICS_GATHERING --> HANDED_OFF : seller takes over
  DEAL_PENDING --> HANDED_OFF : seller takes over immediately
  HANDED_OFF --> COMPLETED : seller confirms
  DEAL_PENDING --> CANCELLED
  LOGISTICS_GATHERING --> CANCELLED
  HANDED_OFF --> CANCELLED
  COMPLETED --> [*]
  CANCELLED --> [*]
```

| Rule | Statement |
|---|---|
| SM-D-01 | The agent may collect availability and non-sensitive logistics only. |
| SM-D-02 | Exact location is never disclosed by the agent unless policy explicitly permits an area, and never a precise address. |
| SM-D-03 | `COMPLETED` is set only by an authenticated seller action and moves the listing to `SOLD`. |
| SM-D-04 | `CANCELLED` returns the listing to `ACTIVE_CONVERSATIONS` and reopens other offers if the seller chooses. |

## 8. Content version

```mermaid
stateDiagram-v2
  [*] --> SELLER_DRAFT : seller writes original
  SELLER_DRAFT --> ENHANCEMENT_PENDING : seller requests enhancement
  ENHANCEMENT_PENDING --> ENHANCED : model returns copy
  ENHANCEMENT_PENDING --> ENHANCEMENT_FAILED : model error or validation failure
  ENHANCEMENT_FAILED --> SELLER_DRAFT
  ENHANCED --> SELLER_EDITED : seller edits
  ENHANCED --> APPROVED : seller accepts
  SELLER_EDITED --> APPROVED
  SELLER_DRAFT --> APPROVED : seller approves original unenhanced
  ENHANCED --> SELLER_DRAFT : seller restores original
  APPROVED --> SUPERSEDED : a newer version is approved
  SUPERSEDED --> [*]
```

| Rule | Statement |
|---|---|
| SM-CT-01 | Exactly one version per listing is `APPROVED` and buyer-visible at a time. |
| SM-CT-02 | Restoring the original creates a new version; it does not delete the enhanced one. |
| SM-CT-03 | Only `APPROVED` content is used in the buyer-safe projection and in agent context. |
| SM-CT-04 | Enhancement failure is a visible, recoverable state. It never silently returns unenhanced text as if enhanced. |
