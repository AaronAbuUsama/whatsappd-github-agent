# T1 — Participation rubric ratification

Type: `wayfinder:grilling` (HITL — resolves only in live session with Aaron)
Blocked-by: — (frontier)
Blocks: T2 (scorer suite shape encodes the rubric), the entire A2/A3 spec

## Question

What is the ratified rubric for when the agent speaks vs stays silent in a group chat —
precise enough to encode as vitest-evals scorers? This is the evals critical path: the
top live complaint is "agent answers more than expected," and no rubric exists to
measure against.

## Problem in code

Today the rubric exists only implicitly, as three hand-picked deterministic cases in
[whatsapp-participation.eval.ts](../../../src/evals/whatsapp-participation.eval.ts):

```ts
// src/evals/whatsapp-participation.eval.ts:13-20
it("keeps casual group conversation private", async ({ run }) => {
  const result = await run({
    message: window("Beautiful sunset today."),
    fixture: { resetWhatsApp: true },
  });
  expect(toolCalls(result).filter((call) => call.name === "say")).toHaveLength(0);
  expect(result.output.whatsappEvents).toEqual([]);
});
```

Silence is already cleanly assertable (`whatsappEvents.length === 0` via the fixture's
`GET /test/whatsapp/events`, recorded in `src/host/fake-whatsapp-host.ts:64-99`). What's
missing is the *policy*: which of the live agent's actual behaviors were right.

## What the grilling session must produce

Scorer definitions across at least these axes (seeded from live observations in the
handoff doc):

1. **Address forms** — explicit name ("Ambience, …") vs implicit request ("can someone
   post the release time?") vs pure chatter. Which tiers warrant a reply?
2. **Usefulness threshold** — when addressed but with nothing valuable to add: reply
   "I don't know" or stay silent?
3. **Issue-capture side effects** — when a message warrants a GitHub issue but no reply:
   is silent capture correct? Should capture ever be announced in-chat?
4. **Multi-message windows** — a window containing both chatter and one addressed
   request: reply once, to the request only?
5. **Repair/meta traffic** — QR/status/system chatter: always silent?
6. **Rate/etiquette** — max replies per window? follow-up questions allowed?

Output artifact: a `docs/planning/PARTICIPATION-RUBRIC.md` with, per axis, the rule and
its scorer expression (deterministic assert where possible, LLM-judge criterion where
not). T2's suite layout consumes this.

## Resolution (Aaron, 2026-07-16 — live grilling session)

Rubric ratified across all six axes; artifact:
[docs/planning/PARTICIPATION-RUBRIC.md](../../PARTICIPATION-RUBRIC.md). Key rulings:

- Two speech categories: conversational interjection (default silence; explicit
  address always engages; implicit only with retrievable/citable facts) vs **task
  workflow speech, which is always allowed** — "this is not a bot."
- Addressed-with-nothing → brief honest reply, never silence.
- Capture is a conversation: elicit until the template is fillable (NO cap on
  questions), file, reply with the issue link, and post the PR link when it lands
  (→ new DAG ticket: GitHub-ingress PR-event routing).
- Multi-item windows: one message per concern, threaded via reply-to; chatter never
  acknowledged. Meta traffic + SMOKE: hard silence.
- Mechanics ratified: rubric feeds the agent prompt (behavior) AND the evals
  (deterministic mechanics asserts + live LLM-judge rates in Braintrust).

CLOSED.

## Grading (of doing this first)

Floor-first: this IS the floor — A2/A3 code without it encodes a guess. Reversibility:
total (it's a doc). Blast radius: none until encoded. Parallelizability: independent of
all B/C/D work. Recommendation: run as the first HITL session of the pass.
