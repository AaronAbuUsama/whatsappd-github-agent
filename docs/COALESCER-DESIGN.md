# Coalescer design

The Coalescer is the application-owned timing and per-chat ordering layer between
the in-process whatsappd event stream and Flue Ambience admission.

## Contract

- One actor and queue exist per managed `chatId`.
- The managed account records every arrival in the Conversation Archive before
  notifying the Coalescer. The same application transaction projects the message
  and inserts configured live inbound arrivals into the Managed Chat Inbox.
- Unmanaged chats, history, and self echoes remain archive-only.
- A mention or quote reply of the bot flushes immediately.
- Ambient messages flush after the quiet window; `maxWait` bounds a nonstop burst.
- Reaching `maxWindowMessages` creates a capacity Window and begins another; no
  accepted arrival is evicted by count or age.
- Each accepted Inbox arrival is assigned once, in observed order, to a stable
  Window ID. A Window is persisted before dispatch.
- Unwindowed arrivals and pending Windows are replayed on runtime startup.
- If the durable startup backlog cannot be read, intake fail-stops before newer
  arrivals can overtake it.
- A failed Ambience dispatch is logged and does not wedge the chat actor. A local
  Window-store failure fail-stops that chat so a later arrival cannot overtake
  the durable pending batch; restart replay resumes in Inbox order.

## Production seam

`src/host/whatsapp-runtime.ts` wires the managed account recorder, durable Inbox,
full-fidelity whatsappd event source, Window store, and Ambience dispatcher. The
dispatcher calls:

```ts
dispatch(ambience, {
  id: window.chatId,
  input: whatsappWindowInput(window),
});
```

Flue therefore owns the continuing canonical model context. The Coalescer does
not parse assistant output, keep an agent session cursor, run a model tool loop,
poll workflow state, or copy results. It only performs admission.

## Outbound and workflows

The Coalescer has no outbound transport. Ambience's bound `say` tool is the sole
path to `WhatsAppSession.send`.

Root Ambience can admit a bounded GitHub workflow and immediately receives its
`runId`. The workflow's terminal result is later dispatched as new input to the
same `chatId` Ambience. GitHub mutation tools remain inside that specialist
workflow and are not available to root Ambience.

## Tunable timing

Defaults in `src/coalescer/config.ts` are a 3-second quiet window, a 10-second
maximum wait, and ten messages per Window. Tests use Effect's virtual clock to
prove light traffic, burst coalescing, immediate addressed flushes, lossless
capacity segmentation, per-chat isolation, ordering, and recovery after a failed
turn.

## Proof boundary

#50 mechanically proves transactional intake, stable ordered Window assignment,
lossless segmentation, and restart availability in the local application SQLite
database. Pending Windows currently replay with the same ID, so a dispatch whose
outcome is unknown can be repeated. #51 owns durable admission receipts and the
`Uncertain` state needed to prove exactly-once Flue admission. Live WhatsApp
provider delivery is outside these local tests and requires a paired account.
