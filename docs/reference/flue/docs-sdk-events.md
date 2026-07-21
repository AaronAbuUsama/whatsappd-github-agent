<!-- source: https://flueframework.com/docs/sdk/events/ -->
---
description: SDK event, workflow-run record, and normalized model-turn types.
title: Events and records | Flue
image: https://flueframework.com/docs/og4.jpg
---

# Events and records

Last updated Jun 15, 2026 [ View as Markdown ](https://flueframework.com/docs/sdk/events/index.md) 

## `FlueEvent`

`FlueEvent` is the observable runtime-event union. It includes run lifecycle, agent lifecycle, model turn, message, tool, task, compaction, operation, log, structured `data`, idle, and recovery-settlement (`submission_settled`) events. Events are durably stored in an event stream and can be replayed from any offset via the Durable Streams protocol. Dispatched activity uses `dispatchId` as its delivery identity rather than becoming a workflow run.

Every delivered event carries the durable event-format version `v: 3`, a per-context `eventIndex`, and a `timestamp`. SDK readers reject v1, v2, missing, and unknown versions with `UnsupportedFlueEventVersionError`; they do not normalize historical formats. The SDK union mirrors the wire format: `turn_request` is in-process only on the server (`observe()` subscribers and exporters) and never appears on streams the SDK reads.

A `data` event carries a template-safe `name`, optional stable `id`, and JSON-compatible `data` payload. It is append-only on the wire; UI consumers can reconcile repeated `(name, id)` events last-writer-wins, while events without ids remain distinct.

`message_start` and `message_end` bound both user and assistant messages. Text and thinking deltas are best-effort live progress; for a completed assistant message, `message_end` is authoritative. A reader that attaches after generation starts may miss earlier partial output until it arrives. Internal interrupted-turn recovery uses separate durable state and is unaffected by this public stream behavior.

## `AttachedAgentEvent`

`AttachedAgentEvent` is emitted by direct interactions with persistent agent instances. It excludes workflow-run lifecycle events, requires `instanceId`, and does not include `runId`.

## Run types

| Type      | Description                                                                                                      |
| --------- | ---------------------------------------------------------------------------------------------------------------- |
| RunRecord | Persisted workflow-run record, including the workflow name, status, timestamps, input, result, and error fields. |
| RunStatus | Workflow-run status: 'active', 'completed', or 'errored'.                                                        |

## Normalized model-turn types

`turn` events keep correlation, duration, purpose, and error status at top level. Their required `request` is a `ModelRequestInfo` summary; their required `response` is a `ModelResponse`. Output, usage, finish reason, and normalized errors exist only under `response`.

| Type                | Description                                                            |
| ------------------- | ---------------------------------------------------------------------- |
| ModelRequestInput   | Model-visible system prompt, messages, and tools.                      |
| ModelRequestInfo    | Provider identity, requested model, API, and request settings.         |
| ModelRequest        | ModelRequestInfo plus the full request input; used by turn\_request.   |
| ModelResponse       | Response identity, output, usage, finish reason, and normalized error. |
| LlmAssistantMessage | Normalized assistant message.                                          |
| LlmTextContent      | Text content.                                                          |
| LlmThinkingContent  | Reasoning content.                                                     |
| LlmToolCall         | Tool call content.                                                     |
| LlmTurnPurpose      | Model-turn purpose: 'agent', 'compaction', or 'compaction\_prefix'.    |

`request.providerId` is the provider-registration key used in model specifiers. `request.providerName` is the semantic provider identity and may differ for gateways or custom registrations.

## Docs Navigation

Current page: [Events and records](https://flueframework.com/docs/sdk/events/)

### Sections

* [Guide](https://flueframework.com/docs/getting-started/quickstart/)
* [Reference](https://flueframework.com/docs/api/agent-api/)
* [CLI](https://flueframework.com/docs/cli/overview/)
* [SDK](https://flueframework.com/docs/sdk/overview/)
* [Ecosystem](https://flueframework.com/docs/ecosystem/)

### SDK

* [ Overview ](https://flueframework.com/docs/sdk/overview/)
* [ createFlueClient(...) ](https://flueframework.com/docs/sdk/client/)  
  * [ CreateFlueClientOptions ](https://flueframework.com/docs/sdk/client/#createflueclientoptions)
  * [ RequestHeaders ](https://flueframework.com/docs/sdk/client/#requestheaders)
* [ client.agents ](https://flueframework.com/docs/sdk/agents/)  
  * [ prompt(...) ](https://flueframework.com/docs/sdk/agents/#clientagentsprompt)
  * [ send(...) ](https://flueframework.com/docs/sdk/agents/#clientagentssend)
  * [ stream(...) ](https://flueframework.com/docs/sdk/agents/#clientagentsstream)
* [ client.workflows ](https://flueframework.com/docs/sdk/workflows/)  
  * [ invoke(...) ](https://flueframework.com/docs/sdk/workflows/#clientworkflowsinvoke)
* [ client.runs ](https://flueframework.com/docs/sdk/runs/)  
  * [ get(...) ](https://flueframework.com/docs/sdk/runs/#clientrunsget)
  * [ events(...) ](https://flueframework.com/docs/sdk/runs/#clientrunsevents)
  * [ stream(...) ](https://flueframework.com/docs/sdk/runs/#clientrunsstream)
* [ Events and records ](https://flueframework.com/docs/sdk/events/)
* [ Errors ](https://flueframework.com/docs/sdk/errors/)