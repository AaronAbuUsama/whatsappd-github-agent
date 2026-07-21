<!-- source: https://flueframework.com/docs/ecosystem/sandboxes/e2b/ -->
---
description: Connect a Flue agent to an E2B Linux sandbox.
title: E2B | Flue
image: https://flueframework.com/docs/og4.jpg
---

# E2B

Last updated May 30, 2026 [ View as Markdown ](https://flueframework.com/docs/ecosystem/sandboxes/e2b/index.md) 

The E2B adapter adapts an initialized E2B sandbox from the `e2b` package into Flue’s sandbox interface. Use it for provider-managed Linux execution when an agent needs shell commands and workspace files outside the application host.

## Quickstart

Add provider-managed Linux sandbox capability to an existing Flue project with the [E2B](https://e2b.dev) blueprint. Run the following command in your terminal or coding agent of choice:

```bash
flue add sandbox e2b
```

## Overview

The blueprint installs `e2b` when needed and creates `sandboxes/e2b.ts` in your source-root. That file adapts an E2B sandbox that your application has already created; it does not create, retain, or close provider resources.

```ts
// flue-blueprint: sandbox/e2b@1
import { createSandboxSessionEnv } from '@flue/runtime';
import type { SandboxApi, SandboxFactory, SessionEnv, FileStat } from '@flue/runtime';
import type { Sandbox as E2BSandbox } from 'e2b';

class E2BSandboxApi implements SandboxApi {
  constructor(private sandbox: E2BSandbox) {}

  /* Implements file reads, writes, stat, listing, existence, and mkdir with sandbox.files. */

  /* Rejects recursive or force before calling sandbox.files.remove(). */

  /* Implements exec() with sandbox.commands.run(), forwarding timeoutMs unchanged. */
}

export function e2b(sandbox: E2BSandbox): SandboxFactory {
  return {
    async createSessionEnv(): Promise<SessionEnv> {
      const sandboxCwd = '/home/user';
      const api = new E2BSandboxApi(sandbox);
      return createSandboxSessionEnv(api, sandboxCwd);
    },
  };
}
```

Pass an initialized E2B `Sandbox` to `e2b(...)`, then assign the returned factory to an agent’s `sandbox` property. Flue resolves workspace paths from `/home/user`, exposes E2B’s files and commands through session operations, forwards command timeouts in milliseconds, and reports only the file metadata E2B exposes. E2B’s direct remove API has no recursive or force controls, so the adapter rejects either option before deletion. Your application remains responsible for sandbox configuration and lifecycle.

## Configure

| Variable      | Purpose                                        |
| ------------- | ---------------------------------------------- |
| E2B\_API\_KEY | **Required** — Authenticates with the E2B API. |

| Requirement                    | Purpose                                                                     |
| ------------------------------ | --------------------------------------------------------------------------- |
| e2b package                    | **Required** — Provides the initialized E2B sandbox adapted by Flue.        |
| Provider-managed Linux sandbox | **Required** — Supplies the command and filesystem environment.             |
| Application-owned lifecycle    | **Required** — Creates the sandbox and closes or retains it as appropriate. |

## Integration shape

```ts
import { Sandbox } from 'e2b';
import { defineAgent } from '@flue/runtime';
import { e2b } from '../sandboxes/e2b';

const sandbox = await Sandbox.create();
const agent = defineAgent(() => ({
  model: 'anthropic/claude-sonnet-4-6',
  sandbox: e2b(sandbox),
}));
```

Select templates, timeouts, network access, secret exposure, and resource reuse through your application and provider policy. Flue adapts the active environment; it does not choose provider retention for you.

See [Sandboxes](https://flueframework.com/docs/guide/sandboxes/) and [Sandbox Adapter API](https://flueframework.com/docs/api/sandbox-api/).

## Docs Navigation

Current page: [E2B](https://flueframework.com/docs/ecosystem/sandboxes/e2b/)

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