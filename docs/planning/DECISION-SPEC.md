# Decision spec — WhatsApp-native agent on Eve (one process)

Architecture decision record for moving the hand-rolled two-tier agent onto Eve as a
**WhatsApp-native agent**. Ratifies the decisions made in the 2026-07-12 planning
session. Grounded in [`EVE-PRIMITIVES-MAP.md`](./EVE-PRIMITIVES-MAP.md) and
[`STATE-AND-FAILURE-MODES.md`](./STATE-AND-FAILURE-MODES.md). This is the spine of the
refactor plan; read it before the plan.

Status: **ratified via grill 2026-07-12 (G1–G7 below).** §2a is the authoritative decision
log; §2 (D1–D11) is retained as history and superseded where it differs. Companion docs:
[`DOORWAY-OPTIONS.md`](./DOORWAY-OPTIONS.md), [`NON-BLOCKING-DELEGATION.md`](./NON-BLOCKING-DELEGATION.md).

---

## 2a. Ratified decisions — grill 2026-07-12 (authoritative)

Confirmed from §2 unchanged: **D1** (one process, VPS), **D2** (keep the Coalescer),
**D4** (one durable Eve session per chat → memory + compaction), **D6** (persist chats to
SQLite), **D11** (evals). Decided/updated in the grill:

- **G1 — Doorway = loopback `eve/client`.** The gateway opens the doorway by calling the
  app's own HTTP route in-process: `new Client({host:"127.0.0.1"}).session(chatId).send(...)`.
  One mechanism, used in all three directions (coalescer→voice, gateway→worker,
  result→voice). Option 2 (captured channel `send`) shelved. See `DOORWAY-OPTIONS.md`.
- **G2 — Two agents (supersedes D5).** **Voice** = orchestrator: holds state, delegates,
  narrates; never blocks. **Subagent(s)** = task-based, take a task, return **structured
  output** (`outputSchema`), always back to the voice. GitHub is subagent #1; code-review
  / coding are the real reason for the pattern. *Why two agents:* non-blocking +
  busy-chat responsiveness (also why coalescing exists).
- **G3 — State lives in the voice, and falls out of the job model (supersedes D7's
  "provenance layer").** The voice's `defineState` ledger + the SQLite `jobs` rows + typed
  worker results ARE the "what it did / why / with evidence" state. No separate provenance
  system. Subagents stay stateless (task in → structured out).
- **G4 — Non-blocking job-runner from day one.** SQLite `jobs` table + a gateway
  `Effect.fork` runner. `delegate` enqueues + returns "started" (voice says "on it", turn
  ends); the runner runs the worker via loopback with `outputSchema`, then delivers the
  result back into the chat → voice narrates. See `NON-BLOCKING-DELEGATION.md`.
- **G5 — Participant, not reply-bot (the speech model).** The model's final text is
  internal working memory; reaching the group is an explicit **`say` tool** call. Worker
  results return structured and the voice narrates deliberately. Kills F3 by design.
- **G6 — Config service + persisted file; zero app env vars (supersedes D-CLI, D8-key).**
  `npx` CLI (clack via `eve/setup`'s `createPrompter`, minus the Vercel provisioning) does
  WhatsApp QR login + chat picker + GitHub token + model choice → writes
  `~/.wa-agent/config.json`; the app reads a typed `AppConfig`, never `process.env`.
  Replaces all 19 env vars.
- **G7 — Model: NOT gpt-5.6-sol.** Aaron's pick (floated "5.6 luna"); TBD, chosen in the
  CLI (Codex login or an OpenAI key).
- **Frozen/dropped:** framework-ization (fork the repo instead); new GitHub tools (the 13
  are fine). The real tool gap is **WhatsApp tools** (send/typing/search over the SQLite
  chat log).

---

## 1. Goal (what we're actually building)

> "I want the WhatsApp agent to be a WhatsApp agent — the right WhatsApp tools, a base
> prompt that knows how to navigate and behave in WhatsApp."

A competent **WhatsApp group agent** that owns its surface. GitHub issue-filing is the
**current capability**, not the point. It must **know what it has done** (state), **be
able to pull more context** from the chat history (searchable store), and **behave well
in a group** (base prompt). It runs as **one always-on process on our VPS**.

**Explicitly out of scope** (decided): generic framework-ization / no-code extension
(we'll fork the repo instead); expanding the GitHub tool surface (the 13 we have are
fine); `search_issues`/`update_issue`.

---

## 2. Decisions

**D1 — One process, always-on.** whatsappd must stay connected to receive messages, so
it can't be serverless. The Eve app and the WhatsApp gateway share a fate (if either
dies the bot is dead), so splitting them buys nothing. One long-running process
(`eve start` on the VPS), one CLI. *(Two-process split reconsidered only if the gateway
ever needs to scale independently — not now.)*

**D2 — The agent moves onto Eve; the Coalescer stays hand-rolled.** The genuinely-novel
debounce/cap/relevance timing (`coalescer.ts`) has no Eve equivalent (schedules are
minute-granularity) — **keep it**. Everything the Coalescer *fires into* (the voice's
session bookkeeping, the worker's hand-rolled tool loop) becomes real Eve primitives.

**D3 — The doorway is opened by a loopback call to a real Eve route.** The fire comes
from a background timer with no `send()` in scope (`coalescer.ts:95`). Instead of the
unproven "capture `send` and call it from the timer" trick, the Coalescer opens the
doorway by calling the app's **own HTTP front door** in-process — `eve/client`
(`Client({host:'http://localhost:PORT'}).session(chatId).send(window)`) or a loopback
POST to a custom-channel route. This uses a *real, supported* doorway and dissolves the
whole "doorway problem." **Must be proven by a spike (plan commit #1) before anything
else migrates.**

**D4 — One durable Eve session per chat** (`continuationToken = chatId`). Gives Layer-1
conversation memory + **compaction** (`agent-definition.d.ts:95`) for free — deletes the
`.slice(-30)` in `voice.ts:221` and the stateless-worker amnesia.

**D5 — The GitHub agent becomes a declared subagent** (`agent/subagents/github/`),
reusing `agent/tools/*` and `instructions.md` **unchanged**. Eve auto-lowers it to a
`github` tool (`subagents.mdx:99`), deleting `worker.ts`'s `adapt()` + hand-rolled
`streamText`. The parent (the WhatsApp agent) owns state and packs "already filed #63 —
update, don't recreate" into the delegation `message` (subagent state is never shared —
`state.md:66`).

**D6 — The chat log is persisted to a local DB and made searchable.** We store nothing
today. whatsappd is stream-only (no history query API — verified), so we persist every
inbound/outbound message to **SQLite** ourselves, exposed via a `whatsapp_search` /
`whatsapp_read_thread` tool so the agent can pull more context on demand.

**D7 — State has four homes** (see §4). Conflating them is the root of the duplicate-issue
bug. No single "memory."

**D8 — Model default = `experimental_chatgpt()` → gpt-5.6-sol** (subscription, no key,
`models/openai/index.d.ts`), replacing `gpt-5.4-nano`. Keep it as the no-key path;
`makeModel()` stays for the API-key/gateway alternative.

**D9 — A WhatsApp-native base prompt** (`agent/instructions.md`) governs group behavior
(when to speak/stay silent, brevity, how to address a group, when to delegate), separate
from the GitHub-triage instructions (which live in the subagent).

**D10 — Delivery is native, not a relay hack.** The agent's assistant text reaches the
group through the channel's delivery path (or a `whatsapp_send` tool), so the "🛠️
delegated, no reply" black-hole (F3) can't happen — no second tier to drop the output.

**D11 — Evals are a first-class deliverable.** Seed `eve eval` cases straight from the
F1–F10 failure table (dedup, repo resolution, silence calibration, feature-vs-bug).

---

## 3. Target architecture (one process)

```
 ┌──────────────────────── one Node process (eve start, VPS) ───────────────────────┐
 │                                                                                    │
 │  whatsappd session (in-process, full mention context)                              │
 │     │ onMessage                                                                    │
 │     ├─► persist(msg) ──────────────► SQLite chat log ◄──── whatsapp_search tool    │
 │     └─► Coalescer (Effect: debounce + cap + relevance)   [KEEP — unchanged timing] │
 │              │ fire(window)                                                         │
 │              └─► loopback doorway ─► Eve session (continuationToken = chatId)       │
 │                                         │  durable history + compaction  [Layer 1]  │
 │                                         │  defineState ledger            [Layer 2]  │
 │                                         │  WhatsApp-native instructions.md   [D9]   │
 │                                         ├─ tools: whatsapp_send / _typing / _search │
 │                                         └─ subagent: github/ (13 tools, unchanged)  │
 │                                              └─► GitHub API                         │
 │  reply ◄──── channel delivery / whatsapp_send ──── whatsappd.send                  │
 └────────────────────────────────────────────────────────────────────────────────────┘
```

Component responsibilities:

| Component | Owns | Source today → target |
|---|---|---|
| whatsappd module | WA connection, full mention context | `whatsapp.ts` → in-process module (keep) |
| Coalescer | *when* to wake the agent | `coalescer.ts` (keep verbatim) |
| Doorway | timer → session | `voice.ts` streamText → **loopback `eve/client`** |
| Chat store | searchable message log | *(nothing)* → SQLite + `whatsapp_search` tool |
| WhatsApp agent | conversation, state, delivery, WA tools | `voice.ts` → `agent/` (instructions + tools) |
| GitHub subagent | filing/triage | `worker.ts` → `agent/subagents/github/` |

---

## 4. State homes (D7)

| State | Example | Home | Notes |
|---|---|---|---|
| **Coalescer buffer** | rolling window, debounce timers, `burstStart` | **in-memory, ephemeral** | not the DB; lose-on-restart is fine |
| **Chat message log** | every message | **SQLite** | searchable; the new store (D6) |
| **Conversation state** | "mid-intake; filed #63 here" | **Eve session + compaction** | free under D4; deletes `.slice(-30)` |
| **Action ledger** | "issues touched: #63(bug), #67(feat)" | **`defineState`** (session) / SQLite (forever) | injected via dynamic instructions so the model sees it |

The ledger + durable session together are the "knows what it's done" fix (F1/F2/F7).
It lives on the **parent** WhatsApp agent, never the subagent (state.md:66).

---

## 5. WhatsApp tool surface + base prompt (D9)

**Tools** (new — the actual gap):
- `whatsapp_send(text)` — post to the current chat (or native channel delivery).
- `whatsapp_set_typing(on)` — typing indicator while working.
- `whatsapp_search(query)` — search this chat's stored history (D6 store).
- `whatsapp_read_thread(limit)` — pull recent messages beyond the coalesced window.
- (later, if whatsappd supports: `whatsapp_react`, `whatsapp_quote`.)

**Base prompt** (`agent/instructions.md`) — WhatsApp behavior, not GitHub:
- Engage when it can genuinely help; stay silent in social chatter (calibration was
  mostly right — keep it, fix F9: a clear GitHub question is "help").
- Group etiquette: brief, address the group, don't narrate tool calls.
- Remember what you've done this chat (state); don't re-file; update, don't recreate.
- Delegate real GitHub work to the `github` subagent; narrate the result back.
GitHub-specific triage rules stay in `agent/subagents/github/instructions.md` (the
existing `instructions.md`, unchanged).

---

## 6. Keep / delete / gain

**Delete:** `voice.ts` histories + `.slice(-30)`; `voice.ts` SPEECH_CONTRACT relay hack;
`worker.ts` `adapt()` + hand-rolled `streamText`; the voice→worker `delegate` tool.
**Keep:** `coalescer.ts`/`buffer.ts`/`config.ts`/`events.ts` (timing); `whatsapp.ts`
in-process session; `agent/tools/*` + `agent/instructions.md` (become the subagent);
`makeModel()` (thin). **Gain:** durable session + compaction, skills, real subagents,
native text delivery, searchable chat store, WhatsApp tools, evals.

Folds in the parked issues: **#1** (Eve/conversation-state → D4/D7), **#2** (in-process
device-auth → still the no-key path, D8), **#3** (agent CLI/daemon → the one-process
daemon + `eve` CLI).

---

## 7. Migration principles (no big-bang)

- **The alpha stays green throughout** (main @ `ef02dac`, 72 tests). The Coalescer +
  ports are the stable seam; migrate what's *behind* a port, one port at a time.
- **Spike the doorway first** (D3) — if loopback-client can't cleanly open a
  per-chat session, the topology assumption is wrong and we learn it in commit #1, not
  commit #20.
- **Keep the hand-rolled path runnable as a fallback** until the Eve path is proven live
  in the group.

---

## 8. Open risks

- **R1 — the loopback doorway (D3).** Unproven that `eve/client` against localhost cleanly
  opens/resumes a per-chat session and delivers back to WhatsApp. → de-risking spike,
  plan commit #1. Fallback: custom-channel `POST /flush` route hit via loopback, or the
  captured-`send` trick.
- **R2 — running whatsappd + the Coalescer inside the Eve app process.** Need a clean boot
  hook (instrumentation `setup`, a channel module, or a custom entrypoint) that starts
  long-lived background work under `eve start`. → confirm in the spike.
- **R3 — native delivery vs tool delivery (D10).** If we open the doorway via the generic
  session route (no channel), the agent's assistant text may be discarded unless it uses
  `whatsapp_send`. Decide during the spike: custom channel (natural text delivery) vs
  background module + `whatsapp_send` tool (proven, but prompt must enforce it).
- **R4 — repo resolution bug (F4/F5)** is independent of all the above and can be fixed
  now (`agent/lib/github.ts` `resolveRepo` + `worker.ts:47` empty-strip). Quick win.
