# Session handoff — 2026-07-23

Durable checkpoint for a long session that stabilized 3 of #299's remaining rungs, deployed and
proved the fix against real production data, ran a Phase 1 debt/hygiene audit, and agreed a plan
for Phase 2 before handing off to a fresh context. This file is the source of truth for that
handoff — read it before doing anything else.

## Goal / mission

Complete issue **#299** — "Build the definitive coworker replacement runtime" — the single
execution authority for finishing the coworker on `integration/coworker-replacement`. #299 has its
own "Final definition of done" checklist; that checklist **is** the real end goal, not something to
invent:

```
- [x] Conversation loop proven.
- [ ] Knowledge loop proven live and through historical replay.
- [ ] Work loop proven through real GitHub and WhatsApp.
- [ ] Proactive liveness and one chat routing path proven.
- [ ] Replacement architecture map in docs/ARCHITECTURE.md matches the code that actually exists.
- [ ] Legacy/dead replacement paths deleted.
- [ ] Cumulative scenario suite passes at the final integration commit.
- [ ] One atomic PR cuts integration/coworker-replacement into main.
```

## Decisions made, with rationale

1. **Workflow concurrency: hard 6-agent cap, always, no read-only exception.** A background
   Workflow's Verify phase spawned one agent per debt finding (60 findings → 60+ agents, ~135
   total across the run) — the user was furious, stopped it mid-flight. Root cause: every agent
   call has a fixed ~60,000-token base cost regardless of task size, so one-agent-per-tiny-check is
   a real cost multiplier, not just an optics problem. Fixed by batching (group ~10 items per agent)
   and capping concurrent batches at 6. Saved to memory:
   `workflow-concurrency-and-model-assignment.md`. **Any future workflow script must batch
   data-dependent fan-outs (one-per-finding/issue/row) — never `parallel(items.map(...))` directly
   over an unbounded list.**
2. **Model assignment convention:** `opus` for agents that write/edit code, `fable` for agents that
   review/critique/audit, `haiku` for trivial mechanical steps (CI-check-and-merge, listing issues).
3. **Never deploy a migration without checking it against real production data first.** PR #322's
   `brain_effects` rename-copy-drop migration would have crashed the live service on deploy — SQLite
   auto-repoints a child table's FK clause when its target is renamed, so `surface_deliveries`/
   `directive_outcomes` (which have real rows on the live DB) would have ended up pointing at the
   dropped `_legacy` table. Caught by reading the live DB directly before deploying, not by guessing.
   Fixed in PR #324 (two rounds — the first fix missed an edge case that Codex's own bot review on
   the fix PR itself caught: a child table can be left dangling even when `brain_effects` is already
   widened, if an earlier partial migration succeeded because it had zero referencing rows at the
   time). Both scenarios now have dedicated regression tests
   (`tests/brain/effects-migration.test.ts`).
4. **When a migration is unsafe, deploy the safe subset first rather than wait or ship broken
   code.** Deployed commit `5282da7` (multi-org only, verified to touch zero schema code) while the
   migration fix was still being written.
5. **Self-authored fixes still get an independent check before merging** — even without spinning up
   another subagent for it (the user explicitly doesn't want more in-session subagents right now;
   see decision 8). GitHub's own Codex bot review filled that role for PR #324.
6. **GitHub hygiene (closing stale issues, creating a milestone) is DEFERRED until after the Phase 2
   grill**, so the milestone reflects refined scope from the PRD/spec process, not first-draft
   framing. Nothing has been closed or created yet — see "Held / not yet done" below.
7. **Every future issue/PR needs an agreed-in-advance "proof contract"** — which evidence layers
   apply (WhatsApp receipt, `application.sqlite` rows, GitHub artifacts, Braintrust traces,
   screenshots where DB rows alone can't prove UI/behavior) — decided before work starts, not after.
8. **Foundational readiness check must run before Phase 2 construction resumes**: confirm whichever
   agent(s) do the work can actually (a) drive a WhatsApp test message in the `Tst` group, (b) query
   `application.sqlite` for evidence, (c) query GitHub for evidence, (d) query Braintrust. (d) was a
   real gap mid-session — no Braintrust MCP was connected — but the user has since installed one
   (tools now visible: `mcp__<id>__sql_query`, `list_recent_objects`, `generate_monitor_chart`,
   `summarize_experiment`, `search_docs`, `load_braintrust_skill`, etc. — exact server id varies by
   session, search by keyword `braintrust`). **This MCP was not yet exercised/verified working in
   this session — verifying it is step one of Phase 2.**
9. **Remaining construction (rungs 4-6) should run as an "agent team" — separate dispatched
   agents/Claude Code CLI sessions with a natural pause after every step — not another single long
   unattended background Workflow script.** The user was explicit: not Task-tool subagents forked
   inside one session: actual separate agents. This shapes how the fresh session should organize
   execution once Phase 2 planning is done.
10. **No "Wayfinder" (the old heavy multi-week planning campaign that #299 already
    supersedes), no aggressive/heavy `grilling` skill session.** The user wants a *light* grill only
    — light grill → PRD → spec → issues, not an exhaustive interrogation.

## What's done (commit SHAs)

- **PR #321** (multi-org GitHub App installation resolution) — merged, commit `5282da7`.
- **PR #322** (Brain `file_issue` effect + Speaker issue-shape elicitation + honest closure, #317/#319 partial) — merged (part of the `7b2ec13` history).
- **PR #323** (Brain `start_reviewer_job` on-request launcher, #318) — merged, commit `ab1bef9`.
- **PR #324** (stabilization: fixed the `brain_effects` migration FK bug in two rounds + the `file_issue` surface-provenance guard) — merged, commit **`7b2ec13`** — this is the current tip of `integration/coworker-replacement`.
- **Deployed to capxul-vps at tip `7b2ec13`.** `dist/server.mjs` sha256
  `ebab65755b660a6ff649a80c3f5357a947d82331b4185afac1ece8bba5e3bc83`. The migration ran against
  **real** production data (not a fixture): `surface_deliveries` (3 rows) and `directive_outcomes`
  (4 rows) survived with correct FK linkage to the widened `brain_effects` table; verified
  byte-identical across a forced restart (durability proof). Service healthy, WhatsApp online.
- **Stabilization ledger posted to #299**:
  https://github.com/AaronAbuUsama/ambient-agent/issues/299#issuecomment-5059808352
- **Phase 1 audit completed** — full report copied into this same commit at
  `docs/PHASE1-AUDIT-2026-07-23.md`. Headline: 59 confirmed debt findings (dead code, duplicated
  logic, over-engineering, stale config, doc drift — nothing catastrophic), real drift found in
  `docs/ARCHITECTURE.md` vs. actual code, and **`STATUS.md`'s claim that `TenantRuntime*` was
  removed in "Layer 2 — done" is false** — it's still live-wired, just dead because nothing sets
  the env vars it gates on. Same pattern in `pnpm-workspace.yaml` (still pins the entire deleted
  SaaS/web dependency catalog). This means #299's own checklist box "Legacy/dead replacement paths
  deleted" is **not actually done** despite reading as closed in spirit. 31 open issues were
  triaged (not yet acted on): 15 proposed for closing (7 stale/done, 8 superseded), 8 proposed for
  a new tracking milestone, 8 keep-active as-is.

## Held / not yet done — do these first, in this order

1. **Foundational readiness check** (decision 8 above): verify the Braintrust MCP actually works
   (try `list_recent_objects` or `search_docs` against the connected project), verify driving a
   WhatsApp message in `Tst` still works end-to-end, verify pulling evidence from
   `application.sqlite` on capxul-vps and from GitHub. Don't assume any of these work — check.
2. **Light grill session** (not Wayfinder, not the aggressive `grilling` skill) → PRD → spec →
   issues. Must produce: (a) the formal proof-contract template every issue will use, (b) refined
   framing of the three new-scope topics below, (c) the final milestone/issue list.
3. **Three new-scope topics — surfaced this session, not yet filed as issues, intentionally held
   for the grill to shape:**
   - **Ambient presence/UX** — typing indicator before sending, spoken preambles before anything
     slow, no long silent gaps. Cross-cutting (every Speaker interaction, not one rung). A test
     fixture already expects "show typing before this message" — the seam exists, just not wired.
   - **DM / Person-surface completion** — `STATUS.md`'s own "distance to close" list already names
     this ("complete Surface routing by resolving known-Person DM targets"). Confirmed live: a real
     DM from a personal WhatsApp account (`204663831932940@lid`, sender "Abdullah", text "Gm") was
     received and archived in `conversation_events` but never acted on — correctly fail-closed,
     since that chat isn't in `managedChats`. This is #299's own "one chat registry and routing
     path for configured group and direct chats" line item, not scope creep.
   - **Issue update/comment/close effects** — `file_issue` (#317) explicitly scoped these out
     ("update/comment/close-issue effects are out of scope" per its own honest boundary). The
     Phase 1 audit found the code for this **already exists and is fully unused**:
     `packages/agents/src/capabilities/issue-management/tools.ts:481`, a 10-tool GitHub surface
     with zero production callers. This is a wiring task, not a build-from-scratch task.
4. **GitHub hygiene** (close 15, create milestone, link 8) — do this AFTER the grill, using
   whatever the grill actually decided, not the Phase 1 audit's first-draft proposal verbatim
   (though it's a solid starting point — see `docs/PHASE1-AUDIT-2026-07-23.md`).
5. **Resume construction** on the three remaining original rungs, each deployed and proven as it
   lands (not batched at the end), as an agent-team (decision 9):
   - **ingress-upinbox (#254)** — GitHub webhooks → Brain up-inbox, replacing broadcast/drop.
   - **refine-rekick (#211)** — Brain re-kicks the Coder on review feedback. **Agreed live
     scenario**: a real "changes requested" review left on a real PR → confirm it lands via #254's
     webhook path → confirm the Brain launches a refine job against the *same* PR/branch (not a new
     one) → confirm a real commit addressing the feedback lands → confirm a second identical review
     event does NOT trigger a duplicate refine launch (loop-guard) → restart mid-flow, confirm the
     durable launch record survives. **Depends on #254 being live first** — the review-feedback
     event has to reach the Brain somehow.
   - **downflow-awareness (#319)** — work-state digest across chats. Live scenario: nonce work
     state visible via the digest in both `Tst` and `Bug Reports`.
   - **multi-org's own live proof stays BLOCKED** until Aaron confirms the three GitHub Apps
     (coder/reviewer/planner) are installed on the Xelmar-tech and TheCallApp orgs — check with the
     planner App JWT before claiming it's unblocked.

## How-to / conventions to match

- **Deploy recipe**: `.claude/skills/rig/SKILL.md` is authoritative — clean worktree off
  `origin/integration/coworker-replacement`, `pnpm install && typecheck && test && build:runtime`,
  `npm pack`, scp to capxul-vps, back up `application.sqlite`/`flue.sqlite`/`whatsapp/` before
  installing, `systemctl stop` → any config change → `systemctl start` (never run `config` against
  a live service — rule #311), restart-survival proof for anything durability-touching.
- **PR discipline**: one PR = one narrow claim + its own stated honest boundary. CI green on Node
  22 + 24 before merge. Check GitHub's own Codex bot review (`chatgpt-codex-connector[bot]`) before
  merging — it has caught real bugs our own review missed twice already this session.
- **Proof contract** (until Phase 2 formalizes it further): nonce-tagged scenario, evidence
  correlated across every layer the diff touches (WhatsApp/provider IDs, `application.sqlite` rows,
  Flue records, GitHub URLs, now optionally Braintrust traces), restart-survival proof for
  durability-touching diffs, and an explicit honest boundary (what's proven vs. not).
- **Live runtime state right now**: two managed WhatsApp chats — `Tst`
  (`120363410063306573@g.us`) and `Bug Reports` (`120363428464069244@g.us` — this is TheCallApp's
  own bug-reports group, with real users and real bugs, e.g. the Isha-time iOS/Android
  discrepancy). No DM chats are managed yet. `github.allowedRepositories`/`defaultRepository` on
  the live config is **still just this repo** — TheCallApp's own repo isn't configured, so
  `file_issue` would currently misfile a TheCallApp bug into this repo. Tracing is off
  (`runtime.tracing.enabled: false`).

## Gotchas & risks

- The live capxul-vps service is healthy right now at tip `7b2ec13`. **Never run `ambient-agent
  config` or hand-edit `config.json` while the service is running** — stop first. The WhatsApp
  session store is single-home; a companion-revocation/`logged_out` event is unrecoverable except
  via a QR re-pair from Aaron's phone.
- `config.json` is a flat file, not hot-reloadable, and there's no UI. A real design question
  (config-file vs. database for live-mutable settings like `managedChats`/`allowedRepositories`)
  was raised and **explicitly deferred**, not solved — don't assume it's been decided.
- **Don't trust `STATUS.md`'s claims without checking the code** — it says Layer 2 (TenantRuntime
  removal) is done; the Phase 1 audit found it isn't.
- The user is currently sensitive about token/agent-spend discipline after the runaway-workflow
  incident (decision 1) — be conservative, always batch and cap before large fan-outs, and ground
  any large action in a concrete plan before executing it.
- Several stale worktrees from the now-complete `coworker-remaining-rungs.js` construction workflow
  are still on disk under `.claude/worktrees/wf_35205597-7f2-*` — harmless, not cleaned up, safe to
  ignore or prune later.

## Key file pointers

- **#299** — https://github.com/AaronAbuUsama/ambient-agent/issues/299 — master execution
  authority + its own "Final definition of done" checklist. Source of truth for "what does done
  mean."
- `docs/PHASE1-AUDIT-2026-07-23.md` — full Phase 1 audit report (59 findings, docs/legacy drift,
  31-issue triage), committed alongside this file.
- `STATUS.md`, `docs/SYSTEM-ARCHITECTURE.md` (esp. §13), `docs/ARCHITECTURE.md` — canon, but verify
  against code, don't trust blindly (see gotchas).
- `.claude/skills/rig/SKILL.md` — deploy/proof/ops recipe.
- `.claude/workflows/coworker-remaining-rungs.js` — the construction workflow that landed rungs
  1-3; rungs 4-6 remain but per decision 9 should NOT run through this same mechanism.
- Memory: `workflow-concurrency-and-model-assignment.md` — the 6-agent cap + batching rule + model
  split, learned the hard way this session.
- This file, `docs/SESSION-HANDOFF-2026-07-23.md`.
