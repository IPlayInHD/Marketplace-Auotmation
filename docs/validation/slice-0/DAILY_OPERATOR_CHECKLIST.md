# Daily operator checklist

Printed and ticked for every session day. A tick is a claim; the item it refers to must
exist in the protected store or the manifest.

## 1. Before a session

- [ ] Consent recorded for every participant in today's sessions; notice version noted.
- [ ] Participant IDs assigned; the ID map is the only place a name appears.
- [ ] Today's fact sheets, private price sheets and permitted ranges prepared; the
      minimum price is on the private sheet only.
- [ ] Channel evidence rows exist (policy reading complete) for every channel a seller
      will publish on today; classification and `BUYER-024` wording ready to read out.
- [ ] Static buyer page for each listing checked against `SELLER_CONCIERGE_TEST.md` §5
      (`page_checked`); disclosure P-01 and the pilot notice visible above the form.
- [ ] Playbook §12 forbidden list on the operator's desk; fixed texts P-01 to P-07 to hand.
- [ ] Stopwatch log opened for each workflow; scorecard rows created with
      `stage_reached` set.
- [ ] Second founder's review slot booked for today's conversations.
- [ ] Incident contact route reachable; incident log open.

## 2. During a session

- [ ] Read scripts as written; note every deviation in the observation notes.
- [ ] Never suggest a fact, a price, a condition word or a reply to a seller.
- [ ] Every operator message logged with its kind (`answer` with fact ID, `unknown`,
      `counter`, `route`, `refuse`, `hold`, `authority`, `disengage`, `logistics`,
      `closed`) before it is sent.
- [ ] Every buyer question logged with its answer type.
- [ ] Unknown facts: fixed response sent; seller asked; time logged.
- [ ] Offers: terms restated to the buyer; summary sent to the seller; no acceptance
      language; seller decision time logged.
- [ ] "Am I talking to a person?" answered truthfully (P-07); `asked_human` logged.
- [ ] Any stop condition in `SELLER_CONCIERGE_TEST.md` §16 or `BUYER_TEST_SCRIPT.md` §8:
      stop, tell the participant, open an incident row now.
- [ ] Timings recorded from the stopwatch, not reconstructed.

## 3. After a session

- [ ] Scorecard rows completed for every field the stage reached; blanks stay blank.
- [ ] Conversation summaries written (playbook §10) with IDs only.
- [ ] Raw transcripts, notes, audio and unmasked screenshots moved to the protected
      store; nothing left on a phone, a chat app or a shared drive.
- [ ] Redacted copies produced only where a manifest row will reference them.
- [ ] Evidence manifest rows added with SHA-256 for every new artefact.
- [ ] Channel visibility checks due today (24h / 48h / 7d) performed by eye and recorded.
- [ ] Seller informed of any offer waiting, in the summary format, with "only you decide".

## 4. Evidence quality checks (second founder, daily)

- [ ] Sample at least one in three operator answers per conversation, plus every flagged
      one, against the fabrication check (playbook §4); record findings; any material
      finding that reached a buyer or an approved draft → incident, HS-04 candidate.
- [ ] Read every operator message for commitment language (`G-09` words) → HS-05 check.
- [ ] Check every summary for the seller's minimum, other buyers, addresses → HS-03 check.
- [ ] Confirm every scorecard `t_*` value has a stopwatch-log line.
- [ ] Confirm every exclusion has a reason, a decider, a date and the
      `exclusion_decided_before_outcome` flag.
- [ ] Confirm no row was edited after the review except to correct a documented
      transcription error (note the correction in `notes_ref`).
- [ ] Confirm moderated rows (`BM-###`) are `population = moderated` and real rows
      (`RC-####`) are `real`; every real row has `listing_id`, `arm`, `exposure_basis`
      and `open_attribution`; every `SW-###` row carries its `linked_si_id`; no interview
      record was created from a buyer session or a workflow debrief.

## 5. Privacy cleanup (daily, and weekly review)

- [ ] No name, handle, email, phone or address in any scorecard, summary or manifest row.
- [ ] Optional pilot reply channels (OVQ-02) stored only with the raw transcript.
- [ ] Private price sheets for closed workflows deleted and logged.
- [ ] Withdrawal requests actioned within 24 hours and confirmed to the person.
- [ ] Weekly: the other founder verifies the deletions logged this week actually happened.
- [ ] Nothing from the protected store has been committed, pasted into the repository,
      or shared outside the two founders.

## 6. Incident escalation

- [ ] Any `critical` or `major` incident: both founders review within 24 hours; the row
      records `confirmed` / `not_confirmed` / `disputed`.
- [ ] Any confirmed HS condition: sessions on the affected workflow pause; the memo's
      hard-stop section is started that day; participants affected are told what happened
      and what was deleted.
- [ ] Any marketplace warning or restriction on a participant's account: the seller is
      told immediately, decides whether to continue, and the channel row is updated the
      same day.
- [ ] Any request for a credential, payment detail or identity document, by anyone:
      refused, logged, reviewed.
