# T5 — React tool: agent sends reactions

Type: `wayfinder:grilling` (HITL — tool-surface decision; feature ratified, shape open)
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

**Recommendation: O1.** Open sub-decisions for Aaron: (a) allow remove-reaction in v1?
(b) any participation-rubric coupling — e.g. "prefer a 👍 react over a 'noted' reply"
(feeds T1's rubric axes)?
