<!-- source: https://flueframework.com/docs/ecosystem/sandboxes/exedev/ -->
---
description: Connect a Node-target Flue application to an exe.dev VM over SSH.
title: exe.dev | Flue
image: https://flueframework.com/docs/og4.jpg
---

# exe.dev

Last updated May 30, 2026 [ View as Markdown ](https://flueframework.com/docs/ecosystem/sandboxes/exedev/index.md) 

The exe.dev adapter adapts an existing exe.dev VM into Flue’s sandbox interface using SSH for commands and SFTP for files. Because it depends on Node.js APIs and `ssh2`, use it with the Node target rather than a Cloudflare Worker target.

## Quickstart

Add SSH-backed sandbox capability to an existing Flue project with the [exe.dev](https://exe.dev) blueprint. Run the following command in your terminal or coding agent of choice:

```bash
flue add sandbox exedev
```

## Overview

The blueprint installs `ssh2` and its TypeScript declarations, then creates `sandboxes/exedev.ts` in your source-root. The generated Node adapter uses SSH and SFTP for an existing VM and also exports optional helpers for explicit VM creation, cloning, readiness checks, and deletion.

```ts
// flue-blueprint: sandbox/exedev@1
import { createSandboxSessionEnv } from '@flue/runtime';
import type { FileStat, SandboxApi, SandboxFactory, SessionEnv } from '@flue/runtime';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Client as SSHClient } from 'ssh2';
import type { ConnectConfig, SFTPWrapper } from 'ssh2';

/* ... generated VM and option interfaces, error type, and HTTPS lifecycle helpers ... */
/* ... generated SSH authentication, retry, connection, and stream interfaces ... */

export class ExeDevSandboxApi implements SandboxApi {
  /* ... generated SFTP connection and file operations ... */

  async exec(
    command: string,
    options?: {
      cwd?: string;
      env?: Record<string, string>;
      timeoutMs?: number;
      signal?: AbortSignal;
    },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    /* ... generate the SSH command from env, cwd, and command ... */
    /* ... collect both output streams and close the stream after timeoutMs ... */
    /* ... return exit code 124 when the timeout closes the stream ... */
  }
}

export function exedev(vm: ExeDevVm | string, options?: ExeDevAdapterOptions): SandboxFactory {
  const resolvedVm = typeof vm === 'string' ? { host: vm } : vm;
  return {
    async createSessionEnv(): Promise<SessionEnv> {
      const { ssh } = await sshConnect(resolvedVm, options ?? {});
      const api = new ExeDevSandboxApi(ssh);

      let sandboxCwd = '/home/user';
      try {
        const { stdout } = await api.exec('echo $HOME');
        const detected = stdout.trim();
        if (detected) sandboxCwd = detected;
      } catch {
        /* ... retain /home/user when home-directory detection fails ... */
      }

      return createSandboxSessionEnv(api, sandboxCwd);
    },
  };
}
```

Pass an SSH-reachable VM hostname or `ExeDevVm` to `exedev(...)` and assign the returned factory to an agent’s `sandbox` property. Flue uses the detected remote home directory when available; `timeoutMs` remains in milliseconds and closes the SSH command stream at the deadline, returning exit code 124\. File removal uses SFTP directly, so recursive and force options are rejected before mutation rather than emulated with a one-off shell command.

## Configure

| Variable        | Purpose                                                                                       |
| --------------- | --------------------------------------------------------------------------------------------- |
| EXE\_VM\_HOST   | **Required** — Identifies the exe.dev VM used to wire the sandbox adapter.                    |
| EXE\_SSH\_KEY   | **Optional** — Points to a private SSH key file.                                              |
| SSH\_AUTH\_SOCK | **Optional** — Authenticates through an SSH agent instead of EXE\_SSH\_KEY.                   |
| EXE\_API\_TOKEN | **Required for lifecycle examples** — Authenticates helpers that manage exe.dev VM lifecycle. |

| Requirement                       | Purpose                                                                   |
| --------------------------------- | ------------------------------------------------------------------------- |
| Node.js target                    | **Required** — Provides the Node APIs used by the adapter and SSH client. |
| ssh2 package                      | **Required** — Provides SSH command execution and SFTP file access.       |
| Existing SSH-reachable exe.dev VM | **Required** — Supplies the remote sandbox resource.                      |
| SSH configuration                 | **Required** — Authenticates access to the VM.                            |

## Choose this adapter when

Use exe.dev when a Node-hosted Flue application should operate inside a VM you reach through SSH/SFTP. The adapter blueprint includes optional lifecycle helpers, but the sandbox adapter itself is designed around a VM your application owns.

Treat SSH keys and provider tokens as server-side secrets. Decide whether agent instances share or allocate VMs, and clean up application-owned VMs according to your retention policy.

See [Deploy on Node.js](https://flueframework.com/docs/ecosystem/deploy/node/), [Sandboxes](https://flueframework.com/docs/guide/sandboxes/), and [Sandbox Adapter API](https://flueframework.com/docs/api/sandbox-api/).

## Docs Navigation

Current page: [exe.dev](https://flueframework.com/docs/ecosystem/sandboxes/exedev/)

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