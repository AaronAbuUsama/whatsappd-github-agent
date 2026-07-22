# Status

The canonical description of the system is
[`docs/SYSTEM-ARCHITECTURE.md`](docs/SYSTEM-ARCHITECTURE.md) — **the coworker**: one
**Brain** (the mind, the owner, the decider), many dumb reactive **Speakers** (one per
surface), a single global **Scribe**, and one owned **Graph**. Its **§13** is the honest,
always-current map of what is built versus what is designed-but-not-yet-built. Read §13 for
the real frontier; this file is only the one-paragraph orientation.

## Where we are (2026-07-22)

Mid-reset. Three dead pivots — **Eve-era**, **Ambience**, and the **SaaS / multi-tenant**
cutover — have been stripped down to one stable line, and the system is being rebuilt
forward from `SYSTEM-ARCHITECTURE.md`. **One instance, one operator — not multi-tenant**
(tenancy was killed 2026-07-19).

**Already built in reusable form** (§13): the Graph's typed query surface, the live Digest
pull side, the reactive Brain conversation loop (Intent → Batch → Directive/silence → Outcome),
stable account-scoped Surfaces, async delegation with durable return, modelless coalescing,
and the Coder / Reviewer / Planner Specialists as distinct GitHub identities. The current Graph write model
is **not** definitive: mutable entity/relation upserts must become append-only Attestations
with the same read shape derived as the Belief Projection.

**The distance to close is concentration of authority, not new machinery:**

- Finish concentrating authority in the **Brain** — route GitHub/work/ontology through its
  existing durable up-inbox and add its proactive clock.
- Consolidate the **Scribe** to one global ingestion clock with bounded stateless attempts and
  explicit Evidence Sets.
- Replace mutable Graph writes with the append-only Attestation log + derived Belief Projection.
- Reduce the **Speaker** to a dumb mouth — remove issue/delegation/ontology-write; Intent
  escalation and Directive-only Saying are already built.
- Replace GitHub webhook broadcast + drop with the single up-inbox.
- Complete **Surface** routing by resolving known-Person DM targets through the existing
  stable registry and removing the remaining first-chat/provider-id shortcuts.
- Extend the existing live Digest projector with Projection version/evidence/bounds and compose
  bounded Brain-selected seeds over the same `graphContext` channel.

## The reset — where the code stands (2026-07-21)

The reset is a code-level cut down to **one runtime path** (single-box self-host), done in two layers:

- **Layer 1 — done.** Dropped the dead SaaS / multi-tenant + operator-web stack:
  `apps/{api,web,server}`, `packages/{api,auth,db,env}`, and their tests.
- **Layer 2 — done.** Removed the orphaned hosted/tenant runtime boot (`setup-server`/`setup-app`,
  `TenantRuntime*` setup-boot + operate-bridge, `prepareHostedManagedLayout`). Only
  `ambient-agent start` → `apps/runtime/app.ts` remains.

Both were behaviour-neutral on single-box (all removed code was gated behind unset
`AMBIENT_AGENT_RUNTIME_PROFILE`/`TENANT_DB_URL`); typecheck + full test suite green, and the
single-box build is deployed and healthy.

**Deferred (decisions, not deletes — for the next design pass):**

- Credential/session storage: collapse the file-vs-libsql fork to files-only (`tenant-credentials.ts`).
- Specialist sandbox substrate: `local()` vs Daytona (native in Flue) vs e2b.

Branding is `coworker` (surface only); repo, package, and login names are unchanged for now.
