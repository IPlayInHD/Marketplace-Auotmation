# Documentation Index

The source of truth for this product. **You do not need to read all of it.** Find your
task below and read only what it lists.

`CLAUDE.md` at the repository root holds the always-loaded invariants. It is a summary,
not an authority — where it and a canonical document differ, the canonical document wins.

---

## Canonical documents

Each is authoritative in its domain. Where two disagree, the one whose domain is at issue
wins.

| Document | Authoritative for |
|---|---|
| `product/MASTER_PRODUCT_SPEC.md` | Product scope, MVP boundary, removed features, assumptions |
| `ai/POLICY_AND_AUTHORIZATION.md` | AI authority, guardrails, approval integrity |
| `security/PUBLIC_ACCESS_SECURITY.md` | The public buyer surface and access codes |
| `architecture/DOMAIN_MODEL.md` | Entities, responsibilities, relationships |
| `architecture/STATE_MACHINES.md` | Legal lifecycle transitions |
| `decisions/DECISION_LOG.md` | Why things are the way they are |
| `GLOSSARY.md` | Vocabulary. Use these words exactly. |

## Supporting documents

| Document | Contents |
|---|---|
| `product/PRD.md` | Personas, jobs, user stories, acceptance criteria, edge cases |
| `product/BUYER_ACCESS_FLOW.md` | The buyer URL, code entry, sessions |
| `product/UX_FLOWS.md` | Screen flows and fixed copy |
| `product/INVENTORY_AND_SALES.md` | Inventory, sales records, analytics |
| `architecture/ARCHITECTURE.md` | Modules, data flow, failure posture |
| `engineering/SYSTEM_REQUIREMENTS.md` | Testable system requirements |
| `engineering/OPERATIONS.md` | Observability, alerting, runbooks, cost control |
| `ai/LISTING_ENHANCEMENT.md` | Enhancement behaviour and its validator |
| `ai/AI_AGENT_SPEC.md` | Agent role, context, negotiation, escalation |
| `ai/EVAL_STRATEGY.md` | Eval suites and the run policy |
| `security/THREAT_MODEL.md` | Application threat model |
| `security/AI_THREAT_MODEL.md` | AI-specific threats, prompt injection |
| `security/DATA_AND_PRIVACY.md` | Data classification, retention, disclosure |
| `integrations/MARKETPLACE_STRATEGY.md` | The marketplace boundary and policy matrix |
| `business/BUSINESS_MODEL.md` | Monetization and assumptions |
| `business/POSITIONING.md` | Differentiation and prohibited claims |
| `business/UNIT_ECONOMICS.md` | Cost model and metering requirements |
| `business/RISK_REGISTER.md` | Risks, mitigations, what to test first |
| `planning/MVP_ROADMAP.md` | Vertical slices and gates |

## Deprecated specifications

None. No repository or prior documentation existed when this set was written. Features
that appear in `product/MASTER_PRODUCT_SPEC.md` §7 as removed were rejected at
specification time and were never implemented; see `decisions/DECISION_LOG.md` D-09
through D-13 and D-16.

---

## Read this for that

| Task | Read, in order |
|---|---|
| **Anything at all** | `CLAUDE.md`, then this index |
| **Listing enhancement** | `product/MASTER_PRODUCT_SPEC.md` · `product/PRD.md` · `ai/LISTING_ENHANCEMENT.md` · `ai/EVAL_STRATEGY.md` |
| **Buyer access** | `product/MASTER_PRODUCT_SPEC.md` · `product/BUYER_ACCESS_FLOW.md` · `security/PUBLIC_ACCESS_SECURITY.md` · `engineering/SYSTEM_REQUIREMENTS.md` |
| **AI conversation** | `ai/AI_AGENT_SPEC.md` · `ai/POLICY_AND_AUTHORIZATION.md` · `security/AI_THREAT_MODEL.md` · `ai/EVAL_STRATEGY.md` |
| **Negotiation** | `ai/AI_AGENT_SPEC.md` · `ai/POLICY_AND_AUTHORIZATION.md` · `architecture/DOMAIN_MODEL.md` · `architecture/STATE_MACHINES.md` · `ai/EVAL_STRATEGY.md` |
| **Seller approval** | `ai/POLICY_AND_AUTHORIZATION.md` · `architecture/STATE_MACHINES.md` · `security/THREAT_MODEL.md` · `engineering/SYSTEM_REQUIREMENTS.md` |
| **Marketplace questions** | `integrations/MARKETPLACE_STRATEGY.md` · `business/RISK_REGISTER.md` |
| **Security work** | `security/THREAT_MODEL.md` · `security/AI_THREAT_MODEL.md` · `security/PUBLIC_ACCESS_SECURITY.md` · `security/DATA_AND_PRIVACY.md` |
| **Data model or migration** | `architecture/DOMAIN_MODEL.md` · `architecture/STATE_MACHINES.md` · `security/DATA_AND_PRIVACY.md` |
| **Deciding what to build next** | `planning/MVP_ROADMAP.md` · `business/RISK_REGISTER.md` |
| **Pricing or packaging** | `business/BUSINESS_MODEL.md` · `business/UNIT_ECONOMICS.md` |
| **Writing marketing copy** | `business/POSITIONING.md` (see the prohibited-claims table) |
| **Backend implementation** | `decisions/DECISION_LOG.md` D-17 · `architecture/ARCHITECTURE.md` · `engineering/SYSTEM_REQUIREMENTS.md` · `engineering/OPERATIONS.md` |

---

## Requirement ID map

Stable once published. Never renumber; deprecate instead.

| Prefix | Meaning | Blocks in use |
|---|---|---|
| `PROD-` | Product scope | Master spec |
| `LIST-` | Listing and enhancement | 001–029 master spec · 030–068 enhancement |
| `BUYER-` | Buyer experience | 001–099 buyer access flow · 100+ PRD |
| `ACCESS-` | Access codes | 001–099 |
| `AI-` | Agent behaviour | 001–009 master spec · 010–034 agent spec · 200–299 system requirements |
| `NEG-` | Negotiation | 001–017 |
| `OFFER-` | Offers | 001–099 |
| `AUTH-` | Authorization | 001–009 policy · 050–099 master spec · 100+ PRD · 200–299 system requirements. `AUTH-INV-01..11` are invariants, not requirements |
| `SEC-` | Security | 001–099 public access · 100–199 system requirements · 300–399 threat model · 500–599 AI threat model |
| `DATA-` | Data and privacy | 100–149 system requirements · 200–399 data and privacy |
| `UX-` | Interface | PRD and UX flows |
| `OPS-` | Operations | 001–034 evals · 100–129 PRD · 200–314 inventory · 400–449 unit economics · 500–699 operations · 700–799 system requirements |
| `INT-` | Integrations | 001–099 marketplace · 100–199 system requirements |
| `BIZ-` | Business | 001–099 model · 100–199 positioning · 200–249 risk · 250–299 unit economics |
| `PLAN-` | Planning | 001–099 |
| `DM-` `SM-` `G-` `TM-` `AIT-` `V-` `FT-` `RISK-` | Domain rules, state rules, guardrails, threats, validators, fixed text, risks | Per their own documents |

`OPS-` is overloaded across five documents. If a sixth needs it, rename the prefix rather
than reserving another block.

---

## Conventions

- Tables for anything enumerable. Mermaid for flows. No emoji.
- Every claim about an external marketplace carries a verification status. Never assert
  that a marketplace permits something without a dated, quoted source.
- These documents do not give legal advice. Legal questions are flagged for counsel.
- Assumptions are labelled as assumptions.
- Money is integer minor units with an explicit currency, everywhere, always.
