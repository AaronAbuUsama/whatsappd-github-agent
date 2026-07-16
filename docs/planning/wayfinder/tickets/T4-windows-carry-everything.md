# T4 — Windows carry everything: reactions/updates in the deliberation window

Type: `wayfinder:grilling` (HITL — design decision; ratification #3 fixed the WHAT, this decides the HOW)
Blocked-by: — (frontier)
Blocks: D5-reactions (projection fate), the windows-carry-everything feature spec

## Question

How do reactions (and other updates) enter the coalescer and render in the window —
extend-vs-fire semantics, event-type plumbing, and what happens to the
`conversation_reactions` projection?

## Problem in code

Reactions dead-end at the archive; the coalescer never sees them:

```ts
// src/whatsapp/account.ts:161-176 (reactions path)
const unsubscribeUpdate = session.onUpdate(async (update) => {
  const event = conversationUpdate(update);           // edit|reaction|receipt|revocation
  ...echo de-dup...
  options.archive.append(event);                       // ← journal, then NOTHING
  for (const subscriber of updateSubscribers) await subscriber(update);
});

// src/whatsapp/account.ts:156-160 (messages path, for contrast)
const unsubscribeMessage = session.onMessage(async (message) => {
  const inserted = options.archive.append(conversationArrival(message));
  if (!inserted) return;
  for (const subscriber of messageSubscribers) await subscriber(message);  // → coalescer
});
```

The coalescer accepts `IncomingMessage` only (`src/coalescer/events.ts:13-37` — no
reaction fields; `ConversationWindow.messages: readonly IncomingMessage[]`). The window
renderer likewise (`src/ambience/events.ts:6-34` — schema has `messages` only). And the
extend-vs-fire core is a clean two-outcome loop:

```ts
// src/coalescer/coalescer.ts:96-101
return addressesBot(msg, config.botIds)
  ? fireAndReset(next, reasonOf(msg, config.botIds))
  : next.length >= capacity
    ? fireAndReset(next, "capacity")
    : warm(next, burstStart);
```

Meanwhile the existing `conversation_reactions` projection is written on every update
but read ONLY by test-only `messageState()` (verified: all callers are tests). Per ADR
0008, the journal is the source of truth — a new consumer can read/project the journal
rather than needing that table.

## Blast radius

The coalescer event type + chatLoop (guarded by TestClock tests — the Effect seams are
ratified untouchable, but the *event type* flowing through them must widen),
`whatsappWindowInput` schema + agent prompt shaping, `account.ts` subscriber wiring,
fixture `/test/coalescer`, and D5's projection decision. This is the widest-radius
design item in the pass.

## Options

**O1 — widen the coalescer event to a union (message | update), updates extend-only:**

```ts
// coalescer/events.ts
export type CoalescerEvent = IncomingMessage | ConversationUpdateEvent;
// coalescer.ts onMessage: updates never addressBot & don't count toward capacity:
const next = [...buffer, ev];
return isUpdate(ev) ? warm(next, burstStart)          // extend only
  : addressesBot(ev, config.botIds) ? fireAndReset(next, reasonOf(...))
  : messageCount(next) >= capacity ? fireAndReset(next, "capacity")
  : warm(next, burstStart);
// account.ts: updateSubscribers also feed the coalescer source (reaction|edit|revocation; receipts excluded)
// events.ts: window schema grows `updates: [...]` alongside `messages`, rendered into the prompt
```
Window carries everything; a bare reaction (e.g. 👍 on the agent's own message) opens a
window that settles by debounce and dispatches — agent deliberates, usually silent.

**O2 — same plumbing, but a bare reaction NEVER opens a window (only enriches one
already warm):** one extra guard in `routeTo`/`cold`: drop updates when buffer empty.
Cheaper dispatches, but the agent never deliberates on a reaction to its last answer —
arguably the most signal-rich update there is, and Aaron's ratification says windows
"need them for its own deliberations."

**O3 — don't touch the coalescer: enrich at render time.** Keep windows message-only;
when a window fires, `whatsappWindowInput` queries the journal for updates that landed
inside the window's time span and attaches them:

```ts
// dispatch site: whatsappWindowInput(window, archive.updatesBetween(chatId, window.start, window.end))
```
Zero coalescer change (Effect seams untouched), but updates arriving *after* the last
message and *before* debounce-fire are racy, a reaction can't extend or open a window
(post-window reactions are simply lost until the next message), and it needs a new
archive read API anyway.

## Projection fate (D5 rider)

Under O1/O2 the coalescer carries the live update events, so the agent path never reads
`conversation_reactions` → journal-only suffices → **table deletes** along with
`conversation_receipts` (ratified). Under O3 the render-time query could use either the
journal events table or the projection; journal-only still suffices.

## Grading

| | O1 union, extend-only, updates can open | O2 union, enrich-only | O3 render-time join |
|---|---|---|---|
| Floor-first | full feature now | partial (misses trailing reactions) | partial + racy |
| Reversibility | medium (type widens through core) | medium | high |
| Blast radius | coalescer+renderer+account | same | renderer+archive only |
| Correctness | deterministic, TestClock-testable | deterministic | window-boundary races |
| Parallelizable | independent of A/B/C | same | same |
| Fit | matches "windows carry everything" verbatim | weakens it | sidesteps it |

**Recommendation: O1** — extend-only semantics (updates never fire immediately, never
count toward capacity), updates may open a cold window (a reaction IS a
conversation event the agent should get to deliberate on), receipts excluded. Decision
points for Aaron inside O1: (a) may a bare reaction open a cold window, or O2's
enrich-only? (b) which update kinds ride along — reaction+edit+revocation, receipts out?
