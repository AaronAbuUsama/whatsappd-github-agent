# Wayfinder map — tightening pass (2026-07-16)

Label: `wayfinder:map` (local-markdown tracker — GitHub is off-limits for this pass per
handoff guardrail). Tickets live in `docs/planning/wayfinder/tickets/`, one file each,
named `T<n>-<slug>.md`. A ticket is claimed by a `Claimed-by:` line in its header;
resolved tickets get a `## Resolution` section and move to the Decisions-so-far index
below. Blocking edges are declared in each ticket's `Blocked-by:` header line.

## Destination

Every decision needed for the tightening pass is resolved, so `/to-spec` → `/to-tickets`
can emit a real DAG (specs + tickets with explicit blocking edges) covering workstreams
A (evals) / B (observability) / C (split pre-work) / D (deletions) + the four feature
seeds — ready for `/implement`, fresh context per ticket. Nothing left to decide before
someone goes and does the thing.

## Notes

- Domain: ambient WhatsApp→GitHub agent, live on the code-factory test rig (tmux
  `validate-88`). Rig how-to: `docs/planning/TIGHTENING-PASS-HANDOFF.md`.
- Input corpus: `docs/planning/WAYFINDER-INPUTS.md` (survey + ponytail-audit findings,
  Aaron's ratifications). Raw detail: closed issues #99–#105 (source material, not tickets).
- Every HITL decision is presented per the #91 pattern: problem in code (file:line +
  real snippets), blast radius, options as concrete diff sketches, graded on
  floor-first / reversibility / blast radius / correctness / parallelizability / fit,
  with a recommendation — via AskUserQuestion. Skills: /grilling, /domain-modeling,
  /prototype.
- Hard guardrails: NO GitHub issues/milestones without Aaron's go-ahead; NO code changes
  (planning only); never merge PRs. Paperwork commits straight to the docs branch.
- Ratified constraints (do not relitigate): evals FIRST, both tracks equally; react tool
  wanted (echo machinery stays); windows carry everything; chat-visible default console
  (ADR 0016 amendment); receipts projection + legacy ATTACH cutover delete; monorepo
  target `packages/{core,cli,server,test-support}`; C1–C4 before the cut. Do NOT touch:
  operation-store health states (ADR 0004), coalescer Effect seams,
  installation-inspection paranoia, globalThis defer handshake (#87).

## Open tickets (the frontier, in suggested order)

- [T2 — Harness window input + faux/live boundary](tickets/T2-harness-window-input.md) — unblocked (T1 resolved)
- [T8 — Ratify the implementation DAG](tickets/T8-dag-ratification.md) — blocked by T2; gates /to-spec → /to-tickets

## Decisions so far

- **Skill layering architecture** (Aaron, in-session 2026-07-16) — tools are code (the
  machine); ALL policy/behavior lives in skills (the mind); skills are layered bundles
  (Flue `PackagedSkillDirectory`, natively multi-file): a **main ambience skill**
  (identity + WhatsApp teammate behavior — the ratified rubric axes) with **domain
  skills** beneath it (issue-management first; technical depth like label taxonomies
  and blocking relationships as reference files inside the bundle). Layered skills ARE
  the extension mechanism — one domain skill ships now, but the shape must be the
  extensible one. Consequence: the A2 deliverable is a skill-tree restructure +
  SKILL.md amendments, not a rubric-encoded prompt;
  [PARTICIPATION-RUBRIC.md](../PARTICIPATION-RUBRIC.md) is the decision record, the
  skill bundles are the artifact, and eval judges grade against the same skill text
  the agent reads.
- [T1 — Participation rubric ratification](tickets/T1-participation-rubric.md) — all six
  axes ratified in live session; teammate-not-bot; task-workflow speech always allowed;
  capture is a conversation (elicit until template-fillable, reply with issue link,
  post PR link when it lands → new PR-ingress ticket); artifact
  [PARTICIPATION-RUBRIC.md](../PARTICIPATION-RUBRIC.md).

- [T4 — Windows carry everything](tickets/T4-windows-carry-everything.md) — O1: coalescer
  event widens to a union; reaction/edit/revocation extend-only, may open a cold window,
  receipts excluded; `conversation_reactions` deletes (journal-only).
- [T6 — composeAmbience core surface](tickets/T6-compose-ambience.md) — O1: adapters-in →
  Hono-out, subsystems only; coalescer stack joins at the C5 cut.
- [T3 — AmbienceObserver seam](tickets/T3-ambience-observer.md) — O1 named seam over
  `observe()`; settledSilent renders on the default console; typing wraps sends only
  (span-deliberation rejected; broken send-typing re-scoped as the B3 fix).
  Implementation = review/align `codex/semantic-terminal-reporter` (f88e075), which
  already builds the observe()-correlation core.
- [T7 — Smoke canary](tickets/T7-smoke-canary.md) — O2: dedicated canary group,
  `SMOKE <nonce> — ignore`, settled-silent asserted via the T3 observer; rubric
  carve-out feeds T1.
- [T5 — Outbound tool surface](tickets/T5-react-tool.md) — O1 broadened: `say` gains
  `replyTo` (→ `SendOptions.quote`), `react({ messageId, emoji })` as sibling tool;
  no remove-reaction v1; outbound mentions stays fog.
- Flue dispatch-settlement investigation (was the B2 gate) — resolved during charting:
  `dispatch()` settles at admission only, but `@flue/runtime` `observe()` emits
  `agent_end`/`submission_settled` correlated by `dispatchId`; evidence quoted in
  [T3](tickets/T3-ambience-observer.md).
- Paperwork routing — main is PR-protected since the repo moved to
  `AaronAbuUsama/ambient-agent`; the map lives on branch `docs/wayfinder-map` via PR
  (never merged by the agent).

## Not yet specified

- **C5 cut mechanics** — pnpm-workspace layout, build/packaging (tsup? per-package tsc?),
  version/publish story for the four packages. Sharpens only after C2–C4 land and evals
  prove no regression; don't pre-slice.
- **Frontend event feed contract** — the AmbienceObserver seam (T3) doubles as the future
  frontend's feed; what the frontend actually consumes stays fog until the observer
  interface is decided and a frontend effort exists.
- **LLM-judge scorer implementation detail** — model choice, prompt shape, Braintrust
  scorer wiring; sharpens after the rubric (T1) and faux/live boundary (T2) are decided.

## Out of scope

- The frontend itself (a future effort; this pass only leaves core consumable for it).
- Any relitigated ratification (list above).
- Upstream whatsappd protocol changes.
