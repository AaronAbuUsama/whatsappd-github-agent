# Codebase Reset — Handoff (2026-07-21)

> **Frozen checkpoint.** A long session did the destructive half of the "strip the dead pivots,
> rebuild from the coworker architecture" reset and is handing off. **Continue in the primary repo**
> (`/Users/abuusama/projects/ambient-agent`), not a worktree. Read this whole file first, then resume
> at **Order step 2**. Do **not** re-litigate the decisions below — they're settled.

## TL;DR — where we are

- **The line:** `claude/single-box-working` (this PR's head) = the coworker rebuild (#273–#276) + the
  first doc-cleanup commit `3de59d4` (retired 42 dead-pivot planning files). This is canon going forward.
- **`main` is not canon** — it's 78 commits behind and clobberable. This handoff ships as a **clean
  fast-forward PR into `main`**. Merge it (or just keep working on the line); either way `main` becomes
  the reset going forward.
- **Target architecture:** [`docs/SYSTEM-ARCHITECTURE.md`](SYSTEM-ARCHITECTURE.md) (the Brain / dumb
  reactive Speakers / global Scribe / owned Graph / Digest). Everything we build points at this.
- **Branding:** `coworker` (surface only). Repo/package/login names unchanged for now.

## The mission

Strip three dead pivots — **Eve-era**, **Ambience**, and the **SaaS / multi-tenant** cutover — down to
one stable line, and rebuild forward from `SYSTEM-ARCHITECTURE.md`. One instance, one operator, not
multi-tenant (tenancy was killed 2026-07-19).

## What this session already did (don't redo)

- **Adopted** `single-box-working @ 3de59d4` as the surviving base.
- **Swept:** removed 13 stale worktrees; deleted 55 local + 80 remote dead branches. **Remaining
  branches:** `main`, `claude/single-box-working`, `agent/coder/issue-161` (CODEOWNERS). Everything
  else is gone (all git-recoverable via reflog for ~30–90d).
- **Closed** dead PRs #239 (SaaS-unify), #229 (release bot), #185 (editorconfig); **kept** #162
  (CODEOWNERS).
- **Indexed** the tree with codebase-memory — but that index is keyed to the now-removed worktree
  path. **Re-index the primary repo** in the fresh session (it's Order step 1 anyway).

## The order (settled — this is the spine)

1. **Re-index** the primary repo (codebase-memory) — factual "where we are."
2. **Doc reset** — delete the dead docs, rewrite the top-level context docs. (details below)
3. **New concepts** — `domain-modeling` skill → the new ubiquitous language, grounded in
   `SYSTEM-ARCHITECTURE.md` + the index. Replaces the old Ambience language in `CONTEXT.md`.
4. **GRILL with docs** — the **validation gate**, not just a stress test. Re-litigate the architecture,
   the concepts, and the carried-forward DAG items (M/T5a/T5b/T6). Nothing past here runs until it passes.
5. **To-spec** — turn the validated foundation into the **new DAG / specs**. The DAG is an *output* of
   this step, never drafted before the grill. (This is its own tracked ticket.)
6. **Clear + recreate the board** — close all open issues + milestones, then recreate fresh from the
   validated spec.
7. **Build out** — `codebase-design` + `tdd` per the validated spec.

## Decisions locked

**Docs to DELETE in step 2:**
- Dead ADRs: **0024** (operator web app), **0021** (E2B — fold into the new plan instead), and the
  multi-tenant SaaS set **0017–0020, 0022, 0023**.
- Old Ambience/naming docs: `docs/architecture/ambient-agent.md`, `docs/architecture/ambience-recovery.md`,
  `docs/agents/*`.
- **Nuke `docs/proof/`** entirely (backward-looking receipts for already-built, old-named work).
- Rewrite fresh: `CONTEXT.md`, `STATUS.md`, `README.md`, `AGENTS.md` (all still carry old Ambience language).

**Docs to KEEP:**
- `docs/SYSTEM-ARCHITECTURE.md` (the target).
- `docs/planning/ONE-BOX-PLAN-2026-07-20.md` + `ONE-BOX-EXECUTION-STATE.md` — **DAG source**; mine
  M/T5a/T5b/T6 from them, then they can go once the new DAG exists.
- `docs/reference/flue/*` (external Flue framework reference, not our cruft).
- **This file**, until the reset completes.

**Web app (`apps/web` = `@ambient-agent/web`):** Next.js 16 + oRPC, **19 source files**, **loosely
coupled** to the backend via an oRPC typed contract (not code entanglement; deleting it doesn't ripple).
→ **Rebuild from scratch at the spec step** (step 5). Leave the code in place as reference until then;
delete only ADR 0024 now. (Note: this reverses an earlier "the web app stays" position — Aaron
re-decided 2026-07-21.)

**The carried-forward DAG items (undone from the in-flight plan — re-litigate in the grill, don't trust blind):**
- **M** — relocate + stand up the branded instance on *code-factory* (new number), re-run T2 gates,
  kill the `co-worker.tech` container (keep the DNS zone).
- **T5a** — inbound GitHub webhook via **Cloudflare Tunnel** → `agent.coworker.tech/channels/github/webhook`.
- **T5b** — the Reviewer's first real review (+ the #245 discriminator).
- **T6** — observability; lights the read-only SSE routes a future dashboard consumes.
- (Done already: T1, T2 incl. kill-9, T3, C1 #273, C2 #274, T4 #275.)

**The board (clear in step 6, after the grill):** 36 open issues + 9 milestones. Almost all are
old-pivot (`Eve migration`, `Ambience`, `SaaS MVP`, `Tightening pass`, `Memory & state`, …). Only #9
"Coding workflow & the closed loop" and #10 "One box working end to end" are current. Clear **all**,
recreate from the validated spec.

## Loose ends

- **Primary repo** was checked out on `codex/issue-175-scribe-backfill-spec` with 5 stray modified
  PNGs (`assets/agents/0*.png`) from a killed session — **discard them** and switch to `main` /
  `single-box-working` on relaunch.
- **codebase-memory** has ~150 stale project indexes (removed worktrees). Cosmetic; ignore or prune.

## Gotchas (cost real time this session)

- **This shell is `zsh`.** `for x in $VAR` does **not** word-split — it broke a keep-guard and deleted
  keeper branches (restored, no loss). Use `comm`, `while IFS= read -r`, or arrays; **dry-run every
  destructive list** before executing.
- Everything deleted is git-recoverable (reflog ~30–90d); `origin/main` @ `5eecb2b` is the pre-reset baseline.
- **Branch flow:** work on `single-box-working` (or a fresh side-branch off it) and PR into `main`.

## NEXT ACTION

Merge this PR (clean ff) or just keep working on `single-box-working`; then **re-index the primary
repo** and resume at **Order step 2 (doc reset)**.
