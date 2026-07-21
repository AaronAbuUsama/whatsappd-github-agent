<!-- source: https://flueframework.com/docs/cli/build/ -->
---
description: Reference for creating deployable Flue application artifacts.
title: flue build | Flue
image: https://flueframework.com/docs/og4.jpg
---

# flue build

Last updated May 30, 2026 [ View as Markdown ](https://flueframework.com/docs/cli/build/index.md) 

## Synopsis

```bash
flue build [--target <node|cloudflare>] [--root <path>] [--output <path>] [--config <path>] [--env <path>]
```

## Description

`flue build` discovers agents, workflows, and an optional application entrypoint under the selected source root, then writes target-specific deployment output.

For source discovery rules, see [Project Layout](https://flueframework.com/docs/guide/project-layout/).

## Options

| Option                       | Default                                                    | Description                                                                                                                      |
| ---------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| \--target <node\|cloudflare> | Configuration value                                        | Select the build target. Required unless supplied by configuration.                                                              |
| \--root <path>               | Selected config-file directory, or config search directory | Select the project root.                                                                                                         |
| \--output <path>             | <root>/dist                                                | Select the build output directory.                                                                                               |
| \--config <path>             | Auto-discovered flue.config.\*                             | Select a configuration file.                                                                                                     |
| \--env <path>                | <config-base>/.env, when present                           | Select one alternate .env\-format file loaded before configuration. Relative paths resolve from <config-base>. Shell values win. |

## Node.js output

A Node build writes a runnable server artifact:

```text
<output>/server.mjs
```

See [Deploy on Node.js](https://flueframework.com/docs/ecosystem/deploy/node/) for runtime dependencies and deployment setup.

## Cloudflare output

A Cloudflare build writes a Workers-compatible application through the official Cloudflare Vite integration. Flue prepares generated Worker and Wrangler input files without rewriting the project’s authored Wrangler configuration. Durable Object migration history remains in the project-root Wrangler config and passes through unchanged.

See [Deploy on Cloudflare](https://flueframework.com/docs/ecosystem/deploy/cloudflare/) for bindings and deployment setup.

## Examples

```bash
flue build --target node
flue build --target cloudflare --root ./my-app
flue build --target node --output ./build
```

## Docs Navigation

Current page: [flue build](https://flueframework.com/docs/cli/build/)

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