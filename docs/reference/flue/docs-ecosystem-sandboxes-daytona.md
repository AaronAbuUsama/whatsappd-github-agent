<!-- source: https://flueframework.com/docs/ecosystem/sandboxes/daytona/ -->
---
description: Connect a Flue agent to an application-owned Daytona sandbox.
title: Daytona | Flue
image: https://flueframework.com/docs/og4.jpg
---

# Daytona

Last updated Jun 1, 2026 [ View as Markdown ](https://flueframework.com/docs/ecosystem/sandboxes/daytona/index.md) 

The Daytona adapter adapts an already-initialized Daytona sandbox from `@daytona/sdk` into Flue’s sandbox interface. Use it when a Node-hosted application needs a provider-managed Linux environment with filesystem and shell operations.

## Quickstart

Add provider-managed Linux sandbox capability to an existing Flue project with the [Daytona](https://daytona.io) blueprint. Run the following command in your terminal or coding agent of choice:

```bash
flue add sandbox daytona
```

## Overview

The blueprint installs `@daytona/sdk` when needed and creates `sandboxes/daytona.ts` in your source-root. That file adapts a Daytona sandbox that your application has already created; it does not choose its image, identity, retention, or cleanup policy.

```ts
// flue-blueprint: sandbox/daytona@1
import { createSandboxSessionEnv } from '@flue/runtime';
import type { SandboxApi, SandboxFactory, SessionEnv, FileStat } from '@flue/runtime';
import type { Sandbox as DaytonaSandbox } from '@daytona/sdk';

class DaytonaSandboxApi implements SandboxApi {
  constructor(private sandbox: DaytonaSandbox) {}

  /* Implements file reads, writes, stat, listing, existence, and mkdir with sandbox.fs. */

  /* Forwards recursive removal and rejects unsupported force before deletion. */

  /* Implements exec() with executeCommand(), rounding timeoutMs up to whole seconds. */
}

export function daytona(sandbox: DaytonaSandbox): SandboxFactory {
  return {
    async createSessionEnv(): Promise<SessionEnv> {
      const sandboxCwd = (await sandbox.getWorkDir()) ?? '/home/daytona';
      const api = new DaytonaSandboxApi(sandbox);
      return createSandboxSessionEnv(api, sandboxCwd);
    },
  };
}
```

Pass an initialized Daytona `Sandbox` to `daytona(...)`, then assign the returned factory to an agent’s `sandbox` property. Flue uses the provider’s working directory as the workspace root, exposes Daytona filesystem and process operations through the session, preserves Daytona’s available file metadata, and rounds millisecond command deadlines up to the SDK’s whole-second timeout. Daytona supports recursive deletion but not force semantics, so the adapter rejects `force` before deletion. Your application remains responsible for sandbox creation and lifecycle.

## Configure

| Variable          | Purpose                                            |
| ----------------- | -------------------------------------------------- |
| DAYTONA\_API\_KEY | **Required** — Authenticates with the Daytona API. |

| Requirement                 | Purpose                                                                                       |
| --------------------------- | --------------------------------------------------------------------------------------------- |
| @daytona/sdk package        | **Required** — Creates the Daytona sandbox adapted by Flue.                                   |
| Application-owned lifecycle | **Required** — Creates, retains, and deletes the sandbox, then passes it to daytona(sandbox). |

The generated adapter expects your application to create and own the Daytona sandbox. It does not decide sandbox identity, retention, or cleanup for you.

## Typical use

```ts
import { Daytona } from '@daytona/sdk';
import { defineAgent } from '@flue/runtime';
import { daytona } from '../sandboxes/daytona';

const client = new Daytona({ apiKey: env.DAYTONA_API_KEY });
const sandbox = await client.create();
const agent = defineAgent(() => ({
  model: 'anthropic/claude-sonnet-4-6',
  sandbox: daytona(sandbox),
}));
```

Configure images, snapshots, regions, environment variables, and volumes through the Daytona SDK before passing the sandbox to `daytona(...)`. For a narrower working directory, configure `cwd` on the agent definition; Flue resolves it once against the adapter’s provider-owned base directory during `init()`.

See [Sandboxes](https://flueframework.com/docs/guide/sandboxes/#remote-sandboxes), [Sandbox Adapter API](https://flueframework.com/docs/api/sandbox-api/), and [Daytona’s TypeScript SDK reference](https://www.daytona.io/docs/en/typescript-sdk/daytona/).

## Docs Navigation

Current page: [Daytona](https://flueframework.com/docs/ecosystem/sandboxes/daytona/)

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