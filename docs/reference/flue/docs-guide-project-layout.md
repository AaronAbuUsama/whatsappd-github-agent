<!-- source: https://flueframework.com/docs/guide/project-layout/ -->
---
description: Understand the source files and generated output in a Flue project.
title: Project Layout | Flue
image: https://flueframework.com/docs/og4.jpg
---

# Project Layout

Last updated Jun 22, 2026 [ View as Markdown ](https://flueframework.com/docs/guide/project-layout/index.md) 

Flue discovers application entrypoints from your project’s source directory. Use `src/` for new projects, with `app.ts`, `db.ts`, `cloudflare.ts`, `agents/`, `workflows/`, and `channels/` defining the application surfaces Flue builds.

## Example project layout

```text
my-project/
├─ package.json
├─ flue.config.ts
├─ src/
│  ├─ app.ts
│  ├─ db.ts
│  ├─ cloudflare.ts
│  ├─ agents/
│  │  └─ support-assistant.ts
│  ├─ workflows/
│  │  └─ summarize-ticket.ts
│  └─ channels/
│     └─ github.ts
└─ dist/
```

Organize supporting application code however you prefer inside `src/`. The files and directories below are the parts of your application that Flue discovers and builds automatically.

## Important files and directories

| Path          | Purpose                                                                               | Learn more                                                                                     |
| ------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| app.ts        | Optional entrypoint for composing Flue with your application’s routes and middleware. | [Routing](https://flueframework.com/docs/guide/routing/)                                       |
| db.ts         | Optional Node.js persistence adapter for agent conversations and workflow runs.       | [Database](https://flueframework.com/docs/guide/database/)                                     |
| cloudflare.ts | Optional Cloudflare-only module for Worker exports and non-HTTP handlers.             | [Cloudflare](https://flueframework.com/docs/ecosystem/deploy/cloudflare/#extending-the-worker) |
| agents/       | Addressable agents that can receive continuing interactions over time.                | [Agents](https://flueframework.com/docs/guide/building-agents/)                                |
| workflows/    | Finite operations that receive input and return a result.                             | [Workflows](https://flueframework.com/docs/guide/workflows/)                                   |
| channels/     | Verified provider HTTP ingress discovered by filename.                                | [Channels](https://flueframework.com/docs/guide/channels/)                                     |

### `app.ts`

`app.ts` is an optional custom application entrypoint. Add it when your server needs to compose Flue routes with application behavior such as authentication, webhooks, health endpoints, or a route prefix. A project without `app.ts` uses Flue’s generated application directly.

For more information, see [Routing](https://flueframework.com/docs/guide/routing/).

### `db.ts`

`db.ts` is an optional Node.js persistence entrypoint. Its default export configures the `PersistenceAdapter` used for canonical agent conversations, attachments, accepted submissions, and workflow-run records. Without it, Node.js uses in-memory SQLite and loses this state when the process exits. Cloudflare provides Durable Object SQLite automatically and rejects `db.ts`.

For more information, see [Database](https://flueframework.com/docs/guide/database/).

### `cloudflare.ts`

`cloudflare.ts` is an optional Cloudflare-only deployment module. Its named exports become top-level Worker exports, and its optional default export adds non-HTTP Worker handlers. Use it for same-Worker Durable Object classes, explicit Cloudflare Sandbox aliases, queue consumers, scheduled handlers, and other Cloudflare-native additions. Custom HTTP handling remains in `app.ts`.

For more information, see [Deploy on Cloudflare](https://flueframework.com/docs/ecosystem/deploy/cloudflare/#extending-the-worker).

### `agents/`

The `agents/` directory contains agents that Flue can address by name. Each immediate file defines one discovered agent, and its filename becomes the agent name: `src/agents/support-assistant.ts` is discovered as `support-assistant`.

Keep agent files flat inside `agents/`; nested files are not discovered as additional agents. Prefer lower-kebab-case filenames such as `support-assistant.ts` so names remain portable across deployment targets.

For more information, see [Agents](https://flueframework.com/docs/guide/building-agents/).

### `workflows/`

The `workflows/` directory contains finite operations that Flue can invoke by name. Each immediate file defines one discovered workflow, and its filename becomes the workflow name: `src/workflows/summarize-ticket.ts` is discovered as `summarize-ticket`.

Keep workflow files flat inside `workflows/`; nested files are not discovered as additional workflows. Prefer lower-kebab-case filenames such as `summarize-ticket.ts` so names remain portable across deployment targets.

For more information, see [Workflows](https://flueframework.com/docs/guide/workflows/).

### `channels/`

The `channels/` directory contains provider HTTP integrations. Each immediate file must export one named `channel` binding. Its filename becomes an immutable namespace: `src/channels/github.ts` publishes provider-declared routes beneath `/channels/github`.

Nested files are ordinary support modules and are not discovered as channels. Every route has a provider-owned non-empty suffix such as `/webhook`, `/events`, or `/interactions`; `/channels/github` itself is not an endpoint.

For more information, see [Channels](https://flueframework.com/docs/guide/channels/).

## Source directory

`src/` is the canonical source directory for new Flue projects. When integrating Flue into another application or maintaining an existing layout, authored modules may instead live in `.flue/` or at the project root. Flue selects one source directory in this order:

1. `.flue/` — A self-contained Flue source area inside a larger application.
2. `src/` **(Recommended)** — The recommended layout for new projects.
3. The project root — A compact layout for small dedicated projects.

The first matching directory wins. Flue does not merge layouts: when `.flue/` exists, it does not discover agents, workflows, channels, `app.ts`, `db.ts`, or `cloudflare.ts` from `src/` or the project root. Authored modules may still import ordinary supporting code from elsewhere in the project.

The source directory is always discovered relative to your project root. To configure the project root, see [Configuration](https://flueframework.com/docs/reference/configuration/).

## Output directory

`dist/` is the default output directory for generated build artifacts. It is created at the project root when you build the application and is never part of authored source discovery.

To change where generated artifacts are written, set `output` in `flue.config.ts`:

```ts
import { defineConfig } from '@flue/cli/config';

export default defineConfig({
  output: './build',
});
```

For more information about project and output configuration, see [Configuration](https://flueframework.com/docs/reference/configuration/).

## Docs Navigation

Current page: [Project Layout](https://flueframework.com/docs/guide/project-layout/)

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