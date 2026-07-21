<!-- source: https://flueframework.com/docs/api/action-api/ -->
---
description: Reference for defining reusable finite Actions with @flue/runtime.
title: Action API | Flue
image: https://flueframework.com/docs/og4.jpg
---

# Action API

Last updated Jun 19, 2026 [ View as Markdown ](https://flueframework.com/docs/api/action-api/index.md) 

The Action API is exported from `@flue/runtime`.

## `defineAction()`

```ts
function defineAction<TInput, TOutput>(
  options: ActionOptions<TInput, TOutput>,
): ActionDefinition<TInput, TOutput>;
```

Defines reusable finite behavior. The returned frozen value can be bound to a workflow with `defineWorkflow({ agent, action })` or exposed to a model through an agent’s `actions` field.

### Options

| Field       | Required | Description                                                                                  |
| ----------- | -------- | -------------------------------------------------------------------------------------------- |
| name        | Yes      | Non-empty model-facing tool name. Must not conflict with another active tool or Action name. |
| description | Yes      | Non-empty model-facing description.                                                          |
| input       | No       | Top-level object Valibot schema.                                                             |
| output      | No       | Valibot schema for the returned value.                                                       |
| run         | Yes      | Finite handler receiving ActionContext.                                                      |

Definition rejects missing metadata, non-Valibot schemas, and input schemas whose top level is not an object. Inline `defineWorkflow({ run })` definitions delegate these schema checks to `defineAction()` and report the same errors.

## `ActionContext`

```ts
type ActionContext<S> = {
  readonly harness: FlueHarness;
  readonly log: FlueLogger;
} & (S extends ActionInputSchema ? { readonly input: InferOutput<S> } : {});
```

| Member  | Description                                                                                   |
| ------- | --------------------------------------------------------------------------------------------- |
| harness | Invocation-scoped harness supplied by the runner.                                             |
| input   | Parsed and transformed schema output. Omitted from the type when no input schema is declared. |
| log     | Structured logger for the current execution.                                                  |

Action context intentionally excludes transport requests, platform bindings, and workflow identity. Pass required data through input and configure capabilities on the agent.

When a model calls an Action, Flue runs it in an isolated child scope. The child shares the parent agent configuration, sandbox, and filesystem, but has independent default and named sessions and cannot reenter the active parent session. Its canonical records remain append-only in the agent-instance stream for that instance’s lifetime; there is no recursive per-session deletion.

## Input and output contracts

Input is validated before `run()` executes. Output is validated after `run()` when an output schema exists. Valibot transformations are reflected in the values received and returned.

Without an output schema, an Action may return any JSON-serializable value or `undefined`. With an output schema, the parsed result must be JSON-serializable and cannot be `undefined` unless the schema produces a serializable value.

## Utility types

```ts
type ActionInput<TAction extends ActionDefinition> = /* schema input type */;
type ActionOutput<TAction extends ActionDefinition> = /* schema output type */;
type ActionInputSchema = GenericSchema<Record<string, unknown>, unknown>;
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
```

`ActionInput<TAction>` is the authored schema input type. `ActionOutput<TAction>` is the parsed output type, or `unknown` when no output schema is declared.

## Errors

| Error                          | type                          | Contract                                                                |
| ------------------------------ | ----------------------------- | ----------------------------------------------------------------------- |
| ActionInputValidationError     | action\_input\_validation     | Input failed schema parsing. meta contains action and issues.           |
| ActionOutputValidationError    | action\_output\_validation    | Returned output failed schema parsing. meta contains action and issues. |
| ActionOutputSerializationError | action\_output\_serialization | Final output was not JSON-serializable. meta.action identifies it.      |

Validation issues use the exported `ValidationIssue` shape with `message` and an optional property-key `path`.

## Docs Navigation

Current page: [Action API](https://flueframework.com/docs/api/action-api/)

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