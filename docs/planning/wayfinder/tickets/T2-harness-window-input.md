# T2 — Eval harness: coalesced-window input + faux/live suite boundary (A1+A3)

Type: `wayfinder:grilling` (HITL — API-shape decision)
Blocked-by: T1 (rubric defines what the window suites must express)
Blocks: A2 scorer implementation spec; A4 Braintrust wiring rides the same suites

## Question

What input shape does the harness grow so participation evals stimulate the real
production path (coalesced windows through debounce + admission relay +
`whatsappWindowInput`), and where exactly is the faux-vs-live suite boundary declared?

## Problem in code

The harness's only path to the agent is a direct prompt — production input never
arrives this way:

```ts
// src/evals/harness.ts:169-172
const invocation = await client.agents.prompt(options.agentName, instanceId, {
  message: input.message,
  signal,
});
```

Evals fake the window by hand-formatting a string:

```ts
// src/evals/whatsapp-participation.eval.ts:7
const window = (text: string): string => `WhatsApp Window for the current managed chat:\nAlice: ${text}`;
```

…so debounce, admission, and the real `whatsappWindowInput` rendering are all
unexercised — the eval can pass while the real pipeline regresses. The fixture already
exposes the real path, used by integration tests but not evals:

```ts
// tests/fixtures/ambience/src/app.ts:239-245
app.post("/test/coalescer", async (context) => {
  const input = await context.req.json<IncomingMessage>();
  archiveMessage(input);
  const accepted = inbox.pendingArrival(input.chatId, input.id);
  if (accepted !== undefined) await Effect.runPromise(Queue.offer(source, accepted));
  return context.json({ accepted: true }, 202);
});
// + GET /test/admission (app.ts:250-259) to poll window admission
```

## Blast radius

`src/evals/harness.ts` (input union + run branch), the four `*.eval.ts` files, nothing
in `src/` production code. Existing `message:` evals keep working (additive). The
faux responder keys off serialized message text (`app.ts:146-158`), so window-path
inputs still trigger it — texts just arrive via the real renderer.

## Options

**O1 — additive `window` variant on the existing input (survey's proposal):**

```ts
export interface FlueAgentEvalInput {
  message?: string;                                      // was required
  window?: { texts: string[]; addressed?: boolean };     // NEW
  fixture?: { ... };
}
// run(): if (input.window) { for (const t of input.window.texts) POST /test/coalescer;
//         await pollAdmission(baseUrl, instanceId, signal); } else prompt(...)
```
~40 lines in harness.ts. `addressed?` seeds sender/name shaping — exact fields depend
on T1's address-form axis.

**O2 — separate `createWindowHarness()` factory:** duplicate harness with a window-only
input. Clean types, but forks fixture-seeding/whatsappEvents plumbing (~120 lines,
drift-prone twin of the exact kind C2 is deleting).

**O3 — keep hand-formatted strings, add a unit test pinning `whatsappWindowInput`'s
format:** cheapest (~10 lines) but still skips debounce/admission — the pipeline the
evals exist to guard. Fails the mission.

## Faux/live boundary (A3 — declare, mostly exists)

Mechanics already present: deterministic suites `skipIf AMBIENCE_EVAL_LIVE_MODEL`
(whatsapp-participation.eval.ts:11), live fixture via `AMBIENCE_FIXTURE_LIVE_MODEL`
(app.ts:36-37). Decision to ratify: deterministic suites = mechanics-only (routing,
silence, tool receipts) on the faux responder; `*.live.eval.ts` = quality, live model +
LLM-judge scorers per T1 rubric. Braintrust (A4) attaches to both as reporter/logging.

## Grading

| | O1 additive | O2 twin factory | O3 pin format |
|---|---|---|---|
| Floor-first | ships real-path evals now | same, later | doesn't ship the thing |
| Reversibility | high (additive) | medium | high |
| Blast radius | harness + evals only | new file + evals | one test |
| Correctness | exercises real pipeline | same | misses debounce/admission |
| Parallelizable | yes (after T1) | yes | yes |
| Fit | matches fixture design | duplicates plumbing | anti-mission |

**Recommendation: O1.** Additive, small, exercises the ratified real path, and the
fixture was built for exactly this.
