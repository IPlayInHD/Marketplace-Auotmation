# Public Access Security Model

**Status:** Canonical for the public buyer surface and the access-code mechanism.

---

## 1. The central finding

**The 6-digit access code is public by design.**

In the primary flow the seller publishes the code inside a marketplace advertisement
that anyone can read. It is printed next to the URL, in public, on purpose. Any security
model that treats the code as a shared secret is wrong from the first line.

This reframes everything. The code is not authentication. It is:

- a **routing key** that resolves which listing a buyer is talking about,
- an **intent confirmation** that the buyer came from a real listing,
- an **abuse-control handle** that can be rate-limited, rotated and revoked,
- a **friction gate** that makes bulk automated access expensive.

`SEC-001` **Design rule.** Assume the code is known to an adversary. Nothing reachable
behind a code may be sensitive. The security of the buyer surface must come from what is
*on* the surface, not from who can reach it.

That is a stronger and simpler posture than trying to keep a six-digit number secret,
and it is achievable, because everything a legitimate buyer needs is information the
seller has already chosen to publish.

## 2. Entropy, honestly

A 6-digit code has 10^6 = 1,000,000 values, about 20 bits. That is not authentication
under any threshold. Two consequences:

`SEC-002` The code must never be the only thing standing between an attacker and
anything of value.
`SEC-003` The URL's opaque public id, not the code, is the unguessable component. It
must carry at least 64 bits of entropy from a CSPRNG. With both required, blind guessing
is not a viable attack; the realistic attacks are the ones below.

## 3. Threats and controls

| ID | Threat | Impact | Preventive control | Detective control | Residual |
|---|---|---|---|---|---|
| T-01 | Brute-force code against a known listing id | Reach one listing's public conversation | 5 attempts then 60-minute lock per client; per-IP and per-listing token buckets; identical error body and timing | Alert on failed-attempt spikes per listing and per IP | Low — the prize is a public conversation surface |
| T-02 | Enumerate public listing ids | Harvest a catalogue of listings, sellers, prices | ≥64-bit opaque ids; no listing search on the public surface; `noindex` + `robots.txt` disallow; no sequential ids anywhere | Alert on 404 rate per client | Low |
| T-03 | Automated scraping of our own buyer surface | Competitive harvesting; cost | Edge bot filtering; per-client rate limits; progressive challenge; cheap static preview separated from expensive chat | Traffic anomaly detection | Medium |
| T-04 | Conversation-cost abuse (adversary burns model spend) | Direct financial loss | Per-session, per-listing and per-seller token budgets; turn caps; cost circuit breaker degrading to holding mode | Cost-per-listing alerting | Medium |
| T-05 | Cross-listing access | Read a listing the code was not for | Session is bound to one listing at creation; every read re-checks scope server-side | Audit on scope violations | Low |
| T-06 | Cross-buyer access | Read another buyer's conversation | Conversation is keyed by session; no client-supplied conversation id is trusted | Authorization-failure alerting | Low |
| T-07 | Session token theft | Impersonate a buyer session | httpOnly, Secure, SameSite cookies; rotation on privilege change; short inactivity expiry; no token in URL or logs | Concurrent-use anomaly | Medium |
| T-08 | Protected data leakage through the agent | Minimum price, address, other offers exposed | Minimum price never in context; buyer-safe projection computed server-side; egress redaction; guardrail check G-14 | Automated scanning of outbound text for protected patterns | Low |
| T-09 | Prompt injection to change agent behaviour | Unauthorized concession or disclosure | Guardrails validate the structured action regardless of drafted text; see `AI_THREAT_MODEL.md` | Guardrail denial logging | Medium |
| T-10 | Code leakage beyond intent (screenshot, repost) | Strangers reach the conversation | Accepted by design; rotation available; nothing sensitive behind the code | Volume anomaly per listing | Accepted |
| T-11 | Denial of service on the public surface | Buyers cannot reach the agent | Edge rate limiting and caching; static preview served independently of the chat backend | Availability monitoring | Medium |
| T-12 | Malicious content in buyer messages (XSS) | Seller dashboard compromise | Treat all buyer text as data; escape on render; strict CSP; never render buyer HTML | CSP violation reports | Low |
| T-13 | Seller misconfiguration exposes protected data | Minimum price pasted into the description | Validation warning when a listing field contains a value matching the minimum price; seller education copy | Content scanning at approval time | Medium |
| T-14 | Phishing impersonation of our buyer surface | Buyer harmed, brand damaged | Single stable domain; consistent visual identity; never ask a buyer for payment details or credentials, so a copy has nothing to steal that we ever ask for | External domain monitoring (future) | Medium |

## 4. Rate limiting

`SEC-010` Layered buckets, all of them:

| Scope | Limit intent |
|---|---|
| Per IP, code attempts | Blunt automated guessing |
| Per listing, code attempts | Contain an attack on one listing |
| Per session, messages | Contain cost and spam |
| Per listing, new sessions | Contain mass session creation |
| Per seller, total model spend | Contain financial blast radius |
| Global | Backstop |

`SEC-011` Limits return a neutral response. Never reveal remaining attempts, whether a
code exists, or whether a listing exists.

`SEC-012` The static listing preview and the conversation endpoint have different limits.
The preview is cheap and should stay generous; the conversation is expensive and should
be tighter.

## 5. Buyer-safe projection

`SEC-020` The public surface serves a **computed projection**, never a filtered view of
the listing record. Building the projection by removing fields from an internal object
is forbidden, because the failure mode of forgetting to remove one is a leak.

Projection contains: approved title, approved summary, approved description, approved
structured details, asking price, currency, images, seller display name, pickup/delivery
booleans as buyer-relevant statements, and general seller instructions.

Projection never contains: minimum price, target price, concession limits, auto-decline
threshold, internal notes, cost basis, analytics, other offers, other conversations,
exact location, seller contact details, or any account data.

`SEC-021` A contract test asserts that the projection type cannot structurally hold a
protected field. This is a type-level guarantee, not a runtime filter.

## 6. Isolation requirements

`SEC-030` Tenant isolation is enforced at the data layer in addition to application
filtering. A query that forgets its tenant predicate must fail, not return another
seller's rows.
`SEC-031` Buyer session scope is re-derived server-side on every request from the session
token. No client-supplied listing id, conversation id or offer id is ever trusted.
`SEC-032` The public buyer application and the authenticated seller application are
separate route trees with separate middleware. No seller endpoint is reachable with a
buyer session, by construction rather than by check.

## 7. Logging and privacy

`SEC-040` Access codes never appear in logs, error messages, analytics or audit payloads.
`SEC-041` Session tokens never appear in URLs or logs.
`SEC-042` Buyer message content is not written to application logs. Transcripts live in
their own store with their own retention.
`SEC-043` Failed-attempt records store a hashed client identifier, not raw IP, beyond the
short window needed for rate limiting.

## 8. Required tests

Every item is a blocking test in CI.

| Test | Assertion |
|---|---|
| Correct code | Session created, scoped to the right listing |
| Incorrect code | Generic error, no session, attempt counted |
| Repeated failures | Lock applied at threshold, neutral response |
| Timing | Response time for wrong code and unknown listing are statistically indistinguishable |
| Revoked code | Generic error |
| Expired code | Generic error |
| Code of another listing | Generic error, no cross-resolution |
| Session isolation | Buyer A cannot read Buyer B's conversation, offers or summary |
| Scope | A buyer session cannot reach any other listing |
| Dashboard | A buyer session receives 404 on every seller route |
| Minimum price | Not present in any buyer-facing response payload, ever |
| Projection | Protected fields structurally absent |
| Enumeration | Sequential or incremental ids are not accepted anywhere |
| XSS | Buyer-supplied markup is inert in the seller dashboard |
| Cost breaker | Budget breach degrades to holding mode rather than unbounded spend |
