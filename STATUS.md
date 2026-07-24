# Status

The canonical description of the system is
[`docs/SYSTEM-ARCHITECTURE.md`](docs/SYSTEM-ARCHITECTURE.md) — **the coworker**: one
**Brain** (the mind, the owner, the decider), many dumb reactive **Speakers** (one per
surface), a single global **Scribe**, and one owned **Graph**. Its **§13** is the honest,
always-current map of what is built versus what is designed-but-not-yet-built. Read §13 for
the real frontier; this file is only the one-paragraph orientation.

## Where we are (2026-07-24)

Phase 2 (issue #299, milestone #11) is substantially complete. Three dead pivots —
**Eve-era**, **Ambience**, and the **SaaS / multi-tenant** cutover — have been stripped down
to one stable line, and the system has been rebuilt forward from `SYSTEM-ARCHITECTURE.md`.
**One instance, one operator — not multi-tenant** (tenancy was killed 2026-07-19).

**Already built and deployed** (§13): the append-only Graph Attestation log and derived
Belief Projection (including the typed query surface), the live Digest pull side composed
with bounded Brain-selected Directive seeds, the reactive Brain conversation loop (Intent →
Batch → Directive/silence → Outcome), stable account-scoped Surfaces including known-Person
DM resolution (one prompt operation for "DM someone" and "reply in the group", the
provider-chat-JID routing shortcut removed), Brain-owned async delegation with durable
return and down-flow work-state streaming to Speakers, modelless coalescing, the durable
global Scribe clock shared by live and Historical Replay, and the Coder / Reviewer / Planner
Specialists as distinct GitHub identities. The Brain owns stable Coder work identity, Flue
admission reconciliation, terminal-result intake, the independent reporting-Surface choice,
**GitHub ingress** (events admitted to the single up-inbox and routed by Brain decision — the
broadcast/drop path is deleted), the **full GitHub issue-mutation set** (comment
create/update/delete, issue update, state change) as durable down-flow effects, **live-reload
of authorization config** (managedChats/allowedRepositories/reviewRepositories, no restart),
and the **proactive clock** (Scheduled Wake + coalesced Proactive Sweep — the Brain chases
overdue commitments on its own initiative). Speaker and Specialist Graph access remains
read-only.

**Remaining before the atomic cutover to `main`:**

- **#211** (S10) — repair Coder-owned PRs after formal Reviewer REQUEST_CHANGES feedback.
  Merged; its real dependency (S6/#254, inbound webhook transport) is deployed and verified live.
- **S12** — delete the superseded Speaker/routing ownership paths, green the cumulative scenario
  suite at the final commit, and cut one atomic PR into `main`. The `TenantRuntime*` dead-code
  removal and the SaaS/web catalog-pin pruning are done (see Layer 2 below); this file and
  `docs/ARCHITECTURE.md` are reconciled against the code that actually exists.

## The reset — where the code stands (2026-07-21)

The reset is a code-level cut down to **one runtime path** (single-box self-host), done in two layers:

- **Layer 1 — done.** Dropped the dead SaaS / multi-tenant + operator-web stack:
  `apps/{api,web,server}`, `packages/{api,auth,db,env}`, and their tests.
- **Layer 2 — done (S12 prep).** The Phase 1 audit (2026-07-23) found `TenantRuntimeEnvironment`,
  `RuntimeDeploymentIdentity`, and `runtimeDeploymentIdentityFromEnvironment`
  (`packages/installation/src/runtime-dependencies.ts`) still live in the tree — dead because
  nothing set `AMBIENT_AGENT_RUNTIME_PROFILE`/`AMBIENT_AGENT_CONFIG_VERSION`. S12 removed those
  symbols and their call sites (CLI lifecycle, bridge-contract health, runtime app), plus the
  SaaS/web-only pins from the `pnpm-workspace.yaml` catalog. The core single-box runtime
  dependencies (`getManagedRuntimeDependencies`, the deferred WhatsApp start) are untouched.

Layer 1 was behaviour-neutral on single-box; typecheck + full test suite green, and the
single-box build is deployed and healthy.

**Deferred (decisions, not deletes — for the next design pass):**

- Credential/session storage: collapse the file-vs-libsql fork to files-only (`tenant-credentials.ts`).
- Specialist sandbox substrate: `local()` vs Daytona (native in Flue) vs e2b.

Branding is `coworker` (surface only); repo, package, and login names are unchanged for now.
