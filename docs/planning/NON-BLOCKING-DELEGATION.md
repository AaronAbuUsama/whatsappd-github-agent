# Non-blocking delegation — in code, with the implications

> Historical design record. Superseded by the Flue Ambience production path completed in milestone #3; this is not current operator or architecture guidance.

You asked to see the non-blocking pattern (Q3 Option B) in real code before deciding.
Here it is, grounded in the verified Eve APIs, with every implication spelled out — the
good and the cost.

## The core insight (why this shape at all)

A tool runs **inside** the voice's Eve turn. Eve subagents **park the parent turn until
they finish** (`subagents.mdx:19`, `remote-agents.md:68`). And a tool has no `waitUntil`
(that's a route/schedule thing), so a tool **can't** legally spawn work that outlives the
turn. Therefore the async orchestration **cannot live in the voice's turn**. It must live
in the one long-lived, non-turn-scoped place we already have: **the gateway** (the
Coalescer's Effect process).

So the division of labour is:
- **Voice turn** — decides, *records* a job, narrates. Never blocks, never awaits work.
- **Gateway** (Effect, long-lived) — runs jobs, awaits results, reports them back.
- **Job queue** (SQLite) — the decoupling seam between "a turn that can't wait" and "a
  process that can." Also makes jobs **durable** (survive a crash).

```
 Coalescer fire ─► loopback ─► VOICE turn
                                 │ calls delegate(task)  ── writes job row, returns "started"
                                 │ calls say("on it 👍")  ── turn ENDS (voice stays responsive)
                                 ▼
                            SQLite jobs (pending)
                                 ▲ gateway job-runner watches
                                 │ Effect.fork ─► loopback ─► WORKER session (outputSchema)
                                 │                              runs minutes, durable
                                 │ ◄── structured result ───────┘
                                 │ write result, status=done
                                 └─► loopback deliver ─► VOICE turn (new)
                                        │ narrates "done — filed #123"
                                        │ updates its defineState ledger
```

Every arrow is the **same loopback doorway** (Q1). One mechanism, three uses.

## The code

**1 — the voice's `delegate` tool. Trivial: record + return. No awaiting.**
```ts
// agent/tools/delegate.ts
import { defineTool } from "eve/tools";
import { z } from "zod";
import { jobs } from "../lib/jobs";           // SQLite-backed queue

export default defineTool({
  description: "Hand a long task (file/triage an issue, review a PR) to a worker. Returns " +
    "immediately with a job id; the result comes back to you later — narrate it when it does.",
  inputSchema: z.object({
    kind: z.enum(["github"]),                  // later: "code-review", "coding"
    task: z.string().describe("Everything the worker needs; it won't see this chat."),
  }),
  async execute({ kind, task }, ctx) {
    // chatId comes from verified session context, never the model
    const chatId = ctx.session /* resolve continuation token → chatId */;
    const jobId = await jobs.enqueue({ chatId, kind, task });   // durable row, status=pending
    return { jobId, status: "started" };       // voice reads this, says "on it", turn ends
  },
});
```

**2 — the gateway job-runner. The long-lived Effect loop that does the async work.**
```ts
// src/gateway/job-runner.ts
import { Effect } from "effect";
import { Client } from "eve/client";
import { z } from "zod";
import { jobs } from "../../agent/lib/jobs";

const client = new Client({ host: "http://127.0.0.1:3000" });   // loopback, same process

const GithubResult = z.object({                // the worker's STRUCTURED output (task mode)
  action: z.enum(["created", "updated", "closed", "commented", "refused"]),
  number: z.number().optional(),
  url: z.string().optional(),
  summary: z.string(),
});

const runOne = (job: Job) =>
  Effect.gen(function* () {
    // start a detached WORKER session; the gateway CAN await — it's not a chat turn
    const res = yield* Effect.tryPromise(() =>
      client.session(`job:${job.id}`).send({
        message: job.task,
        outputSchema: zodToJsonSchema(GithubResult),   // → Eve task mode, structured return
      }),
    );
    const result = GithubResult.parse(res.data);        // typed, not free text
    yield* Effect.promise(() => jobs.complete(job.id, result));
    // report BACK into the originating chat's voice session → a new voice turn narrates it
    yield* Effect.tryPromise(() =>
      client.session(job.chatId).send({
        message: `[worker result for job ${job.id}]\n${JSON.stringify(result)}`,
      }),
    );
  }).pipe(
    Effect.catchAll((cause) =>                          // failure is a RESULT, never a silent drop
      Effect.promise(() => jobs.fail(job.id, String(cause))).pipe(
        Effect.zipRight(Effect.tryPromise(() =>
          client.session(job.chatId).send({ message: `[worker FAILED job ${job.id}] ${cause}` }))),
      ),
    ),
  );

// watch the queue; fork each pending job so many can run at once, none blocking the others
export const jobRunner = Effect.forever(
  Effect.gen(function* () {
    for (const job of yield* Effect.promise(() => jobs.claimPending(10)))
      yield* Effect.forkScoped(runOne(job));
    yield* Effect.sleep("1 second");
  }),
);
```

**3 — the worker** is `agent/subagents/github/` (its `agent.ts` declares `outputSchema:
GithubResult`), reusing the 13 tools + `instructions.md` unchanged. Reached by the
loopback `client.session('job:…')` above, so it's a real durable Eve session (compaction,
its own tools) — which is what a minutes-long code-review will need.

**4 — the voice narrates + updates state.** When `[worker result …]` arrives as a new
turn, the voice's job (its prompt) is to `say` a human version and update its ledger:
```ts
// agent/lib/ledger.ts
export const ledger = defineState("wa.ledger", () => ({ jobs: [] as JobRecord[] }));
// the voice, on a worker-result turn: ledger.update(s => ({ jobs: [...s.jobs, record] }))
```

## Implications — the honest cost

1. **New surface: a SQLite `jobs` table + a gateway job-runner loop.** This is the real
   price of non-blocking. It composes with the chat-store SQLite we already need (D6).
2. **The voice never blocks** — it records + narrates. That's what keeps a busy chat
   responsive while a code-review runs for minutes. (The whole point.)
3. **One doorway, three directions** — coalescer→voice, gateway→worker, result→voice. If
   Q1's loopback works, this works; nothing new to prove.
4. **Structured output, not free text** — the worker returns typed data (`outputSchema`);
   the voice narrates *deliberately*. This is the anti-black-hole: the result always comes
   back, and speaking is the voice's explicit job.
5. **Failure is a delivered result**, never a silent gap (F3 can't recur): a worker crash
   becomes a `[worker FAILED]` turn the voice explains.
6. **Durability**: jobs survive a gateway crash (they're rows); on restart the runner
   re-claims pending jobs. Worker sessions are durable Eve sessions. This is the state
   richness you wanted — "what it did, why, with evidence" — as the job row + result +
   ledger, *without* a separate heavy provenance system.
7. **Correlation lives in the gateway** (`job.chatId`), read from verified context, never
   the model — no cross-chat leakage.
8. **Two turns per delegation** (one to start, one to narrate) instead of one blocking
   turn. Slightly more model calls; far more responsive.

## Contrast — what "blocking now (A)" saves

Option A is just: `delegate` awaits the worker inside the turn. **No jobs table, no
runner, no report-back** — maybe 60 fewer lines. It's genuinely fine while tasks are ~2s
(issue-filing). It breaks the moment a task takes long enough that freezing the chat is
unacceptable — i.e. exactly when code-review/coding arrive. The `delegate` port stays the
same shape either way, so A→B is a swap of the tool + adding the runner, not a rewrite.

## The decision, restated

- **B now** — build the jobs table + runner from the start; non-blocking is designed in.
- **A→B** — ship blocking (no jobs table) for today's quick GitHub tasks; add the runner
  when the first long-running worker (code-review) lands. Same `delegate` port.
