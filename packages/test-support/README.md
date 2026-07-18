# @ambient-agent/test-support

Fakes, mocks, and the eval battery. May import anything (the one package with no arrow
restrictions); nothing in production imports it.

## What's here

| Concern | Files | Seam it sits at |
|---|---|---|
| **Fakes** | `fake-whatsapp-host.ts`, `fake-issue-repository.ts` | Second adapters at real seams: `WhatsAppOutboundPort` (production: `apps/runtime/src/host/whatsapp-runtime.ts` `createWhatsAppHost`) and `IssueRepository` (production: `@ambient-agent/installation/github-issue-repository.ts`). |
| **Coalescer mocks** | `coalescer-mocks.ts` | `Ref`-backed Layers for engine's `EventSource` / `WindowDispatcher` / `WindowStore` ports, so timing tests can inspect exactly what fired. |
| **Managed fixtures** | `managed-installation.ts`, `managed-chat-inbox.ts` | Thin adapters over the *real* `installPreparedManagedData` staging path and the real inbox — tests exercise production code, not parallel implementations. |
| **Eval infra** | `evals/harness.ts`, `evals/braintrust-reporter.ts` | The Flue agent harness (`@flue/sdk` + vitest-evals) and Braintrust score reporting. The eval *suites* live with what they measure: each capability's `evals/` folder, plus the shared mechanics suite and rubric judges in `packages/agents/evals/`. |

## Known gap

`package.json` declares `"exports": {}` — consumers import via relative `src/` paths, so
the "test-support → anything" boundary is policed only by the hard-cut test, not by a
declared surface. Flagged in the 2026-07-17 architecture survey.

## Run the evals

`vitest.evals.config.ts` at the repo root drives `packages/agents/evals/*.eval.ts` and `packages/agents/src/capabilities/*/evals/*.eval.ts`.
