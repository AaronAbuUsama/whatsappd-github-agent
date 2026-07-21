<!-- source: https://flueframework.com/docs/cli/overview/ -->
---
description: Use the Flue CLI to configure, develop, exercise, inspect, and build an application.
title: CLI | Flue
image: https://flueframework.com/docs/og4.jpg
---

# CLI

Last updated Jun 22, 2026 [ View as Markdown ](https://flueframework.com/docs/cli/overview/index.md) 

Install `@flue/cli` as a development dependency, then invoke `flue` through your package manager:

```bash
npm install --save-dev @flue/cli
npx flue dev
```

The CLI requires Node.js `>=22.19.0`. Cloudflare development and deployment also require `wrangler` as a development dependency.

## Develop locally

`flue dev` serves the application for its configured Node.js or Cloudflare target, watches source files, and rebuilds on changes:

```bash
npx flue dev
```

Use its real HTTP and SDK surface while authoring application routes and integrations. Agents and workflows are not public merely because they are discovered; [Routing](https://flueframework.com/docs/guide/routing/) explains authored exposure.

## Exercise one resource

`flue run` executes one agent prompt or workflow invocation and exits:

```bash
npx flue run assistant --input '{"message":"Summarize this repository."}'
npx flue run summarize-ticket --input '{"ticket":"Ticket details"}'
```

Without an absolute `--server`, the command starts the configured Node.js or Cloudflare runtime temporarily. It calls through the authored `app.ts` and an existing `flue()` mount, so normal application and resource middleware executes. Route-free resources are temporarily available through that mount for local use; this does not alter deployment behavior or create a mount.

Use `--server /api/flue` for a non-root authored local mount. An absolute URL attaches to an already-running local or deployed application:

```bash
npx flue run workflow:summarize-ticket \
  --server https://example.com/api/flue \
  --input '{"ticket":"Ticket details"}'
```

See [flue run](https://flueframework.com/docs/cli/run/) for input, identity, headers, resource qualification, and server behavior.

## Build and deploy

`flue build` creates target-specific deployment output:

```bash
npx flue build
```

A build packages the discovered application for its runtime target. It does not choose a model, add credentials, expose additional routes, or configure platform-owned bindings. Continue to the [Node.js](https://flueframework.com/docs/ecosystem/deploy/node/) or [Cloudflare](https://flueframework.com/docs/ecosystem/deploy/cloudflare/) deployment guide.

## Command reference

| Command                                                   | Description                                                                     |
| --------------------------------------------------------- | ------------------------------------------------------------------------------- |
| [flue init](https://flueframework.com/docs/cli/init/)     | Create an initial flue.config.ts.                                               |
| [flue dev](https://flueframework.com/docs/cli/dev/)       | Serve and watch the local application.                                          |
| [flue run](https://flueframework.com/docs/cli/run/)       | Execute one agent prompt or workflow invocation, then exit.                     |
| [flue build](https://flueframework.com/docs/cli/build/)   | Create deployable application artifacts.                                        |
| [flue add](https://flueframework.com/docs/cli/add/)       | Fetch sandbox, channel, or database installation blueprints for a coding agent. |
| [flue update](https://flueframework.com/docs/cli/update/) | Fetch a current blueprint so a coding agent can apply its newer upgrade guides. |
| [flue docs](https://flueframework.com/docs/cli/docs/)     | List, read, and search the bundled Flue documentation.                          |

## Docs Navigation

Current page: [CLI](https://flueframework.com/docs/cli/overview/)

### Sections

* [Guide](https://flueframework.com/docs/getting-started/quickstart/)
* [Reference](https://flueframework.com/docs/api/agent-api/)
* [CLI](https://flueframework.com/docs/cli/overview/)
* [SDK](https://flueframework.com/docs/sdk/overview/)
* [Ecosystem](https://flueframework.com/docs/ecosystem/)

### CLI

* [ Overview ](https://flueframework.com/docs/cli/overview/)
* [ init ](https://flueframework.com/docs/cli/init/)
* [ dev ](https://flueframework.com/docs/cli/dev/)
* [ run ](https://flueframework.com/docs/cli/run/)
* [ build ](https://flueframework.com/docs/cli/build/)
* [ add ](https://flueframework.com/docs/cli/add/)
* [ update ](https://flueframework.com/docs/cli/update/)
* [ docs ](https://flueframework.com/docs/cli/docs/)