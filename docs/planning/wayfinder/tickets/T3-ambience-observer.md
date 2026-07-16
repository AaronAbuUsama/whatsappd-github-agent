# T3 — AmbienceObserver seam: deliberations, silence, and dispatch-spanning typing (B2+B3)

Type: `wayfinder:grilling` (HITL — the one genuinely new abstraction of the pass)
Blocked-by: — (frontier; the Flue-hooks investigation that gated this is DONE, findings below)
Blocks: B2/B3 spec; the chat-visible console's "settled silent" line (B1 ships without it, upgrades with it); future frontend event feed

## Question

What shape is the observer seam that makes deliberations and deliberate-silence
visible — and drives the dispatch-spanning typing indicator?

## Investigation result (was the gate — resolved 2026-07-16)

`dispatch()` does NOT settle on completion — receipt at admission only:

```ts
// node_modules/@flue/runtime/dist/flue-app-*.d.mts:246-265
// "Resolves after the current runtime admits and queues the input. It does not
//  wait for model processing, tool calls, or an agent reply."
declare function dispatch(agent, request): Promise<DispatchReceipt>; // { dispatchId, acceptedAt }
```

But the runtime EXPOSES settlement — `observe()` emits correlated lifecycle events in
the same isolate:

```ts
// node_modules/@flue/runtime/dist/index.d.mts:104-130
declare function observe(subscriber: FlueEventSubscriber): () => void;
// event variants (types-*.d.mts:816-941):
//   { type: 'agent_end'; messages: AgentMessage[] }
//   { type: 'submission_settled'; submissionId; outcome: 'completed'|'failed'|'aborted'; ... }
// every event carries optional { instanceId?, dispatchId?, agentName?, ... }
```

Caveats from the docs: subscribers run synchronously on the emit path (must be cheap),
no replay, same-isolate only — fine here (CLI+server are one process via the deferred
handshake).

## Problem in code

Dispatch is fire-and-forget; nothing sees the outcome:

```ts
// src/ambience/dispatch.ts:18-19
export const dispatchAmbience = ({ id, input }: AmbienceDispatchRequest): Promise<DispatchReceipt> =>
  dispatch(ambience, { id, input });
```

Typing only flickers per send, inside the say tool (`src/host/whatsapp-runtime.ts:41-63`
— `setTyping(true)` → `send` → `setTyping(false)`), so between window admission and the
reply (or silent settle) the chat shows nothing. And a silent settle is literally
invisible: no log, no event, anywhere.

## Blast radius

New small module (`src/ambience/observer.ts` or inline in host wiring); consumers:
console logging (chat-visible "…deliberating" / "settled silent" lines), typing
indicator in `runWhatsAppSession` (`src/host/whatsapp-runtime.ts:84-108`), later the
frontend feed. No coalescer or agent changes. B3 rides B2's correlation: typing-on at
window dispatch, typing-off on settlement.

## Options

**O1 — thin adapter over `observe()`, domain-named callbacks:**

```ts
export interface AmbienceObserver {
  windowDispatched(w: { chatId: string; windowId: string; dispatchId: string }): void;
  spoke(w: { chatId: string; dispatchId: string; text: string }): void;      // from say port, not Flue
  settledSilent(w: { chatId: string; dispatchId: string }): void;
  settledFailed(w: { chatId: string; dispatchId: string; error: string }): void;
}
// wiring: dispatchAmbience records dispatchId→{chatId,saw-say?}; observe() matches
// submission_settled/agent_end by dispatchId; say port marks "spoke" for that dispatch.
```
~60 lines + wiring. Both survey passes endorsed exactly this seam; frontend consumes
the same interface later.

**O2 — no abstraction: subscribe `observe()` directly where needed** (a logging
subscriber in logging wiring, a typing subscriber in `runWhatsAppSession`): fewer
names, but the dispatchId→chatId correlation map gets duplicated per consumer, and
"did this dispatch say anything?" (the silence signal) needs the say port and the Flue
events joined — that join IS the abstraction; writing it twice is the drift C2 kills.

**O3 — patch Flue upstream for a settlement promise on dispatch:** cleanest contract
but not ours to ship on this pass's clock; blocked on upstream.

## Grading

| | O1 observer seam | O2 raw subscribers | O3 upstream |
|---|---|---|---|
| Floor-first | ships B2+B3 now | ships, duplicated | blocked |
| Reversibility | high (thin adapter) | high | n/a |
| Blast radius | 1 new module + 2 consumers | 2 wiring sites + shared map anyway | upstream |
| Correctness | one correlation, tested once | two correlations to keep in sync | — |
| Parallelizable | after nothing; before B1's silent-line upgrade | same | — |
| Fit | endorsed by both passes; frontend-ready | contradicts frontend seed | — |

**Recommendation: O1.** Sub-decisions for Aaron: (a) does `settledSilent` render on the
default console (chat-visible) or info-log only? (b) typing indicator: on for the whole
deliberation even when it settles silent (humans see "typing…" then nothing — honest or
weird?), or only until the agent decides not to speak?
