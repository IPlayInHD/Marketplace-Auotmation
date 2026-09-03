# Buyer test script

Two buyer populations exist and are never mixed:

| Population | Who | Counted in | Script sections |
|---|---|---|---|
| **Real** (`RC-####`) | People who contacted a live validation listing (`WF-###` or `FI-###`) on their own; logged as events on a listing, never as recruited people (`SLICE_0_SCORECARD.md` §1a) | Canonical funnel M-09, M-19, M-20, M-21; offers M-12; questions M-10 | §1 (notice only), §4 to §6 handled by the operator per the playbook; no interview, no research question |
| **Moderated** (`BM-###`) | Recruited participants, about 25 minutes each; 20 completed sessions minimum, 26 to 28 booked (`RECRUITMENT_PLAN.md` §0); not sellers in this run | M-10, M-11, M-12 (reported separately); trust and confusion questions | All sections |

Moderated sessions explain *why*; real contacts measure *whether*. A moderated result is
never entered in a real-funnel field. Neither population counts toward the 20 structured
seller interviews (`SI-###`), which use a different script and a different cohort.

## 1. Buyer entry

**Real buyers.** The listing carries the URL and code. The page shows the pilot notice
(`CONSENT_AND_PRIVACY_SCRIPT.md` §2) before the first message. Nothing else is asked.
The operator records, per contact (`RC-####`): `listing_id` and `arm`, exposure basis
and confirmation (`SLICE_0_SCORECARD.md` §1a, OVQ-05), page opened and its attribution
(OVQ-08), code entered, first message sent, and the marketplace channel key. No name,
handle or contact route is recorded in the scorecard.

**Moderated buyers.** Consent per the consent script §3, ID assigned. The moderator says:

> Imagine you saw this item for sale on [marketplace] and the seller's post said:
> "Questions? Open [URL] and enter code [######]." Here is the post. Use your own phone
> and do what you would actually do. Think out loud if you can. I won't help unless you
> are stuck for more than a minute, and if I do I'll note it. A person, not a computer,
> will answer your messages today.

Hand over the post (a printed or on-screen copy of the actual published listing text).
Start the timer.

## 2. URL/code experience

Observe and record, without prompting:

| Field | Values |
|---|---|
| `opened_url` | yes / no / helped |
| `t_to_open_s` | seconds from start to page load |
| `preview_noticed` | did the participant mention the item, price or seller before entering the code (verbatim) |
| `code_attempts` | count |
| `code_entered` | yes / no / helped |
| `t_to_code_s` | seconds |
| `confusion_markers` | any of: asked what the code is for; asked if this is a scam; looked for a login; tried to buy on the page; stopped at the gate; other (verbatim) |

If the participant stops for more than a minute, ask "What are you thinking?" once.
Record the answer. If they still cannot proceed, help, and record `helped`.

## 3. Disclosure

After the gate, the banner and notice are visible. Do not point at them. Later (§7) ask
whether they were noticed. If the participant asks during the session "am I talking to a
person?", the operator answers truthfully per OVQ-01 and the moderator records
`asked_human = yes`.

## 4. Questions

Say: "Ask whatever you'd want to know before deciding." The operator answers per
`CONCIERGE_OPERATOR_PLAYBOOK.md` from the fact sheet only. The moderator records each
question, the answer type (`fact` / `unknown` / `refusal` / `escalation`), the fact ID
used, and the participant's reaction (verbatim or `continued` / `stopped`).

At least one question per moderated session must be one the fact sheet cannot answer.
If the participant does not ask one naturally, after their third question say: "Ask
something specific about the item that isn't in the description." Record that the prompt
was used (`unknown_prompted = yes`).

## 5. Unknown-fact handling

The operator's response is fixed (playbook §5): the fact is not confirmed, the seller
will be asked, would that help. The moderator records whether the participant: waited
for the seller's answer, moved on, or stopped; and any verbatim reaction. For real
buyers the operator relays the seller's answer when it arrives, or says plainly that the
seller has not answered yet.

## 6. Offer submission

The moderator does not suggest an offer. If, after the questions, the participant has
not raised price, say: "Do what you'd do next." If they make an offer, the operator
restates the terms as understood, says it will go to the seller and that only the seller
can accept, and relays it. Record `offer_made`, `offer_amount_band` (as a share of the
asking price: below 70%, 70 to 89%, 90 to 99%, at asking, above asking — never the
exact amount in the scorecard), `offer_conditions` (pickup / delivery / include item /
hold / other), and the participant's reaction to "only the seller can accept".

If the participant asks "is it a deal?", the operator uses the fixed authority response
(playbook §6). Record `asked_is_deal = yes`.

## 7. Trust and confusion questions (moderated only, after the task)

Open questions first. Do not use the words "trust", "scam", "AI" or "clear" before the
participant does.

| ID | Question |
|---|---|
| BQ-01 | Talk me through what you just did, from the post to the end. |
| BQ-02 | What did you expect to see when you opened the link? What did you see? |
| BQ-03 | What was the six-digit code for, as far as you could tell? |
| BQ-04 | Was there a point where you nearly stopped? What was happening? |
| BQ-05 | What did you notice about who was answering you? |
| BQ-06 | If you had found this listing for real, what would you have done differently? |
| BQ-07 | (Only now) Did you see any notice about who was answering? What did it say, as you remember it? |
| BQ-08 | (Only now) Suppose the person answering had been an AI assistant working for the seller, and the page told you so. What, if anything, changes for you? |
| BQ-09 | What, if anything, would you have wanted to know that you couldn't find out? |
| BQ-10 | Is there anything you'd want deleted from today? (Record; act per consent script §5.) |

Record verbatim. Code afterwards, never during, using: `trust_signal` (positive /
neutral / negative, with the quote), `ai_reaction` (positive / neutral / negative / no
change, with the quote), `scam_mention` (yes/no).

## 8. Safety escalation

The moderator stops the session and opens an incident row if: the participant is asked
for, or offers, a password, payment detail or identity document; the page shows any
protected seller information or another buyer's content (HS-03); the operator sends
commitment language (HS-05); the operator states an unconfirmed fact (HS-04); the
participant becomes distressed. The participant is told plainly what happened and what
will be deleted.

## 9. Completion criteria

A moderated session is **complete** when the participant reached the gate outcome
(entered or stopped), asked at least one question, received the unknown-fact response at
least once, and answered BQ-01 to BQ-10 or declined to. A session stopped by the
participant is complete with `stopped_by_participant = yes` and stays in the
denominator of M-11.

A real contact is complete when the funnel fields are recorded up to the last observed
event and the conversation reached a stated end, a seller decision, or the observation
window closed.
