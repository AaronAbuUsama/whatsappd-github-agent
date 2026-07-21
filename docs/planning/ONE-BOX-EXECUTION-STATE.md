# One-box execution state — orchestrator handoff

**2026-07-20.** Single source of truth for resuming this work after a context compaction. The
**plan** is [`ONE-BOX-PLAN-2026-07-20.md`](ONE-BOX-PLAN-2026-07-20.md) (revision 3) — this file is
the *execution log and next-step brief* on top of it. If the two ever disagree, the plan wins on
scope and this file wins on "what's done / what's next".

## Role

I am the **orchestrator**. I do not implement or dispatch — I hold the whole plan, verify what
implementing agents report (never trust an agent's "done" — verify against GitHub / the box / the
kernel), keep the plan and tickets honest, and **write the handoff prompts the owner (Aaron)
dispatches to implementing agents.** Aaron runs the agents and does the human ceremonies.

## The goal (unchanged)

**One VPS, one instance, one operator. A WhatsApp message produces a real reply, files a real
GitHub issue, and opens a real PR — and survives a reboot.** T2 + T3 green together = the goal.

## The DAG (revision 4, 2026-07-21 — milestone MET; go-forward)

**Milestone (T1+T2+T3, incl kill-9) is MET on capxul-vps.** Go-forward = relocate to code-factory,
rebrand to *coworker* (surface), harden T5/T6, add model selection — built dashboard-ready. Full
rationale + forward frame: **`ONE-BOX-PLAN-2026-07-20.md` § Revision 4**.

```
  C1 model+reasoning+auth ─┐
  C2 surface rebrand ──────┤  (both before M; new box inits once)   PRs → claude/single-box-working
  T4 env→CLI (#252) ───────┤
                           ▼
                           M  relocate + brand + stand up on code-factory (new number,
                           │  re-run T2 gates; kill co-worker.tech container, KEEP zone)
                           ▼
                    T5a Cloudflare Tunnel → agent.coworker.tech /channels/github/webhook (#254a)
                           ▼
                ┌──────────┴──────────┐
              T5b Reviewer review        T6 observability
              (#245 + reviewRepos, +T3)  (needs T4 + T3)
```
Critical path: **C1·C2 → M → T5a → T5b/T6.** T4 parallel, gates T6.

- **T1 #250** ✅ DONE (merged #257). **T2 #253** ✅ DONE — incl **kill-9 → interrupted (owner-run 2026-07-21)**, receipt #263. **T3 #251** ✅ DONE (merged #266; Coder green PR **#269** from Planner-issue #267).
- **C1 — model & reasoning selection + interactive auth choice.** ◀ **NEXT.** Config already holds it (`schema.ts:46-80`); gap is the interactive `select`s. No fallback. Parallel-safe. New ticket.
- **C2 — surface rebrand → coworker.** Repo/packages/`ambient-*[bot]` logins UNCHANGED. Parallel-safe. New ticket.
- **T4 #252 — env→CLI config.** Parallel-safe; now **load-bearing** (config = the dashboard's future write path).
- **M — relocate & stand up the branded instrument on code-factory** (new number). Needs C1+C2. Replaces capxul-vps as the measuring instrument. New ticket.
- **T5a #254a — inbound webhook via Cloudflare Tunnel.** Needs M. (Rewritten — no Dokploy/Traefik.)
- **T5b #254 — Reviewer's first review + #245 discriminator.** Needs T5a + T3.
- **T6 #255 — observability.** Needs T3 + T4. Lights the read-only SSE routes the dashboard will consume.
- **Parked (not this plan):** Planner-identity overload (naming + identity model); Speaker tool-authority / create-issue-as-handoff (+#265); the web dashboard + multi-group/repo/instance config.

## Core decisions + rationale (the "why", so it survives)

1. **Instrument-first ordering.** The installed instance is the *measuring instrument* for every
   gate, not a late deliverable. It's built at T2, right after the one code stage (T1) that makes an
   install possible. The previous revision put the first gate's install four stages later — a cycle
   — which is why acceptance criteria kept mutating ad hoc.
2. **Acceptance vs gate vs pre-flight.** Acceptance = code-level, agent runs it, no install/secrets.
   Gate = real-world proof against the live instance. Pre-flight = a narrow real proof claiming
   nothing beyond what it exercised (de-risks a deploy, never substitutes for a gate).
3. **No fakes, ever.** A rig that injects the inbound message and captures the outbound reply is
   real-model-but-fake-world (= `tests/fixtures/speaker`), inadmissible. A receipt caveat does not
   legitimize a fake. This killed an agent's proposed "stubbed-socket gate" for T1.
4. **Ceremonies are prerequisites, never gate content, never simulated.** WhatsApp pairing needs a
   human + phone once (`first-run.ts:233-235` hard-aborts non-interactive pairing by design).
5. **Multi-tenancy dropped** (Aaron, 2026-07-19). One instance; two companies = two chats + two
   GitHub orgs inside it. F-1/F-2 void. Do NOT re-propose tenant rows / tenantId / de-globalisation.
6. **Model auth is API key OR subscription — NEITHER required.** No OpenAI subscription available;
   currently an OpenAI **API key** with limited funds, model `gpt-5.4-mini`. Mid-tier models CAN
   code — do not scope down assuming they can't.
7. **Local sandbox, unattended, AUTHORIZED by Aaron directly 2026-07-20** (Resolved decision D-1 in
   the plan). Scope: single operator, capxul-vps, until the E2B key arrives. Does NOT extend to a
   second operator / second company chat / public instance. The exposure (model bash shares the
   runtime's uid + mount namespace with credentials/ and whatsapp/) is accepted for this scope.
8. **Findings accumulate; plans are singular.** Root cause of the whole mess was four unreconciled
   plans on one tree. There is now ONE active plan. Superseded docs are bannered; two dead specs
   (SPEC-S0.5, SPEC-S7a) were deleted.
9. **Fable is for REVIEW ONLY** (Aaron). Verification/adversarial passes may use Fable; do not use
   it for implementation.

## What's done (with SHAs, on branch `claude/single-box-working`, tip a0b9c97)

Branch flow: `claude/single-box-working` → PR #256 → `integration/unify-tracks` → #239 →
`track/fix-forward`. **NEVER target main** (39+ commits behind, nothing merges into it).

- `2b65b6a` T1 code: model auth is API key OR subscription (#257 merged, verified).
- `d05d5a8` #258 refuse a second runtime on one data directory (the T2 instance lock).
- `ebc2a05` #259 read --github-apps-file even when a human is present.
- `8cc51be` #260 take the App private key as a path (PEM truncation fix).
- `6c6067d` #261 **the T2 blocker** — ready the runtime archive on `online`, not a sync batch. A
  real bug only a live deploy could surface: restart hung 60s waiting for a conversation-sync batch
  that a whatsappd *reconnect* never emits. `createWhatsAppAccount` (flagged riskiest module, zero
  live coverage) ran live for the first time.
- `e2ccb5d` #263 T2 receipt (docs/proof/one-box-instance-live.md).
- `a0b9c97` docs: T2 done, plan updated, follow-ups filed. ← **current tip**

Grill/plan history (earlier): PR #240 (closed, carried into #256), grill report, ADR banners.

## THE LIVE INSTRUMENT (capxul-vps — being RETIRED)

> **Rev 4:** the instrument is relocating to **code-factory** (`ssh code-factory`) under a **new
> WhatsApp number** at stage **M**. capxul-vps stays only until M re-proves the T2 gates on the new
> box, then it is retired. The coords below are the *current* capxul-vps instrument — do not build
> new gates against it.

- **Host:** `capxul-vps` — SSH alias works, Tailscale `100.80.138.56`, user `abuusama`, key
  `~/.ssh/id_ed25519`. (Tailscale-only SSH; if `ssh capxul-vps` fails, Tailscale is down.)
- **Unit:** systemd `ambient-agent`, enabled + active, **port 3737** (3000 was taken by
  docker-proxy/Dokploy). `curl localhost:3737/health` → `ok:true, whatsapp.phase:online`.
- **Journal:** `journalctl -u ambient-agent -f --output cat` (operatorEvent stream lives here).
- **Config:** model `openai/gpt-5.4-mini` (API-key), managed chat **Tst** =
  `120363410063306573@g.us`, default repo **AaronAbuUsama/ambient-agent**.
- **Runs commit 6c6067d — PRE-T3.** `start_coder_job` is mounted-but-unprovisioned today; T3 code
  must land AND the instrument must be re-deployed before the Coder can run.
- **`/tmp` on capxul-vps is EXEC-mounted (verified).** #172 (noexec /tmp) CANNOT fire here — a green
  Coder run does NOT validate #172, and a Coder FAILURE here is NOT #172 (it'd be the model, the
  workspace wiring, or the App-credential path). Keep the workspace-local TMPDIR fix regardless — it
  is load-bearing for portability to noexec boxes (the code-factory rig).
- **Ingress (rev 4): Cloudflare Tunnel, NOT Traefik/Dokploy.** On code-factory, `cloudflared` routes
  **`agent.coworker.tech`** → `127.0.0.1:<port>/channels/github/webhook` (zero inbound ports).
  co-worker.tech is stale on Dokploy → kill the container at M, **KEEP the Cloudflare zone** and
  reuse it for the hostname. (The old capxul-vps 443-ownership question no longer applies.)
- **GitHub App triples** live at `~/ambient-apps.json` on the Mac (0600) and were used for init;
  the copy on the box should have been deleted post-init. App slugs: ambient-coder[bot] (id
  306398670), ambient-reviewer[bot] (306401437), ambient-planner[bot] (306402753). Repo owner is a
  User (AaronAbuUsama), not an org — App IDs/installation IDs are NOT API-derivable, must come from
  the settings UI.

## Immediate next step: C1 (then C2 / T4 in parallel) → M

**T3 is DONE** (merged #266; Coder green PR #269). **The verbatim T3 prompt below is spent — kept as
a record of the dispatch shape.** Next is the code track:

- **C1 — model & reasoning selection + interactive auth choice** is the recommended first dispatch:
  it makes the new box's one-time init the good one (any OpenAI model, any reasoning level,
  API-key-vs-subscription `select`, **no fallback**). Config already carries it (`schema.ts:46-80`);
  the gap is the interactive surface (`first-run.ts`, `program.ts:276-278`, `model-configuration.ts`).
- **C2 (surface rebrand) and T4 (env→CLI)** run in parallel with C1; all three PR into
  `claude/single-box-working`.
- Then **M** stands up the branded instrument on code-factory under the new number (real pairing),
  re-runs the T2 gate suite, and kills the co-worker.tech container (keep the zone).

**Owner decisions locked (rev 4):** rebrand **surface only**; webhook host **`agent.coworker.tech`**;
**Cloudflare Tunnel** ingress; code-factory is provisioned + SSH-reachable (`ssh code-factory`);
co-worker.tech is stale (kill container, keep zone). Coder PRs still target
`AaronAbuUsama/ambient-agent` (Aaron reviews; Coder can't self-merge).

**T3 has a redeploy step T2 didn't:** the live box runs pre-T3 code, so T3 must land → re-pack →
`npm i -g` on the box → `config --sandbox local` → `systemctl restart` before its gate can run.
Every code stage from here re-deploys the instrument.

### The T3 handoff prompt (verbatim — hand this to the implementing agent)

```
You are implementing T3 (#251) in AaronAbuUsama/ambient-agent: the sandbox
selector, ending in the Coder's first green PR against the LIVE instrument on
capxul-vps. This is the path that has NEVER worked. Read
docs/planning/ONE-BOX-PLAN-2026-07-20.md § T3 and "The instrument is LIVE"
section, plus #251's comments. The plan is the only authority; a doc that
disagrees is stale.

You run locally on the owner's Mac and SSH into capxul-vps for the gate. Branch
off claude/single-box-working; PR into it (fix-forward, NOT main).

=== ALREADY MEASURED — do not re-derive ===
- Instrument is LIVE: capxul-vps, systemd unit `ambient-agent` on port 3737,
  commit 6c6067d, model openai/gpt-5.4-mini, managed chat Tst
  (120363410063306573@g.us), default repo AaronAbuUsama/ambient-agent.
- The live box runs PRE-T3 code, so `start_coder_job` is mounted-but-unprovisioned
  today. Your code must land AND the instrument must be RE-DEPLOYED before the
  gate can run.
- /tmp on capxul-vps is EXEC-mounted (verified). #172 CANNOT fire on this box.
  Therefore: a green run here does NOT validate #172, and if the Coder FAILS here
  it is NOT #172 — do not chase it. It's the model, the workspace wiring, or the
  App-credential path. Use the layer-naming instrumentation below to tell them
  apart.

=== CODE (parallel-safe, write first) ===
Per § T3 and #251:
- runtime.sandbox = {kind: "local"|"e2b", template?}, default local. Follow the
  runtime.port config pattern verbatim, incl. adding dotted paths to
  CONFIG_ISSUE_PATHS (the forgotten step).
- The resolver returns sandbox AND workspacesRoot TOGETHER. E2B_WORKSPACES_ROOT
  (/home/user/workspaces, e2b-sandbox.ts:13) does not exist on a host; local uses
  paths.workspaces (paths.ts:94).
- Use local(options?) from "@flue/runtime/node" (dist/node/index.d.mts:45) —
  exactly what bc93fb9 deleted. NOT bash(factory).
- Explicit apiKey into Sandbox.create for the e2b branch.
- RETAIN the #172 TMPDIR fix in the local branch (workspace-local, mkdir before
  first use). It is load-bearing for portability to noexec-/tmp boxes even though
  this box is exec-mounted. Deleting it once already caused a regression.
- Remove ALL FIVE silent-disable paths, not two: apps/runtime/src/app.ts:51,:73
  (sandbox — deleted by the selector) AND :58,:87 (missing coder/reviewer App
  credential — these SURVIVE the selector and were unowned), plus the CLI sibling
  lifecycle.ts:35-42 (resolveAgentSandbox → undefined). A mispasted App credential
  must cause a non-zero exit or config-write refusal, not a green boot with a dead
  Coder. This closes #247 — reference it.

=== ACCEPTANCE (you, no instrument) ===
- pnpm typecheck && pnpm test green.
- config --sandbox local|e2b round-trips.
- Negative: the process does NOT boot green with the sandbox OR an App credential
  misconfigured — assert the non-zero exit / config-write refusal, not a log line.

=== PRE-FLIGHT (owner runs, throwaway repo, before the box gate) ===
The self-cleaning live-test pattern from
tests/speaker/issue-management.live.test.ts, driving the Coder workflow against a
THROWAWAY repo — real GitHub, real model, real local sandbox, no WhatsApp claim.
Get it to the point the owner runs one command with his key; tell him when. This
de-risks the redeploy; it is NOT the gate.

=== RE-DEPLOY THE INSTRUMENT (after your PR merges) ===
1. Pack from a commit containing your merged T3 code:
   pnpm install --frozen-lockfile && pnpm pack --pack-destination ./artifacts
   Record commit SHA + tarball SHA-256.
2. scp to capxul-vps, npm install -g the tarball (NOT Docker — its CMD is the
   deleted provisioner entry and would eat the box's remaining disk).
3. On the box: ambient-agent config --sandbox local ; sudo systemctl restart
   ambient-agent ; confirm curl localhost:3737/health → ok:true, whatsapp online.

=== THE GATE (live instance, from the managed chat) ===
From the Tst chat, a small well-specified task (add a file / fix an obvious bug /
add a small function with a test). Assert ALL of:
- a real NON-DRAFT PR by ambient-coder[bot] on AaronAbuUsama/ambient-agent,
- a NON-EMPTY diff,
- verdict === "PASS",
- produced in a LOCAL sandbox with NO E2B key present,
- the PR REFERENCES the real GitHub issue filed by the same chat request (so one
  run proves the whole goal sentence: reply → issue → PR).

Negatives:
- verdict PASS *and* non-empty diff asserted together — a legitimate SKIP also
  yields a non-draft PR, so draft-ness alone proves nothing.
- must not boot green with sandbox or App credential misconfigured.
- If any run reports reason `rate-limited` (#246): that run is INCONCLUSIVE —
  never PASS, never FAIL. Re-run it. Do not chase it as a regression.

RECORD alongside the verdict, so a failure names its layer: whether sandbox exec
succeeded, and `mount | grep /tmp` from inside the sandbox (expected exec on this
box). This is what tells "shell broke" from "model wrote a bad diff".

The Coder can NOT self-merge; the owner reviews the PR before any merge. Do not
merge it.

=== AFTER T3 IS GREEN ===
Re-run the ONE deferred T2 leg, now possible: kill -9 an in-flight Coder job on
the box → the run settles `interrupted`, the message reaches the thread, and NO
relaunch happens without a user turn (sweepUnsettledLaunches, app.ts:187-199).
Add it to the T2 receipt as a follow-up entry.

RECEIPT: docs/proof/coder-green-local.md (§ T3), github-webhook-live.md
convention — dated, commit + tarball SHA, exact commands, real output, mount
flags, verdict table, explicit ❌ for anything not observed. Never ✅ for anything
you did not see. T2 + T3 green together are the milestone.

REPORT BACK what actually happened, including failures with their layer named. A
clear-caused failure is a good outcome; a green receipt papering over a skipped
step is not.
```

## Open follow-up tickets (not blockers, filed so they aren't lost)

- **#264** setup lock orphans on a killed init and bricks every later init (found in T2).
- **#265** Speaker goes silent ~15s on action turns (no ack-then-act) (found in T2).
- **whatsappd#4** `link-preview-js` missing from bundled baileys (upstream footgun).
- **#245** fabricated-review discriminator (owned in T5b).
- **#248** ChatGPT apiKey never refreshes after boot — do NOT switch a standing instance to
  subscription auth before this lands.
- **#242** ADR-0020 self-approval 422 configuration test (deferred, not on critical path).
- **#243 / #249** two-GitHub-orgs (F-5) + cross-company event broadcast (F-6). **Do NOT add the
  second company's chat before #249 lands — it is a live cross-company confidentiality leak.**

## Gotchas & guardrails (will bite if forgotten)

- **NEVER target main.** Fix-forward via `claude/single-box-working` → #256 → integration branch.
- **Verify, do not trust.** Every "done" from an implementing agent must be checked against GitHub /
  SSH to the box / the kernel. This session's worst near-misses were agent assertions taken as fact
  (the original "owner confirmed the plan" that deleted a third of the codebase; a proposed
  stubbed-socket fake gate). The T2 verification caught nothing wrong — but only because it was run.
- **No env vars for runtime config** — everything CLI-configurable into managed config. Test
  harness `AMBIENT_AGENT_LIVE_*` are the only exception, by design.
- **Do not print secrets.** API key is pasted interactively by Aaron, never via a tool call / flag /
  transcript. App PEMs may be read into a 0600 file but never echoed.
- **A rate-limited run is INCONCLUSIVE, never FAIL** (#246 shipped this). Re-run, don't investigate.
- **capxul-vps disk ~82% (18G free).** Use the npm tarball, never a Docker build (5-6 GB).
- **The plan file gets EDITED IN PLACE on scope changes** — never spawn a competing plan doc.

## Key file pointers

- Plan (authority): `docs/planning/ONE-BOX-PLAN-2026-07-20.md`
- This handoff: `docs/planning/ONE-BOX-EXECUTION-STATE.md`
- Findings (evidence, still authoritative): `docs/planning/GRILL-REPORT-2026-07-19.md`,
  `docs/planning/ARCHITECTURE-ASSESSMENT-2026-07-19.md`
- T2 receipt: `docs/proof/one-box-instance-live.md`. Receipt convention model:
  `docs/proof/github-webhook-live.md`.
- Milestone: "One box working end to end" (#10) on AaronAbuUsama/ambient-agent.
- Memory: `~/.claude/projects/.../memory/` — `ambient-agent-single-instance.md`,
  `t2-instance-live-capxul-vps.md`, `agent-written-confirmation-is-not-authorization.md`.
