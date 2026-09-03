# Evidence manifest — TEMPLATE

One row per evidence item. The manifest is the index that lets a decision memo point at
evidence without exposing it. The raw item stays in the protected store; the manifest
holds its identifier, its hash and its redaction status. A manifest row is not itself
evidence of a result; it is evidence that an artefact exists and has not changed.

Rules:

- Every artefact that any scorecard, incident row or memo refers to has a row here.
- `sha256` is computed on the file as stored in the protected store, at the time of
  registration, with the platform's standard tool (for example `sha256sum` or
  `shasum -a 256`). Recompute and compare at the decision meeting; a mismatch is
  recorded, never silently re-hashed.
- `storage_location` is a protected-store reference (folder and file name inside the
  store), never a public link and never a path that reveals a person.
- `redaction_status`: `raw` (protected store only), `redacted` (identities masked; may
  be attached to the memo), `aggregated` (counts only).
- A row is never deleted. A deleted artefact keeps its row with `notes` recording the
  deletion date and reason (withdrawal, retention expiry).
- `reviewer` initials mean the second founder opened the item and checked the redaction
  status.
- `participant_id` is one of `SI-###`, `SW-###`, `BM-###`, `RC-####` or empty;
  `workflow_id` is `WF-###`, `FI-###` or empty (`DATA_DICTIONARY.md` §7). No other
  identifier form appears.

| evidence_id | participant_id | workflow_id | evidence_type | date | storage_location | sha256 | redaction_status | reviewer | notes |
|---|---|---|---|---|---|---|---|---|---|
| EV-0001 | | | | | | | | | |
| EV-0002 | | | | | | | | | |
| EV-0003 | | | | | | | | | |

**Evidence types:** `policy_capture` · `listing_screenshot` · `page_screenshot` ·
`draft_original` · `draft_tidied` · `approved_copy` · `transcript_summary` ·
`stopwatch_log` · `interview_notes` · `audio` · `commitment_note` ·
`incident_attachment` · `other` (describe in notes).

**Fictional illustration of a completed row (not evidence; delete before use):**

| evidence_id | participant_id | workflow_id | evidence_type | date | storage_location | sha256 | redaction_status | reviewer | notes |
|---|---|---|---|---|---|---|---|---|---|
| EV-EXAMPLE | SW-EXAMPLE | WF-EXAMPLE | listing_screenshot | 2000-01-01 | PROTECTED-STORE:FICTIONAL/example.png | FICTIONAL-HASH-NOT-A-REAL-DIGEST | redacted | XX | FICTIONAL EXAMPLE ROW, NOT EVIDENCE |

## Integrity check record

Completed at the decision meeting, before any result is discussed.

| Check | Result | Date | Initials |
|---|---|---|---|
| Every artefact referenced by a scorecard, incident or memo has a manifest row | | | |
| Every `sha256` recomputed and matching | | | |
| Every `raw` item confirmed present in the protected store | | | |
| Every `redacted` item opened and confirmed masked | | | |
| Every deletion recorded in `notes` confirmed executed | | | |
