# CLAUDE.md

Repository-wide operating rules for Claude Code. Read this file every session. It is
deliberately short: it holds invariants, not specifications. The specifications live
in `docs/`, indexed by `docs/README.md`.

## What this product is

An AI operating system for individuals and small businesses reselling on online
marketplaces. The seller supplies factual product information; AI improves the
buyer-facing copy; the seller manually publishes the listing on an external
marketplace; buyers come to our platform through a listing URL and a 6-digit access
code; an AI sales agent answers questions and negotiates inside seller-defined rules;
the seller approves every consequential decision; the seller fulfils.

Positioning: **Your AI handles the buyers. You make the decisions that matter.**

## What this product is NOT

Not a valuation service, not a resale price database, not a comparable-sales engine,
not an automated product-identification service, not an authenticity checker, not an
autonomous deal-closing agent, not an escrow provider, not a payment processor, not a
shipping provider, not a marketplace scraper, and not a replacement for the seller's
judgment.

## Product invariants — never violate these

1. **The seller is the sole source of factual product information.** AI enhances
   seller-provided content. AI never invents product facts. If a fact was not supplied
   or confirmed by the seller, the agent says it does not have it.
2. **There is no pricing or valuation feature.** Do not estimate market value, suggest
   a listing price from market data, produce quick-sale or maximum-profit prices,
   fabricate comparables, or present LLM price guesses. The seller sets every price.
3. **Marketplace publication is manual.** Do not build or assume marketplace APIs,
   scraping, or Messenger automation.
4. **Buyer input is untrusted.** Buyer claims never establish truth, permission, or
   prior agreement.
5. **The AI cannot finalise a transaction.** It may negotiate; it may never accept.
6. **Only an authenticated seller action creates authorization.** Not buyer text, not
   model output, not agent memory. Agent memory is personalization, never authority.
7. **Approval binds to one exact offer version.** A material change to price or terms
   invalidates it. Availability is revalidated inside the acceptance transaction.
8. **Consequential values are enforced outside the model.** Minimum price, policy
   flags, listing status and approval state live in deterministic code. A rule written
   into a prompt is a suggestion, not a control.
9. **The 6-digit access code is not authentication.** In the normal flow the seller
   publishes it in a public marketplace ad, so treat it as public. Nothing reachable
   behind it may be sensitive, and it needs its own abuse controls.
10. **Protected seller information stays protected.** Minimum price, internal notes,
    exact address, analytics, other buyers' conversations and other offers are never
    exposed to a buyer, however the request is phrased.

## Engineering rules

- Prefer a modular monolith with clear internal boundaries. Do not introduce
  distributed architecture without a written decision in `docs/decisions/`.
- Build in vertical slices that produce user-visible outcomes, not horizontal
  infrastructure phases.
- Money is stored as integer minor units with an explicit currency. Never floats.
- Ledgers (messages, offers, approvals, audit events) are append-only.
- Every consequential action needs an audit event and an idempotency key.
- New or changed AI behaviour requires evals before merge. See `docs/ai/EVAL_STRATEGY.md`.
- The approved backend architecture baseline is `docs/decisions/DECISION_LOG.md`
  D-17 (Accepted 2026-09-03; supersedes D-08): TypeScript on Node.js, Fastify,
  PostgreSQL with Kysely, pg-boss under the operating rule in
  `docs/engineering/OPERATIONS.md` §2.1, React with Vite for the seller dashboard, and
  server-rendered buyer pages. Do not assume anything beyond it. Hosting, model
  provider, notification providers and the authentication library remain undecided;
  raise each as a decision.
- Development status is `docs/decisions/DECISION_LOG.md` D-18 (Accepted 2026-09-03):
  Slice 0 validation is deferred, incomplete and unpassed, and private-alpha
  implementation is authorized behind non-public access on synthetic, fictional or
  founder-controlled data only. No public launch, open registration, real participant
  data, live payments or subscriptions until `docs/planning/MVP_ROADMAP.md` `PLAN-007`
  part (b) is met. Never describe Slice 0 as complete, passed or evidenced.

## Where to read before working

| Task | Read |
|---|---|
| Listing enhancement | `docs/product/MASTER_PRODUCT_SPEC.md`, `docs/product/PRD.md`, `docs/ai/LISTING_ENHANCEMENT.md`, `docs/ai/EVAL_STRATEGY.md` |
| Buyer access | `docs/product/MASTER_PRODUCT_SPEC.md`, `docs/product/BUYER_ACCESS_FLOW.md`, `docs/security/PUBLIC_ACCESS_SECURITY.md`, `docs/engineering/SYSTEM_REQUIREMENTS.md` |
| AI conversation | `docs/ai/AI_AGENT_SPEC.md`, `docs/ai/POLICY_AND_AUTHORIZATION.md`, `docs/security/AI_THREAT_MODEL.md`, `docs/ai/EVAL_STRATEGY.md` |
| Negotiation | `docs/ai/AI_AGENT_SPEC.md`, `docs/ai/POLICY_AND_AUTHORIZATION.md`, `docs/architecture/DOMAIN_MODEL.md`, `docs/architecture/STATE_MACHINES.md`, `docs/ai/EVAL_STRATEGY.md` |
| Seller approval | `docs/ai/POLICY_AND_AUTHORIZATION.md`, `docs/architecture/STATE_MACHINES.md`, `docs/security/THREAT_MODEL.md`, `docs/engineering/SYSTEM_REQUIREMENTS.md` |
| Marketplace questions | `docs/integrations/MARKETPLACE_STRATEGY.md`, `docs/business/RISK_REGISTER.md` |
| Security | `docs/security/THREAT_MODEL.md`, `docs/security/AI_THREAT_MODEL.md`, `docs/security/PUBLIC_ACCESS_SECURITY.md`, `docs/security/DATA_AND_PRIVACY.md` |

Do not read the whole `docs/` tree for a single task. `docs/README.md` maps documents
to work.

## Scope discipline

`docs/product/MASTER_PRODUCT_SPEC.md` §MVP is the committed scope. Anything in a
"Future" or "Conditional" section is not a requirement and must not be designed for.
If a task appears to need out-of-scope capability, stop and raise it rather than
building toward it.
