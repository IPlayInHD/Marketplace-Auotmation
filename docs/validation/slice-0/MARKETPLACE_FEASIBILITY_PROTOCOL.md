# Marketplace feasibility protocol

Executes `integrations/MARKETPLACE_STRATEGY.md` §5 for Slice 0 and Test 1 of
`business/RISK_REGISTER.md` §4. **This document states no marketplace policy.** Every
channel row starts as `UNCLEAR - REQUIRES RESEARCH` (`INT-020`) and moves only on dated
evidence recorded in `MARKETPLACE_EVIDENCE_TEMPLATE.csv`. A statement about what a
marketplace allows, made anywhere without a matching evidence row, is a documentation
defect (`INT-021`, `INT-022`).

## 1. Rules

- Policy is read by a person from the marketplace's own current published pages
  (`INT-030` step 1). No scraping, no automated collection, no summary site, no forum
  post, no model recollection. Record the URL, the retrieval date and the exact quoted
  text.
- Live tests use real listings for real items the seller actually owns and will sell,
  on accounts the seller or the founders control (`INT-031`). A fake listing is a policy
  breach and is not evidence.
- One placement variant per listing (`INT-040` surfaces A to F plus "listing body").
- A surviving listing is an observation on a date, not a permission (`INT-032`).
- Every row gets a `next_recheck_date` per `INT-033`.
- No marketplace account is automated, no message is sent programmatically, and the
  founders never act inside a seller's account (`INT-060`).

## 2. One evidence row per channel and surface

For each channel the validation will use, and each surface tested on it, one row in
`MARKETPLACE_EVIDENCE_TEMPLATE.csv` with these fields:

| Field | Content |
|---|---|
| `channel_key` | From `INT-052` (`fb_marketplace`, `ebay`, `kijiji`, `craigslist`, `offerup`, `mercari`, `poshmark`, `depop`, `varagesale`, `social_dm`, `own_site`, `other`) |
| `surface` | `listing_body`, `reply_message` (A), `profile_field` (B), `own_landing_page` (C), `qr_image` (D), `manual_share` (E), `code_only` (F) |
| `policy_source_url` | The marketplace's own page; blank means step 1 is not done and no listing may be published for the study on this channel |
| `policy_source_date` | Retrieval date |
| `policy_quote` | Exact quoted text addressing links, off-platform contact or codes, or `no explicit statement found` |
| `policy_page_last_updated` | As shown on the page, if shown |
| `urls_permitted` | `stated_yes` / `stated_no` / `not_addressed` / `unknown` — from the quote only |
| `codes_or_text_permitted` | Same values, for a numeric code or plain text without a link (`INT-025` Q5) |
| `messages_permit_flow` | Same values, for a link or code in a reply or direct message (Q2) |
| `distinguishes_link_types` | What the policy says about bare domain, path URL, image, QR (Q4), or `not_addressed` |
| `stated_enforcement` | Removal, warning, restriction, suspension, or `not_stated` (Q6) |
| `visibility_test_listing` | The `WF-nn` used, or `founder-owned:<item>` |
| `visibility_test_date` | Date published |
| `visible_after_24h`, `visible_after_48h`, `visible_after_7d` | `yes` / `no` / `altered` / `not_checked` |
| `mobile_behavior` | What a buyer sees on a phone: link tappable / plain text / hidden / truncated |
| `desktop_behavior` | Same on desktop |
| `moderation_outcome` | `none_observed` / `removed` / `altered` / `warned` / `restricted` / `suspended`, with the date |
| `region_or_category_note` | Any regional or category dependence observed (Q8) |
| `evidence_refs` | `EV-nnnn` ids of screenshots (redacted copies) and the policy capture |
| `classification` | `VERIFIED SUPPORTED` / `VERIFIED RESTRICTED` / `UNCLEAR - REQUIRES RESEARCH` / `NOT REQUIRED FOR MVP` |
| `classification_basis` | Which evidence justifies it, in one line |
| `reviewer` | Initials of the founder who classified and the second founder who checked |
| `next_recheck_date` | Per `INT-033` |

## 3. Procedure per channel

1. **Read.** Find the current terms, community standards and prohibited-content pages.
   Answer `INT-025` Q1 to Q10 in the row fields from quoted text only. Screenshot the
   page with its date; store raw in the protected store; hash a redacted copy into the
   manifest. If nothing addresses links or codes, record `not_addressed`; that is not
   permission.
2. **Decide surfaces to test.** Listing body first; then reply-only (A); then any other
   surface the seller normally uses. Never test a surface the policy `stated_no` for
   with a participant's account; a `stated_no` surface may be tested only on a
   founder-owned account and item, if at all, and the founders accept the account risk.
3. **Publish.** The seller publishes per `SELLER_CONCIERGE_TEST.md` §9, on their own
   account and device. Record the surface used and the exact text.
4. **Observe.** Check visibility at 24 hours, 48 hours and 7 days from the seller's
   own view and from a second, logged-out or different-account view where the
   marketplace allows public viewing. Record mobile and desktop rendering. Never use
   automation to check.
5. **Record moderation.** Any removal, edit, warning or restriction is recorded the day
   it is noticed, with a redacted screenshot. The seller decides whether to continue on
   another surface; the founders never ask a seller to re-post something removed.
6. **Classify.** `VERIFIED SUPPORTED` requires either a policy quote that permits the
   surface **and** a completed 7-day observation without removal, or two independent
   listings on that surface surviving 7 days where the policy is `not_addressed`.
   `VERIFIED RESTRICTED` requires a policy quote that prohibits it **or** a removal or
   warning attributable to the surface. Anything else stays `UNCLEAR`. Both founders
   initial the classification.

## 4. Test 1 evaluation

Test 1 passes when at least one surface is `VERIFIED SUPPORTED` on at least two primary
channels (OVQ-03 defines primary for this run). It fails when every candidate surface on
the primary channels is `VERIFIED RESTRICTED`. Any other state is `UNCLEAR`, and the
memo reports Test 1 as not passed. **HS-01** is the failure case for the primary launch
marketplace.

## 5. What the marketplace evidence never contains

Participant names or handles, listing URLs on the marketplace that identify the seller,
the seller's marketplace identity, unredacted screenshots, or any statement of the form
"[marketplace] allows links" that is not a quote with a date. The redacted screenshot
shows the placement and the moderation outcome with identities masked.
