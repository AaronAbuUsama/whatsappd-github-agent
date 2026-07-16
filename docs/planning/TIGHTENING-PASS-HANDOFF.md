# Tightening-pass handoff (2026-07-16)

Session handoff written immediately after #88 shipped and was live-validated. This file is the
single source of truth for the next phase; the compact/reactivation prompts point here.

## Mission

Get real value out of the now-live agent, then restructure. Two ordered thrusts, both ratified
by Aaron on 2026-07-16:

1. **Evals first.** The product is BOTH chat→GitHub issue capture AND in-chat reply quality,
   equally. Before any restructure, build the eval battery that measures live behavior (what it
   answered, what it ignored, whether that was right) so the restructure has a regression
   harness. "We have no evals, we don't know how any of this is working" is the top complaint.
2. **Then the restructure.** Bigger than a cleanup: Aaron wants a **monorepo split with isolated
   modules** — the CLI as its own module, a core that a future **frontend** can consume. Design
   passes and decision specs come before any tickets.

## Agreed process (ratified, in order)

1. `/compact-continue` (this document is its artifact).
2. **In parallel**: `/improve-codebase-architecture` (survey of deepening/seam candidates) and an
   **aggressive `/ponytail-audit`** over the whole repo (over-engineering / delete-list report).
3. Feed both reports + the live-operation observations (below) into **`/wayfinder`** — decision
   tickets, not deliverables; the #91 pattern that worked for the stable base.
4. Merge onto the main flow: `/to-spec` → `/to-tickets` **with blocking edges declared** (Aaron
   explicitly wants a real DAG, not a flat list) → `/implement` per ticket, fresh context each.

Context hygiene: steps 3–4 want one unbroken context window; `/handoff` rather than degrade.

## Hard guardrails (violating these burned trust this session)

- **Never file GitHub issues or milestones from collated feedback without Aaron's explicit
  go-ahead.** Collate = present back in conversation. Ticket shape comes out of the design pass.
  (Violated once: #99–#105 + milestone 5, filed then withdrawn/closed same day.)
- Decisions are presented as code + options + rubric (floor-first, reversibility, blast radius,
  correctness, parallelizability, fit) via AskUserQuestion — never abstract questions.
- No code changes until the tightening pass is agreed and ticketed.

## Decisions made this session (with why)

- **Evals before split** — the split needs a harness proving nothing regressed; value-now beats
  architectural purity.
- **Both eval tracks equally** — issue-operation correctness AND participation/reply quality.
- **code-factory is a TEST RIG** — the managed group there is a *test group*, not the real org.
  Full authority to stop/start/drive it end to end. (Earlier hands-off assumptions are void.)
- **Flue's eval way is already installed**: `src/evals/harness.ts` is stamped
  `flue-blueprint: tooling/vitest-evals@1` — fixture-seeded repeatable Vitest suites over the
  real agent HTTP boundary. Docs: `pnpm exec flue docs read guide/evals` and
  `ecosystem/tooling/vitest-evals`. Extend this; do not invent a harness.
- **Braintrust is wanted and NOT yet installed** — official Flue blueprint exists:
  `pnpm exec flue add tooling braintrust` (docs: `ecosystem/tooling/braintrust`). No braintrust
  dependency/config/env exists in the repo today.

## What's done (shipped + validated)

- **#88 shipped** via PR #98, squashed to main as `a96f4fe`: installation vocabulary
  `absent|incomplete|corrupt|ready`; component states (whatsapp `re-pair-required|paired|online`,
  chatgpt/github `ready|reauthentication-required`); runtime `stopped|starting|healthy|failed`;
  guided `ambient-agent repair whatsapp` (private staging + validate identity/chat visibility +
  promote only the store); logged_out startup exits pointing at repair; `backlog: N pending,
  N failed`; deterministic repair tests; `docs/proof/whatsapp-re-pair-checklist.md`.
- **Live-validated on code-factory** via npx against packed main tarball (sha256 `b35ea9e7…`) in
  tmux session `validate-88`: root migration ran (legacy XDG → `~/.ambient-agent`), all gates and
  refusals behaved, Aaron QR-scanned, repair promoted the store, runtime went healthy/online,
  the 1 pending Window re-dispatched and settled. Runtime currently running there with
  `--debug --log-format pretty`.

## Live-operation observations (raw material for wayfinder — NOT tickets)

Filed prematurely as issues #99–#105, all closed "not planned" same day; their bodies hold the
detail. The observations remain valid:

- Default terminal shows no chat messages (`logInbound` is debug-only, `src/coalescer/whatsapp.ts:36`).
- The agent's **reply text is never logged at any level** (`say` logs id only,
  `src/host/whatsapp-runtime.ts:54`); deliberations and deliberate-silence outcomes are invisible
  (`dispatchAmbience` → Flue surfaces nothing; needs a dispatch-observer seam investigation).
- Typing indicator only flickers around send; should span dispatch (`whatsapp-runtime.ts:41`).
- No ratified participation rubric; agent answers more than expected; evals must encode the rubric.
- `--debug` terminal is unreadable (upstream whatsappd protocol noise); custom pino-pretty
  renderer is feasible, contained in `src/logging/logging.ts:80` (chat-style lines, dimmed noise).
- No live smoke battery (one command, per-station pass/fail across all promised paths).

## How-to (operate the test rig)

- SSH: `ssh code-factory` (user abuusama). Runtime lives in tmux session `validate-88`.
- Run the packed CLI: `npx --yes --package=file:$HOME/validate-88/ambient-agent-0.2.2.tgz ambient-agent <cmd>`
  (plain `npx <tgz>` does NOT work). Tarball + validate script live in `~/validate-88/`.
- Managed data: `~/.ambient-agent` (port 42069). Health: `curl 127.0.0.1:42069/health`.
- Repo checks: `pnpm build`, `pnpm exec vp lint`, `pnpm exec tsc --noEmit`, `pnpm test`
  (311 passing; 3 skips are pre-existing live/gated), `pnpm evals`.

## Gotchas & risks

- Unrelated `node dist-bundle/server.mjs` (PID 1722, cwd `/app`, since Jul 4) runs on
  code-factory — holds no ambient data; leave it alone.
- `stream:error code 515` right after QR pairing is WhatsApp's benign forced-reconnect.
- The worktree branch `feat/88-whatsapp-repair` is merged; work off fresh `origin/main`.
- Paperwork (ADRs, planning docs) goes straight to main per repo convention; product code goes
  through PRs. Never merge a PR without Aaron.

## Key file pointers

- This phase: `docs/planning/TIGHTENING-PASS-HANDOFF.md` (this file).
- Prior decision pattern: `docs/planning/DECISION-SPEC.md`, `docs/planning/DOORWAY-OPTIONS.md`.
- ADRs: `docs/adr/0014` (at-least-once wake), `0015` (data root), `0016` (logging root).
- Live proofs: `docs/proof/ambient-agent-stable-base-live.md`,
  `docs/proof/whatsapp-re-pair-checklist.md`.
- Evals: `src/evals/harness.ts` (+ `*.eval.ts`, `*.live.eval.ts`), `vitest.evals.config.ts`.
- Auto-memory: `~/.claude/projects/-Users-abuusama-projects-hack-space-whatsappd-github-agent/memory/`.
