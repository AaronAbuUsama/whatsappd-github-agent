# Flue conversation state: compaction, context, and durable resume

Research for Wayfinder ticket #287, against the versions installed in this repository on
2026-07-22. It informs the stateful/stateless decision in #286; this is a runtime-behavior
report, not an implementation proposal.

## Executive conclusion

`dispatch(agent, { id, input })` is a durable admission into the default session of the
agent instance named by `(agent, id)`. Reusing one stable `id` therefore continues one
canonical conversation. Flue owns that conversation's append-only record stream, ordered
submission queue, model-visible compaction, and conservative crash recovery. It does **not**
own the application's ingress truth, Window identity, up-inbox/coalescing policy, external
side-effect idempotency, Brain clocks, or durable business state.

A single permanent global Brain conversation is technically supported: use one discovered
Brain agent and one stable global instance id. It is not sufficient as the Brain's whole
memory or scheduler. The safe architecture is one Flue conversation for working continuity,
plus an application-owned durable up-inbox, Graph, Conversation Archive, work ledger, and
wake schedule. The canonical Flue log grows forever and is replayed from offset zero on
reconstruction; compaction shrinks the **model projection**, not the stored log. A single
default session is also a single ordered/serial work lane.

## Evidence baseline and installed versions

The root lockfile resolves `@flue/runtime` to `1.0.0-beta.9` and
`@earendil-works/pi-agent-core` to `0.80.6`. The installed graph contains two Pi model-package
versions: Flue's direct `@earendil-works/pi-ai` dependency is `0.80.2`, while agent-core's
dependency resolves to `0.80.6` (`pnpm-lock.yaml:29-40`, `pnpm-lock.yaml:4586-4588`,
`pnpm-lock.yaml:4875-4878`). Flue imports `Agent` from agent-core but imports `streamSimple`
and its compaction helpers from the direct Pi package
(`/Users/abuusama/projects/ambient-agent/node_modules/@flue/runtime/dist/conversation-stream-store-Bitz7UoW.mjs:9-10`,
`/Users/abuusama/projects/ambient-agent/node_modules/@flue/runtime/dist/conversation-projections-XMug3C6A.mjs:1-6`).
The installed package manifests independently report the same versions and provenance:

- `/Users/abuusama/projects/ambient-agent/node_modules/@flue/runtime/package.json:2-10,68-70`
- `/Users/abuusama/projects/ambient-agent/node_modules/@earendil-works/pi-agent-core/package.json:2-12,31-49`
- `/Users/abuusama/projects/ambient-agent/node_modules/@earendil-works/pi-ai/package.json:2-16,77-82`

All findings below are about those exact installed artifacts. “Proven” means the behavior is
stated in installed first-party docs/types or traced in the installed executable source.
“Inference” is called out explicitly.

## 1. Automatic compaction exists

### Trigger and policy (proven)

Threshold compaction is enabled by default. After a successful assistant turn, Flue reads
that assistant response's provider usage and compacts when:

```text
used context tokens > model.contextWindow - reserveTokens
```

The exact check is in
`/Users/abuusama/projects/ambient-agent/node_modules/@flue/runtime/dist/conversation-stream-store-Bitz7UoW.mjs:2412-2422`,
calling the predicate defined at
`/Users/abuusama/projects/ambient-agent/node_modules/@flue/runtime/dist/conversation-projections-XMug3C6A.mjs:1959-1962`.
The threshold is checked only after a non-error, non-aborted assistant turn. A provider
context-overflow response instead enters overflow recovery: Flue rebuilds canonical context,
compacts, and retries the model once; a second overflow is not retried
(`/Users/abuusama/projects/ambient-agent/node_modules/@flue/runtime/dist/conversation-stream-store-Bitz7UoW.mjs:2325-2361`).

Defaults are model-aware:

- `keepRecentTokens = 8_000`.
- `reserveTokens` starts at `min(20_000, model.maxTokens)` (or 20,000 when output metadata
  is absent).
- If that reserve would consume at least half of a known context window, it becomes
  `max(1_024, floor(contextWindow / 3))`.

Source:
`/Users/abuusama/projects/ambient-agent/node_modules/@flue/runtime/dist/conversation-projections-XMug3C6A.mjs:1867-1894`.

The cut is chosen backwards from the newest message until the estimated retained tail reaches
`keepRecentTokens`. Valid boundaries are user or assistant messages, never a tool-result row.
When a boundary splits a turn, Flue separately summarizes the turn prefix so the kept suffix
remains intelligible
(`/Users/abuusama/projects/ambient-agent/node_modules/@flue/runtime/dist/conversation-projections-XMug3C6A.mjs:2127-2197`).
For summary input only, textual tool results are clipped to 2,000 characters; this does not
rewrite the canonical tool-result record
(`/Users/abuusama/projects/ambient-agent/node_modules/@flue/runtime/dist/conversation-projections-XMug3C6A.mjs:2008-2040`).

Compaction normally costs one extra model call. A split-turn compaction can make two calls in
parallel (history summary and turn-prefix summary). The normal summary output limit is
`min(0.8 * reserveTokens, 16_000)`; the prefix limit is
`min(0.5 * reserveTokens, 16_000)`
(`/Users/abuusama/projects/ambient-agent/node_modules/@flue/runtime/dist/conversation-projections-XMug3C6A.mjs:2199-2241,2242-2280,2281-2313`).
The resulting summary, cut point, file-operation details, and summarization usage are appended
as a canonical `compaction` record, then context is rebuilt
(`/Users/abuusama/projects/ambient-agent/node_modules/@flue/runtime/dist/conversation-stream-store-Bitz7UoW.mjs:2431-2535`).

### Configuration (proven)

`AgentProfile.compaction` and `AgentRuntimeConfig.compaction` accept:

```ts
false | {
  reserveTokens?: number;
  keepRecentTokens?: number;
  model?: string;
}
```

The installed types describe each field at
`/Users/abuusama/projects/ambient-agent/node_modules/@flue/runtime/dist/types-USSZhfC6.d.mts:246-272`.
`false` disables only threshold compaction. It does **not** disable overflow recovery or an
explicit `session.compact()` call
(`/Users/abuusama/projects/ambient-agent/node_modules/@flue/runtime/dist/types-USSZhfC6.d.mts:311-316,339-343,512-526`).
An optional `model` changes the summarizer but not the primary session model; unspecified
numeric fields inherit model-aware defaults
(`/Users/abuusama/projects/ambient-agent/node_modules/@flue/runtime/dist/conversation-stream-store-Bitz7UoW.mjs:1076-1091,2437-2441`).

## 2. Context assembled for each model call

### Before the first compaction (proven)

Flue reconstructs the active conversation by walking the canonical entry graph from its active
leaf to the beginning, reversing that path, and projecting it into model messages
(`/Users/abuusama/projects/ambient-agent/node_modules/@flue/runtime/dist/conversation-projections-XMug3C6A.mjs:1514-1533`).
There is no token-window truncation step in this projection. With no compaction record, the
entire valid active path is projected.

Projection preserves user messages, assistant messages, signals (rendered as user-context
messages), and complete assistant-tool-call/tool-result batches. Failed or aborted assistant
messages are normally omitted. An assistant tool-call message is included only when its full
result batch is present; orphan tool-result messages are not independently sent
(`/Users/abuusama/projects/ambient-agent/node_modules/@flue/runtime/dist/conversation-projections-XMug3C6A.mjs:1555-1622`).

The Session rebuild replaces Pi's in-memory message list with that canonical projection
(`/Users/abuusama/projects/ambient-agent/node_modules/@flue/runtime/dist/conversation-stream-store-Bitz7UoW.mjs:2299-2307`).
Flue constructs Pi's `Agent` without a `transformContext` callback
(`/Users/abuusama/projects/ambient-agent/node_modules/@flue/runtime/dist/conversation-stream-store-Bitz7UoW.mjs:684-718`).
Pi therefore passes the complete `context.messages` list through `convertToLlm` and into the
provider request on every assistant turn; Pi only has a reduction/window hook when a caller
supplies `transformContext`
(`/Users/abuusama/projects/ambient-agent/node_modules/@earendil-works/pi-agent-core/dist/agent-loop.js:173-198`).

### After compaction (proven)

The stored pre-compaction records remain. The model projection changes to:

1. one user-context message containing the latest compaction summary;
2. the unsummarized messages from `firstKeptEntryId` up to that compaction record; and
3. every valid message after the compaction record.

This exact assembly is at
`/Users/abuusama/projects/ambient-agent/node_modules/@flue/runtime/dist/conversation-projections-XMug3C6A.mjs:1530-1550`.
On later compactions, the prior summary is passed to the summarizer and updated with only the
new older segment
(`/Users/abuusama/projects/ambient-agent/node_modules/@flue/runtime/dist/conversation-projections-XMug3C6A.mjs:2171-2197,2199-2204`).

There is therefore no independent “last N turns” or sliding window. Context is full valid
replay until a compaction exists, then latest summary plus an unsummarized tail plus everything
new. The canonical persisted log itself is never shortened: installed Flue docs explicitly say
reconstruction replays the stream from its beginning and persisted-log compaction/replay
acceleration are deferred
(`/Users/abuusama/projects/ambient-agent/node_modules/@flue/runtime/docs/api/data-persistence-api.md:89-93`).

## 3. `dispatch(agent, { id })` persistence and resume

### Identity and keys (proven)

Public `dispatch()` validates and JSON-clones the input, then generates a fresh random
`dispatchId` and timestamp before queue admission
(`/Users/abuusama/projects/ambient-agent/node_modules/@flue/runtime/dist/flue-app-DweeRG3g.mjs:7-24,856-879`).
The canonical stream path is `agents/${agentName}/${instanceId}`
(`/Users/abuusama/projects/ambient-agent/node_modules/@flue/runtime/dist/conversation-projections-XMug3C6A.mjs:362-364`).
All external direct and dispatch submissions target harness `default`, session `default`; the
session storage key is:

```text
agent-session:[<id>,"default","default"]
```

Source:
`/Users/abuusama/projects/ambient-agent/node_modules/@flue/runtime/dist/run-store-CYeXjR-d.mjs:23-70,85-110`.
Thus `agent` separates canonical streams, `id` selects the continuing agent instance, and all
`dispatch()` calls for that instance feed one default conversation/session.

### Database and schema in this application (proven)

This repository configures Flue's Node `sqlite()` adapter with the managed
`flue.sqlite` file (`apps/runtime/src/db.ts:1-7`; `packages/installation/src/paths.ts:83-105`).
The adapter opens file-backed SQLite in WAL mode and wires the SQL execution, run, event,
conversation, and attachment stores
(`/Users/abuusama/projects/ambient-agent/node_modules/@flue/runtime/dist/node/index.mjs:51-75,91-122`).

The dispatch queue is principally stored in `flue_agent_submissions`, keyed by unique
`submission_id` (the dispatch id), with `session_key`, kind, JSON payload, status, admission and
canonical-readiness timestamps, attempt/lease/recovery/timeout fields, and terminal settlement
fields. Its exact DDL and indexes are at
`/Users/abuusama/projects/ambient-agent/node_modules/@flue/runtime/dist/sql-run-store-DRLffFXh.mjs:422-459`.
Conversation history lives separately in `flue_conversation_streams` (primary key `path`) and
ordered `flue_conversation_stream_batches` (primary key `(path, seq)`, with producer fencing and
submission/attempt ownership columns)
(`/Users/abuusama/projects/ambient-agent/node_modules/@flue/runtime/dist/conversation-stream-store-Bitz7UoW.mjs:3495-3518`).

### Admission, ordering, and transaction behavior (proven)

SQL admission derives the default-session key and, in one SQLite transaction, inserts the
queued submission with `INSERT OR IGNORE`, reloads it, rejects mismatched kind/payload as a
conflict, and returns the existing identical row for an exact replay
(`/Users/abuusama/projects/ambient-agent/node_modules/@flue/runtime/dist/sql-run-store-DRLffFXh.mjs:306-345`).
The Node transaction wrapper is an explicit `BEGIN` / `COMMIT`, rolling back on error
(`/Users/abuusama/projects/ambient-agent/node_modules/@flue/runtime/dist/node/index.mjs:50-65`).

Admission then materializes the canonical default conversation if needed and marks the
submission `canonical_ready`. Only a canonical-ready queued row is runnable. For a given
`session_key`, a row is runnable only if no earlier queued/running/terminalizing row exists;
claims atomically transition the head row to running
(`/Users/abuusama/projects/ambient-agent/node_modules/@flue/runtime/dist/sql-run-store-DRLffFXh.mjs:143-175,226-240`).
The coordinator builds one writer per `agents/<agent>/<id>` stream and processes claimed work
asynchronously; later work for the same session becomes runnable after settlement
(`/Users/abuusama/projects/ambient-agent/node_modules/@flue/runtime/dist/internal.mjs:1343-1365,1398-1459`).

The submission admission transaction and the subsequent canonical materialization/readiness
write are intentionally separate. Flue reconciles queued rows missing canonical readiness on
its claim passes. Canonical appends themselves are fenced and transactional: a stale producer
or stale submission attempt cannot append, and a retry of the same producer sequence must
carry identical bytes and ownership
(`/Users/abuusama/projects/ambient-agent/node_modules/@flue/runtime/dist/conversation-stream-store-Bitz7UoW.mjs:3685-3744,3798-3811`).

### Crash/restart resume (proven)

Because this application uses file-backed `flue.sqlite`, accepted submissions and canonical
conversation batches survive a process restart. The Node coordinator starts a persistent claim
loop, periodically scans expired leases, claims the next runnable head, and renews active leases
(`/Users/abuusama/projects/ambient-agent/node_modules/@flue/runtime/dist/internal.mjs:1269-1276,1437-1523`).
The installed durability contract is conservative:

- completed canonical output is reconstructed without another provider call;
- durable partial text/reasoning can be marked interrupted and continued;
- already-recorded tool results are reused;
- an unresolved tool call gets an explicit unknown-outcome result and is not blindly rerun;
- work with no durable input application can be requeued; and
- attempts/timeouts are bounded (defaults: ten total attempts and one hour).

The recovery decision tree is implemented at
`/Users/abuusama/projects/ambient-agent/node_modules/@flue/runtime/dist/conversation-stream-store-Bitz7UoW.mjs:3110-3197`;
partial stream and tool-batch handling at the same file's `1326-1403` and `1146-1163`; defaults
at `2781-2785`. The first-party durability guide summarizes the same guarantees and calls out
at-least-once provider execution when nothing was persisted, external-effect idempotency, and
Node's one-live-owner constraint
(`/Users/abuusama/projects/ambient-agent/node_modules/@flue/runtime/docs/concepts/durable-execution.md:37-57`).

## 4. Boundary versus Managed Chat Inbox and Window dispatch

These are two independent durability domains in two SQLite files.

The application owns immutable Conversation Events, lossless per-chat Window membership, and
the `managed_chat_admissions` ledger in `application.sqlite`. Creating a Window atomically
creates its `pending` admission and assigns the oldest accepted events
(`packages/engine/src/intake/managed-chat-inbox.ts:424-491`). The ledger can move from pending
to `done` only with a Flue receipt, or to terminal `failed`
(`packages/engine/src/intake/managed-chat-inbox.ts:505-530`). The domain definition is explicit:
accepted events stay pending until their Window is admitted and its receipt is recorded
(`CONTEXT.md:78-87`).

The seam is `dispatch(speaker, { id: window.chatId, input: whatsappWindowInput(window) })`:
the chat id selects the continuing Speaker instance, while the Window payload becomes one Flue
dispatch input (`packages/agents/src/speaker/dispatch.ts:27-35,38-54`). `admitWindow` retries
that call up to three times, records `done` only after a receipt, and deliberately leaves the
Window pending if the done-write is lost so startup will dispatch it again
(`packages/engine/src/intake/admission-relay.ts:11-20,22-74`).

Consequences:

- **Application at-least-once is outside Flue.** Each public retry generates a new random
  `dispatchId`; Flue's exact-replay/idempotent admission applies to a particular dispatch id,
  which this API does not let the application supply. A lost receipt followed by application
  retry can therefore create duplicate Flue inputs. The stable application dedupe identity is
  the Window id inside the payload, and any duplicate-sensitive Brain effect must check an
  application-owned ledger.
- **No cross-database atomic commit exists.** Flue admission commits to `flue.sqlite`; the
  application then records the receipt in `application.sqlite`. The intentional failure mode is
  “duplicate wake,” not lost chat truth.
- **Flue owns processing after acceptance, not chat intake.** Flue orders and resumes the
  default session once it has accepted a dispatch. It does not know which Conversation Events
  are accepted, how they coalesce into a Window, or whether a Window was already semantically
  processed.

## 5. Is one permanent global Brain conversation viable?

### Yes, as working continuity

Use one Brain agent definition and one stable global `id`. Every dispatch then targets
`agents/<brain-agent>/<global-id>` and the default session, producing one durable conversation.
This directly fits the canonical design's “single global mind” and single up-inbox
(`docs/SYSTEM-ARCHITECTURE.md:127-147`). It also corrects a useful #286 vocabulary point:
“stateful” is a runtime fact about a stable Flue instance/session, not authority over durable
domain truth. Today's per-chat Speaker is stateful working context because dispatch uses
`window.chatId`; it still must not own cross-surface durable meaning
(`docs/SYSTEM-ARCHITECTURE.md:149-164`).

### Concrete ceilings and failure modes

1. **One serial lane.** All external Brain submissions use one default session and are admitted
   in order. A long model/tool turn head-of-line blocks later Brain inputs. Parallel bounded work
   must remain separate workflows/subagents; the up-inbox may coalesce wakes but cannot assume
   parallel Brain turns.
2. **Unbounded persisted log and startup replay.** Sessions are append-only for the agent
   instance lifetime, with no per-session deletion. Canonical reconstruction replays from the
   beginning; persisted-log compaction and replay acceleration are deferred
   (`/Users/abuusama/projects/ambient-agent/node_modules/@flue/runtime/docs/api/data-persistence-api.md:63-67,89-93`).
   This is a concrete long-lived-instance storage/startup ceiling even though model context is
   compacted.
3. **Lossy model memory.** Old verbatim turns become an LLM-generated summary. Repeated summary
   updates can omit or distort details; summary failure can make threshold compaction a no-op,
   and overflow recovery retries only once. Therefore the conversation cannot be the source of
   truth for commitments, work state, identity, provenance, or schedules.
4. **Context/cost ceiling.** Before first compaction the full active path is sent. Afterward the
   summary plus retained/new tail is sent. Every Brain call pays for that projection, and
   compaction adds one or two LLM calls. Large single turns/tool outputs can still overflow or
   force split-turn summarization.
5. **One live Node owner.** File-backed SQLite survives restart on the same host but not host
   loss. Even with shared durable storage, active-active ownership of one instance is unsafe
   (`/Users/abuusama/projects/ambient-agent/node_modules/@flue/runtime/docs/concepts/durable-execution.md:43-57`).
6. **Unknown external effects remain unknown.** Flue intentionally does not repeat a tool call
   whose durable result is absent. The application must reconcile external operation identity
   and decide what happened; the domain already defines this as application-owned Operation
   Identity (`CONTEXT.md:157-162`).
7. **A conversation is not a clock or inbox query model.** Flue resumes accepted work, but it
   does not implement the Brain's cron floor, event-threshold wakes, self-scheduled durable
   timers, coalescing/admission policy, or “what is still open?” queries. Those are explicit
   architecture responsibilities (`docs/SYSTEM-ARCHITECTURE.md:365-393`).

### What the application must own

For the global Brain, the application must durably own:

- up-inbox item identity, payload/provenance, pending/claimed/settled status, and semantic
  idempotency;
- coalescing and priority/admission policy;
- cron floor, event wakes, self-scheduled wakes, and boot reconciliation;
- Conversation Archive and Graph truth/projection;
- work/delegation lifecycle and external Operation Identity; and
- retention/rotation policy if the permanent Flue instance eventually exceeds acceptable
  replay/storage or summary-quality ceilings.

Flue dispatch should be treated as an at-least-once **wake carrying a durable item reference**,
not as the up-inbox itself. The Brain should read/fold the application-owned pending items,
decide, and settle them transactionally in the application database. This keeps a duplicate
dispatch harmless and makes a future Brain-conversation rotation possible without losing work.

## 6. Ownership table

| Concern | Flue owns (proven) | Application owns | Unknown / unproven |
|---|---|---|---|
| Agent continuity | Canonical stream keyed by `agents/<agent>/<id>`; default durable session | Choosing stable ids and actor cardinality | Supported practical lifetime of one ever-growing instance |
| Model context | Canonical projection; complete valid replay; latest compaction summary + verbatim tail | Domain facts supplied/read through tools and inputs | Summary fidelity across years of repeated compaction |
| Compaction | Threshold, overflow, manual compaction; summary record and usage | Whether to tune/disable; retention/rotation above Flue | No persisted-log compaction/replay acceleration in beta.9 |
| Dispatch queue | Per-session ordered SQL admission, claim, attempts, leases, settlement, restart recovery | Durable upstream item/Window and semantic dedupe | Public API for caller-selected dispatch id (not present in installed types/code) |
| Tool recovery | Reuse durable results; continue safe partial text; mark unknown outcomes | External-effect idempotency and provider reconciliation | Exact outcome of a tool whose call escaped before durable result |
| Chat intake | Nothing before `dispatch()` acceptance | Conversation Archive, Managed Chat Inbox, Window, receipt ledger | Cross-database atomicity (not provided) |
| Brain control loop | Executes a turn after an admitted wake | Up-inbox, coalescing, Graph, work ledger, routing, clocks, boot sweep | Final policy for Brain queue schema and rotation |
| Availability | Same-host restart with file SQLite; coordinator lease recovery | Host durability/backup and single-owner routing | Active-active same-instance safety (explicitly unsupported) |

## Architecture implications for #286

1. Classify an actor as **stateful** when invocations intentionally reuse a stable Flue
   `(agent, id)` and therefore one default conversation. Classify a unit as **stateless/finite**
   when it gets a fresh run/task identity and durable results are returned to an owning actor.
   Authority and durable domain ownership are separate axes.
2. The Speaker is runtime-stateful per Surface/chat today; “holds only transient
   conversational state” should be read as “its Flue working memory is not authoritative
   cross-surface truth,” not “cold model call.”
3. The Brain should be runtime-stateful with one global id, but its up-inbox, Graph, work ledger,
   and clocks must be application state. Ticket #286 should not equate “one persistent Brain
   conversation” with “the conversation owns all Brain state.”
4. The global Scribe decision should use the same test: if it needs an evolving private
   working monologue, one stable id is viable; if each batch is fully determined by Archive +
   Graph + batch input, a finite/stateless operation avoids another growing summary stream.
   Flue does not answer that product decision.
5. No new conversation-state subsystem is needed for the first Brain slice. Reuse Flue's
   installed durable conversation and build only the application-owned up-inbox/clock seam that
   §13 says is missing (`docs/SYSTEM-ARCHITECTURE.md:574-586,588-595`).

## Unresolved / not proven

- No benchmark in the installed package establishes acceptable replay time or database size for
  a multi-year single instance.
- No guarantee quantifies summary fidelity or bounds cumulative summary drift.
- The installed public dispatch API always generates its own id; no supported caller-supplied
  dispatch/idempotency key was found.
- Node host-loss durability is not provided by this repository's file-backed SQLite setup.
- The final Brain up-inbox schema, coalescing rules, wake priorities, and conversation-rotation
  policy remain application design work; Flue's harness does not define them.
