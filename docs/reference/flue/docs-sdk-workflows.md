<!-- source: https://flueframework.com/docs/sdk/workflows/ -->
---
description: Start workflow runs and receive their run ID.
title: client.workflows | Flue
image: https://flueframework.com/docs/og4.jpg
---

# client.workflows

Last updated Jun 20, 2026 [ View as Markdown ](https://flueframework.com/docs/sdk/workflows/index.md) 

## `client.workflows.invoke(...)`

```ts
invoke(name: string, options: WorkflowInvokeOptions & { wait: 'result' }): Promise<WorkflowWaitResult>;
invoke(name: string, options?: WorkflowInvokeOptions): Promise<WorkflowInvokeResult>;
```

Starts a workflow run and returns its ID.

```ts
const run = await client.workflows.invoke('summarize', {
  input: { text: 'Summarize this document.' },
});

console.log(run.runId); // "run_01JX..."
```

If the workflow exports `runs` middleware, use the returned `runId` with [client.runs](https://flueframework.com/docs/sdk/runs/) to stream events, fetch events, or retrieve run metadata.

Pass `wait: 'result'` to hold the request open until the run finishes and resolve with its terminal result:

```ts
const run = await client.workflows.invoke('summarize', {
  input: { text: 'Summarize this document.' },
  wait: 'result',
});

console.log(run.result); // the workflow's return value
```

### `WorkflowInvokeOptions`

| Field  | Type        | Default | Description                                                      |
| ------ | ----------- | ------- | ---------------------------------------------------------------- |
| input  | unknown     | —       | Workflow-defined input.                                          |
| wait   | 'result'    | —       | Wait for the run to finish and resolve with its terminal result. |
| signal | AbortSignal | —       | Cancel the HTTP request.                                         |

### `WorkflowInvokeResult`

```ts
interface WorkflowInvokeResult {
  runId: string;
}
```

`runId` is the server-generated workflow run ID.

### `WorkflowWaitResult`

```ts
interface WorkflowWaitResult {
  runId: string;
  result: unknown;
}
```

Returned when `wait: 'result'` is passed.

## Docs Navigation

Current page: [client.workflows](https://flueframework.com/docs/sdk/workflows/)

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