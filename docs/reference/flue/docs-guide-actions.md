<!-- source: https://flueframework.com/docs/guide/actions/ -->
---
description: Define finite agent-backed operations that can be reused by workflows and agents.
title: Actions | Flue
image: https://flueframework.com/docs/og4.jpg
---

# Actions

AI-generated, awaiting review [ View as Markdown ](https://flueframework.com/docs/guide/actions/index.md) 

An Action is reusable logic that orchestrates an agent harness in a deterministic, reliable way. Use one when a sensitive or reliability-critical task needs application-controlled steps, context, and results.

Actions give [workflows](https://flueframework.com/docs/guide/workflows/) and [agents](https://flueframework.com/docs/guide/building-agents/) a reliable way to perform tasks that should follow application-defined logic instead of leaving every step to the model.

## Define an Action

Create an Action with `defineAction()`:

```ts
import { defineAction } from '@flue/runtime';
import * as v from 'valibot';

export const summarize = defineAction({
  name: 'summarize_document',
  description: 'Summarize a document clearly and concisely.',
  input: v.object({ text: v.string() }),
  output: v.object({ summary: v.string() }),

  async run({ harness, input, log }) {
    log.info('Summarizing document');
    const session = await harness.session();
    const response = await session.prompt(`Summarize this text:\n\n${input.text}`);
    return { summary: response.text };
  },
});
```

An Action has these parts:

* `name` is the model-facing name used when an agent exposes the Action.
* `description` helps the model decide when to call it.
* `input` is an optional top-level [Valibot](https://valibot.dev) object schema. Flue validates and transforms input before `run()` starts.
* `output` is an optional Valibot schema. Flue validates and snapshots the returned value as JSON-compatible data.
* `run({ harness, input, log })` performs the operation. Use the harness to open sessions, work with the configured sandbox, or call other agent capabilities.

This guide uses `src/actions/` to organize shared Actions, but Flue does not discover that directory. An Action becomes available only when you import it into a workflow or agent configuration.

## Use an Action in a workflow

Bind the Action to an agent with `defineWorkflow()`:

```ts
import { defineAgent, defineWorkflow } from '@flue/runtime';
import { summarize } from '../actions/summarize.ts';

export default defineWorkflow({
  agent: defineAgent(() => ({ model: 'anthropic/claude-haiku-4-5' })),
  action: summarize,
});
```

Each invocation runs `summarize` with the workflow’s configured agent and records the run, result, and events under the workflow. The Action owns its schemas and handler, so the workflow does not repeat them.

Binding an Action to a workflow does not expose it to that workflow’s model. Add it separately to the agent’s `actions` list if the model should also be able to call it.

For behavior used by only one workflow, define `input`, `output`, and `run` directly inside `defineWorkflow()`. See [Workflows](https://flueframework.com/docs/guide/workflows/) for the recommended inline form and invocation options.

## Give an Action to an agent

Add an Action to the agent’s `actions` list when the model should decide when to run it:

```ts
import { defineAgent } from '@flue/runtime';
import { summarize } from '../actions/summarize.ts';

export default defineAgent(() => ({
  model: 'anthropic/claude-sonnet-4-6',
  instructions: 'Help the user edit and understand their documents.',
  actions: [summarize],
}));
```

Flue presents each configured Action to the model as a framework-managed tool using its name, description, and input schema. When the model calls it, Flue runs the Action with an isolated child harness and returns its result to the conversation. The child has independent sessions while sharing the parent agent’s configuration, sandbox, and filesystem. Its conversation records remain in the append-only agent-instance stream rather than being recursively deleted.

Actions share the model-facing namespace with custom and framework-provided tools, so every active capability needs a distinct name.

Adding an Action to an agent does not create a workflow or a public endpoint. To invoke the same operation as an inspectable run, bind it to a discovered workflow as well.

## When to use an Action

Actions are most useful when:

* application code needs to control the sequence of agent operations;
* sensitive or reliability-critical work needs validated inputs and results;
* a multi-step task should behave consistently instead of relying on the model to plan every step;
* the same agent-backed operation should be available to workflows, agents, or both.

For a direct application function, use a [tool](https://flueframework.com/docs/guide/tools/). For reusable instructions and resources, use a [skill](https://flueframework.com/docs/guide/skills/).

## Next steps

* [Workflows](https://flueframework.com/docs/guide/workflows/) — run inline or reusable finite behavior as an inspectable job.
* [Agents](https://flueframework.com/docs/guide/building-agents/) — expose Actions alongside an agent’s other reusable capabilities.
* [Tools](https://flueframework.com/docs/guide/tools/) — define direct application functions for models.
* [Skills](https://flueframework.com/docs/guide/skills/) — package reusable instructions and supporting resources.
* [Action API](https://flueframework.com/docs/api/action-api/) — look up complete schemas, context types, and error contracts.

## Docs Navigation

Current page: [Actions](https://flueframework.com/docs/guide/actions/)

### Sections

* [Guide](https://flueframework.com/docs/getting-started/quickstart/)
* [Reference](https://flueframework.com/docs/api/agent-api/)
* [CLI](https://flueframework.com/docs/cli/overview/)
* [SDK](https://flueframework.com/docs/sdk/overview/)
* [Ecosystem](https://flueframework.com/docs/ecosystem/)

### Introduction

* [ Getting Started ](https://flueframework.com/docs/getting-started/quickstart/)
* [ Why Flue? ](https://flueframework.com/docs/introduction/why-flue/)
* [ What is an agent? ](https://flueframework.com/docs/concepts/agents/)
* [ Durable Agents ](https://flueframework.com/docs/concepts/durable-execution/)
* [ Changelog ](https://github.com/withastro/flue/blob/main/CHANGELOG.md)

### Guides

* [ Project Layout ](https://flueframework.com/docs/guide/project-layout/)
* [ Routing ](https://flueframework.com/docs/guide/routing/)
* [ Database ](https://flueframework.com/docs/guide/database/)
* [ Agents ](https://flueframework.com/docs/guide/building-agents/)
* [ Workflows ](https://flueframework.com/docs/guide/workflows/)
* [ Actions ](https://flueframework.com/docs/guide/actions/)
* [ LLM ](https://flueframework.com/docs/guide/models/)
* [ Tools ](https://flueframework.com/docs/guide/tools/)
* [ Skills ](https://flueframework.com/docs/guide/skills/)
* [ Subagents ](https://flueframework.com/docs/guide/subagents/)
* [ Sandboxes ](https://flueframework.com/docs/guide/sandboxes/)
* [ Schedules ](https://flueframework.com/docs/guide/schedules/)
* [ Channels ](https://flueframework.com/docs/guide/channels/)
* [ Evals ](https://flueframework.com/docs/guide/evals/)
* [ Observability ](https://flueframework.com/docs/guide/observability/)

### Frontend

* [ React ](https://flueframework.com/docs/guide/react/)

### Targets

* [ Cloudflare ](https://flueframework.com/docs/guide/targets/cloudflare/)
* [ Node.js ](https://flueframework.com/docs/guide/targets/node/)