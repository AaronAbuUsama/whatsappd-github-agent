# Behavior battery — Memory & state arm

**What this is.** The formal, repeatable behavioral verification of milestone 7 — the battery we should have defined before building. Each scenario names: the ratified behavior (spec §), the surface we drive, the exact drive, the observable pass criteria, and the evidence captured. Verdict column filled in per run, smoke-battery style. Code review is a separate lane (`/code-review ultra 163`); this file is behavior only.

**Surfaces.** (1) The TST WhatsApp group — driven from Aaron's WhatsApp desktop via scripted keystrokes, screen-recorded. (2) The GitHub webhook socket on the rig — driven by signed POSTs (no repo webhook exists today; see BAT-0). (3) GitHub itself — PRs/issues/authors via `gh` JSON dumps. (4) The state stores — `application.sqlite` before/after snapshots per scenario.

**Evidence protocol.** Per scenario `BAT-<id>`: `evidence/BAT-<id>/` containing ① screen recording (`screencapture -V`, mp4) or terminal capture, ② rig log slice (timestamped from `~/validate-88/integration-*-start.log`), ③ DB delta (scripted SELECT dump before/after), ④ GitHub JSON where relevant. The WhatsApp thread itself is a durable transcript. Verdicts + evidence paths recorded here.

**What is NOT testable, and why — read this first.**
| Expectation | Reality |
|---|---|
| "The Reviewer actually reviews PRs" | **The Reviewer does not exist.** #147 ratified its shape; its implementation issue (sibling of #158) was never filed — explicitly out of milestone 7. Nothing to test. Its App identity authenticates (verified), nothing uses it. |
| "The Planner plans" | **The Planner Specialist does not exist** — milestone 7 built only the Coder ("first Specialist, sets the template"). What exists: the Planner *App identity*, used by the Speaker for inline issue-filing — that IS testable (BAT-E2). |
| `specialist.milestone` interrupts the thread | **No producer.** The transport member exists; the Coder emits only `ctx.log` waypoints. Dormant until a Specialist emits one. |
| Webhook-launched Specialist return | `resolveSpecialistReturnChat` has no production caller (deferred to the Reviewer/broadcast consumer). Dead until then. |
| N-thread broadcast | Only one managed chat is configured. Single-thread broadcast is testable; true fan-out needs a second managed group (optional extension BAT-D3). |

---

## BAT-0 · Preconditions (fix the bench before testing on it)

| id | Task | Why |
|---|---|---|
| 0a | Diagnose + fix the rig EACCES (`spawn …/.bin/ambient-agent EACCES` inside the Coder workspace — suspect `noexec` mount or npm-cache perms) | Blocks the Coder **green path** (A2/A3); today every run is env-red |
| 0b | Decide webhook transport: configure a real repo webhook to the rig (Tailscale funnel) **or** ratify synthetic signed POSTs to `:42069` as the drive | Broadcast (D) has never seen a live event |
| 0c | Evidence rig: recording script (per-scenario `screencapture -V`), DB-snapshot script, log-slicer | Everything below captures evidence uniformly |
| 0d | (Optional, for D3) Second managed WhatsApp group added to config | True fan-out |

## BAT-A · The main thing: the delegation loop (P0)

| id | Behavior (spec) | Drive | Pass when | Status |
|---|---|---|---|---|
| A1 | Launch is typed, non-blocking, ledgered (§8) | Ask in TST: "kick off a coder job for issue #X" | Ack reply < ~30s; ledger row with runId; Speaker turn ended before run finished | ✅ proven 07:02 (re-run under recording) |
| A2 | **Green path**: green suite → non-draft PR, `Closes #N` | After 0a: Speaker files fresh trivial issue (via E2), launch Coder on it | Non-draft PR by `ambient-coder[bot]`, body `Closes #N`, CI green on it | ❌ never seen live |
| A3 | Idempotent relaunch (§8, natural keys) | Relaunch same issue | Same `agent/coder/issue-N` branch reused; existing PR updated, no duplicate | ❌ unit-only |
| A4 | Green-gate refuses red work | (Already proven by #162: env-red → draft + `blocked` + honest summary) | draft PR + blocked summary + honest Speaker report | ✅ proven (evidence: PR #162, log 07:06) |
| A5 | `check_jobs` = launch memory across restarts (§8) | Mid-run and post-restart: "what jobs have you run?" | Reply lists the run(s) + live status from the ledger | ❌ never exercised |
| A6 | Durable result bridge (ADR 0001) | (rides A2) | `specialist.result` delivered exactly once, after durably-terminal; Speaker announces with PR link | ✅ proven once; re-verify on green path |
| A7 | Seam #1: finished job → graph facts (§4) | (rides A2) DB snapshot after result | `works_on` + `resolves` edges present, idempotent on re-delivery | ✅ proven (edges captured 07:44) |
| A8 | **Crash recovery**: boot sweep → `interrupted` in-thread, Speaker asks before relaunch (§8 Failure; the port-ordering fix) | Launch a job, `kill` the runtime mid-run, restart | On boot: interrupted message arrives in TST (proving sweep runs *after* port wiring); Speaker offers relaunch, does NOT auto-relaunch | ❌ never live-fired — the highest-value untested scenario |

## BAT-B · The Scribe is actually scribing (P1)

| id | Behavior | Drive | Pass when | Status |
|---|---|---|---|---|
| B1 | Owned commitment extracted, due normalized, `made_by` exactly-one (§4/§9) | "I'll do X by Friday" | Commitment row, made_by → sender, due ISO | ✅ proven 06:58 (re-record) |
| B2 | Ownerless promise never written (§9 gate 1) | "Someone should really fix the flaky smoke test" | **No** new commitment row | ❌ |
| B3 | Hedged promise written low, not surfaced (θ≈0.5) | "I might get to the docs cleanup at some point" | Commitment row with confidence < 0.5; Speaker does not raise it | ❌ |
| B4 | Restating converges + bumps confidence (keyless policy) | Repeat B1's promise verbatim later | Same node updated (no third row), confidence ↑ | ❌ |
| B5 | Debounced cadence: burst → ONE extraction turn (#149) | 4 rapid messages, then quiet | Log shows one Scribe dispatch for the burst | ❌ (observable in log) |
| B6 | Scribe failure never touches Speaker | — | Accepted by construction + unit tests; no live forcing | SKIP (by design) |
| B7 | Anchored auto-close: commitment `about` → Issue closes when the issue does (§9) | "I'll handle #X" in chat; then close #X (rides A2 merge) | Commitment status flips open→done after the close event reaches the Scribe | ❌ (needs D working) |

## BAT-C · The Speaker's memory is real (P1)

| id | Behavior | Drive | Pass when | Status |
|---|---|---|---|---|
| C1 | Digest recall: single-turn answer from pushed context (§5) | "Remind me — what did I say I'd do, and by when?" | Correct answer (release-notes commitment, Monday) in one turn | ❌ (probe was interrupted mid-battery-design) |
| C2 | Resolution surface: user confirms → merge/bump, `record_relation` still Scribe-only (§5 D5) | "Those two duplicate release-notes promises are the same thing" | `merge_entities` fired: one commitment row remains, confidence bumped | ❌ |
| C3 | GitHub work-in-view from the advisory cache (Q3) | "What's the state of issue #161?" | Answer names title/state (cache or live tool — either is ratified) | ❌ |

## BAT-D · Broadcast ingress (P1, precondition 0b)

| id | Behavior | Drive | Pass when | Status |
|---|---|---|---|---|
| D1 | Supported event → managed thread's Speaker, silence valid (§6) | Signed `issues.opened` POST (or real webhook) | Delivery row `done`; Speaker dispatch observed; reply optional | ❌ never live (no webhook exists) |
| D2 | Unsupported/uncorrelated settle honestly | Signed unsupported event | Delivery row `unsupported`, no dispatch | ❌ |
| D3 | (Optional) True N-thread fan-out | Precondition 0d, then D1 | Both threads' Speakers each dispatched once | deferred |

## BAT-E · Identities (P2)

| id | Behavior | Drive | Pass when | Status |
|---|---|---|---|---|
| E1 | Coder acts as `ambient-coder[bot]` | (proven: PR #162 author) | — | ✅ |
| E2 | Speaker's inline filing acts as `ambient-planner[bot]` (§2/§7) | "File an issue for X" in TST | Issue author = `ambient-planner[bot]` | ❌ — also produces A2's target issue |
| E3 | PAT→App migration walk | Copy of a PAT-era data dir + `config` | Walk completes; PAT file retired; components green | ❌ partial (hand-provisioned; interactive PEM paste is a known gap — advisory) |
| E4 | Reviewer App auth | (verified by probe at provisioning) | — | ✅ auth only; no behavior exists |

## Run order (one recorded narrative, ~90 min)

0. BAT-0a/0b/0c → 1. **E2** (Speaker files issue as planner[bot]) → 2. **A2** green Coder run on it (+A6, A7 rechecks) → 3. **A5** check_jobs → 4. **B7 prep**: commitment about the new issue → 5. merge the PR (closes issue) → **B7** auto-close via D1 event → 6. **A3** relaunch idempotency → 7. **A8** crash recovery (fresh launch, kill, reboot) → 8. **C1, C2, C3** memory drives → 9. **B2–B5** Scribe specials → 10. **D2** unsupported event. Verdicts + evidence recorded here per scenario.

## From battery → standing verification environment

1. **This file** is the spec; each run appends a dated verdict table (smoke-battery idiom).
2. **`.claude/skills/verify/SKILL.md`** captures the drive mechanics (WhatsApp scripting, DB snapshot, log slicing, recording commands) so any session can rerun it.
3. **The recorded transcripts become the eval fixtures**: freeze BAT-B/C scenario transcripts into the `SCRIBE_FIXTURE_READY` fixture and A2/A4 into `CODER_FIXTURE_READY` — that un-skips the authored eval batteries, and from then on CI guards the behavioral prose offline while this live battery stays the periodic ground truth. That is the missing "verification environment," built from evidence instead of invented.
