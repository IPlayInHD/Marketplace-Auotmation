# Seller concierge test — moderator instructions

One run of this procedure is one seller/listing **workflow** (`WF-###`). Each workflow
seller (`SW-###`) runs at least two, on two real items they intend to sell. A
founder-experiment item (`FI-###`) is never run through this procedure. The moderator
is one founder; the concierge operator answering buyers may be the other founder. Every
step is timed with a stopwatch log kept in the protected store.

Roles: **Moderator** (runs this script, observes, records) · **Operator** (plays the
future system per `CONCIERGE_OPERATOR_PLAYBOOK.md`) · **Seller** (the participant).

## 1. Before the session

- Consent given and recorded (`CONSENT_AND_PRIVACY_SCRIPT.md` §1); `SW-###` assigned
  with its linked `SI-###`.
- Structured interview completed under that `SI-###`; `baseline_prepare_min` recorded.
- Channel(s) the seller will publish on have a completed policy-reading row in
  `MARKETPLACE_EVIDENCE_TEMPLATE.csv` (`MARKETPLACE_FEASIBILITY_PROTOCOL.md` step 1).
  If the row is `VERIFIED RESTRICTED` for every surface on that channel, the seller
  still publishes the listing **without** the link and code (their normal listing), and
  ST-04 is recorded as `simulated` with the reason. If the row is `UNCLEAR` the seller
  is told so in the words of `BUYER-024` and chooses whether to include the link.
- A static buyer page exists for this listing (§5) with the code set, the pilot notice
  and the disclosure banner.
- Scorecard row `WF-###` created with `stage_reached = 0`, `seller_id` and
  `linked_si_id` filled.

## 2. Opening (read aloud)

> We'll take one item you're selling anyway and go through the whole thing, from your
> facts to a live listing to buyer questions. I'll ask you to do everything a seller
> would do yourself, on your own device. I'll time some steps; that's about the process,
> not about you. Say "stop" at any point and we stop.

Start the stopwatch log: `t0`.

## 3. Seller fact intake (stage ST-01)

Hand the seller the blank fact sheet (paper or a plain document): the fields of
`MASTER_PRODUCT_SPEC.md` `LIST-002` — title (required), name, brand, model, size,
colour, condition, included items, defects, age, usage history, specifications,
summary, description — each optional except title, each in the seller's own words.

Say only: "Write what you know about the item, in your own words. Leave anything you
don't know blank. Blank is fine."

Do **not** suggest a field value, a brand, a model, a condition word or a price. If the
seller asks "what should I put", answer "whatever you know; if you don't know, leave it".
If the seller asks the moderator to look something up, decline and record
`asked_inference = yes`.

Record: `t_facts_start`, `t_facts_end`, `fact_fields_populated` (count of non-blank
fields), `asked_inference`, verbatim notable remarks.

## 4. Photo intake (ST-01)

Ask the seller to provide the photos they would normally use, from their own device.
Record `photos_supplied` (count) and how they were transferred (never through a
marketplace; a plain file transfer to the protected store). No photo is used to derive a
fact (`D-11`); if the seller says "you can see the model in the photo", the moderator
says "for this test only what you write counts; would you like to write it in?"

## 5. The static buyer page

Before publication the operator prepares one hand-made page for this listing, outside
this repository, on a founder-controlled domain. Requirements (mirroring `BUYER-004` to
`BUYER-007` as far as a static page can):

| Element | Requirement |
|---|---|
| Preview above the gate | Photos, approved title, asking price, seller display name, approved summary, visible before any input |
| Code gate | A six-digit numeric field with a numeric keyboard on phones; a wrong code shows "That code doesn't match this listing." with no other detail |
| Disclosure banner | Fixed text, above the conversation area, per OVQ-01: "Questions here are answered by a sales assistant acting for [display name]. During this pilot the assistant is a person from the pilot team, not the seller. Only [display name] can accept an offer." |
| Pilot notice | The buyer notice from `CONSENT_AND_PRIVACY_SCRIPT.md` §2, before the first message can be sent |
| Question form | Free-text question, plus the optional reply-channel field of OVQ-02, plus a "how to have this deleted" line |
| Absent | Any account, email requirement, payment field, valuation, other listings, minimum price, seller contact details, third-party analytics script |

The page contains no protected seller information. The moderator checks the page against
this table before publication and records `page_checked = yes`.

## 6. Listing-draft procedure (ST-02)

The operator produces the draft from the fact sheet only, following
`CONCIERGE_OPERATOR_PLAYBOOK.md` §3, in the seller's absence (a break for the seller).
Time box: 15 minutes. The operator runs the fabrication check (§4 of the playbook) and
the moderator, as second reviewer, runs it again. Both sign the check in the stopwatch
log. Record `t_draft_min`, `draft_check_findings` (count and V-codes), and whether any
finding was corrected before the seller saw the draft.

The draft is presented side by side with the seller's original, field by field,
labelled "Your words" and "Tidied version of your words" (`UX_FLOWS.md` §4.1).

## 7. Seller correction and approval (ST-03)

Say: "Here are your words and a tidied version. Read them both. You can accept the
tidied version, change anything, or go back to your own words. Nothing goes live until
you say it's right."

Record `t_review_min`, `seller_action` (accept / edit / restore), `edits_made` (count of
fields changed), `seller_flagged_addition` (yes if the seller says something was added
that they did not say — this is also a draft-check escape and an incident row), and the
seller's rating 1 to 5 of "the tidied version says only what I said".

`t_prepare = t_review_end − t_facts_start` in minutes.

## 8. Price and rules

The seller states their asking price, their minimum acceptable price (written on a
separate sheet kept by the seller and the operator only; never on the buyer page, never
in any buyer reply), and answers: negotiation yes/no; maximum they'd let the assistant
come down without asking; trades, delivery, pickup yes/no; whether an area may be
mentioned; how long an offer may wait for them.

The moderator never suggests a number and never comments on one. If the seller asks
"what should I ask", the answer is "whatever you'd ask today; we don't advise on price."

## 9. Manual posting step (ST-04)

The seller publishes on their own account, from their own device, using the copy block
the operator assembled: approved title, approved description, details, asking price,
and — where the channel row permits it or is `UNCLEAR` and the seller chose to — the
line "Questions? Open [URL] and enter code [######]. A sales assistant answers for me
during this pilot; I make every final decision."

The moderator watches without touching the device. Record `t_publish_min`,
`published` (yes / rejected / simulated), `placement_surface` (listing body / reply
only / profile / other, per `INT-040`), `channel_key`, and any obstacle in the seller's
words. If the marketplace rejects or removes the listing, record it in the channel
evidence sheet as well (`MARKETPLACE_FEASIBILITY_PROTOCOL.md` §5).

## 10. URL/code-sharing step (ST-05 preparation)

Record how the link and code were actually exposed: in the listing body, in a reply
only (arm 2), or via the phone-number control arm (arm 3, founder items `FI-###` only).
Note the exact text as published (screenshot to the protected store, redacted copy to
the manifest). This is the evidence for M-08 and the exposure denominator of M-19
(OVQ-05).

## 11. Buyer phase (ST-05 to ST-08)

Real buyers now contact the listing. The operator handles them per the playbook. The
seller is available by their preferred route (own phone) for unknown facts and offers.
The moderator keeps the buyer scorecard rows per contact. The workflow stays open for
the observation window in `EXECUTION_SCHEDULE.md` (default 7 days) or until the seller
sells or withdraws the item, whichever is first.

## 12. Summary and decision (ST-09)

When an offer or a notable conversation occurs, the operator delivers the structured
summary of playbook §8 to the seller. The moderator records `summary_delivered`,
`t_offer_to_decision_min`, `seller_decision` (approve / decline / counter / ignore /
none), `seller_summary_rating` (1 to 5, "this told me what I needed to decide"), and
verbatim reaction. The seller alone decides; the operator relays.

## 13. Review (ST-10) and close

Within 24 hours of the workflow closing, both founders review every operator turn on
this listing for fabrication (M-07), privacy (HS-03, HS-07), commitment language
(HS-05), disclosure (HS-06), and log incidents. Then the moderator fills the stage
outcomes ST-01 to ST-10 and `workflow_completed = yes`.

## 14. Timing instructions

- One stopwatch log per workflow, in the protected store, with the timestamp of every
  `t_*` event. Never reconstruct a time from memory; a missing time is blank.
- Times exclude breaks and are recorded to the minute.
- `t_prepare` is the only timing used in M-04 and M-05.

## 15. Observation fields

Fields in `SELLER_SCORECARD_TEMPLATE.csv` are the authoritative list. In addition the
moderator keeps free-text observations under these headings, in the seller's words where
possible: what the seller hesitated on; what they asked for that the study cannot give;
what they said about buyers; what they said about the approval step; what they said
unprompted about paying.

## 16. Stop conditions for a session

Stop the session, record the reason and time, and open an incident row when:

- the seller asks to stop;
- a credential, password or login would be needed to continue (`INT-060`);
- the operator cannot answer a buyer without inventing a fact and the seller is not
  reachable — the buyer receives the unknown-fact response and the session continues,
  but if the operator has already sent an invented fact, stop and record HS-04;
- a buyer receives anything that could read as acceptance before the seller decided
  (HS-05);
- the buyer page has exposed anything protected (HS-03);
- a marketplace warns or restricts the seller's account — the listing is taken down by
  the seller immediately, the channel row is updated, and the workflow continues only
  on another surface with the seller's agreement.
