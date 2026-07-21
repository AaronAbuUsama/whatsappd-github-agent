<!-- source: https://flueframework.com/docs/ecosystem/sandboxes/islo/ -->
---
description: Connect a Node-target Flue application to a named islo sandbox through its CLI.
title: islo | Flue
image: https://flueframework.com/docs/og4.jpg
---

# islo

Last updated May 30, 2026 [ View as Markdown ](https://flueframework.com/docs/ecosystem/sandboxes/islo/index.md) 

The islo adapter adapts a named islo sandbox into Flue’s sandbox interface by invoking the local `islo` CLI. It is designed for a Node.js server, container, or CI runner where the binary is installed and can launch remote commands.

## Quickstart

Add named remote sandbox capability to an existing Flue project with the [islo](https://islo.dev) blueprint. Run the following command in your terminal or coding agent of choice:

```bash
flue add sandbox islo
```

## Overview

The islo blueprint creates `sandboxes/islo.ts` in your source-root without adding an npm dependency. The generated adapter uses Node’s child-process API and expects an authenticated `islo` binary plus an application-managed sandbox name.

```ts
// flue-blueprint: sandbox/islo@1
import { spawn } from 'node:child_process';
import { createSandboxSessionEnv } from '@flue/runtime';
import type { SandboxApi, SandboxFactory, SessionEnv, FileStat } from '@flue/runtime';

export interface IsloAdapterOptions {
  cwd?: string;
  cliPath?: string;
}

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

class IsloSandboxApi implements SandboxApi {
  constructor(
    private name: string,
    private cliPath: string,
  ) {}

  async exec(
    command: string,
    options?: {
      cwd?: string;
      env?: Record<string, string>;
      timeoutMs?: number;
      signal?: AbortSignal;
    },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const cd = options?.cwd ? `cd ${q(options.cwd)} && ` : '';
    const envPrefix = options?.env
      ? Object.entries(options.env)
          .map(([k, v]) => `${k}=${q(v)}`)
          .join(' ') + ' '
      : '';
    const tmo =
      typeof options?.timeoutMs === 'number' ? `timeout ${options.timeoutMs / 1000} ` : '';
    const remote = `${envPrefix}${tmo}bash -lc ${q(cd + command)}`;
    const args = ['--output', 'json', 'use', this.name, '--', 'bash', '-lc', remote];

    /* ... spawn the islo CLI and map its output and exit code ... */
  }

  /* ... generated file operations using quoted remote shell commands ... */
}

export function islo(name: string, options?: IsloAdapterOptions): SandboxFactory {
  const cliPath = options?.cliPath ?? 'islo';
  return {
    async createSessionEnv(): Promise<SessionEnv> {
      const sandboxCwd = options?.cwd ?? '/workspace';
      const api = new IsloSandboxApi(name, cliPath);
      return createSandboxSessionEnv(api, sandboxCwd);
    },
  };
}
```

Pass a sandbox name to `islo(...)` and assign the returned factory to an agent’s `sandbox` property. Flue resolves relative paths from `/workspace`; the adapter converts `timeoutMs` from milliseconds to seconds for GNU `timeout` inside the sandbox, while the CLI handles remote execution and file operations.

## Configure

| Variable       | Purpose                                                                                                                |
| -------------- | ---------------------------------------------------------------------------------------------------------------------- |
| ISLO\_API\_KEY | **Alternative authentication** — Authenticates server or CI operation when existing CLI authentication is unavailable. |

| Requirement                            | Purpose                                                                   |
| -------------------------------------- | ------------------------------------------------------------------------- |
| Existing CLI authentication or API key | **Required** — Authenticates through the CLI session or ISLO\_API\_KEY.   |
| Node.js child-process capability       | **Required** — Allows the adapter to invoke the CLI.                      |
| islo binary on PATH                    | **Required** — Executes remote shell and file operations.                 |
| Named islo sandbox                     | **Required** — Identifies the application- or deployment-managed sandbox. |

## Choose this adapter when

Use islo when an application can rely on a host-installed CLI and wants to connect to named sandboxes from a Node execution environment. Do not use it in Cloudflare Workers or other runtimes that cannot execute native child processes.

The adapter runs remote shell/file work through the CLI; ensure its host process, credentials, and agent inputs match your intended trust boundary.

See [Deploy on Node.js](https://flueframework.com/docs/ecosystem/deploy/node/), [Sandboxes](https://flueframework.com/docs/guide/sandboxes/), and [Sandbox Adapter API](https://flueframework.com/docs/api/sandbox-api/).

## Docs Navigation

Current page: [islo](https://flueframework.com/docs/ecosystem/sandboxes/islo/)

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