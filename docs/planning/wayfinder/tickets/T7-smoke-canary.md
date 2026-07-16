# T7 — Live smoke battery: canary message decision (B5)

Type: `wayfinder:grilling` (HITL — needs Aaron's pick of chat + text)
Blocked-by: — (frontier for the *decision*; the `smoke` command itself lands after C3 splits program.ts)
Blocks: B5 spec (smoke command)

## Question

For the one-command live smoke battery (`ambient-agent smoke` — per-station pass/fail
across all promised paths): does it send a live canary message, and if so into which
chat, with what text, asserting what?

## Problem in code

Every probe already exists, scattered: `doctor --live` (ChatGPT readiness), `status`
(installation + runtime + backlog via `reportInspection`, `src/cli/program.ts:491-500`),
repair preflight (store validation), `/health` (`src/app.ts:36-43`). What no command
proves is the last mile: a real message in → window fires → agent deliberates → outcome
observed. That needs a canary — a real send into a real chat on the paired account, so
it's a *policy* decision, not a code one.

## Options

**O1 — self-chat canary:** send `SMOKE <nonce>` to the account's own JID (message to
self), assert the window admits and settles (via T3's observer) within a timeout.
No third parties see anything. Caveat: self-messages are `fromMe` and the coalescer
filters them (`src/coalescer/coalescer.ts:190-194`, `Stream.filter((m) => m.live && !m.fromMe)`)
— the smoke path would need a test-only ingress (like the fixture's `/test/coalescer`)
or the canary asserts only delivery, not deliberation.

**O2 — dedicated canary group:** a tiny WhatsApp group containing only the paired
account (+ optionally Aaron), listed in `managedChats`; canary text
`SMOKE <nonce> — ignore`, assert full pipeline: admission, dispatch, settled (silent
expected under the T1 rubric). Exercises the true path end to end; costs one standing
group + rubric carve-out ("SMOKE-prefixed → always silent").

**O3 — no live canary:** smoke = compose existing probes only (health, doctor --live,
backlog, store checks). Zero risk, but the top-value assertion — "a message actually
flows" — stays unproven; that gap is what B5 exists to close.

## Grading

| | O1 self-chat | O2 canary group | O3 probes only |
|---|---|---|---|
| Floor-first | partial (fromMe filter blocks the real path) | full pipeline proven | misses the point |
| Reversibility | high | high (delete group) | high |
| Blast radius | needs test ingress in prod build | rubric carve-out + config | none |
| Correctness | asserts delivery only | asserts deliberation + silence | weakest |
| Parallelizable | after C3 | after C3 + T1 (carve-out) + T3 (observe settle) | after C3 |
| Fit | fights the fromMe filter | uses the system as designed | incomplete |

**Recommendation: O2.** Decisions for Aaron: (a) confirm the canary group approach and
who's in it; (b) exact text (`SMOKE <nonce> — ignore` proposed); (c) does the rubric get
an explicit SMOKE carve-out (feeds T1)?
