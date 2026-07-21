<!-- source: https://flueframework.com/docs/ecosystem/sandboxes/modal/ -->
---
description: Connect a Flue agent to an application-owned Modal Sandbox.
title: Modal | Flue
image: https://flueframework.com/docs/og4.jpg
---

# Modal

Last updated May 30, 2026 [ View as Markdown ](https://flueframework.com/docs/ecosystem/sandboxes/modal/index.md) 

The Modal adapter adapts an already-initialized Modal Sandbox from the `modal` JavaScript SDK into Flue’s sandbox interface. Use it for provider-backed command execution and files when your application provisions Modal sandbox resources.

## Quickstart

Add provider-backed compute sandbox capability to an existing Flue project with the [Modal](https://modal.com) blueprint. Run the following command in your terminal or coding agent of choice:

```bash
flue add sandbox modal
```

## Overview

The Modal blueprint installs the `modal` JavaScript SDK when needed and creates `sandboxes/modal.ts` in your source-root. The generated adapter accepts an application-created Modal `Sandbox`; provisioning, image selection, credentials, and shutdown remain outside the adapter.

```ts
// flue-blueprint: sandbox/modal@1
import { createSandboxSessionEnv } from '@flue/runtime';
import type { SandboxApi, SandboxFactory, SessionEnv, FileStat } from '@flue/runtime';
import type { Sandbox as ModalSandbox } from 'modal';

export interface ModalAdapterOptions {
  cwd?: string;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

class ModalSandboxApi implements SandboxApi {
  constructor(private sandbox: ModalSandbox) {}

  /* Adapts Modal open/read/write handles and closes every opened file. */

  /* Implements stat, readdir, exists, mkdir, and rm with quoted shell utilities. */

  /* Runs commands through bash -lc, forwards timeoutMs, and drains both output streams. */
}

export function modal(sandbox: ModalSandbox, options?: ModalAdapterOptions): SandboxFactory {
  return {
    async createSessionEnv(): Promise<SessionEnv> {
      const sandboxCwd = options?.cwd ?? '/';
      const api = new ModalSandboxApi(sandbox);
      return createSandboxSessionEnv(api, sandboxCwd);
    },
  };
}
```

Passing `modal(sandbox)` as an agent’s `sandbox` exposes the created Modal Sandbox’s files and command execution through Flue, with relative paths rooted at `/` unless you set `cwd`. The selected image must provide `bash` and compatible filesystem utilities for operations that Modal’s SDK does not expose directly; the generated `stat` parser supports the output used by GNU and BusyBox `stat`, and `rm` receives the requested recursive and force flags.

## Configure

| Variable             | Purpose                                                                                                          |
| -------------------- | ---------------------------------------------------------------------------------------------------------------- |
| MODAL\_TOKEN\_ID     | **Required without \~/.modal.toml** — Identifies the Modal token when file-based credentials are unavailable.    |
| MODAL\_TOKEN\_SECRET | **Required without \~/.modal.toml** — Authenticates the Modal token when file-based credentials are unavailable. |

| Requirement          | Purpose                                                                            |
| -------------------- | ---------------------------------------------------------------------------------- |
| modal package        | **Required** — Provides the Modal JavaScript SDK.                                  |
| Node.js 22 or later  | **Required** — Runs the SDK used by the generated adapter.                         |
| Suitable Modal image | **Required** — Provides the shell and system utilities required by the agent work. |

## Choose this adapter when

Use Modal when your application already manages Modal applications, images, or sandbox lifetimes and needs to expose that compute boundary to Flue operations. The adapter adapts the created sandbox; creation, shutdown, secret handling, networking, and image content remain your responsibility.

See [Sandboxes](https://flueframework.com/docs/guide/sandboxes/) and [Sandbox Adapter API](https://flueframework.com/docs/api/sandbox-api/).

## Docs Navigation

Current page: [Modal](https://flueframework.com/docs/ecosystem/sandboxes/modal/)

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