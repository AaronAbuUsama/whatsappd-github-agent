# @ambient-agent/installation

The installation machinery: everything that is the durable, on-disk state and lifecycle of
one running Ambient Agent on one machine. What `ambient-agent init / config / repair /
status / doctor` operate on.

Named after the CLI's own verb vocabulary — every file here is "the installation"
(rationale: `docs/planning/PACKAGE-TAXONOMY-HANDOFF.md`, decision 3; renamed from
`station` 2026-07-17).

## What it owns

| Concern | Exports | What's behind them |
|---|---|---|
| **Managed data directory** | `paths.ts`, `installation.ts`, `configuration.ts`, `schema.ts` (internal) | `managedPaths()` answers every path question. `inspectManagedData` / `installPreparedManagedData` hide the staged install: lock → re-inspect → stage → validate → promote. `writeManagedConfiguration` is atomic (rename + fsync + rollback). |
| **Health & repair** | `diagnostics.ts`, `runtime-health.ts`, `uncertain-work.ts`, `migration.ts` | Service checks, the runtime health probe (installation id derived from the webhook secret), the Uncertain-work doctor/reconciliation controller, and the one-time managed-root migration (ADR 0015). |
| **Runtime handoff** | `runtime-dependencies.ts` | The cross-bundle `globalThis` handshake: the CLI installs dependencies *before* importing the flue-generated server bundle, which reads them at module-eval time. `Symbol.for` is load-bearing — CLI and server are separate bundles. |
| **Credentials** | `chatgpt-authentication.ts` | Binds engine's ChatGPT OAuth machinery to managed paths. |
| **GitHub adapter** | `github-issue-repository.ts`, `issue-operation-footer.ts` (internal) | The Octokit adapter for the agents package's `IssueRepository` port, and the `<!-- ambience-operation-footer:v1 -->` body markers that carry Operation Identity on real GitHub issues. |
| **WhatsApp pairing** | `whatsapp-account.ts`, `qr.ts` | Pairing, echo-dedup, sync-wait behind a 5-method `ManagedWhatsAppAccount`; terminal QR rendering. |

## Glossary terms implemented here

Uncertain, Reconciliation, Operation Identity (footer + adapter), Managed Chat
(config `managedChats`). See root `CONTEXT.md`.

## Dependency arrows

Imports `@ambient-agent/engine` and `@ambient-agent/agents` (issue-repository types
only). Imported by `apps/cli` (heaviest consumer) and `apps/runtime`. Never imports apps.

## Tested by

All of `tests/managed/`, `tests/setup/`, `tests/whatsapp/account.test.ts`,
`tests/packaging/packed-cli.test.ts`.
