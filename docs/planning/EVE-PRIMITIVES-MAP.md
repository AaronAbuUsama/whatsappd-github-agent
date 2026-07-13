# Eve primitives map (grounded in `node_modules/eve@0.22.5` d.ts + docs)

> Historical design record. Superseded by the Flue Ambience production path completed in milestone #3; this is not current operator or architecture guidance.

Research artifact for the Eve-migration + framework-ization effort. Every claim
below cites the real `.d.ts` / doc path. Companion to
[`COALESCER-VOICE-HANDOFF.md`](./COALESCER-VOICE-HANDOFF.md). Read this before the
refactor plan.

Eve is **filesystem-first**: capabilities are *files on disk under `agent/`*
discovered at build time (`eve build` → `.eve/`), then served (`eve start`) or
deployed (`eve deploy`). Adding a capability = adding a file/folder, not runtime
config. Hold that fact — it shapes both the doorway and the framework-ization
answer.

---

## 0. The doorway, precisely (why it exists, where it opens)

A session only starts/continues through the runtime, and authored code reaches the
runtime **only** inside one of these handler contexts:

| Doorway | Where you get it | Signature |
|---|---|---|
| Channel HTTP route | `POST("/x", (req, args) => …)` | `args.send`, `args.receive`, `args.getSession`, `args.waitUntil` — `channel/routes.d.ts:14` |
| Channel WS route | `WS("/x", (req, args) => hooks)` | same `args`; **`send` stays in closure for the whole connection** — `channel/routes.d.ts` (`WebSocketRouteHandler`) |
| Schedule handler | `defineSchedule({ run({receive, waitUntil, appAuth}) })` | `receive` + `waitUntil` — `schedules.mdx:21` |
| External HTTP client | `new Client({host}).session(token).send(...)` | `eve/client` — `client/client.d.ts:5`, `client/session.d.ts` |

The plumbing under all of them: `send`/`receive`/`deliver` are **closures over a
`Runtime`** (`channel/send.d.ts` → `createSendFn(runtime, adapter, channelName)`;
`channel/cross-channel-receive.d.ts` → `createCrossChannelReceiveFn(runtime, channels)`).
The `Runtime` (`channel/types.d.ts:308`) is host-constructed; authored code never
builds one. **So you cannot fabricate a doorway from pure background code** (e.g. a
bare `setTimeout`/Effect timer) — you must be inside a handler *or* call the app
over HTTP via `eve/client`.

Session identity = **continuation token**. `send(msg, { continuationToken: chatId })`
(`channel/routes.d.ts`, `SendOptions`) starts-or-resumes the per-chat session.
`Runtime.deliver` (`types.d.ts:320`) pushes a follow-up into a *parked* session and
**coalesces** `message` + `context[]`. A channel can contribute
`context: string[]` (`routes.d.ts`, `SendPayload.context`) which eve appends as
`role:"user"` history before the delivery message and **persists** — a native way to
feed "the buffered window."

---

## 1. Context / memory / compaction  → replaces our `.slice(-30)`

- **`compaction` on `defineAgent`** (`shared/agent-definition.d.ts:95`,
  `PublicAgentCompactionDefinition`): `{ thresholdPercent?=0.9, model?, modelContextWindowTokens? }`.
  When the window fills past `thresholdPercent`, eve summarizes earlier turns
  automatically. **This is the durable, per-session memory we hand-rolled** in
  `voice.ts:96` (`histories` HashMap) and `voice.ts:221` (`.slice(-MAX_HISTORY)`).
- **`Session` / `SessionAuth` / `SessionTurn` / `SessionParent`** (`context/keys.d.ts:20-45`,
  re-exported from `eve/context`): the durable session record. `SessionAuth.current`
  (most recent caller) vs `.initiator` (creator) — the multi-tenant hook. `SessionParent`
  (`channel/types.d.ts:33`) is the subagent lineage (`rootSessionId`, `callId`).
- **`ctx.session`** inside tools/hooks (`SessionContext`, `public/definitions/callback-context.d.ts:13`):
  `{ id, auth, turn, parent }` + `getSandbox()` + `getSkill()`.
- **`defineState` / durable context keys** (`eve/context`: `getContext`/`setContext`/
  `ensureContext`, `context/accessors.d.ts`): per-session durable KV. `setContext`
  serializes at step end and survives future turns.

**Takeaway:** adopting Eve for the *agent* deletes our per-chat transcript bookkeeping
and gets summarization for free. It does **not** replace the Coalescer's *timing*.

---

## 2. Skills → we have zero today

- **`defineSkill({ description, markdown, license?, metadata?, files? })`**
  (`public/definitions/skill.d.ts`, `shared/skill-definition.d.ts`) — or just drop a
  markdown file under `agent/skills/<name>/`. Path-derived identity.
- **Runtime access** (`execution/skills/types.d.ts`): `ctx.getSkill(name): SkillHandle`;
  `SkillHandle.file(path): SkillFile`; `SkillFile.text()/bytes()`. Skill files live in
  the sandbox skills root.
- Dynamic skills: `defineDynamic` (`eve/skills`) resolves skills per-session/turn.
- **When to use vs subagent** (`subagents.mdx:118`): a skill = an optional procedure
  the same agent can pull in; a subagent = a different identity/tool-surface. For us:
  "how to write a good QA bug report", "GitHub triage playbook" are **skills**, not code.

---

## 3. Subagents  → replaces the hard-wired voice→worker `delegate` tool

- **Built-in `agent` tool** (`subagents.mdx:8`): every agent can delegate to a copy of
  itself; shares sandbox+tools; fan out by emitting several calls in one turn.
- **Declared subagent** = a folder `agent/subagents/<id>/` with its own `agent.ts`
  (`description` **required**), `instructions.md`, `tools/`, `skills/`, `sandbox/`
  (`subagents.mdx:26`). Eve **lowers it to a model-visible tool** named `<id>` with
  input `{ message, outputSchema? }` (`subagents.mdx:99`). **Our GitHub Worker becomes
  `agent/subagents/github/`; the voice's `delegate` tool disappears** — eve generates
  a `github` tool automatically.
- **`defineRemoteAgent({ url, description, auth?, outputSchema? })`**
  (`public/definitions/remote-agent.d.ts`): a subagent that is *another eve deployment*
  reached over HTTP. Same `{message, outputSchema?}` tool shape. This is the
  multi-agent / different-machine story.
- **`experimental.workflow` + `Workflow` tool** (`AgentWorkflowDefinition`,
  `agent-definition.d.ts:219`; `subagents.mdx:97`; `guides/dynamic-workflows`): the
  model orchestrates its subagents programmatically (fan-out/map-reduce), root-only,
  capped by `limits.maxSubagents` (default 100).
- **Limits** (`agent-definition.d.ts:121`): `maxSubagentDepth`=1, `maxSubagents`=100,
  `maxInputTokensPerSession`=40M, `maxOutputTokensPerSession`.
- **HITL caveat** (`channel/types.d.ts:178`, `SessionCapabilities.requestInput`):
  `ask_question`/tool-approval only work when the *channel that started the session*
  set `requestInput:true`. **Schedules do NOT set it** — a scheduled session cannot
  pause to ask a human. Directly relevant to "voice asks a clarifying question."

---

## 4. Channels  → the doorway surface + our WhatsApp ingress

- **`defineChannel({ routes, events, state?, context?, metadata?, fetchFile?, cors? })`**
  (`channels/custom.mdx`, `channel/routes.d.ts`, `channel/types.d.ts`). Lives at
  `agent/channels/<name>.ts`, root-only. `GET/POST/PUT/PATCH/DELETE/WS` route helpers.
- **`state` + `context(state, session)` + `events`**: a channel holds mutable adapter
  `state`, and `context()` can **close over `session` to register callbacks that re-key
  or act later** (`custom.mdx:218`, `session.setContinuationToken`). Event handlers
  (`message.completed`, `turn.started`, …) fire on session events and can mutate `state`.
- **Cross-channel `receive(channel, {message, target, auth})`** (`custom.mdx:118`,
  `cross-channel-receive.d.ts`): start a session on *another* channel from a handler.
- **Prebuilt channels** (package exports): `eve/channels/{slack,discord,telegram,github,
  linear,twilio,teams,chat-sdk,eve}` + `eve/channels/auth`. Each is a `defineChannel`
  value you configure and re-export (`docs/channels/*.mdx`).
- **whatsappd's own Eve adapter** (`whatsappd@0.2.1` → `whatsappd/adapters/eve`):
  exports `whatsappChannel()`, `createEventRoute`, `createEventHandlers`, `toUserContent`.
  **It goes through the HTTP sidecar → drops `mentions`/`quoted`** (the fields
  `addressesBot` needs — `events.ts:38`, `whatsapp.ts:8`). The **in-process**
  `createSession().onMessage` keeps full context and is what `src/coalescer/whatsapp.ts`
  binds to today. Any Eve-native path must not regress to the lossy sidecar.

---

## 5. Schedules  → a doorway on a clock (min 1-minute)

- **`defineSchedule({ cron, markdown | run })`** (`schedules.mdx`,
  `shared/schedule-definition.d.ts`). File under `agent/schedules/`, root-only.
- `cron` is a standard **5-field, minute-granularity** string — **no sub-minute**.
- `markdown` = fire-and-forget task mode (cannot park/ask a human). `run({receive,
  waitUntil, appAuth})` = full control, hands off to a channel via `receive`, and a
  handler-form session *can* park.
- **Documented "dynamic scheduling" pattern** (`patterns/dynamic-scheduling.md`): one
  `cron:"* * * * *"` dispatcher + an app store with an atomic `claimDue` lease + CRUD
  tools → application-managed schedules. Delivery is at-least-once.
- Dev trigger: `POST /eve/v1/dev/schedules/:id` (prod cron never fires in `eve dev`).
- **Hosting gotcha**: schedules fire under `eve start` (Nitro task runner) or Vercel
  Cron. A bare HTTP-only host won't run them.

---

## 6. Sandbox  → not on our critical path yet

- **`defineSandbox({ backend?, bootstrap?, onSession? })`** (`public/definitions/sandbox.d.ts`)
  at `agent/sandbox.ts`; backends `eve/sandbox/{docker,vercel,microsandbox,just-bash}`.
  `ctx.getSandbox(): SandboxSession` gives fs + `run()` in a tool. Relevant later for a
  code-runner Worker; **not needed** for the GitHub-API Worker (pure HTTP/octokit).

---

## 7. Models  → the "crap model" fix slots here

- **`experimental_chatgpt(model?)`** (`public/models/openai/index.d.ts`): local
  ChatGPT/Codex-subscription model, **now defaults to `gpt-5.6-sol`** (not nano!),
  no API key, **local-dev only** (reads `~/.codex` login; fails in deploy). This is
  the ONE Eve import we keep (`model.ts:19`, `agent/agent.ts:16`).
- `defineAgent.model` accepts an AI-Gateway id string (`"anthropic/claude-sonnet-5"`),
  any AI-SDK `LanguageModel`, or `defineDynamic({fallback, events})` for scoped model
  selection (`agent-definition.d.ts:249`). Gateway path needs a Vercel AI-Gateway key.
- Our `makeModel()` (`model.ts`) currently forces `gpt-5.4-nano` on the API-key path —
  **that's the dumb-model bug**, independent of Eve.

---

## 8. Setup / scaffold / CLI  → workstream D is mostly already built by Eve

- **CLI** (`reference/cli.md`): `eve init`, `eve dev` (TUI), `eve build`, `eve start`,
  `eve deploy`, `eve info`, `eve channels add [slack|web]`, `eve eval`,
  `eve extension {init,build}`. `npx eve@… init` scaffolds; `eve dev` = the interactive
  REPL/TUI we hand-rolled as `live.ts`/`repl.ts`.
- **Programmatic `eve/setup`** (`setup/index.d.ts`): clack-style `createPrompter`,
  `runInteractive`/`runHeadless`, `composeOnboardingBoxes` (name/model/channel/connection
  onboarding), Vercel provisioning + AI-Gateway key pull.
- **`eve/setup/scaffold`** (`setup/scaffold/index.d.ts`): `scaffoldBaseProject`,
  `ensureChannel`, `ensureConnection`, `SCAFFOLDABLE_CHANNELS`, connection catalog.
- **Bias**: this toolkit is **Vercel-deployment-centric** (AI-Gateway, `vercel link`).
  For a VPS/NPX **local daemon** the reusable bits are the prompter + scaffold; the
  Vercel provisioning is not what we want. Don't hand-roll clack; do skip the Vercel path.

---

## 9. One-line "keep vs delete vs gain" if we adopt Eve for the agent

| Hand-rolled today | Under Eve |
|---|---|
| `voice.ts` per-chat `histories` + `.slice(-30)` | **DELETE** → `compaction` + durable session |
| `voice.ts` `delegate` tool → `worker.ts` | **DELETE** → declared subagent `agent/subagents/github/` (auto tool) |
| `worker.ts` `adapt()` of 13 tools via `streamText` | **DELETE** → tools run natively under the Eve runtime |
| SPEECH_CONTRACT / reply-tool hack (`voice.ts:49`) | **DELETE** → eve channels deliver assistant text directly |
| `model.ts` `makeModel()` | **KEEP** (thin) — `experimental_chatgpt` is the no-key transport |
| `agent/` tools + `instructions.md` | **KEEP unchanged** — reused natively, not via `adapt()` |
| Coalescer `coalescer.ts`/`buffer.ts` debounce+cap+relevance | **KEEP** — genuinely novel; no Eve equivalent (schedules are min-granularity) |
| `whatsapp.ts` in-process session (full mention context) | **KEEP** — must not regress to the lossy sidecar |
| skills | **GAIN** — zero today |
| CLI/onboarding (`live.ts`) | **GAIN** — `eve dev` + `eve/setup` (minus Vercel) |

The **only** thing with no clean Eve home is the Coalescer's sub-minute
debounce/cap/relevance timing driven from a background timer. That is the doorway
problem, and the subject of the options doc / ask-matt.
