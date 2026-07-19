# Issue #173: Flue runtime research receipt

> Evidence receipt, not the implementation contract. The ratified
> [`173-CODING-WORKFLOW-SPEC.md`](./173-CODING-WORKFLOW-SPEC.md) supersedes the
> candidate designs below: the modes are `new_issue` and `review_continuation`, an
> unprompted TypeScript coordinator is the root, Coder child tasks own implementation and
> publication, and there is no PR-agent stage.

Research date: 2026-07-18

Installed package: `@flue/runtime@1.0.0-beta.9`

Question: what does the installed Flue runtime actually support for the planner -> coder -> verifier -> PR-agent workflow proposed in [issue #173](https://github.com/AaronAbuUsama/ambient-agent/issues/173)?

## Executive finding

The installed runtime supports the proposed shape as **one workflow-authored, sequential coordinator** which initializes one root harness and awaits named `session.task()` calls. Each call runs in its own child conversation but shares the root harness's single sandbox environment and filesystem. The coordinator must explicitly pass structured results or persist handoff artifacts in that shared filesystem; child agents do not inherit one another's transcripts.

The same workflow may accept two application-level input modes—fresh work from an issue, or continuation from an existing PR plus external Reviewer findings—but each invocation is a **new Flue run**. Flue has no public paused/waiting run status and does not resume workflow code. “Resume” in the run-stream protocol means reconnecting a reader from an offset; `run_resume` during Cloudflare recovery means terminal recovery handling, not restarting the workflow body.

Two constraints are load-bearing:

1. A programmatic `session.task()` is awaitable child work, not a durable stage/checkpoint. Flue explicitly says programmatic task calls are not recovered, and workflow recovery does not resume arbitrary TypeScript from the last completed line (`node_modules/@flue/runtime/docs/concepts/durable-execution.md:68-74`, `:80-97`).
2. One `FlueSession` permits only one active operation. The four stages can reuse one coordinator session only sequentially; parallel work requires separate named sessions, while still sharing the same sandbox and therefore requiring application-level filesystem coordination (`node_modules/@flue/runtime/docs/api/agent-api.md:346-366`; implementation at `node_modules/@flue/runtime/dist/conversation-stream-store-Bitz7UoW.mjs:2100-2116`).

A bounded coder-verifier loop is compatible with those rules: workflow code can call the same named coder and verifier profiles repeatedly, one awaited child task at a time, and log each round. A verifier rejection must be modeled as **successful structured data** such as `{ passed: false, findings }`, not thrown as an operation error, if the workflow must continue to a PR-agent stage that opens or updates a draft.

## Source and evidence boundary

- **Declared API** below means exported TypeScript declarations and first-party documentation shipped inside the exact installed package.
- **Verified implementation behavior** means direct inspection of the bundled JavaScript implementation installed for `1.0.0-beta.9`. The bundle has no source map, so citations name the generated module and generated line.
- A small runtime smoke check of the public `defineAgentProfile()` export confirmed valid nested profiles pass, while duplicate subagent names, subagent durability, and circular subagent definitions throw the messages implemented by the bundle. This does not constitute an end-to-end model/sandbox run.

The package metadata identifies version `1.0.0-beta.9`, requires Node `>=22.19.0`, exports types through `types/index.d.ts`, and identifies the first-party source repository as `withastro/flue/packages/runtime` (`node_modules/@flue/runtime/package.json:1-15`, `:58-67`; `node_modules/@flue/runtime/types/index.d.ts:1-4`).

## Exact public contracts

### `SandboxFactory`

```ts
interface SandboxFactory {
  createSessionEnv(options: { id: string }): Promise<SessionEnv>;
  tools?: SessionToolFactory;
}

type SessionToolFactory = (
  env: SessionEnv,
  options: { subagents: Record<string, AgentProfile> },
) => AgentTool<any>[];
```

Declared at `node_modules/@flue/runtime/dist/types-USSZhfC6.d.mts:641-663` and documented at `node_modules/@flue/runtime/docs/api/sandbox-api.md:82-104`.

Verified implementation behavior:

- The runtime recognizes a sandbox structurally by a callable `createSessionEnv`, awaits it with `{ id }`, and retains the optional tool factory (`node_modules/@flue/runtime/dist/internal.mjs:726-736`).
- `createSessionEnv()` runs while the root harness initializes. The resulting `SessionEnv` is stored on that harness (`node_modules/@flue/runtime/dist/internal.mjs:683-709`).
- Root sessions receive the same `env` reference, and child task sessions receive either that same environment or a `cwd` view over it; Flue does **not** create one sandbox per task (`node_modules/@flue/runtime/dist/internal.mjs:378-401`, `:403-460`).
- A custom `tools` factory replaces the sandbox's default model-facing tool list, but Flue appends its framework `task` tool separately (`node_modules/@flue/runtime/dist/conversation-stream-store-Bitz7UoW.mjs:1835-1878`).

Implication for #173: planner, coder, verifier, and PR agent can observe the same working tree. This is what lets coder changes become verifier input without copying the repository. It also means parallel writers are not isolated merely because they are different tasks.

### `FlueHarness` and `harness.session(name)`

```ts
interface FlueHarness {
  readonly name: string;
  session(name?: string): Promise<FlueSession>;
  readonly sessions: FlueSessions;
  shell(command: string, options?: ShellOptions): CallHandle<ShellResult>;
  readonly fs: FlueFs;
}

interface FlueSessions {
  get(name?: string): Promise<FlueSession>;
  create(name?: string): Promise<FlueSession>;
}
```

Declared at `node_modules/@flue/runtime/dist/types-USSZhfC6.d.mts:433-459`.

Semantics:

- `harness.session()` is get-or-create and defaults to the name `default` (`node_modules/@flue/runtime/dist/types-USSZhfC6.d.mts:435-439`; implementation at `node_modules/@flue/runtime/dist/internal.mjs:318-330`, `:530-532`).
- `sessions.get()` rejects when absent; `sessions.create()` rejects when present. Concurrent opens of the same name are serialized inside the harness (`node_modules/@flue/runtime/dist/internal.mjs:327-400`).
- Public names beginning with `task:` are rejected because Flue owns that namespace (`node_modules/@flue/runtime/dist/run-store-CYeXjR-d.mjs:24-45`).
- A session is persistent conversation state. Only one `prompt`, `skill`, `task`, `shell`, or `compact` operation may be active on a session; a second rejects with `SessionBusyError` (`node_modules/@flue/runtime/docs/api/agent-api.md:346-366`, `:523-540`; implementation at `node_modules/@flue/runtime/dist/conversation-stream-store-Bitz7UoW.mjs:2100-2116`).

Implication for #173: a single coordinator session is sufficient for an awaited four-stage chain. If later design wants parallel planner/research branches, give each branch a distinct named root session and make shared-worktree ownership explicit.

### `AgentProfile` and `subagents: AgentProfile[]`

The exact relevant fields are:

```ts
interface AgentProfile {
  name?: string;
  description?: string;
  model?: string;
  instructions?: string;
  skills?: Skill[];
  tools?: ToolDefinition[];
  actions?: ActionDefinition[];
  subagents?: AgentProfile[];
  thinkingLevel?: ThinkingLevel;
  compaction?: false | CompactionConfig;
  durability?: DurabilityConfig;
}

interface AgentRuntimeConfig {
  // ...
  subagents?: AgentProfile[];
  cwd?: string;
  sandbox?: SandboxFactory;
}
```

Declared at `node_modules/@flue/runtime/dist/types-USSZhfC6.d.mts:320-352`, `:354-387`.

Verified rules:

- A profile selected with `session.task({ agent })` needs a name. At harness initialization, named profiles are converted to a lookup map and nameless profiles are filtered out (`node_modules/@flue/runtime/dist/internal.mjs:695-706`).
- Definitions reject duplicate subagent names, circular subagents, invalid capabilities, and durability on a delegated subagent (`node_modules/@flue/runtime/dist/conversation-projections-XMug3C6A.mjs:190-210`, `:250-255`).
- A named subagent is self-contained for `instructions`, `tools`, `skills`, `actions`, and nested `subagents`; those capabilities do not flow from the parent. Model, thinking level, and compaction fall back to the parent (`node_modules/@flue/runtime/docs/guide/subagents.md:41-51`; implementation at `node_modules/@flue/runtime/dist/internal.mjs:403-460`).
- A task that omits `agent` gets a fresh child context using the parent's full configuration. A task naming an undeclared agent throws `SubagentNotDeclaredError` (`node_modules/@flue/runtime/docs/guide/subagents.md:47-51`; implementation at `node_modules/@flue/runtime/dist/conversation-stream-store-Bitz7UoW.mjs:1897-1904`).
- Nested Task/Action delegation is capped at four levels in this build (`node_modules/@flue/runtime/dist/conversation-stream-store-Bitz7UoW.mjs:370-373`, `:1932-1936`).

Implication for #173: put planner, coder, verifier, and PR agent directly in the workflow agent's `subagents` array and have workflow code select them. Vendor `/verify` only into the verifier's `skills`, and expose `open_pull_request` only to the PR-agent profile. If instead coder is expected to invoke verifier itself, verifier must also be declared in coder's own `subagents` array and that consumes a nested delegation level.

### `session.task()`

```ts
task<S extends v.GenericSchema>(
  text: string,
  options: TaskOptions<S> & { result: S },
): CallHandle<PromptResultResponse<v.InferOutput<S>>>;

task(text: string, options?: TaskOptions): CallHandle<PromptResponse>;

interface TaskOptions<S extends v.GenericSchema | undefined = undefined>
  extends OperationOptions<S> {
  agent?: string;
  cwd?: string;
  images?: PromptImage[];
}

interface OperationOptions<S extends v.GenericSchema | undefined = undefined> {
  result?: S;
  tools?: ToolDefinition[];
  model?: string;
  thinkingLevel?: ThinkingLevel;
  signal?: AbortSignal;
  images?: PromptImage[];
}
```

Declared at `node_modules/@flue/runtime/dist/types-USSZhfC6.d.mts:473-510`, `:569-619`.

Result behavior:

- Without `result`, the awaited value is `{ text, usage, model }`. With a Valibot `result` schema, it is `{ data, usage, model }` (`node_modules/@flue/runtime/dist/types-USSZhfC6.d.mts:569-584`).
- The implementation creates a framework-named child session, awaits `child.prompt(text, childOptions)`, returns that prompt output, and closes the child in `finally`. “Detached” therefore describes the child conversation/context boundary, not unawaited background execution (`node_modules/@flue/runtime/dist/conversation-stream-store-Bitz7UoW.mjs:1932-2036`).
- Structured extraction can throw `ResultUnavailableError` if the agent gives up or does not call the generated `finish` tool after the framework's bounded follow-up loop (`node_modules/@flue/runtime/dist/conversation-stream-store-Bitz7UoW.mjs:2894-2918`; public error contract at `node_modules/@flue/runtime/dist/index.d.mts:83-93`).

Error behavior:

- Configuration failures (for example an undeclared profile), model/tool failures, result-validation failure, and other child errors reject the task handle. The task emits an error event, rethrows the same error, and closes the child (`node_modules/@flue/runtime/dist/conversation-stream-store-Bitz7UoW.mjs:2015-2036`).
- The enclosing operation emits `operation { isError: true, error }` and rethrows. With ordinary sequential `await`s, the workflow function therefore stops before the next stage unless authored code catches the error (`node_modules/@flue/runtime/dist/conversation-stream-store-Bitz7UoW.mjs:2038-2097`).
- Framework errors include `SessionBusyError`, `SubagentNotDeclaredError`, `DelegationDepthExceededError`, and `OperationFailedError` (`node_modules/@flue/runtime/docs/api/errors-reference.md:85-108`).

Cancellation/interruption behavior:

- A task returns a promise-like `CallHandle` with `.signal` and `.abort(reason?)`. An external `options.signal` is merged into its internal controller (`node_modules/@flue/runtime/dist/sandbox-tx-XM70E.mjs:32-65`).
- Cancellation is surfaced as a standard `DOMException` named `AbortError`; the signal reason is attached as `cause` (`node_modules/@flue/runtime/dist/sandbox-tx-XM70E.mjs:1-14`).
- Aborting a parent task operation aborts active child tasks. The child is still closed in `finally` (`node_modules/@flue/runtime/dist/conversation-stream-store-Bitz7UoW.mjs:1972-1983`, `:2030-2055`).
- **Programmatic** `session.task()` calls are not durably resumed. Flue's special subagent recovery applies to a task invoked by the model inside a durable parent submission, not to workflow-authored calls (`node_modules/@flue/runtime/docs/concepts/durable-execution.md:68-74`).
- Workflows are finite function invocations; Flue does not checkpoint arbitrary TypeScript. Cloudflare terminalizes an interrupted run; Node has no equivalent workflow recovery and can leave a durable run active/orphaned. Retrying starts a new invocation (`node_modules/@flue/runtime/docs/concepts/durable-execution.md:80-97`).

Implication for #173: distinguish an operational task failure (a rejected handle, normally terminal unless explicitly caught) from a verifier's valid red result (structured data that drives another round or a draft PR). A whole-run retry may repeat previously completed model work and filesystem effects. The final PR open/update effect needs an application-owned idempotency strategy (for example, detect/reuse an existing branch PR) rather than assuming Flue will resume exactly once.

### `ctx.log` / `FlueLogger`

Workflow `run(...)` is an Action and receives:

```ts
type ActionContext<S> = {
  readonly harness: FlueHarness;
  readonly log: FlueLogger;
} & (S extends ActionInputSchema ? { readonly input: InferOutput<S> } : {});

interface FlueLogger {
  info(message: string, attributes?: Record<string, unknown>): void;
  warn(message: string, attributes?: Record<string, unknown>): void;
  error(message: string, attributes?: Record<string, unknown>): void;
}
```

Declared at `node_modules/@flue/runtime/dist/types-USSZhfC6.d.mts:7-34`, `:394-431`; the workflow-to-Action context wiring is implemented at `node_modules/@flue/runtime/dist/conversation-projections-XMug3C6A.mjs:943-953`.

Verified behavior:

- Each method synchronously emits a decorated `log` event with level, message, and normalized attributes. An `Error` stored at `attributes.error` is serialized to name/message/stack (`node_modules/@flue/runtime/dist/internal.mjs:610-635`, `:711-724`).
- Workflow events receive `runId`, schema revision, monotonic in-context `eventIndex`, and timestamp (`node_modules/@flue/runtime/dist/internal.mjs:542-580`).
- Workflow run fanout persists all non-terminal events except `turn_request`; only text/thinking deltas are buffered. `log` is neither excluded nor buffered, so a waypoint is appended immediately to the run event stream, subject to asynchronous store latency/failure (`node_modules/@flue/runtime/dist/conversation-projections-XMug3C6A.mjs:1101-1158`; exclusions at `node_modules/@flue/runtime/dist/run-store-CYeXjR-d.mjs:220-247`).
- The run stream is exposed over the runtime's SSE read surface when the workflow's `runs` middleware authorizes it (`node_modules/@flue/runtime/dist/flue-app-DweeRG3g.mjs:1209-1253`; route authorization semantics at `node_modules/@flue/runtime/docs/api/workflow-api.md:42-54`).

Implication for #173: `log.info("planner is decomposing", { stage: "planner", status: "started" })`-style waypoints are the correct primitive. For a useful UI contract, use stable structured fields (`stage`, `status`, perhaps `attempt`) and treat the prose message as display text. Flue emits runtime `task_start`, `task`, and `operation` events too (`node_modules/@flue/runtime/dist/types-USSZhfC6.d.mts:877-913`), but those do not replace domain waypoints.

### Workflow pause, continuation, and externally readable progress

There is no public workflow pause/resume contract in this package:

- `RunStatus` is exactly `active | completed | errored`; there is no `paused`, `waiting`, or `needs_input` state (`node_modules/@flue/runtime/dist/run-store-tKpCS1yQ.d.mts:46-60`).
- `invoke()` admits a new run and returns a new `runId`; it does not attach input to or resume an existing run (`node_modules/@flue/runtime/docs/api/workflow-api.md:56-75`).
- The internal `RuntimeActivityGate.pause()` visible in the bundle stops new runtime activity during draining; it is an internal server lifecycle primitive, not a workflow API or stage checkpoint (`node_modules/@flue/runtime/dist/flue-app-mTWSxItI.d.mts:34-43`; implementation at `node_modules/@flue/runtime/dist/internal.mjs:1876-1906`).
- Cloudflare may emit `run_resume` before terminal `run_end` when recovering an interrupted run, but the first-party deployment guide explicitly says this is terminal handling, not resumed or retried workflow code (`node_modules/@flue/runtime/docs/ecosystem/deploy/cloudflare.md:488-506`).

Therefore, continuation after external Reviewer comments must be represented as a new invocation whose input carries or identifies the durable external state, for example:

```ts
type CodingWorkflowInput =
  | { mode: "fresh_issue"; issue: IssueRef; maxRounds: number }
  | {
      mode: "review_continuation";
      issue: IssueRef;
      pullRequest: PullRequestRef;
      review: ExternalReviewSnapshot;
      maxRounds: number;
    };
```

The PR/branch/review system is the cross-run source of truth. A prior Flue `runId` may be included for correlation or audit, but the runtime offers no API for injecting new Reviewer input into that completed run or resuming its local variables. If continuation needs the earlier plan, it must reload it from workflow input, the existing PR/branch, or another application-owned durable artifact.

Externally readable progress is supported, with an authorization condition:

- The workflow must export `runs` middleware; without it, run metadata and stream routes intentionally return the same `404` as an unknown run (`node_modules/@flue/runtime/docs/sdk/runs.md:1-16`; `node_modules/@flue/runtime/docs/api/workflow-api.md:42-54`).
- `client.runs.events(runId)` performs a catch-up read. `client.runs.stream(runId, { live: true })` tails through `run_end`; it supports long-poll or SSE and automatically reconnects from the last offset (`node_modules/@flue/runtime/docs/sdk/runs.md:17-62`).
- Stream offsets are opaque resume-after transport checkpoints. Resumption is at-least-once at the in-flight batch boundary, so consumers should tolerate redelivery. `eventIndex` orders events within one runtime context but is not the stream offset (`node_modules/@flue/runtime/docs/sdk/runs.md:68-79`; raw routes and framing at `node_modules/@flue/runtime/docs/api/streaming-protocol.md:33-67`).
- Because `ctx.log` creates ordinary `log` events and those events are neither excluded nor buffered, every authored stage/round waypoint is part of the externally readable run stream when persistence succeeds (`node_modules/@flue/runtime/dist/internal.mjs:610-635`; `node_modules/@flue/runtime/dist/conversation-projections-XMug3C6A.mjs:1101-1158`; `node_modules/@flue/runtime/dist/run-store-CYeXjR-d.mjs:220-247`).

Recommended event identity is `(runId, eventIndex)` for UI deduplication/order within a run, while retaining the Durable Streams offset separately for reconnect. Stable log attributes should include at least `mode`, `stage`, `round`, `status`, and the issue/PR correlation key.

## Recommended orchestration shape

This is a stack-level sketch, not product implementation:

```ts
const session = await ctx.harness.session();

const source = await resolveInvocationSource(ctx.input); // issue or existing PR + review
ctx.log.info("planner is decomposing", waypoint(ctx.input, "planner", 0, "started"));
const plan = await session.task(renderPlannerInput(source), {
  agent: "planner",
  result: v.object({
    implementationPlan: ImplementationPlan,
    verificationPlan: VerificationPlan,
  }),
});

let findings = source.review?.findings ?? [];
let verification;
let finalRound = 0;
for (let round = 1; round <= ctx.input.maxRounds; round++) {
  finalRound = round;
  ctx.log.info("coder implementing", waypoint(ctx.input, "coder", round, "started"));
  const change = await session.task(renderCoderInput(plan.data, findings), {
    agent: "coder",
    result: ChangeReceipt,
  });

  ctx.log.info("verifier exercising", waypoint(ctx.input, "verifier", round, "started"));
  verification = await session.task(
    renderVerifierInput(plan.data.verificationPlan, change.data),
    { agent: "verifier", result: VerificationReceipt },
  );
  ctx.log.info(
    verification.data.passed ? "verification passed" : "verification found issues",
    waypoint(ctx.input, "verifier", round, verification.data.passed ? "passed" : "red"),
  );
  if (verification.data.passed) break;
  findings = verification.data.findings;
}

const ready = verification?.data.passed === true;
ctx.log.info(
  ready ? "PR agent publishing ready PR" : "PR agent publishing draft with findings",
  waypoint(ctx.input, "pr", finalRound, "started"),
);
return (
  await session.task(renderPrInput(source, plan.data, verification?.data), {
    agent: "pr_agent",
    result: PullRequestReceipt,
  })
).data;
```

Why this fits the runtime:

- The workflow, rather than one of the agents, owns stage order, bounded rounds, and ready-versus-draft policy.
- Fresh issue work and Reviewer-comment continuation enter through explicit input variants but execute as new runs with the same deterministic stage machine.
- Planner output binds both the implementation plan and verification plan before coding begins.
- Structured schemas make stage boundaries explicit; the next child does not automatically see the previous child's transcript (`node_modules/@flue/runtime/docs/guide/subagents.md:35-51`).
- All four tasks see the same sandbox filesystem, so the coder can modify the checkout and the verifier can exercise that exact checkout (`node_modules/@flue/runtime/docs/api/sandbox-api.md:82-104`).
- A red verifier result is data that feeds the next round. Exhaustion still reaches the PR agent, which must open/update a draft containing unresolved findings; a green result opens/updates a ready PR.
- The PR effect is confined to the only profile that should own the PR tool and must implement open-or-update idempotently for both invocation modes.

## Proven, not proven, and unknown

### Proven from the installed package

- The required public types and methods are exported by `@flue/runtime@1.0.0-beta.9`.
- Named programmatic task delegation, schema-backed results, cancellation, structured logs, and shared-sandbox child tasks exist in both declaration and implementation.
- Workflow log events are eligible for immediate durable run-stream append and subsequent SSE delivery when run routes are exposed.
- Run-stream readers can reconnect from an offset, but workflow code itself cannot pause or resume; run status has no paused state.
- Subagent capabilities are profile-owned, while filesystem/sandbox state is harness-shared.
- A single session is sequential and nested delegation has a depth cap of four.
- Repeated sequential coder/verifier tasks are supported; round limits and green/red policy belong to authored workflow code.

### Not proven by this research

- No live LLM, remote sandbox, GitHub mutation, or end-to-end workflow was run.
- No claim is made that the existing repo's sandbox adapter preserves a checkout across host loss; Flue explicitly separates conversation persistence from workspace durability (`node_modules/@flue/runtime/docs/concepts/durable-execution.md:76-78`).
- No claim is made that a run-stream client will see a log waypoint with zero latency or exactly once. Persistence appends are asynchronous and append failures are logged rather than thrown into the workflow (`node_modules/@flue/runtime/dist/conversation-projections-XMug3C6A.mjs:1111-1158`).
- No claim is made that the prior run's sandbox or local variables remain available when a Reviewer later triggers continuation. The installed runtime provides no such cross-run guarantee.

### Design unknowns issue #173 must decide above the runtime

- The exact schemas for `Plan`, `ChangeReceipt`, `VerificationReceipt`, and `PullRequestReceipt`.
- How the continuation trigger snapshots external Reviewer comments and resolves the existing PR/branch before the new run begins.
- Whether handoff truth lives entirely in structured task results, in sandbox files, or in both. Large diffs/test logs should normally remain in files with compact structured receipts.
- The configurable maximum coder/verifier rounds and whether Reviewer-origin findings count as round zero.
- The idempotency key and existing-PR detection/update policy for whole-run retries and Reviewer-continuation invocations.
- The exact branch/readiness contract: green must open or update a ready PR; exhausted/red must open or update a draft whose body preserves unresolved findings.
- Whether failure waypoints are emitted by per-stage `try/catch` blocks before rethrowing, or inferred solely from runtime task/operation/run error events.
- Whether the target deployment supplies durable workspace infrastructure. `SandboxFactory` defines environment creation and sharing; it does not by itself guarantee persistence or cleanup of provider infrastructure (`node_modules/@flue/runtime/docs/api/sandbox-api.md:82-104`).
- Whether future parallel stages may write overlapping files. Flue provides separate conversation sessions, not transactional filesystem isolation.

## Bottom line for issue #173

The floor-first design is: one `defineWorkflow` with explicit fresh-issue and existing-PR-continuation inputs; one coordinator/root agent declaring four named profiles; one shared `SandboxFactory`; one coordinator session; a planner result containing both implementation and verification plans; a bounded configurable coder-verifier loop; Valibot result schemas at every boundary; explicit `ctx.log` waypoints for every stage and round; and an idempotent PR agent that opens/updates ready on green or draft-with-findings on exhausted/red. Expose authorized `runs` middleware so those waypoints are externally readable. Do not represent Reviewer continuation or crash recovery as resuming a paused Flue workflow: each continuation is a new run, and the installed runtime has no durable stage checkpoint mechanism.
