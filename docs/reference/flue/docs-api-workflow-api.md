<!-- source: https://flueframework.com/docs/api/workflow-api/ -->
---
description: Reference for creating and invoking workflows with @flue/runtime.
title: Workflow API | Flue
image: https://flueframework.com/docs/og4.jpg
---

# Workflow API

Last updated Jun 20, 2026 [ View as Markdown ](https://flueframework.com/docs/api/workflow-api/index.md) 

The Workflow API is exported from `@flue/runtime`.

## `defineWorkflow()`

```ts
function defineWorkflow<TAction extends ActionDefinition>(options: {
  agent: AgentDefinition;
  action: TAction;
}): WorkflowDefinition<TAction>;

function defineWorkflow<TInput, TOutput>(options: {
  agent: AgentDefinition;
  input?: TInput;
  output?: TOutput;
  run(context: ActionContext<TInput>): unknown | Promise<unknown>;
}): WorkflowDefinition<ActionDefinition<TInput, TOutput>>;
```

Creates a branded workflow value. Default-export it from a discovered `workflows/<name>.ts` module.

`agent` is required and supplies the execution policy and root harness. Exactly one of `action` or `run` is required. The extracted form does not accept `input` or `output`; those contracts belong to its Action. The inline form creates a workflow-private Action and uses the same schema, context, validation, serialization, and lifecycle contracts as [defineAction()](https://flueframework.com/docs/api/action-api/).

The agent may be private to the workflow. Discovery under `agents/` is required only for persistent agent routes and `dispatch()`.

### `WorkflowDefinition`

```ts
interface WorkflowDefinition<TAction extends ActionDefinition> {
  readonly agent: AgentDefinition;
  readonly action: TAction;
}
```

Treat a Workflow Definition as an opaque identity. The generated runtime associates the exact discovered default-exported value with its module name.

### HTTP exports

HTTP routing is not a `defineWorkflow()` option. Export either middleware separately from the workflow module:

```ts
export default defineWorkflow({ agent, action });
export const route: WorkflowRouteHandler = invokeMiddleware;
export const runs: WorkflowRunsHandler = runMiddleware;
```

`route` enables and controls `POST /workflows/:name` only. `runs` separately exposes and controls every HTTP operation on existing runs owned by this workflow, including `GET`, `HEAD`, `?meta`, unsupported methods, and future run methods. Both are ordinary Hono middleware and may return a response or call `next()`.

Without `runs`, the HTTP run resource returns the same generic `404` as an unknown or removed workflow run. Unsupported methods return `405` only after Flue resolves an exposed run and its middleware authorizes the request. Neither export affects `invoke()`, `listRuns()`, `getRun()`, or schedules. Temporary local `flue run` runtimes additionally expose route-free resources through an existing authored `flue()` mount; absolute `--server` attachments do not.

## `invoke()`

```ts
function invoke<TWorkflow extends WorkflowDefinition>(
  workflow: TWorkflow,
  request: WorkflowInvokeRequest<TWorkflow>,
): Promise<WorkflowInvocationReceipt>;
```

Admits one workflow run through the configured Flue runtime and resolves after admission. It does not wait for Action execution or run route middleware.

The workflow must be the exact default export of a discovered workflow module in the current built application. A workflow with an input schema requires `{ input }`; a workflow without one accepts no input property.

```ts
interface WorkflowInvocationReceipt {
  readonly runId: string;
}
```

Input is snapshotted as JSON before admission. Runtime validation against the Action schema occurs when the workflow executes.

## Lifecycle

For each invocation, Flue:

1. represents omitted input as `undefined` and rejects non-`undefined` input for a workflow without an input schema;
2. snapshots and admits the caller input for detached invocation;
3. validates and transforms declared Action input before initializing the agent or sandbox;
4. emits `run_start` and initializes the workflow’s agent and root harness;
5. runs the Action with transformed input;
6. validates and serializes output;
7. closes invocation resources before persisting `run_end` and the terminal result or error.

Schema-invalid input can therefore produce an admitted, observable failed run, but it never initializes the agent definition or sandbox.

`RunRecord.input` contains the admitted input. The first lifecycle event is normally `run_start`, whose `input` field carries the same value. Interrupted admission may instead expose `run_resume` first. `run_end` records terminal success or failure.

`invoke()` and routed/SDK invocation create the same workflow-run model. `dispatch()` is different: it admits input to a continuing agent instance and returns a `dispatchId`, not a run.

## Errors

| Error                                | type                                  | Contract                                                        |
| ------------------------------------ | ------------------------------------- | --------------------------------------------------------------- |
| WorkflowInvocationNotConfiguredError | workflow\_invocation\_not\_configured | invoke() ran outside a configured Flue-built server.            |
| WorkflowNotDiscoveredError           | workflow\_not\_discovered             | The exact workflow value is not registered in this application. |
| WorkflowInputUnexpectedError         | workflow\_input\_unexpected           | Input was supplied to an Action without an input schema.        |
| WorkflowInputSerializationError      | workflow\_input\_serialization        | invoke().input is not JSON-serializable.                        |
| WorkflowAdmissionUnavailableError    | workflow\_admission\_unavailable      | This runtime has no workflow admission hook.                    |
| WorkflowAdmissionError               | workflow\_admission\_failed           | Target admission failed; meta.workflow identifies the module.   |

Action input, output, and serialization errors are documented in the [Action API](https://flueframework.com/docs/api/action-api/#errors).

## Docs Navigation

Current page: [Workflow API](https://flueframework.com/docs/api/workflow-api/)

### Sections

* [Guide](https://flueframework.com/docs/getting-started/quickstart/)
* [Reference](https://flueframework.com/docs/api/agent-api/)
* [CLI](https://flueframework.com/docs/cli/overview/)
* [SDK](https://flueframework.com/docs/sdk/overview/)
* [Ecosystem](https://flueframework.com/docs/ecosystem/)

### Runtime

* [ Configuration ](https://flueframework.com/docs/reference/configuration/)
* [ Errors Reference ](https://flueframework.com/docs/api/errors-reference/)
* [ Agent API ](https://flueframework.com/docs/api/agent-api/)
* [ Action API ](https://flueframework.com/docs/api/action-api/)
* [ Workflow API ](https://flueframework.com/docs/api/workflow-api/)
* [ Provider API ](https://flueframework.com/docs/api/provider-api/)
* [ Routing API ](https://flueframework.com/docs/api/routing-api/)
* [ Streaming Protocol ](https://flueframework.com/docs/api/streaming-protocol/)
* [ Events Reference ](https://flueframework.com/docs/api/events-reference/)

### Advanced

* [ Sandbox Adapter API ](https://flueframework.com/docs/api/sandbox-api/)
* [ Data Persistence API ](https://flueframework.com/docs/api/data-persistence-api/)