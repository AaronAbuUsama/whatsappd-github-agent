<!-- source: https://flueframework.com/docs/reference/configuration/ -->
---
description: Reference for flue.config.ts options.
title: Configuration | Flue
image: https://flueframework.com/docs/og4.jpg
---

# Configuration

AI-generated, awaiting review [ View as Markdown ](https://flueframework.com/docs/reference/configuration/index.md) 

Use `flue.config.ts` to select the build target, project root, and build output directory. Import `defineConfig()` from `@flue/cli/config` for type checking and editor completion:

```ts
import { defineConfig } from '@flue/cli/config';

export default defineConfig({
  target: 'node',
});
```

Only the options listed below are accepted. Flue recognizes `flue.config.ts`, `.mts`, `.mjs`, `.js`, `.cjs`, and `.cts`, in that priority order. TypeScript configuration files are loaded directly by Node and must use erasable syntax.

For source-module placement, see [Project Layout](https://flueframework.com/docs/guide/project-layout/). For configuration-file discovery, command-line overrides, and environment files, see the [CLI reference](https://flueframework.com/docs/cli/overview/).

## `target`

* **Type:** `'node' | 'cloudflare'`
* **Default:** none

Build and development target. This option is required unless `--target` is passed to the CLI.

* `'node'` builds a Node.js server.
* `'cloudflare'` builds a Workers-compatible application.

## `root`

* **Type:** `string`
* **Default:** directory containing the selected `flue.config.*` file, or the selected search directory when no configuration file is loaded

Project root. Must not be empty. Relative values loaded from a configuration file resolve from the directory containing that file.

Flue uses the first matching source location:

1. `<root>/.flue` when it exists as a directory
2. `<root>/src` when it exists as a directory
3. `<root>`

## `output`

* **Type:** `string`
* **Default:** `<root>/dist`

Build output directory. Must not be empty. Relative values loaded from a configuration file resolve from the directory containing that file, not from `root`.

## Vite configuration

Export `vite` from `flue.config.ts` to pass native Vite configuration to the development server. Use Vite’s `defineConfig()` helper for type checking.

```ts
import { defineConfig as defineViteConfig } from 'vite';
import { defineConfig } from '@flue/cli/config';

export default defineConfig({
  target: 'node',
});

export const vite = defineViteConfig({
  server: {
    watch: {
      ignored: ['**/evals/results/**'],
    },
  },
});
```

Flue owns the Vite project root, server mode, host, port, and its internal plugins. Other Vite options are merged into the Node and Cloudflare development servers.

## `defineConfig()`

```ts
function defineConfig(config: UserFlueConfig): UserFlueConfig;
```

Provides type checking and editor completion for `flue.config.ts`. Returns the configuration unchanged.

## Docs Navigation

Current page: [Configuration](https://flueframework.com/docs/reference/configuration/)

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