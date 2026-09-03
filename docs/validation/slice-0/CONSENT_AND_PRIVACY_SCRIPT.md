# Consent and privacy script

Plain-language disclosures for every participant type, and the data rules the founders
follow. **This is not legal advice and makes no legal claim.** The applicable regime
depends on the unresolved launch-jurisdiction question (`Q-07`); wording here follows
the categories in `security/DATA_AND_PRIVACY.md` (`DATA-248`, `DATA-381`). Where a
review changes the text, the record notes the version each participant saw
(`DATA-245`). Three levels of review apply and are not to be confused:

| Level | What | Effect on the run |
|---|---|---|
| Required | The plain-language disclosure for the participant's type (§1 workflow seller, §1a interview-only seller, §2 real buyer notice, §3 moderated buyer) is given, and consent recorded, before that person's session or first message | Blocks the session it applies to; a session without it is an HS-06 or HS-07 incident |
| Recommended | A jurisdiction-specific legal review of this wording once the run's jurisdiction is known (`Q-07`); the founders record in the memo whether it happened and what changed | Recorded; not a universal blocker on the run |
| Situational | Additional review may be needed before audio recording, before retaining sensitive information a participant volunteers, or where the run's jurisdiction has specific rules on research or recording; if that review is unavailable, the run proceeds without recording and redacts volunteered sensitive information on sight (§7) | Blocks only the specific activity |

No marketplace credentials are requested from anyone. No personal information beyond
the ID map is collected from anyone. Real buyer contacts are not participants in a
study session: they see the page notice (§2) and nothing else.

## 1. Workflow seller disclosure (`SW-###`; read aloud, then given in writing)

> **What this is.** Two founders, [names], are studying how people who sell on online
> marketplaces handle listings, buyer messages and offers. We are doing it by hand,
> before building any software. Taking part means a conversation with us and running
> two of your real listings through a workflow we operate manually.
>
> **What we will ask you to do.** Tell us the facts about an item in your own words and
> give us photos; read and approve a tidied version of your words; publish the listing
> yourself, from your own account, as you normally do; if you choose, add a web link and
> a six-digit code to the listing; give us your prices and your rules for offers; decide
> yourself on any offer we pass to you; and answer some questions afterwards.
>
> **What we will never do.** We will never ask for your marketplace password, login or
> account access. We will never post, edit or message on your behalf inside a
> marketplace. We will never tell you what an item is worth or what to charge. Nothing
> will be agreed with a buyer unless you say yes yourself. No money changes hands with
> us during this study.
>
> **Who answers your buyers.** When a buyer follows the link, a person from our team,
> not a computer and not you, answers using only the facts you gave us. The buyer is
> told this plainly on the page. If a buyer asks something you did not tell us, we say
> we do not have it confirmed and we ask you.
>
> **What we record.** Your answers to our questions; the facts and photos you give us;
> the tidied text and your changes; how long steps take; what buyers ask and what we
> answer; any offers and your decisions; whether the listing stayed up on the
> marketplace; and screenshots of the listing and the page with names masked. We record
> your asking price and your minimum price on a sheet only we and you see. We do not
> record your legal name, address or contact details anywhere except one private list
> that links your participant number to how to reach you.
>
> **How it is stored.** Under a participant number, in a location only the two of us
> can open. Summaries that leave that location use the number only. Nothing that
> identifies you goes into our code repository or any shared document.
>
> **How long.** Raw notes, recordings and unmasked screenshots are deleted within 90
> days after the study's decision is signed. Masked summaries and counts are kept as the
> study record.
>
> **Your choices.** You can skip any question, stop any session, and withdraw at any
> time by telling either of us, in any way. If you withdraw, we delete what identifies
> you and stop using your material; counts already summarised stay as counts. You can
> ask to see what we hold about you.
>
> **Recording.** We would like to record audio of the interview so we do not misquote
> you. Say no and we take notes only.
>
> **Thank you.** [State the gesture, if any, up front: for example a small gift card of
> stated value, given whether or not you complete the study.]
>
> **Contact.** [Incident and questions contact placeholder: a named founder and one
> contact route, to be filled before the first session.]

Record: participant ID (`SW-###` with its linked `SI-###`), `cohort`, date, notice
version, `audio_consent` (yes/no), `screenshot_consent` (yes/no), `gesture_stated`
(yes/no).

## 1a. Interview-only seller disclosure (`SI-###` without a workflow)

Read §1 with these substitutions for a person who is interviewed and does not run
listings: replace the last sentence of **What this is** with "Taking part means one
conversation with us of about twenty-five minutes about how you sell today and what,
if anything, you would pay for help with it. You will not list anything, and we will
not touch your listings or accounts." Omit **What we will ask you to do** and **Who
answers your buyers**. In **What we record**, keep only "your answers to our questions"
and the private list sentence. Keep every other paragraph as written.

If the same person later agrees to run listings, read the full §1 before their first
workflow and record that consent under a new `SW-###` linked to their existing
`SI-###`; the interview is not repeated.

Record as in §1, with `cohort = SI` and `linked_sw_id = none`.

## 2. Real buyer notice on the pilot page (`RC-####`; shown before the first message)

Real buyer contacts are not recruited, not interviewed, not asked any research
question, not offered a gesture and not asked for any personal information. This notice
is the only disclosure they receive; contacting a listing is a funnel event, not a
study session.

Fixed text on every validation page, above the question form:

> **Pilot notice.** This page is run by [company or founders' names] as a pilot for a
> service that helps sellers answer buyers. Questions here are answered by a person from
> the pilot team acting for [seller display name], using only what the seller told us.
> Only [seller display name] can accept an offer. We keep what you write here, and the
> seller can read it, for up to 90 days after the pilot ends, then delete it. We do not
> ask for your name, email or phone number; if you choose to give a way to reply, we use
> it only to reply and delete it with the rest. No payment or personal details are ever
> requested on this page. To have anything you wrote deleted, [deletion route
> placeholder: a contact route that needs no account].

The disclosure banner of `CONCIERGE_OPERATOR_PLAYBOOK.md` §6 (P-01) appears above it.

## 3. Moderated buyer participant disclosure (`BM-###`; read aloud)

> **What this is.** A 25-minute test of a page a marketplace seller might link to. You
> will use your own phone on a real listing, ask questions and, if you want, make an
> offer. It is not a real purchase; nothing is bought, sold or paid.
>
> **Who answers.** A person from our team answers your messages today, not a computer.
> We will ask you afterwards how you would feel if it were an automated assistant.
>
> **What we record.** What you do on the page and how long it takes; what you ask and
> what you are told; your answers to our questions afterwards; and, only if you agree,
> screenshots of the page with anything identifying masked. We record no name, email or
> phone number beyond a private list linking your participant number to how we reached
> you, and we delete that within 90 days after the study's decision.
>
> **Your choices.** Stop at any time, skip any question, ask for anything to be
> deleted. [Gesture, if any, stated up front.] [Contact placeholder.]

Record as in §1, with `cohort = BM`. A moderated buyer participant is not a seller in
this run and is never read §1 or §1a; their session is never recorded as an interview.

## 4. Human-concierge disclosure rules

- Every buyer, real or moderated, sees P-01 before they can send a message.
- No one is ever told or allowed to believe that an AI is answering during Slice 0.
- If asked whether they are talking to a person, the operator answers truthfully (P-07).
- The operator never claims to be the seller (`AI-023`).
- Any deviation is an HS-06 incident.

## 5. Withdrawal procedure

1. A participant withdraws by telling either founder by any route, no reason needed.
2. Within 24 hours: the ID-map entry is deleted; raw notes, recordings and unmasked
   screenshots for that participant are deleted from the protected store; the manifest
   rows are marked `deleted (withdrawal)` with the date; scorecard rows are marked
   `withdrawn = yes`.
3. Aggregated counts already computed stay as counts; nothing attributable remains.
4. A real buyer who asks for deletion through the page's deletion route is handled the
   same way against their `RC-####` event row and the conversation record.
5. The founder confirms to the person what was deleted and what, if anything, remains as
   an aggregate (`DATA-347`: never claim more deletion than happened).

## 6. Data-minimisation rules

| Rule | Statement |
|---|---|
| DM-1 | Collect only the fields in `DATA_DICTIONARY.md`. A new field needs a dictionary entry before it is collected. |
| DM-2 | A real buyer is an event identifier (`RC-####`) on a listing, never a person record. No name, marketplace handle, email or phone is recorded for a real buyer; an optional pilot reply channel (OVQ-02) is kept only with the raw conversation in the protected store and deleted with it. |
| DM-3 | Seller identity lives in one ID-map file in the protected store. Nowhere else. |
| DM-4 | The seller's minimum price and rules live on the private sheet only; never in a scorecard, memo, buyer page or message. |
| DM-5 | Raw transcripts, recordings and unmasked screenshots never leave the protected store. What leaves is a summary with IDs, or a masked screenshot registered in the manifest. |
| DM-6 | Nothing in `docs/validation/slice-0/` in Git ever contains a participant's personal information, a raw conversation, an unredacted screenshot, a phone number, an email or a marketplace identity. Templates, IDs, redacted summaries, aggregates, the decision memo and manifest hashes are permitted. |
| DM-7 | No third-party analytics or tracking runs on the pilot page. |
| DM-8 | Screenshots are taken only with the participant's `screenshot_consent`, and identities on them are masked before any copy leaves the protected store. |
| DM-9 | Buyer free text is treated as sensitive whatever it contains (`DATA-268`). |
| DM-10 | The pilot page's open counter or access log runs on a founder-controlled host, keeps no IP address for longer than 7 days, sets no cookie, and holds only the listing id, timestamp, optional `?r=RC-####` reference and code-entry result (`SLICE_0_SCORECARD.md` §1a). |

## 7. Prohibited data

Never collected, and an HS-07 incident if it is: passwords, session tokens, marketplace
credentials or cookies; payment details of any kind; identity documents; a buyer's home
address; a seller's exact address beyond what the seller chooses to tell a buyer
themselves after approval; health, financial or other special-category information
volunteered in free text (redacted from summaries on sight); photographs of people;
children's data.

## 8. Retention and deletion procedure

| Data | Where | Retention | Deletion |
|---|---|---|---|
| ID map | Protected store | Until 90 days after the decision memo is signed, or withdrawal | Delete the file entry; record in the manifest |
| Raw interview notes and audio | Protected store | Same | Delete; manifest row marked deleted |
| Raw conversations and unmasked screenshots | Protected store | Same | Same |
| Seller private price sheet | Protected store | Deleted when the workflow closes and the summary is written | Same |
| Page-open log | Founder-controlled host | IP addresses at most 7 days; remaining entries as raw data, 90 days after the memo | Rotated on the host; counts copied to rows |
| Scorecard CSVs (IDs and coded fields) | Protected store; a redacted copy may be committed with the memo | Study record | Kept; personal fields never present |
| Masked screenshots, summaries, manifest, memo | Protected store and, redacted, the repository | Study record | Kept |

Deletion is done by a founder, logged in the manifest with the date, and checked by the
other founder in the weekly review (`DAILY_OPERATOR_CHECKLIST.md` §5).

## 9. Incident contact placeholder

`[Name of the founder responsible for participant contact] · [one contact route that
needs no account] · [hours of availability]` — to be completed before the first session
and printed on every consent copy.
