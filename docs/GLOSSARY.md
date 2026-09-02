# Glossary

Canonical vocabulary. Use these terms exactly in code, documentation and UI copy.

| Term | Definition |
|---|---|
| **Seller** | An authenticated tenant who owns listings, sets prices and policy, and makes all consequential decisions. The only actor who can create authorization. |
| **Buyer** | An unauthenticated or pseudonymous person who reaches a listing's conversation surface through the buyer URL and access code. Never an account holder in the MVP. |
| **User** | An identity record. A Seller is a User with a seller account. Reserved for future team accounts. |
| **InventoryItem** | A physical thing the seller owns. May exist before it is listed and persists after sale. |
| **Listing** | The sellable presentation of an InventoryItem: approved copy, price, policy, images, access. |
| **Seller-Provided Fact** | A product statement supplied or explicitly confirmed by the seller. The only admissible source of product truth. Provenance value `SELLER_PROVIDED_FACT`. |
| **AI-Enhanced Copy** | A presentational transformation of seller-provided content. Never a source of fact. Provenance value `AI_ENHANCED_COPY`. |
| **Seller-Approved Copy** | Enhanced or original copy the seller has explicitly approved for buyer-facing use. The only copy the agent may quote. Provenance value `SELLER_APPROVED_COPY`. |
| **ListingContentVersion** | An immutable snapshot of listing copy with its provenance and approval state. |
| **PublicListingAccess** | The public buyer surface for one listing, addressed by an opaque public id. |
| **ListingAccessCode** | A 6-digit numeric code that resolves a listing and opens a buyer session. **Not authentication.** Public by design in the normal flow. |
| **BuyerSession** | An isolated, pseudonymous session created after successful code entry. Scoped to exactly one listing. |
| **Conversation** | The message thread between one BuyerSession and the agent for one listing. |
| **Message** | A single append-only utterance in a Conversation, from buyer, agent or system. |
| **SellerPolicy** | The deterministic rule set governing what the agent may do for a listing: minimum price, concession limits, trades, delivery, pickup, hold window, disclosure rules. |
| **SellerPolicyVersion** | An immutable snapshot of SellerPolicy. Every agent action records the version in force. |
| **Minimum Price** | The seller's floor. Protected information. Never placed in model context and never disclosed to a buyer. |
| **Permitted Counter Range** | The bounded price interval the policy engine computes from policy and conversation state, and the only price guidance the model receives. |
| **Offer** | A buyer's proposal to transact, extracted from conversation into structured form. |
| **OfferVersion** | An immutable snapshot of an offer's material terms. Approval binds to a version, never to an offer in the abstract. |
| **Material Terms** | The fields whose change invalidates approval: amount, currency, included items, delivery or pickup mode, and any condition attached to the offer. |
| **SellerApproval** | A recorded, authenticated seller decision authorizing one exact OfferVersion. The only thing that permits the agent to communicate acceptance. |
| **Authorization** | Permission for a consequential action. Created only by an authenticated seller action. Never by buyer text, model output or agent memory. |
| **Guardrail Engine** | Deterministic, side-effect-free code that evaluates a proposed agent action against policy and conversation state and returns allow, deny or escalate. |
| **Proposed Action** | The structured object the model emits instead of free text: intent, draft reply, optional proposed price, cited fact ids, escalation flag. |
| **Escalation** | Handing a conversation to the seller because the agent may not or should not proceed. |
| **Deal** | An approved offer progressing toward fulfilment. |
| **Handoff** | The transition where the agent stops and the seller takes over location, payment and physical exchange. |
| **Protected Seller Information** | Minimum price, internal notes, exact address, analytics, policy internals, other buyers' conversations and offers, and account data. Never buyer-visible. |
| **AuditEvent** | An append-only record of a consequential action, sufficient to reconstruct what happened and on whose authority. |
| **AIInteraction** | A record of one model call: purpose, model, tokens, cost, latency, outcome. |
| **Action Required** | The seller-facing queue of decisions. The product's primary surface, replacing an inbox. |
| **Eval** | An automated regression test of AI behaviour with deterministic assertions. |
