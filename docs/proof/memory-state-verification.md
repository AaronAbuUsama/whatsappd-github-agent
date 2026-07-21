# Verification dossier — Memory & state arm (milestone 7)

**Status as of 2026-07-18 ~07:45.** PR #163 merged to main (v0.4.0 in-repo; npm publish blocked on a dead `NPM_TOKEN`, pre-existing since the 0.3.0 attempt). Rig: code-factory, tmux `ambient`, data-dir `~/validate-88/issue126-data`, build `integration-321241a` (= main tip).

This file is the honest ledger: what was built, how each piece was verified, what was **not** verified, and how to review the arm. Written by the build orchestrator; treat the "verified" column as claims *with evidence pointers*, not as review.

---

## 1. How verification was layered

1. **Deterministic gate** — `pnpm typecheck` + `pnpm test` at every commit; 377 tests on main → **452** at tip. Caveat: most new tests were written by the same builder agents (self-verification bias); reviewers audited DoD coverage and did catch tests enshrining bugs (e.g. red-run-labeled-`no-op`).
2. **Adversarial review (in-session, NOT on GitHub)** — one Fable review per issue against issue body + spec section, then a final 3-lens whole-arm pass (cross-issue seams / silent failures / standards). **13 must-fix findings, all fixed in-branch.** The review record exists only in the build session and in PR #163's body — no GitHub review comments were posted. That is a gap in reviewability, which this dossier partially repairs.
3. **Live proof on the rig** — deploy, smoke, and three end-to-end drives (below).

## 2. Live-verified, with evidence

| Claim | Evidence |
|---|---|
| PAT→App cutover works; runtime + smoke green under App identities | smoke 6/6 at 07:06 and again on the fixed build 07:31 (`github: access` = Planner App); `~/validate-88/integration-*-start.log` |
| Scribe extracts real conversation → graph | From one TST message: `commitment` ("release notes by Monday", due normalized 2026-07-20, 0.98) + `made_by` (exactly-one) + `person` keyed by WhatsApp lid + `participates_in` + conservative `discusses` (0.8). Query: `sqlite3 application.sqlite "select * from graph_entities"` |
| Keyless duplication policy behaves as ratified | The restart replay produced a second low-confidence commitment row — honest-recording by design, converges via `merge_entities` |
| Delegation launch → ledger → non-blocking Speaker | Speaker replied "Kicked off the coder job for issue #161" in-thread; `delegation_launches` row `run_01KXT0GSQP…` launched 07:02:15, settled 07:05:59 |
| Coder does real work under its own identity | PR #162 authored by `app/ambient-coder`, commit by `ambient-coder[bot]`, diff exactly `* @AaronAbuUsama` in `.github/CODEOWNERS`, branch `agent/coder/issue-161` (check-then-act 404→create observed in logs) |
| Green-gate refuses red work | Suite red on the rig (env EACCES, see §4) → **draft** PR + blocked summary + Speaker reported honestly with the PR link |
| Durable result bridge (ADR 0001) | `specialist.result` delivered to the thread after the run settled; Speaker's completion message in the log at 07:06 |
| **Seam #1** (finished job → graph facts) | Post-run graph: `works_on(agent→issue_161)`, `works_on(agent→pr_162)`, `resolves(pr_162→issue_161, 0.8)`, `mentions`, `part_of` — written by the Scribe from the `specialist.result` window |
| npm artifact boots | Standards reviewer unpacked the packed tarball and ran the CLI (`--help`) in a temp dir |
| App triples authenticate (all three) | Provisioning session's Octokit probe: each lists exactly `AaronAbuUsama/ambient-agent` |

## 3. NOT verified — the honest gap list

| Gap | Severity | What would verify it |
|---|---|---|
| **Behavioral eval batteries are authored but skipped** — Scribe extraction (`SCRIBE_FIXTURE_READY`) and Coder SKILL (`CODER_FIXTURE_READY`) gates never ran; per the #137 bar, that behavioral prose ships un-asserted. New Speaker instruction lines (digest use, confirm loop, relaunch-asks) also un-evaled. `check_jobs` prose ungated. | High (it's the house standard) | Build the two fixtures; run the batteries red-then-green |
| **Live judged (Braintrust) eval family not run at all** | High | `pnpm evals:live` against the shipped prose |
| **Digest injection never directly observed** — unit-tested, but no transcript inspected to confirm a live Speaker turn carried `graphContext`, nor that it changed a reply | Medium | Ask the Speaker something the graph knows ("what did I promise?") and/or dump the Flue transcript for a turn |
| **Speaker confirm/resolution surface untested live** (record_entity confidence bump, merge_entities on user confirmation) | Medium | Drive the "is X the same as Y?" loop in the TST chat |
| **Broadcast fan-out live-tested with only ONE managed chat** — N-chat broadcast, and the confidence-inflation advisory, never observed | Medium | Add a second managed chat; fire a webhook |
| **Boot sweep / interrupted path never live-fired** — unit-tested only; the deployed pre-fix build had the port-ordering bug, and the fixed sweep hasn't seen a real crash | Medium | Kill the runtime mid-Coder-run; reboot; expect the interrupted message in-thread |
| **Coder green path never seen live** — the only run was env-red; "non-draft PR when suite green" is unit-tested only. Also relaunch/idempotency (branch reuse, PR update) live-untested | Medium | Fix the rig EACCES (§4), relaunch #161 → expect the draft to flip/update |
| **`specialist.milestone` and `check_jobs` never exercised live** | Low | Ask the Speaker "what jobs are running?" during a run |
| **PAT→App *migration walk* skipped live** — I hand-provisioned the credential files; the interactive guided-paste/migration path is unit-tested only (and its PEM paste is single-line — needs `--github-apps-file` parity on `config`) | Medium | Run `ambient-agent config` against a copy of a PAT-era data dir |
| **Reviewer App verified for auth only** — no consumer exists until #147 | Known/by design | #147 |
| **Coder PR body quality** — raw ANSI escapes + truncated failure line in #162's body; env-failure indistinguishable from code-failure burned 3 model attempts | Real bugs, unfiled | File issues; strip ANSI; consider an env-failure short-circuit before attempt 2 |
| **Rig env bug: EACCES** spawning the packed CLI inside the Coder workspace (`tests/packaging/packed-cli.test.ts`) — the cause of the draft | Real, unfiled | Diagnose exec perms on `~/.ambient-agent/workspaces` / tmp on the VPS |

Advisory backlog from the reviews (constraint bypass in `mergeEntities`, boot-sweep-consult-`getRun`, silent Scribe catches, snapshot failure signal, dead `resolveSpecialistReturnChat`, `skill-authoring.md` doc never landed, `ambience-recovery.md` name, exec-bit drop, …) — full list in **PR #163's body**.

## 4. How to review this arm

The merged diff is ~32 commits / 8 issues — don't read it linearly.

1. **`/code-review ultra 163`** in a fresh session — the multi-agent cloud review over the whole PR. This is the missing independent review; everything so far was in-session.
2. **By issue slice**, against contract: for each issue N, `git log --oneline --grep "#N" main` + its issue body + the spec section it cites. The capability dirs map 1:1: `graph/`, `graph-extraction/`, `scribe/`, `delegation/`, `coder/` under `packages/agents/src/`, `graph/` under `packages/engine/src/`, App auth in `packages/installation/`.
3. **Live, from your phone** — the most honest review layer: talk to the TST group. Ask what you promised (digest), confirm a low-confidence fact (resolution surface), launch a job (delegation), ask `check_jobs`. §3 doubles as the punchlist.
4. **The review record** — per-issue findings + fixes are summarized in PR #163's body; this dossier is the verification side.
