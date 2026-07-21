<!-- source: https://flueframework.com/docs/api/errors-reference/ -->
---
description: Reference Flue transport errors, runtime failures, and development diagnostics.
title: Errors Reference | Flue
image: https://flueframework.com/docs/og4.jpg
---

# Errors Reference

Last updated Jun 21, 2026 [ View as Markdown ](https://flueframework.com/docs/api/errors-reference/index.md) 

Flue exposes stable machine-readable error categories through its public transports. Runtime operations, workflow records, CLI commands, development servers, and builds also report failures, but not every surface uses the transport error vocabulary.

## Public transport errors

#### `FluePublicError`

```ts
interface FluePublicError {
  type: string;
  message: string;
  details: string;
  dev?: string;
  meta?: Record<string, unknown>;
}
```

Caller-safe error details exposed by Flue transports. Unknown failures become a generic `internal_error` payload without leaking their original message. Branch on `type`, not message prose.

| Field   | Meaning                                                                                   |
| ------- | ----------------------------------------------------------------------------------------- |
| type    | Stable machine-readable error category.                                                   |
| message | Short caller-facing summary.                                                              |
| details | Caller-facing explanation.                                                                |
| dev     | Additional local development guidance when available.                                     |
| meta    | Structured error-specific metadata when available. For example, validation issue details. |

`dev` is omitted unless the runtime has additional guidance and is running locally. Temporary local `flue run` runtimes use local error rendering on Node.js and in Cloudflare’s Vite/workerd development runtime. An absolute `--server` attachment renders whatever envelope that server provides; preview and production builds omit local-only guidance.

### Categories

The following categories are stable for framework-owned transport failures. HTTP responses use the listed status code.

| Type                     | HTTP status | Meaning                                                                                                 |
| ------------------------ | ----------- | ------------------------------------------------------------------------------------------------------- |
| method\_not\_allowed     | 405         | The endpoint does not accept the request method. HTTP responses include Allow.                          |
| unsupported\_media\_type | 415         | A request body was not sent as JSON.                                                                    |
| invalid\_json            | 400         | A request body could not be read or parsed as JSON.                                                     |
| agent\_not\_found        | 404         | The requested agent is not registered or not exposed through the requested transport.                   |
| workflow\_not\_found     | 404         | The requested workflow is not registered or not exposed over HTTP.                                      |
| route\_not\_found        | 404         | No generated default-application route matches the request.                                             |
| run\_not\_found          | 404         | The workflow run is missing, expired, or not owned by the resolved workflow instance.                   |
| stream\_not\_found       | 404         | The agent-instance event stream does not exist yet; agent streams are created on first admitted prompt. |
| run\_store\_unavailable  | 501         | The runtime does not provide workflow-run storage, lookup, or listing.                                  |
| invalid\_request         | 400         | The request shape, parameters, or protocol message is invalid. Read details for the specific reason.    |
| internal\_error          | 500         | An unknown or non-public server failure occurred.                                                       |

## Transport envelopes

| Surface                                                  | Envelope                   |
| -------------------------------------------------------- | -------------------------- |
| Framework HTTP error response                            | { error: FluePublicError } |
| Durable Streams invalid-query or missing-stream response | { error: FluePublicError } |

Durable Streams reads use the same framework envelope for invalid query parameters and missing streams. A stream may still terminate through transport behavior rather than a JSON error body, such as a client disconnect during SSE.

See [Events Reference](https://flueframework.com/docs/api/events-reference/) for runtime event types.

### Workflow-run streams

Workflow failures normally appear in a terminal `run_end` event with `isError: true`.

## Workflow-run and operation failures

Workflow-run records, `run_end` events, and operation events expose open-ended `error?: unknown` values. Runtime exceptions are commonly serialized as `{ name, message }` when recorded. These failure records are structured observation data, not a closed list of machine-readable transport categories.

## Runtime exceptions

### `FlueError`

```ts
class FlueError extends Error {
  readonly type: string;
  readonly details: string;
  readonly dev: string;
  readonly meta?: Record<string, unknown>;
}
```

The catchable base class for framework-thrown runtime failures, exported from `@flue/runtime`. Application code distinguishes Flue failures from arbitrary errors with `instanceof FlueError`, then narrows with the concrete subclasses below or the stable `type` field. Message, `details`, and `dev` strings are human-readable prose, not API.

### Runtime errors

Harness and session operations, and runtime provider registration, reject with typed `FlueError` subclasses, all importable from `@flue/runtime`:

| Class                        | type                            | Thrown when                                                                                                                                                                                                       |
| ---------------------------- | ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SessionNotFoundError         | session\_not\_found             | sessions.get() targets a session that does not exist.                                                                                                                                                             |
| SessionAlreadyExistsError    | session\_already\_exists        | sessions.create() targets a session that already exists.                                                                                                                                                          |
| SessionBusyError             | session\_busy                   | An operation starts while another operation is running.                                                                                                                                                           |
| SkillNotRegisteredError      | skill\_not\_registered          | A skill call or activation names a skill that is not registered.                                                                                                                                                  |
| DelegationDepthExceededError | delegation\_depth\_exceeded     | Nested Task and Action delegation exceeds the supported depth.                                                                                                                                                    |
| SubagentNotDeclaredError     | subagent\_not\_declared         | task() names a subagent the agent does not declare.                                                                                                                                                               |
| ToolNameConflictError        | tool\_name\_conflict            | Custom or sandbox adapter tool names collide with each other or with framework-reserved names.                                                                                                                    |
| ToolLegacyDefinitionError    | tool\_legacy\_definition        | A tool definition uses the removed parameters or execute fields. meta.fields lists the legacy fields found.                                                                                                       |
| ToolInputValidationError     | tool\_input\_validation         | Model-supplied tool arguments fail the tool’s Valibot input schema. The agent loop converts the throw into an error tool result so the model can retry; meta.tool and meta.issues identify the tool and failures. |
| ToolOutputValidationError    | tool\_output\_validation        | A tool’s return value fails its Valibot output schema. meta.tool and meta.issues identify the tool and failures.                                                                                                  |
| ToolOutputSerializationError | tool\_output\_serialization     | A tool’s parsed return value cannot be snapshotted as JSON-compatible data, or an output schema produces undefined. meta.tool identifies the tool.                                                                |
| OperationFailedError         | operation\_failed               | An operation ran but did not complete successfully (for example, the model call errored).                                                                                                                         |
| SubmissionTimeoutError       | submission\_timeout             | A durable submission exceeded its configured processing timeout.                                                                                                                                                  |
| ProviderRegistrationError    | invalid\_provider\_registration | registerProvider() targets a non-catalog provider id without api and baseUrl.                                                                                                                                     |

When one of these errors escapes to an HTTP transport (for example, a synchronous `?wait=result` invocation), the response body carries the error’s typed envelope with status `500` instead of the generic `internal_error` payload.

### `ResultUnavailableError`

```ts
class ResultUnavailableError extends Error {
  readonly reason: string;
  readonly assistantText: string;
}
```

Thrown when an agent cannot produce a required structured result, either because it gives up or does not finish after follow-up attempts. Import it from `@flue/runtime` when application logic needs to handle that outcome separately.

### Cancellation

Aborted prompt, skill, task, and shell operations reject with a standard `AbortError` (`DOMException`) carrying the abort reason as `cause` when the runtime permits it. Cancellation is deliberately not part of the `FlueError` vocabulary.

Authoring and definition-time validation failures, such as invalid agent profiles, tool definitions, dispatch payloads, or model ids, reject with human-readable `Error` messages. Those messages are not stable machine-readable categories.

## CLI, build, and development diagnostics

CLI diagnostics are human-oriented messages written to stderr. They do not currently expose stable machine-readable error codes.

| Surface                | Diagnostic families                                                                                                            |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| CLI arguments          | Unsupported flags, missing values, invalid targets, and invalid JSON payloads.                                                 |
| Configuration          | Missing or invalid flue.config.\* files, invalid default exports, unsupported fields, missing target, and environment files.   |
| Build                  | Missing source modules, invalid or duplicate source names, generated module exports, imported skills, and target requirements. |
| Cloudflare build       | Wrangler availability, compatibility settings, reserved bindings, target packages, and filename constraints.                   |
| flue dev initial build | Reports the build failure and exits.                                                                                           |
| flue dev rebuild       | Reports the rebuild failure and keeps watching for a later fix.                                                                |

Use the actionable diagnostic prose when resolving these errors. Do not parse it as a stable API. See [flue build](https://flueframework.com/docs/cli/build/) and [flue dev](https://flueframework.com/docs/cli/dev/) for command behavior.

## Application-owned responses

An authored [app.ts](https://flueframework.com/docs/api/routing-api/) owns its request pipeline. Custom routes and middleware may return arbitrary statuses and bodies, including authorization responses. Flue does not impose an `unauthorized` transport category on application-owned responses.

## Stability boundary

| Surface                                                           | Contract                                                 |
| ----------------------------------------------------------------- | -------------------------------------------------------- |
| FluePublicError fields and documented categories                  | Stable public transport contract.                        |
| Exported FlueError subclasses and their type fields               | Stable public runtime contract.                          |
| Workflow-run records, workflow events, and operation events       | Structured but open-ended failure data.                  |
| Runtime exception messages and CLI, configuration, build messages | Human-oriented diagnostics subject to refinement.        |
| Generated target internals                                        | Implementation details, not public transport categories. |

## Docs Navigation

Current page: [Errors Reference](https://flueframework.com/docs/api/errors-reference/)

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