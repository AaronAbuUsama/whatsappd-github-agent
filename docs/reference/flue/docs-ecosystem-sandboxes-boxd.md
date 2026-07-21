<!-- source: https://flueframework.com/docs/ecosystem/sandboxes/boxd/ -->
---
description: Connect a Flue agent to an application-owned boxd Linux VM.
title: boxd | Flue
image: https://flueframework.com/docs/og4.jpg
---

# boxd

Last updated May 30, 2026 [ View as Markdown ](https://flueframework.com/docs/ecosystem/sandboxes/boxd/index.md) 

The boxd adapter adapts an already-initialized boxd `Box` from `@boxd-sh/sdk` into Flue’s sandbox interface. Use it when an agent needs a provider-backed Linux virtual machine with filesystem and shell behavior rather than the lightweight default workspace.

## Quickstart

Add provider-backed Linux VM sandbox capability to an existing Flue project with the [boxd](https://boxd.sh) blueprint. Run the following command in your terminal or coding agent of choice:

```bash
flue add sandbox boxd
```

## Overview

The boxd blueprint installs `@boxd-sh/sdk` when needed and creates `sandboxes/boxd.ts` in your source-root. The generated adapter accepts an application-created boxd `Box`; it does not create, retain, or delete the VM.

```ts
// flue-blueprint: sandbox/boxd@1
import { createSandboxSessionEnv } from '@flue/runtime';
import type { SandboxApi, SandboxFactory, SessionEnv, FileStat } from '@flue/runtime';
import type { Box as BoxdBox } from '@boxd-sh/sdk';

export interface BoxdAdapterOptions {
  cwd?: string;
  readyTimeoutMs?: number;
}

async function waitForReady(box: BoxdBox, timeoutMs: number): Promise<void> {
  /* Polls box.exec(['true']) until the VM is ready or the deadline passes. */
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

class BoxdSandboxApi implements SandboxApi {
  constructor(private box: BoxdBox) {}

  /* Adapts direct boxd file reads and writes. */

  /* Implements stat, readdir, exists, mkdir, and rm with quoted shell utilities. */

  /* Runs commands through bash -lc and forwards env and timeoutMs unchanged. */
}

export function boxd(box: BoxdBox, options?: BoxdAdapterOptions): SandboxFactory {
  let readyPromise: Promise<void> | undefined;
  return {
    async createSessionEnv(): Promise<SessionEnv> {
      const sandboxCwd = options?.cwd ?? '/home/boxd';
      readyPromise ??= waitForReady(box, options?.readyTimeoutMs ?? 30_000);
      await readyPromise;
      const api = new BoxdSandboxApi(box);
      return createSandboxSessionEnv(api, sandboxCwd);
    },
  };
}
```

Passing `boxd(box)` as an agent’s `sandbox` waits for that VM’s exec endpoint once, then exposes its files and Linux shell through Flue. Relative paths resolve from `/home/boxd` unless you set `cwd`; command timeouts remain in milliseconds, `stat` validates GNU metadata output, and `rm` receives the requested recursive and force flags, while VM identity, credentials, networking, persistence, and cleanup remain application-owned.

## Configure

| Variable       | Purpose                                                                                                            |
| -------------- | ------------------------------------------------------------------------------------------------------------------ |
| BOXD\_API\_KEY | **Alternative authentication** — Authenticates with boxd when a short-lived token is not used.                     |
| BOXD\_TOKEN    | **Alternative authentication** — Provides provider-supported short-lived authentication instead of BOXD\_API\_KEY. |

| Requirement                 | Purpose                                                        |
| --------------------------- | -------------------------------------------------------------- |
| One boxd credential         | **Required** — Uses either BOXD\_API\_KEY or BOXD\_TOKEN.      |
| @boxd-sh/sdk package        | **Required** — Creates the Linux VM adapted to SandboxFactory. |
| Application-owned lifecycle | **Required** — Creates, reuses, and deletes the VM.            |

The generated adapter expects your application to create and own the boxd VM. It does not decide VM identity, retention, or cleanup for you.

## Use it when

Choose boxd when a task requires real Linux command behavior in an isolated provider VM, particularly where a separate VM per workspace or agent instance is part of your application design.

Before reusing a VM across sessions or tenants, define identity, authorization, egress, secrets, and cleanup policies. Conversation persistence remains controlled separately by Flue session storage.

See [Sandboxes](https://flueframework.com/docs/guide/sandboxes/) for execution-boundary design and [Sandbox Adapter API](https://flueframework.com/docs/api/sandbox-api/) for the adapter contract.

## Docs Navigation

Current page: [boxd](https://flueframework.com/docs/ecosystem/sandboxes/boxd/)

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