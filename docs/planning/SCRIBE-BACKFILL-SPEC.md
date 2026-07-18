# Scribe backfill — ratified implementation spec (#175)

**Status:** ratified on 2026-07-18; ready for an implementation session
**Source:** [GitHub issue #175](https://github.com/AaronAbuUsama/ambient-agent/issues/175)
**Scope:** design only. This document contains no product implementation.

## 1. Outcome

When a WhatsApp chat becomes managed, Ambient Agent starts a background Scribe
workflow that reads the chat's existing Conversation Archive and builds its shared
graph history. The Speaker remains live throughout. The workflow processes bounded
archive windows sequentially on one persistent Scribe conversation, checkpoints each
successful window, catches up with traffic that arrived while it was working, and
atomically hands the chat to the ordinary live Scribe coalescer.

The same product path covers:

- the chat selected during first-run setup;
- a chat added later through Settings or configuration management; and
- recovery of a workflow interrupted by a process restart.

A thin CLI entry may exercise or retry this path for development and operations, but
the CLI is not the product trigger.

## 2. Ratified boundaries

### In scope

- Automatic background admission when a chat becomes managed.
- One active backfill per chat.
- Provider-online eligibility, archive-backed processing, durable checkpoints, and a
  race-free catch-up-to-live transition.
- Chronological processing of the initial archive snapshot followed by insertion-order
  processing of messages that arrive during catch-up.
- Fixed windows of at most 50 archive events.
- One persistent Scribe session for every window in a run.
- Shared-store enforcement of the already-ratified exact-phrase convergence rule for
  keyless graph entities.
- Structured `ctx.log` progress events.
- Retry, crash recovery, managed-chat removal, and explicit retry after terminal
  failure.
- Raising the Scribe role's reasoning effort from `minimal` to `medium`; live and
  historical extraction continue to share one role configuration.

### Out of scope

- No Speaker pause and no replay through the Speaker.
- No second backfill-specific ontology or graph-writing path.
- No confidence-decrease semantics. Existing confidence accumulation remains intact.
- No destructive graph reset or deletion-by-provenance command.
- No multi-source provenance redesign.
- No semantic time-gap or token-budget windowing until real runs demonstrate a need.
- No bulk "all chats" command; reconciliation admits chats independently.
- No keyless-entity consolidation pass beyond exact-phrase convergence.
- No real or private WhatsApp transcript committed as a test fixture.
- The `SCRIBE_FIXTURE_READY` eval battery remains deferred until real backfill output
  has been inspected and the right eval corpus and assertions are understood.

The last item deliberately supersedes the original issue's fixture-unskip Definition
of Done. Implementation must produce inspectable real-run output first; fixture and
eval calibration should become a follow-up ticket after that evidence exists.

## 3. Existing foundation

### 3.1 Archive precedes agent delivery

`packages/installation/src/whatsapp-account.ts:154-170` archives both history-sync
messages and live messages before notifying subscribers. The managed inbox wraps this
in the archive transaction at
`packages/engine/src/intake/managed-chat-inbox.ts:366-378`.

This gives backfill one durable source of truth. It does not need a second message
buffer.

### 3.2 Provider sync eligibility

whatsappd emits history as one or more `conversationSync` batches. Its internal
`conversation_sync_complete` transition makes the session `online`; the installed
documentation states that an authenticated device becomes online only after history
sync settles.

The current local `waitForInitialSync()` in
`packages/installation/src/whatsapp-account.ts:196-225` resolves after the first batch,
not after the complete sync. It must not be used as the backfill completion boundary.

The product rule is:

```text
provider online      => the selected chat is eligible for backfill admission
archive tail reached => backfill is complete and live Scribe may resume
```

### 3.3 Live Scribe seam

All Speaker inputs converge at
`packages/agents/src/speaker/dispatch.ts:21-29`. The current funnel dispatches the
Speaker, records its receipt, then offers the original input to the detached Scribe
coalescer.

Backfill adds a WhatsApp-only gate around that final Scribe offer:

```ts
const receipt = await dispatch(speaker, { id, input: enriched });
speakerActivity.accepted(receipt, enriched);

if (!isWhatsAppInput(input) || scribeBackfill.allowsLive(input.chatId)) {
  scribeCoalescer.offer({ id, input });
}

return receipt;
```

The Speaker path is unchanged. GitHub and specialist-result inputs are unchanged.
Only WhatsApp inputs for chats in `catching_up` or `failed` are withheld from the live
Scribe coalescer; those inputs are already in the archive and will be consumed by the
backfill cursor.

### 3.4 Scribe role and Flue session

`packages/agents/src/scribe/agent.ts:13-25` already mounts the graph-extraction skill
and the four graph tools. The workflow reuses that agent definition and changes its
role-wide `thinkingLevel` from `minimal` to `medium`.

`FlueHarness.session(name)` returns one persisted named conversation. The workflow
creates one session and awaits one prompt per archive window:

```ts
const session = await harness.session("scribe-backfill");

for (;;) {
  const window = await nextWindow();
  if (window === undefined) break;
  await session.prompt(renderScribeBatch(window));
  checkpoint(window);
}
```

The session preserves prior conversation and tool results across windows. Flue's
model-aware automatic compaction handles long histories; #175 adds no parallel summary
mechanism.

## 4. Product admission and reconciliation

### 4.1 One reconciliation seam

First-run and Settings/configuration do not directly own workflow behavior. After a
managed-chat set is promoted, and again when the runtime boots, one reconciliation
function compares managed chats with durable Scribe state:

```ts
reconcileScribeBackfills({ managedChats, state, invoke });
```

For each managed chat:

- no state row: atomically create `catching_up` and admit one workflow;
- `catching_up` with no surviving process after boot: admit one replacement run from
  the stored cursor;
- `live`: no-op;
- `failed`: remain failed until an explicit retry;
- `disabled`: transition back to `catching_up` and resume from its cursor.

For each state row whose chat is no longer managed, transition to `disabled` at the
next window boundary. Do not delete its graph or cursor.

### 4.2 Admission is detached

The caller receives the workflow admission/run identity and does not await the
backfill:

```ts
type StartScribeBackfillResult =
  | { admitted: true; runId: string }
  | {
      admitted: false;
      reason: "already-catching-up" | "already-live" | "failed";
    };
```

The uniqueness boundary is the chat's durable state row, not an in-memory mutex.
Concurrent reconciliation attempts must not create two runs.

### 4.3 CLI boundary

A thin CLI command may call the same reconciliation/retry service for development and
operator proof. It must not contain a second implementation of pagination, graph
extraction, or state transitions.

## 5. Durable state

Store one row per chat in the existing application SQLite database:

```sql
CREATE TABLE scribe_backfills (
  chat_id TEXT PRIMARY KEY,
  mode TEXT NOT NULL
    CHECK (mode IN ('catching_up', 'live', 'failed', 'disabled')),
  phase TEXT NOT NULL
    CHECK (phase IN ('snapshot', 'tail')),
  snapshot_high_water INTEGER,
  snapshot_unknown_time INTEGER,
  snapshot_occurred_at_ms INTEGER,
  snapshot_event_id TEXT,
  after_sequence INTEGER NOT NULL DEFAULT 0,
  run_id TEXT,
  last_error TEXT,
  updated_at_ms INTEGER NOT NULL
);
```

The exact column names are implementation detail, but the stored information is not:

- mode;
- initial snapshot high-water sequence;
- resumable chronological snapshot cursor;
- resumable insertion-order tail cursor;
- most recent workflow run ID;
- terminal error summary suitable for an operator surface.

Do not create a second run ledger. Flue owns workflow run records and run events;
`scribe_backfills` owns the product state needed to gate Scribe and resume the chat.

## 6. Ordering and pagination

### 6.1 Initial snapshot

After provider-online eligibility and admission, capture the chat's archive high-water
sequence. Read only events at or below that sequence, ordered chronologically:

```sql
SELECT rowid AS archive_sequence, *
  FROM conversation_events
 WHERE chat_id = :chat_id
   AND rowid <= :snapshot_high_water
   AND (
     CASE WHEN occurred_at_ms = 0 THEN 1 ELSE 0 END,
     occurred_at_ms,
     event_id
   ) > (
     :snapshot_unknown_time,
     :snapshot_occurred_at_ms,
     :snapshot_event_id
   )
 ORDER BY
   CASE WHEN occurred_at_ms = 0 THEN 1 ELSE 0 END,
   occurred_at_ms,
   event_id
 LIMIT 50;
```

Treat unknown timestamps as a deterministic final bucket. The tuple cursor makes the
snapshot resumable without assuming that the provider delivered history batches in
conversation order.

### 6.2 Tail

After the snapshot is complete, set `after_sequence = snapshot_high_water` and consume
new events in archive insertion order:

```sql
SELECT rowid AS archive_sequence, *
  FROM conversation_events
 WHERE chat_id = :chat_id
   AND rowid > :after_sequence
 ORDER BY rowid
 LIMIT 50;
```

Tail traffic is live arrival order. This cursor cannot skip a late write merely
because its provider timestamp is old.

### 6.3 Window shape

Each page contains at most 50 archive events. Decode arrivals and updates into the
existing `ConversationWindow` shape, then present the existing Scribe vocabulary:

```ts
scribeBatchInput([
  whatsappWindowInput({
    id: stableWindowId(chatId, cursor),
    chatId,
    messages,
    updates,
    reason: "capacity",
  }),
]);
```

The implementation may add an internal backfill reason if the existing reason union
cannot represent the window honestly, but it must not invent a second extraction
input language.

No overlap is added between adjacent windows. The persistent Scribe session supplies
cross-window context.

## 7. Per-window transaction semantics

For every window:

1. Check that the chat remains managed.
2. Emit `scribe_backfill.window.started`.
3. Await the Scribe prompt on the one persistent session.
4. When the prompt resolves successfully, advance the appropriate cursor.
5. Emit `scribe_backfill.window.completed`.

Cursor advancement happens only after the model turn and its graph tool calls finish.
If the process dies after graph writes but before checkpointing, the same window may
run again. Section 8 makes that replay convergent.

## 8. Idempotency

### 8.1 Existing convergence retained

- People, agents, threads, and GitHub objects converge on existing natural identities.
- Relations converge on `(fromId, relation, toId)`.
- Existing noisy-OR confidence accumulation remains unchanged.

### 8.2 Enforce existing exact-phrase keyless convergence

The graph-extraction skill already says that keyless entities reuse an existing node
only for the same exact phrasing. Enforce that policy in the shared GraphStore rather
than trusting every caller to look up and supply the ID:

```text
topic      => exact label
commitment => exact description
goal       => exact description
```

When an upsert supplies no explicit ID and an exact-phrase node exists, update that
node and combine confidence. Different phrasing remains a distinct low-confidence
node; #175 does not add fuzzy consolidation.

This shared enforcement covers both live Scribe and backfill and makes a replayed
partial window mechanically convergent.

### 8.3 Completed reruns

Reconciliation of a chat already in `live` is a no-op. Explicit retry resumes from its
stored cursor. No destructive reset path is part of the product or CLI surface.

## 9. Catch-up-to-live handoff

When a tail query returns no events, perform the final check and state transition in
one immediate SQLite transaction:

```sql
BEGIN IMMEDIATE;

SELECT rowid
  FROM conversation_events
 WHERE chat_id = :chat_id
   AND rowid > :after_sequence
 ORDER BY rowid
 LIMIT 1;

-- Only if the query returned no row:
UPDATE scribe_backfills
   SET mode = 'live', run_id = NULL, last_error = NULL, updated_at_ms = :now
 WHERE chat_id = :chat_id
   AND mode = 'catching_up';

COMMIT;
```

This resolves both races:

```text
archive append commits first
  => final check sees it and the workflow processes another tail window

live transition commits first
  => the later append observes live mode and ordinary Scribe receives the input
```

No quiet-period timer participates in correctness.

## 10. Failure, retry, interruption, and removal

### Window failure

Retry the current window up to three times in the current workflow. Emit a structured
retry event for attempts two and three. Do not advance the cursor between attempts.

After the third failure:

- record `mode = 'failed'` and a redacted error summary;
- terminalize the workflow with a failed business result;
- keep WhatsApp-to-Scribe live fanout gated for that chat;
- leave the Speaker live;
- continue archiving new events; and
- require explicit retry to return to `catching_up` from the stored cursor.

### Process interruption

A process crash cannot execute the failure transition, so the row remains
`catching_up`. Runtime boot reconciliation treats it as interrupted work and admits
one replacement workflow from the checkpoint. It must not create one replacement per
old Flue run record.

### Managed-chat removal

Check the managed-chat gate between windows. If the chat was removed, stop before the
next prompt and mark the row `disabled`. Do not delete historical graph facts or reset
the cursor. Re-adding the chat resumes catch-up.

## 11. Observability contract

Use `ctx.log` so Flue persists the events in the workflow's live run stream. Event
names are stable; attributes contain counters and cursors, never chat content,
participant names, or media.

```ts
log.info("scribe_backfill.started", {
  chatId,
  phase,
  startingSequence,
});

log.info("scribe_backfill.window.started", {
  chatId,
  phase,
  window,
  fromSequence,
  throughSequence,
  eventCount,
});

log.info("scribe_backfill.window.completed", {
  chatId,
  phase,
  window,
  throughSequence,
  eventsProcessed,
});

log.warn("scribe_backfill.window.retrying", {
  chatId,
  window,
  attempt,
  errorCode,
});

log.error("scribe_backfill.failed", {
  chatId,
  window,
  attempts: 3,
  errorCode,
});

log.info("scribe_backfill.live", {
  chatId,
  windowsProcessed,
  eventsProcessed,
  finalSequence,
});
```

Flue already emits model usage and run lifecycle events. Do not duplicate those in a
new progress database.

## 12. Workflow contract

### Input

```ts
interface ScribeBackfillInput {
  readonly chatId: string;
}
```

Window size, retry count, model, and effort are role/workflow policy, not caller
choices in the product admission schema.

### Output

```ts
type ScribeBackfillResult =
  | {
      outcome: "live";
      chatId: string;
      windowsProcessed: number;
      eventsProcessed: number;
      finalSequence: number;
    }
  | {
      outcome: "failed";
      chatId: string;
      cursor: number;
      errorCode: string;
    }
  | {
      outcome: "disabled";
      chatId: string;
      cursor: number;
    };
```

Do not return message contents in results.

## 13. Minimum build slices

The implementation session should work in this dependency order:

1. **Archive pagination and state store**

   - sequence-aware snapshot/tail reads;
   - `scribe_backfills` state transitions;
   - transactional final handoff;
   - one focused race/checkpoint test.

2. **Shared keyless convergence**

   - enforce exact-phrase reuse in GraphStore;
   - one regression test covering topic, commitment, goal, and confidence increase.

3. **Backfill workflow**

   - reuse the Scribe agent;
   - persistent session, 50-event windows, three attempts;
   - medium Scribe thinking level;
   - structured run logs.

4. **Runtime reconciliation and live gate**

   - boot and managed-chat-change reconciliation;
   - one active run per chat;
   - WhatsApp-only live-Scribe gate;
   - disabled/failed/retry behavior.

5. **Developer proof surface**
   - thin CLI admission/status/retry command over the same service;
   - no CLI-owned backfill logic.

These are build-order slices, not separate product abstractions. A worker may combine
adjacent slices when they share the same central files.

## 14. Acceptance proof for #175

The implementation is complete when all of the following are proven:

- Selecting a new managed chat admits exactly one background workflow and returns
  without waiting for completion.
- The Speaker handles a live message while that chat is still backfilling.
- The same message is archived but not offered to live Scribe during catch-up.
- Initial history is presented chronologically in windows of at most 50 events.
- Windows run sequentially on one Scribe conversation and update the graph after each
  turn.
- A process interruption resumes from the last successful checkpoint.
- Replaying a partial window does not increase entity or relation counts for identical
  facts; confidence may increase under the existing policy.
- An event inserted at the final handoff is processed exactly once by either backfill
  or live Scribe.
- Three failures produce durable `failed` state without stopping the Speaker or losing
  later archive events.
- Removing a managed chat stops at the next window boundary and marks it disabled.
- Run-stream consumers can observe started, per-window, retry, failure, and live events
  without receiving message content.
- The development CLI can admit, inspect, and explicitly retry the same workflow path.
- A real local archive can be backfilled and inspected, with private data kept local.

### Deferred proof

`SCRIBE_FIXTURE_READY` remains unset. After at least one real backfill has been
inspected, create a follow-up design/build ticket that selects a sanitized or synthetic
corpus, defines extraction-quality assertions grounded in observed failure modes, and
then un-skips the eval battery.

## 15. Decision ledger

| Decision      | Ratified choice                                                                           |
| ------------- | ----------------------------------------------------------------------------------------- |
| Invocation    | Automatic background workflow on managed-chat selection; CLI only as dev/operator surface |
| Awaiting      | Caller does not await; workflow awaits each Scribe window internally                      |
| Live behavior | Speaker remains live; WhatsApp live-Scribe fanout is gated during catch-up                |
| Readiness     | Provider `online` gates admission; archive cursor determines completion                   |
| Handoff       | Transactional sequence tail check and mode switch                                         |
| Session       | One persistent Scribe session for the whole run                                           |
| Ordering      | Chronological initial snapshot, then insertion-order tail                                 |
| Windowing     | Fixed maximum of 50 archive events                                                        |
| Idempotency   | Shared exact-phrase convergence plus post-success checkpoints                             |
| Lifecycle     | One durable per-chat state machine; three attempts; boot resume; disabled on removal      |
| Provenance    | Existing optional singular provenance; no reset or provenance redesign                    |
| Observability | Structured `ctx.log` lifecycle events, no message content                                 |
| Model policy  | Reuse the Scribe role; raise role effort from `minimal` to `medium`                       |
| Evals         | Defer fixture unskip until real output informs corpus and assertions                      |
