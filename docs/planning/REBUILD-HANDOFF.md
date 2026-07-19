# Rebuild handoff — one Node service

**Written 2026-07-19 at the end of the grill session that produced ADRs 0020–0023. Those four
ADRs are the decisions; this file is the execution brief. The owner has confirmed the plan.
Do not re-litigate the ADRs; do re-verify any code fact you build on.**

## Where to build

Branch `rebuild/one-service` cut from `integration/unify-tracks` (NOT main). Stage PRs land
back into `integration/unify-tracks`. Main is untouched until the owner blesses the whole line.
`track/fix-forward` exists only as the parked base of PR #239 — ignore it.

## Already done on integration/unify-tracks — do not redo

- Vendored Flue fork deleted; stock registry `@flue/runtime@1.0.0-beta.9`; provenance
  machinery (workspace fingerprints, `frameworkTools` exclusion, boot gate) deleted.
- B1 fixed: `packages/engine/src/github/ingress.ts` binds `settle`/`get` per delivery; seam
  tests in `tests/speaker/github-ingress.test.ts` ("tenant-routed deliveries…").
- B2 fixed: web typecheck green (`allowImportingTsExtensions`).
- `prepareHostedManagedLayout` (`packages/installation/src/installation.ts`) initializes a
  bare volume to the 0700/0600 layout — reuse it per tenant directory.
- `apps/runtime/Dockerfile` builds and was smoke-tested live on capxul-vps (native deps OK
  on node:24-slim; CA certs needed for vp pack — already in the file).
- Flue docs vendored at `docs/reference/flue/`. Full suite green: 661 passed / 3 skipped.

## Build order

1. **E2B sandbox adapter** per the blueprint in `docs/reference/flue/docs-ecosystem-sandboxes-e2b.md`;
   both Coder and Reviewer run on it. Delete `local()` from the coder path
   (`apps/runtime/src/app.ts:60`) and retire `reviewer-docker-sandbox.ts` as the isolation
   mechanism. The service container mounts NO docker socket. E2B key comes from the owner
   (Infisical) — code against an env var and a fake in tests until it lands.
2. **Collapse the coding workflow** (`packages/agents/src/capabilities/coder/workflow.ts`):
   three model turns (planner → coder⇄verifier loop) and a plain `openPullRequest()` function
   call; PR title/body ride on the verifier receipt schema. The publication turn and the
   model-facing PR tool go. Keep the handler's idempotent branch/PR upsert logic — it is good.
3. **Tenancy**: tenant rows + `tenants/<slug>/` directories; whatsappd `createSession` per
   tenant with `./stores/libsql`; Flue libsql durable adapter (`db.ts`) so restarts recover
   conversations; authenticated admin route to add a tenant and serve its pairing QR.
4. **Ingress**: route deliveries by installation id → tenant row; key domain is the three
   fixed Apps (ADR 0020). Only simplify the ledger against that shape — the B1-fixed code is
   correct today and keeps the suite green while you work.
5. **One-service Dockerfile** — simplify the proven `apps/runtime/Dockerfile` (no socket, no
   per-tenant image); deploy to capxul-vps (Docker present, ~19G free, `dokploy-network`
   exists but nothing in code may depend on Dokploy).
6. **Pairing spike before trusting deploy**: whatsappd pairing in-container, no TTY, session
   surviving container restart from the volume. Needs the owner's phone. The repo currently
   proves nothing about this (every whatsappd test mocks the module).
7. **Demolition**, behind the working service, tests green at every step: provisioner +
   providers + their tests, control plane, `apps/web`, Polar/billing, Turso lifecycle,
   setup/operate dual entries (ADR 0023 supersedes ADR 0019), `TIGHTENING`/wayfinder docs that
   describe the dead architecture.

## Landmines to respect

- `packages/engine/src/model/pi-subscription.ts:162-190` replaces `globalThis.fetch` for the
  ChatGPT-subscription backend. Untested, undocumented, load-bearing. Touch only deliberately.
- Prose evals are circular (fixture echoes the eval's expectations) — they prove wiring only.
- `managedChats` non-empty is enforced by config schema (`schema.ts:49`); pairing precedes
  operate for every tenant.
- Flue Node durability requires one live process owning an agent instance — one service
  satisfies it; never run two replicas against the same volume.

## Owner-supplied, parallel to all of the above

E2B account + API key; three GitHub Apps (coder/reviewer/planner) created once and installed
on both orgs, webhooks pointed at the service's delivery route. Secrets go to Infisical, then
env. The browser-equipped session is driving this with the owner.
