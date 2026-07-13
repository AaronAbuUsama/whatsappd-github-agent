# Coalescer design

The Coalescer is the application-owned timing and per-chat ordering layer between
the in-process whatsappd event stream and Flue Ambience admission.

## Contract

- One actor and queue exist per managed `chatId`.
- Live inbound messages from other senders are accepted; history and self echoes
  are retained by the history store but never re-admitted as new turns.
- A mention or quote reply of the bot flushes immediately.
- Ambient messages flush after the quiet window; `maxWait` bounds a nonstop burst.
- The rolling window is bounded by count and age.
- Every accepted window is handed to `AmbienceDoorway.admit` exactly once and
  in order for that chat.
- A failed admission is logged and does not wedge the chat actor.

## Production seam

`src/host/whatsapp-runtime.ts` supplies the full-fidelity whatsappd event source
and `makeAmbienceDoorway()`. The doorway calls:

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
maximum wait, ten messages, and five minutes of buffered age. Tests use Effect's
virtual clock to prove light traffic, burst coalescing, immediate addressed
flushes, hard caps, per-chat isolation, ordering, and recovery after a failed
turn.
