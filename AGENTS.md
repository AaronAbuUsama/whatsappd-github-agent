# AGENTS.md

Operating contract for coding agents working in this repository.

## Orient first — the canon

- **Architecture (conceptual):** [`docs/SYSTEM-ARCHITECTURE.md`](docs/SYSTEM-ARCHITECTURE.md) —
  the coworker: one Brain, dumb reactive Speakers, a global Scribe, one owned Graph. Its **§13**
  is the honest map of built-vs-designed. This is the single source of truth for *what the
  system is meant to be*; derive design answers from its §1 first principles.
- **Code layout:** [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — which package owns what.
- **Domain language:** [`CONTEXT.md`](CONTEXT.md) — the ratified vocabulary. Use these words.
- **Current status & reset:** [`STATUS.md`](STATUS.md) — what the reset removed, what is
  one runtime path now, and the decisions deliberately deferred. Don't re-open what it marks settled.

## Code discovery — graph before grep

This repo is indexed with **codebase-memory**. For any code exploration, use the
codebase-memory graph tools *first* (`search_graph`, `trace_path`, `get_code_snippet`,
`get_architecture`), then fall back to Grep/Glob/Read for text, config, and non-code files.
Always Read a file before editing it. If the project is not indexed, `index_repository` first.

## How work flows

- **Branch flow:** work on `main` (the reset line) via a **side-branch**, and open a **PR into
  `main`**. Default to side-branch PRs, not direct commits — check in at stage boundaries.
- **Issues:** tracked in this repo's GitHub Issues via the `gh` CLI. External PRs are not a
  triage surface. (The board is being cleared and recreated from the validated spec — see the
  reset handoff, step 6 — so don't over-invest in the current open issues.)
- **Shell is `zsh`.** `for x in $VAR` does not word-split. Dry-run every destructive list
  (deletes, branch removals) before executing.

## Decisions belong to the operator

Make every reversible step before stopping at a decision. When you must ask the operator to
choose, never ask in the abstract — show, in this order:

1. the problem in code (`file:line` + real snippet);
2. what it touches (callers, dependents, blast radius);
3. each option as concrete code or a diff sketch;
4. the options graded on floor-first, reversibility, blast radius, correctness/integrity,
   parallelizability, and fit with what exists — then your recommendation.

Only then ask the narrow question.

## Prove the work

Non-trivial logic leaves the smallest runnable check behind (a focused test or an
assert-based self-check). Run the checks proportionate to risk:

```bash
pnpm run typecheck
pnpm test
```

Separate mechanically-green from runtime-proven from human-only proof; never imply a claim
passed when it was not verified.
