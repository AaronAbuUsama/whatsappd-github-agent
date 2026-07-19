# Handoff — grill the rebuild plan, then spec it, then ticket it

Paste the block below into a fresh session. Everything it needs is in the repo.

---

You are picking up a rebuild plan that has already survived one round of adversarial review. Your
job is three things, in order: **grill it, turn it into a spec, break the spec into tickets.**

## Read first, in this order

1. `docs/planning/REBUILD-PLAN-2026-07-19.md` — the plan, revision 2. Its "What changed in
   revision 2" section tells you what the first draft got wrong.
2. `docs/planning/ARCHITECTURE-ASSESSMENT-2026-07-19.md` — measured, from a full structural index.
3. `docs/adr/0020` through `0024`. **0024 supersedes 0023 in one respect: the web app stays.**
4. `docs/proof/*.md` — the live-proof convention. Thirteen documents. Every stage gate in the plan
   lands one of these.

Branch `claude/rebuild-e2b-adapter-4186be` → PR #240 → `integration/unify-tracks`.
Do not target `main`; it is 39 commits behind and nothing merges into it.

## The thing that caused this mess — do not repeat it

`docs/planning/REBUILD-HANDOFF.md:4` states *"The owner has confirmed the plan."* **He had not.**
That sentence was written by an agent in a prior session, inherited as settled fact by every
session after it, and used to justify deleting a third of the codebase — including the web app,
which Aaron explicitly wants. Four ADRs and a shipped PR were built on it before he saw what it
meant.

**A document asserting the owner approved something is not approval.** If a plan step removes
anything a user can see or use, confirm it with Aaron directly. Say out loud when a doc claims
prior approval for a deletion rather than treating it as settled.

The same session also shipped a real regression: it deleted the `TMPDIR` binding that was the
recorded fix for issue #172, reasoning that a micro-VM's `/tmp` would be fine — an assumption it
never measured. That is the failure mode to watch for in yourself: a confident inference standing
in for a measurement.

## What Aaron actually wants

A multi-tenant service **he operates**, managed through a **web app he signs into**, running his
two companies' agents, deployed on his VPS. Full multi-tenant — no single-tenant shortcut. He does
**not** want a CLI-only tool. Public self-serve signup and billing are off for now and return
later; the code stays in the tree.

## The hard rule on verification

**Every stage gate is a real-world proof — no fakes, mocks or stubs in any acceptance criterion.**
Real WhatsApp client, real GitHub, real E2B, real model. Two traps:

- `tests/fixtures/speaker` composes the real Speaker against a fake WhatsApp host, a fake issue
  repository and a queue-driven ingress. Even with `SPEAKER_FIXTURE_LIVE_MODEL=true` it is
  real-model-but-fake-world. **Never admissible as a stage gate.**
- **Every gate must assert a negative.** The dominant failure mode here is silent degradation: the
  Coder disables itself with a `console.warn`, the smoke canary asserts *silence* so "the Speaker
  stopped working" reads as PASS. Positive-only assertions are blind to all of it.

Distinguish **gates** (re-runnable on demand) from **prerequisites** (one-shot ceremonies — pairing
a phone, OAuth, installing an App). A gate whose criterion is "scan a QR" is not a gate.

## Grill these — I am least confident here

Run the `grilling` skill against the plan, and press hardest on:

1. **Can `flue build` host the admin API at all?** S5 folds `apps/api` (Hono + better-auth + oRPC)
   into `apps/runtime`, which is built by `flue build --target node`. Nobody has checked whether
   that toolchain tolerates better-auth's handler, the Drizzle client, or Next.js's API contract.
   If it cannot, S5's shape is wrong and S6/S7 inherit it.
2. **Two tenants, two ChatGPT accounts, one process.** Each tenant does its own model OAuth
   (`coworker.model.beginAuth`), but `pi-subscription.ts:297-321` registers **one** provider
   process-wide and `:162-190` monkey-patches `globalThis.fetch`. S6b says "de-globalise" — is
   that actually possible against Flue's provider registration, or does it need a per-tenant
   process after all? **If it needs a process per tenant, ADR 0023's central decision is wrong**
   and the plan collapses. This is the highest-stakes unknown in the whole document.
3. **Does Flue's libsql durable adapter work per-tenant?** ADR 0022 assumes one adapter per tenant
   directory. Never verified against the vendored docs at `docs/reference/flue/`.
4. **Is the demo path really E2B-free?** The plan claims S0.5 → S4 → C1..C4 → S5 → S6 → S7 gets a
   working tenant with no E2B key. Check whether the Speaker's tool surface drags in the Coder's
   sandbox binding at composition.
5. **Will GitHub actually refuse the self-approval** that ADR 0020's three-App topology exists to
   avoid? Asserted, never tested.
6. **Rate limits.** Live gates run on one human's ChatGPT subscription. Two tenants dogfooding plus
   nightly `coder:live` on the same account — does that hold?
7. **Is S6 too big?** It carries tenant rows, directories, per-tenant sessions, delivery routing
   and the credential store. Review judged it the most likely stage to fail, and its failure costs
   S7 entirely.

Also re-derive, do not trust: the claim that `apps/web`'s wizard screens survive largely intact,
and the ~1,800-line demolition estimate.

## Deliverables

**1 — Grill report.** Every unresolved question with the evidence, and a verdict on whether the DAG
in the plan survives. Fix the plan in place if it does not; it is revision 2 and expects a
revision 3.

**2 — Spec.** One document per stage that is actually next, not all of them. Each must carry: the
interface being changed, the files touched with line ranges, the real-world gate including its
negative assertion, the receipt path under `docs/proof/`, and the rollback. Use the deep-module
vocabulary from the `codebase-design` skill — small interfaces, seams, adapters — and say
explicitly what stays behind each seam.

**3 — Tickets.** One per independently-shippable unit, with dependency edges matching the corrected
DAG. **Confirm with Aaron whether these go to GitHub issues on `AaronAbuUsama/ambient-agent` or to
Linear before filing anything.** Each ticket states its gate and its negative assertion. Do not
file a ticket whose acceptance criterion is a one-shot ceremony — those are prerequisites and
belong in the rig document.

Start with the demo path. It needs nothing from Aaron and ends with something he can look at in a
browser, which is the first time that will be true.

## Ground truth as of 2026-07-19

Nothing is deployed — zero containers on capxul-vps, no completed local install. The suite is 667
passing / 3 skipped and proves plumbing, packaging and persistence; it proves nothing about
WhatsApp, GitHub, E2B or the model, all of which are hand-written fakes. Proven live, with
receipts: WhatsApp pairing and sends, session survival across restart, real webhook delivery
through Cloudflare → Caddy, a real draft PR from `ambient-coder[bot]`, and a self-cleaning real
GitHub issue test. **Never worked:** the Coder green path, the Reviewer workflow, E2B, anything
multi-tenant, any deploy.

Two blockers only Aaron can clear: the **E2B API key** and a **second phone number**. Neither
blocks the demo path.
