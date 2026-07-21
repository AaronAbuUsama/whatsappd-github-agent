<!-- source: https://flueframework.com/docs/ecosystem/sandboxes/cloudflare-shell/ -->
---
description: Use a durable Cloudflare Workspace with code-oriented agent operations.
title: Cloudflare Shell | Flue
image: https://flueframework.com/docs/og4.jpg
---

# Cloudflare Shell

AI-generated, awaiting review [ View as Markdown ](https://flueframework.com/docs/ecosystem/sandboxes/cloudflare-shell/index.md) 

The Cloudflare Shell adapter adapts an application-owned `@cloudflare/shell` `Workspace` into a Flue sandbox on the Cloudflare target. Unlike a Linux shell sandbox, it provides a durable workspace and a model-facing `code` tool that executes JavaScript against workspace state through a Worker Loader binding.

## Quickstart

Add durable workspace sandbox capability to an existing Flue project with the [Cloudflare Shell](https://developers.cloudflare.com/workers/runtime-apis/bindings/worker-loader/) blueprint. Run the following command in your terminal or coding agent of choice:

```bash
flue add sandbox cloudflare-shell
```

## Overview

The blueprint installs `@cloudflare/shell` and `@cloudflare/codemode`, creates `<source-root>/sandboxes/cloudflare-shell.ts`, and adds a Worker Loader binding to Wrangler configuration. The generated adapter exports sandbox construction and default workspace helpers; its file API retries nested writes after recursively creating a missing parent directory.

```ts
// flue-blueprint: sandbox/cloudflare-shell@1
import { Workspace, WorkspaceFileSystem /* ... */ } from '@cloudflare/shell';
import { stateTools } from '@cloudflare/shell/workers';
import { DynamicWorkerExecutor, resolveProvider /* ... */ } from '@cloudflare/codemode';
import type { SandboxFactory, SessionToolFactory /* ... */ } from '@flue/runtime';
import { getCloudflareContext } from '@flue/runtime/cloudflare';

export interface GetShellSandboxOptions {
  workspace: Workspace;
  loader: WorkerLoader;
  executor?: Pick<DynamicWorkerExecutorOptions, 'timeout' | 'globalOutbound' | 'modules'>;
}

export function getShellSandbox(options: GetShellSandboxOptions): SandboxFactory {
  /* ... generated workspace and Worker Loader validation ... */

  const { workspace, loader, executor: executorOptions } = options;
  const fs = new WorkspaceFileSystem(workspace);
  const executor = new DynamicWorkerExecutor({
    loader,
    ...executorOptions,
  });
  const stateProvider = resolveProvider(stateTools(workspace));
  const toolFactory: SessionToolFactory = () => [createCodeTool(executor, stateProvider)];

  return {
    async createSessionEnv() {
      return createWorkspaceSessionEnv(workspace, fs, '/');
    },
    tools: toolFactory,
  };
}

/* ... generated workspace session environment and code tool implementation ... */

export function getDefaultWorkspace(): Workspace {
  const { storage } = getCloudflareContext();
  return new Workspace({ sql: storage.sql });
}
```

Create a workspace, then pass it with the `worker_loaders` binding to `getShellSandbox(...)`. Agents receive durable file operations and the isolated JavaScript `code` tool; they do not receive Linux command execution. Application-specific data loading into the workspace remains application-owned.

## Configure

| Requirement                            | Purpose                                                                                                                              |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Cloudflare target                      | **Required** — Runs the Workspace and Worker Loader integration.                                                                     |
| @cloudflare/shell package              | **Required** — Provides the durable Workspace.                                                                                       |
| @cloudflare/codemode package           | **Required** — Provides code-oriented model operations.                                                                              |
| worker\_loaders binding such as LOADER | **Required on Cloudflare** — Executes JavaScript against Workspace state; this is a Cloudflare binding, not an environment variable. |
| Environment-variable credentials       | **Not required** — The integration uses the worker\_loaders binding instead.                                                         |
| Ordinary Linux shell                   | **Not provided** — This adapter provides a model-facing code tool, not shell command execution.                                      |

Import the generated helpers from your project adapter file, not from `@flue/runtime/cloudflare`:

```ts
import { getDefaultWorkspace, getShellSandbox } from '../sandboxes/cloudflare-shell';
```

## Choose this adapter when

Use Cloudflare Shell when files must be stored in a durable Workspace and agent work can be expressed through Workspace operations. It is not interchangeable with a container: `harness.shell(...)` and `session.shell(...)` do not provide Linux command execution through this adapter.

If the workspace should survive later user interactions, associate it with a stable addressable agent instance. A workspace created inside one workflow invocation belongs to that invocation’s owner rather than forming a shared cross-run workspace.

See [Sandboxes](https://flueframework.com/docs/guide/sandboxes/) and [Deploy on Cloudflare](https://flueframework.com/docs/ecosystem/deploy/cloudflare/).

## Docs Navigation

Current page: [Cloudflare Shell](https://flueframework.com/docs/ecosystem/sandboxes/cloudflare-shell/)

### Sections

* [Guide](https://flueframework.com/docs/getting-started/quickstart/)
* [Reference](https://flueframework.com/docs/api/agent-api/)
* [CLI](https://flueframework.com/docs/cli/overview/)
* [SDK](https://flueframework.com/docs/sdk/overview/)
* [Ecosystem](https://flueframework.com/docs/ecosystem/)

* [  Overview ](https://flueframework.com/docs/ecosystem/)

### Channels

* [ Discord ](https://flueframework.com/docs/ecosystem/channels/discord/)
* [ Facebook ](https://flueframework.com/docs/ecosystem/channels/messenger/)
* [ GitHub ](https://flueframework.com/docs/ecosystem/channels/github/)
* [ Google Chat ](https://flueframework.com/docs/ecosystem/channels/google-chat/)
* [ Intercom ](https://flueframework.com/docs/ecosystem/channels/intercom/)
* [ Linear ](https://flueframework.com/docs/ecosystem/channels/linear/)
* [ Microsoft Teams ](https://flueframework.com/docs/ecosystem/channels/teams/)
* [ Notion ](https://flueframework.com/docs/ecosystem/channels/notion/)
* [ Resend ](https://flueframework.com/docs/ecosystem/channels/resend/)
* [ Salesforce ](https://flueframework.com/docs/ecosystem/channels/salesforce-marketing-cloud/)
* [ Shopify ](https://flueframework.com/docs/ecosystem/channels/shopify/)
* [ Slack ](https://flueframework.com/docs/ecosystem/channels/slack/)
* [ Stripe ](https://flueframework.com/docs/ecosystem/channels/stripe/)
* [ Telegram ](https://flueframework.com/docs/ecosystem/channels/telegram/)
* [ Twilio ](https://flueframework.com/docs/ecosystem/channels/twilio/)
* [ WhatsApp ](https://flueframework.com/docs/ecosystem/channels/whatsapp/)
* [ Zendesk ](https://flueframework.com/docs/ecosystem/channels/zendesk/)

### Sandboxes

* [ boxd ](https://flueframework.com/docs/ecosystem/sandboxes/boxd/)
* [ Cloudflare Shell ](https://flueframework.com/docs/ecosystem/sandboxes/cloudflare-shell/)
* [ Cloudflare Sandbox ](https://flueframework.com/docs/ecosystem/sandboxes/cloudflare/)
* [ Daytona ](https://flueframework.com/docs/ecosystem/sandboxes/daytona/)
* [ E2B ](https://flueframework.com/docs/ecosystem/sandboxes/e2b/)
* [ exe.dev ](https://flueframework.com/docs/ecosystem/sandboxes/exedev/)
* [ islo ](https://flueframework.com/docs/ecosystem/sandboxes/islo/)
* [ Mirage ](https://flueframework.com/docs/ecosystem/sandboxes/mirage/)
* [ Modal ](https://flueframework.com/docs/ecosystem/sandboxes/modal/)
* [ Vercel Sandbox ](https://flueframework.com/docs/ecosystem/sandboxes/vercel/)

### Deploy

* [ AWS ](https://flueframework.com/docs/ecosystem/deploy/aws/)
* [ Cloudflare ](https://flueframework.com/docs/ecosystem/deploy/cloudflare/)
* [ Docker ](https://flueframework.com/docs/ecosystem/deploy/docker/)
* [ Fly.io ](https://flueframework.com/docs/ecosystem/deploy/fly/)
* [ GitHub Actions ](https://flueframework.com/docs/ecosystem/deploy/github-actions/)
* [ GitLab CI/CD ](https://flueframework.com/docs/ecosystem/deploy/gitlab-ci/)
* [ Node.js ](https://flueframework.com/docs/ecosystem/deploy/node/)
* [ Railway ](https://flueframework.com/docs/ecosystem/deploy/railway/)
* [ Render ](https://flueframework.com/docs/ecosystem/deploy/render/)
* [ SST ](https://flueframework.com/docs/ecosystem/deploy/sst/)

### Databases

* [ libSQL ](https://flueframework.com/docs/ecosystem/databases/libsql/)
* [ MongoDB ](https://flueframework.com/docs/ecosystem/databases/mongodb/)
* [ MySQL ](https://flueframework.com/docs/ecosystem/databases/mysql/)
* [ Postgres ](https://flueframework.com/docs/ecosystem/databases/postgres/)
* [ Redis ](https://flueframework.com/docs/ecosystem/databases/redis/)
* [ Supabase ](https://flueframework.com/docs/ecosystem/databases/supabase/)
* [ Turso ](https://flueframework.com/docs/ecosystem/databases/turso/)
* [ Valkey ](https://flueframework.com/docs/ecosystem/databases/valkey/)

### Tooling

* [ Braintrust ](https://flueframework.com/docs/ecosystem/tooling/braintrust/)
* [ OpenTelemetry ](https://flueframework.com/docs/ecosystem/tooling/opentelemetry/)
* [ Sentry ](https://flueframework.com/docs/ecosystem/tooling/sentry/)
* [ Vitest Evals ](https://flueframework.com/docs/ecosystem/tooling/vitest-evals/)