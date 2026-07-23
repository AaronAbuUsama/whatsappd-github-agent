# Phase 2 — Agent-team orchestration playbook

**You are the orchestrator.** This document tells you exactly what to run, in what order, how to
prove it, and when to stop and ask Aaron. You have none of the prior conversation — everything you
need is here or in the documents named below.

**Date written:** 2026-07-23 · **Branch:** `integration/coworker-replacement` (tip `5db8271`)
**Execution authority:** #299 · **Milestone:** #11 "Phase 2 — routing, work, and proactive time in the Brain"

---

## 0. Read these first, in this order

1. `docs/planning/PHASE2-PRD-2026-07-23.md` — the 12 specs (S1–S12), each with its proof contract.
2. `docs/SYSTEM-ARCHITECTURE.md` — **§13** (the distance map this phase is derived from), **§8**
   (identity + the Brain choosing surface and voice), **§10** (invariants), **§11** (extension points).
3. `.claude/skills/rig/SKILL.md` — deploy, live-proof discipline, ops gotchas. Authoritative.
4. Issue **#299** — the checklist that defines "done".
5. `docs/PHASE1-AUDIT-2026-07-23.md` — 59 debt findings, incl. `STATUS.md` inaccuracies.

**Do not trust `STATUS.md`.** The audit proved its "Layer 2 — TenantRuntime removed" claim false.
Verify against code.

---

## 1. Your role

You **own** the DAG, the gates, the merges, and the proof verification. You **do not** write the
feature code yourself — you dispatch one agent per work item and review what comes back.

Your loop, per item:

1. Confirm dependencies are merged **and deployed** (not just merged).
2. Dispatch one agent with a **self-contained brief** (§5 template).
3. When it returns a PR: check CI, check the third-party Codex bot review, run a cold review.
4. **Verify the proof yourself** (§4) — never accept a claimed proof you did not see evidence for.
5. Merge → deploy → re-verify live → then move on.

---

## 2. The team model — agents, not a workflow

- **NOT** a `Workflow` script. **NOT** one long unattended background run. Those were tried and
  produced a runaway 135-agent fan-out and an unattended crash.
- **One agent = one work item = one fresh context = one git worktree = one PR.**
- Each brief must be **fully self-contained**. The agent has never seen this conversation.
- **Hard cap: never more than 6 concurrent agents, for any reason.** Every agent call costs ~60k
  tokens of fixed context. For this DAG, 2–3 concurrent is the realistic number.
- **Model split:** `opus` for agents that write code, `fable` for agents that review/critique.
- Cut every branch from the current `origin/integration/coworker-replacement` tip.

---

## 3. The DAG and its gates

| Wave | Items | Gate |
|---|---|---|
| **1** | **S3 → #319** (down-flow) ‖ **S1 → #249** (Brain-owned routing) + **S2 → #19** (repo facts in Graph) | — |
| **2** | **S6 → #254** (webhook transport) | 🔒 **only after #249 is merged AND deployed** |
| **3** | **S5 → #329** (known-Person surfaces) ‖ **S4 → #328** (proactive clock) ‖ **S7 → #331** (issue effects) ‖ **S8 → #179** (live-reload config) | S7 needs #249 + #19 |
| **4** | **S9 → #212** (work-loop proof) · **S10 → #211** (refine-rekick) · **S11 → #330** (knowledge-loop proof) | S10 needs #254 |
| **5** | **S12** — delete superseded paths → `docs/ARCHITECTURE.md` → cumulative suite → atomic cutover PR | everything above |

### 🔒 The security gate — read this twice

`packages/engine/src/github/ingress.ts:515` **broadcasts every GitHub event to every managed chat**
(issue #249 calls it a cross-company leak). `allowedRepositories` now spans **three orgs**
(ambient-agent, TheCallApp ×5, Xelmar-tech ×2).

Verified 2026-07-23: **no inbound path reaches capxul-vps today** — there is no Dokploy vhost for the
webhook host (Host-header probe via `:80` → 404), so GitHub's deliveries 401 at some other origin.

**Therefore: #249 must be merged and deployed before #254 wires any vhost.** Wiring transport first
would flood the Tst group and TheCallApp's Bug Reports group with each other's events. If an agent
proposes doing #254 first, refuse.

---

## 4. How to gather each proof layer — concrete commands

The ratified contract is **L1–L6**; each issue declares which layers are mandatory. **Configuration
is never proof.** Unit tests green ≠ done. A nonce-tagged live scenario with correlated receipts is
the only "done".

**Nonce convention:** `TST-<slice>-<sha7>-R<n>` (e.g. `TST-DOWNFLOW-5db8271-R1`). Always take a
**baseline-absence** reading before driving, proving the nonce appears nowhere.

### L1 — WhatsApp receipt
Drive from **Aaron's personal WhatsApp** in Chrome (`mcp__claude-in-chrome__*`, `web.whatsapp.com`).

> ⚠️ **Aaron authorized driving his account in the `Tst` group ONLY** (`120363410063306573@g.us`).
> Do not send in any other chat — **Bug Reports (`120363428464069244@g.us`) is a real group with
> real users.** Never send from the agent's own account (`22942602729@s.whatsapp.net`).

### L2 — Archive / DB rows
The box has **no `sqlite3` CLI**; use `node:sqlite`:

```bash
ssh capxul-vps "node -e '
const{DatabaseSync}=require(\"node:sqlite\");
const db=new DatabaseSync(process.env.HOME+\"/.ambient-agent/application.sqlite\");
const n=\"<NONCE>\";
console.log(db.prepare(\"select event_id,kind,provider_message_id,chat_id,sender_name,direction from conversation_events where payload_json like ? order by rowid desc\").all(\"%\"+n+\"%\"));
' 2>/dev/null"
```
Key tables: `conversation_events`, `brain_effects`, `surface_deliveries`, `directive_outcomes`.

### L3 — GitHub artifact
`gh` as `AaronAbuUsama`. The artifact must be authored by `ambient-planner[bot]` / `ambient-coder[bot]`
— **never a human login**. Record the real URL.

### L4 — Braintrust trace
Tracing is **live** (enabled 2026-07-23), logging to project **`co-worker`**, id
`ac7f8405-ae21-47ff-b962-7fe70a936fdb`. Query via the Braintrust MCP (`sql_query`,
`object_type: project_logs`). Correlate by `evidenceIds == <the conversation_events event_id>` — this
is the strongest cross-layer link and it is proven to work.

### L5 — Restart-survival
`sudo systemctl restart ambient-agent`, re-run the receipt query, require **byte-identical**
counts/ids (hash before and after).

### L6 — Screenshot / behavioural
For anything rows can't show: typing indicator, preamble ordering, the visible transcript.

**Every item also has a negative assertion** (the failure the proof must actively exclude). It is not
optional — see each spec.

---

## 5. Dispatch brief template

Give each agent exactly this shape. It must stand alone.

```
You are implementing <ISSUE #N: title> on repo AaronAbuUsama/ambient-agent.

BRANCH: cut from origin/integration/coworker-replacement (never main). One PR, one narrow claim.
SPEC: docs/planning/PHASE2-PRD-2026-07-23.md, section <Sn> — read it first, it is authoritative.
CANON: docs/SYSTEM-ARCHITECTURE.md §<relevant>. The architecture wins over existing code:
       where code contradicts it, the code is drift to remove.
RIG:   .claude/skills/rig/SKILL.md — deploy + proof discipline.

DO:
- Implement exactly the spec's "Build" list. Nothing more.
- Satisfy the spec's proof contract (layers listed) AND its negative assertion.
- Add regression tests for the negative assertion specifically.
- State an honest boundary in the PR: what this tip proves and what it deliberately does not.

DO NOT:
- Do not expand scope. Do not refactor adjacent code.
- Do not invent domain nouns; a new term needs a code path that already branches on it.
- Do not propose configuration-based routing (see "Corrections" below).
- Do not deploy or touch the live box — the orchestrator owns deploys.

REPORT BACK: the PR URL, what you proved, what you did not, and any spec assumption you had to make.
```

---

## 6. Hard rules every agent inherits

1. **Scenario evidence only.** "Unit and integration tests are important but they are not proof it
   works. A scenario is proof — with evidence from the database and GitHub."
2. **One PR = one narrow claim + its proof + an honest boundary.**
3. **Review the diff, not the biography. Cap review cycles at 2.** Reviewers get the diff + the spec,
   cold. Two clean verdicts end the loop.
4. **Never invent a noun.**
5. **Decisions land on the branch immediately or they don't exist.**
6. **Ratify the premise before fanning out.** One cheap "does this survive contact with Aaron?" beats
   any amount of parallel execution.
7. **Check the live target first; if blocked, say blocked.** Diagnose the command before declaring an
   environmental blocker.
8. **Check the `chatgpt-codex-connector[bot]` review before merging** — it caught two real bugs that
   our own review missed.

### Live-box rules (these have destroyed things before)

- **Never run `ambient-agent config` (or any WhatsApp-touching CLI command) while the service is
  running** (#311) — `systemctl stop` → change → `start`.
- **The WhatsApp session store is single-home.** Never copy `whatsapp/` anywhere; `logged_out` is
  terminal and only a QR re-pair from Aaron's phone recovers it.
- **Back up before every change:** `application.sqlite`, `flue.sqlite`, `whatsapp/`, `config.json` →
  `~/backups/<ts>`.
- **Don't trust `/health` alone when diagnosing WhatsApp** (#312) — it can report `online` after the
  stream is dead.
- **Verify migrations against real production data before deploying.** A rename-copy-drop migration
  nearly crashed the live service because SQLite auto-repoints child FK clauses.

---

## 7. Corrections — do NOT regress these

These were established the hard way. An agent proposing any of them is wrong:

- **Routing is the Brain's, always.** §11:592 "routing is 'the Brain decides,' and it already does";
  §11:601-604 the surface↔project mapping is "**data in the Graph, not hard-wired configuration — the
  Brain resolves it per decision**"; §8:529 "the Brain chooses **surface and voice** as part of every
  decision." **Never propose config-mapped or surface-hardcoded routing.** `file_issue`'s "resolved
  from that Surface — never chosen here" (`packages/agents/src/brain/tools.ts:64`) and the
  `surfaceRepositories` config field are **drift to remove**, not the design.
- **Config is authorization only** (§8:533) — `managedChats` / `allowedRepositories` are the
  fail-closed permission boundary. Never the routing mechanism.
- **#254 is a Dokploy route, not Caddy.** Dokploy/Docker owns 80+443 on capxul-vps
  (`docker-proxy`; caddy/nginx/traefik systemd units all inactive). The runtime is on **3737**,
  unproxied. #254's Caddyfile plan is wrong for this box. Prefer a **new** hostname; do not reuse
  `co-worker.tech` / `app` / `api` / `docs`.
- **#211's stated blockers (#209/#210) are already CLOSED.** Its real dependency is #254.
- **The proactive clock does not exist at all** — only the reactive clock. Don't assume partial work.
- **#317/#318 are implemented but NOT live-proven** — their code landed (PRs #322/#323); they stay
  open until a live proof exists.

---

## 8. Live rig state (verified 2026-07-23)

| Thing | Value |
|---|---|
| Host / service | `ssh capxul-vps` → systemd `ambient-agent.service`, port **3737** |
| Health | `curl -s localhost:3737/health` → expect `ok:true`, `state:"healthy"`, `whatsapp.phase:"online"` |
| Data dir | `~/.ambient-agent/` (`application.sqlite`, `flue.sqlite`, `credentials/`, `whatsapp/`) |
| Managed chats | Tst `120363410063306573@g.us` · **Bug Reports `120363428464069244@g.us` (real users — do not drive)** |
| Agent's own WhatsApp | `22942602729@s.whatsapp.net` |
| `allowedRepositories` | ambient-agent + TheCallApp/{ios-app,android-app,api,agent,website} + Xelmar-tech/{Capxul,infrastructure} |
| `defaultRepository` | `AaronAbuUsama/ambient-agent` |
| Tracing | **on**, → Braintrust project `co-worker` (`ac7f8405-ae21-47ff-b962-7fe70a936fdb`) |
| Ingress | 80/443 owned by **Dokploy**; runtime on 3737 unproxied; **no webhook vhost** |
| Model | `openai-codex/gpt-5.6-luna` (ChatGPT subscription; tokens not refreshed after boot — #248) |

**GitHub App reachability** (all three apps installed on all three orgs):
full coder∩reviewer∩planner loop works on `TheCallApp/{ios-app,api,agent,android-app}` and
`Xelmar-tech/{Capxul,infrastructure}`.
⚠️ **`TheCallApp/website` is missing from the *reviewer* App** — filing and coder PRs work there, the
reviewer loop does not, until Aaron adds it.

**Known open bug:** `Scribe attempt … has no trusted Attestation context` fires once on **every** boot
— a durable Scribe run stuck failing on replay. Covered by #330. Live Knowledge loop is unaffected.

---

## 9. Checkpoint with Aaron — stop and ask when

- Before **#254** wires any vhost (the security gate) — confirm #249 is deployed and proven.
- Before **any destructive or outward-facing action**: closing issues in bulk, deleting code paths
  (S12), rotating the webhook secret, changing `defaultRepository`.
- Before driving WhatsApp in **any chat other than Tst**.
- When a spec assumption turns out false — **do not paper over it**; Aaron would rather re-scope than
  receive a plausible-but-wrong implementation.
- On a fixed cadence: a short sitrep (PRs open/merged, proofs gathered, what's blocked). Cap any
  unattended stretch at ~45 minutes with a veto-able checkpoint.

**Aaron's outstanding action:** add `TheCallApp/website` to the reviewer GitHub App's repo selection.

---

## 10. Definition of done for the phase

Every milestone-#11 issue closed **with its proof contract satisfied and its negative assertion
demonstrated**, then S12's atomic PR cuts `integration/coworker-replacement` into `main`, with
#299's checklist fully ticked and `docs/ARCHITECTURE.md` matching the code that actually exists.
