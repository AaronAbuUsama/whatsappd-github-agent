# T5 — Outbound tool surface: react + reply-to (broadened per Aaron)

Type: `wayfinder:grilling` (HITL — tool-surface decision; feature ratified, shape open)

> **Broadened 2026-07-16**: Aaron asked whether replying to a specific message is the
> same decision. It is — the transport already supports it natively, no new content
> type needed:
>
> ```ts
> // node_modules/whatsappd/dist/update-*.d.mts:168-175
> interface SendOptions {
>   /** reply to / quote this message */
>   readonly quote?: MessageRef;
>   /** jids to @mention (must also appear in the text) */
>   readonly mentions?: readonly string[];
> }
> /** Build a `MessageRef` from a received message, for react/edit/delete/quote. */
> declare function refOf(m: InboundMessage): MessageRef;
> ```
>
> The managed `send` proxy already accepts `sendOptions` (`account.ts:237`), and the
> window input already carries `quotedFrom` inbound — the agent can see quotes, it
> just can't make them. So the decision covers the whole outbound surface: say
> gains `replyTo`, react is a sibling tool; outbound `mentions` stays fog (needs
> jid-in-text rendering rules).
Blocked-by: — (frontier; T4 only shapes how the agent *sees* reactions, not how it sends them)
Blocks: react-tool feature spec

## Question

What surface does the react tool expose — input schema, port shape, and guardrails
(which messages are reactable, which emoji)?

## Problem in code

The support layer already exists end to end; only the tool is missing. Outbound
reactions are normalized (`src/intake/conversation-event.ts:254-265` builds the
`kind: "reaction"` event from `{ react: { to, emoji } }`), and the managed `send` proxy
journals + echo-dedups them (`src/whatsapp/account.ts:236-251`, the ratified-kept
`pendingMutationEchoes`). But the agent's only outbound port is text:

```ts
// src/capabilities/whatsapp-participation/whatsapp-port.ts:34-37
export interface WhatsAppSayPort {
  readonly say: (chatId: string, text: string) => Promise<WhatsAppSayResult>;
}

// src/capabilities/whatsapp-participation/tools.ts:55-62 — the sibling to clone
export const createSayTool = (chatId: string, port?: WhatsAppSayPort) =>
  defineTool({
    name: "say",
    description: "Send one message to the WhatsApp chat bound to this Ambience instance.",
    input: v.object({ text: v.pipe(v.string(), v.minLength(1), v.maxLength(4_096)) }),
    output: sayOutputSchema,
    run: ({ input }) => (port ?? getWhatsAppParticipationPort()).say(chatId, input.text),
  });
```

## Blast radius

`whatsapp-port.ts` (port grows `react`), `tools.ts` (+~15 lines, register in
`createWhatsAppParticipationTools` at :90-94), `fake-whatsapp-host.ts` (record a
`kind: "react"` event for evals), `whatsapp-runtime.ts` host implementation (~10 lines
calling `session.send(chatId, { react })`). No coalescer, no archive changes — the
journal path already handles the echo. Gives the kept echo machinery its live caller.

## Options

**O1 — minimal sibling: `react({ messageId, emoji })`, chat-bound like `say`:**

```ts
// port
readonly react: (chatId: string, messageId: string, emoji: string) => Promise<WhatsAppSayResult>;
// tool
input: v.object({
  messageId: nonEmptyString,          // must appear in the current window/thread
  emoji: v.pipe(v.string(), v.minLength(1), v.maxLength(8)),  // "" = remove? see decision
}),
```
Free-form emoji, agent's judgment; remove-reaction (`emoji: ""`) excluded from v1.

**O2 — curated emoji enum (`v.picklist(["👍","✅","👀","❤️","😂"])`)**: prevents weird
sends, but the model already picks sanely and the enum is a config-shaped guess (YAGNI);
loosening later is easy either way.

**O3 — fold into `say` as an optional field (`{ text?, react? }`)**: one tool, but
muddies the say contract and its 6-arm result union (D6 is flattening that); reaction
outcomes ≠ delivery outcomes.

## Grading

| | O1 minimal sibling | O2 enum | O3 fold into say |
|---|---|---|---|
| Floor-first | ships now | ships now | ships now |
| Reversibility | high | high (loosen = relax schema) | low (contract change) |
| Blast radius | 4 files, additive | same | say's schema + all its tests |
| Correctness | model-judged emoji | over-constrained | union-arm explosion |
| Parallelizable | independent | independent | conflicts with D6 |
| Fit | mirrors say pattern | adds config | fights D6 |

**Recommendation: O1.**

## Resolution (Aaron, 2026-07-16)

**O1 ratified, broadened surface**: `say` gains optional `replyTo?: messageId`
(mapped to `SendOptions.quote` via a `MessageRef`); `react({ messageId, emoji })`
ships as a separate sibling tool; free-form emoji (max 8 chars), no remove-reaction
in v1; outbound `@mentions` stays fog. Aaron declined the explicit react-vs-reply
rubric axis (plain O1, not O1+rubric). CLOSED.
