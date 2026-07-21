<!-- source: https://flueframework.com/docs/ecosystem/sandboxes/mirage/ -->
---
description: Connect Flue agents to Mirage workspaces and mounted resources.
title: Mirage | Flue
image: https://flueframework.com/docs/og4.jpg
---

# Mirage

Last updated May 30, 2026 [ View as Markdown ](https://flueframework.com/docs/ecosystem/sandboxes/mirage/index.md) 

The Mirage adapter adapts an application-owned Mirage `Workspace` into Flue’s sandbox interface. Mirage offers runtime packages for Node and browser-class runtimes, allowing the adapter pattern to be used on Node or Cloudflare when you choose compatible resources.

## Quickstart

Add mounted workspace sandbox capability to an existing Flue project with the [Mirage](https://docs.mirage.strukto.ai) blueprint. Run the following command in your terminal or coding agent of choice:

```bash
flue add sandbox mirage
```

## Overview

The Mirage blueprint installs `@struktoai/mirage-node` for Node or `@struktoai/mirage-browser` for Cloudflare when needed, then creates `sandboxes/mirage.ts` in your source-root. The generated adapter accepts an application-created `Workspace`; resource mounts, credentials, writable boundaries, and lifetime remain application-owned.

```ts
// flue-blueprint: sandbox/mirage@1
import { createSandboxSessionEnv } from '@flue/runtime';
import type { SandboxApi, SandboxFactory, SessionEnv, FileStat } from '@flue/runtime';
import type { Workspace as MirageWorkspace } from '@struktoai/mirage-core';

export interface MirageAdapterOptions {
  cwd?: string;
}

/* ... generated shellQuote() helper ... */

class MirageSandboxApi implements SandboxApi {
  constructor(
    private workspace: MirageWorkspace,
    private flueContextId: string,
  ) {}

  /* ... generated workspace.fs operations; rm rejects recursive and force before mutation ... */

  async stat(path: string): Promise<FileStat> {
    const s = await this.workspace.fs.stat(path);
    return {
      isFile: s.type === 'file',
      isDirectory: s.type === 'directory',
      ...(s.size === null ? {} : { size: s.size }),
      ...(s.modified === null ? {} : { mtime: new Date(s.modified) }),
    };
  }

  async exec(
    command: string,
    options?: {
      cwd?: string;
      env?: Record<string, string>;
      timeoutMs?: number;
      signal?: AbortSignal;
    },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return this.runShell(command, options);
  }

  private async runShell(
    command: string,
    options?: {
      cwd?: string;
      env?: Record<string, string>;
      timeoutMs?: number;
      signal?: AbortSignal;
    },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const timeoutSignal =
      typeof options?.timeoutMs === 'number' ? AbortSignal.timeout(options.timeoutMs) : undefined;
    const callerSignal = options?.signal;
    const signal =
      callerSignal && timeoutSignal
        ? AbortSignal.any([callerSignal, timeoutSignal])
        : (callerSignal ?? timeoutSignal);

    try {
      const result = await this.workspace.execute(command, {
        sessionId: this.flueContextId,
        cwd: options?.cwd,
        env: options?.env,
        signal,
      });
      return {
        stdout: result.stdoutText,
        stderr: result.stderrText,
        exitCode: result.exitCode,
      };
    } catch (err) {
      if (callerSignal?.aborted) throw err;
      const isTimeout =
        timeoutSignal?.aborted &&
        (err === timeoutSignal.reason ||
          (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')));
      if (isTimeout) {
        return {
          stdout: '',
          stderr: `[flue:mirage] Command timed out after ${options?.timeoutMs} milliseconds.`,
          exitCode: 124,
        };
      }
      throw err;
    }
  }
}

export function mirage(workspace: MirageWorkspace, options?: MirageAdapterOptions): SandboxFactory {
  return {
    async createSessionEnv({ id }: { id: string }): Promise<SessionEnv> {
      try {
        workspace.createSession(id);
      } catch {
        workspace.getSession(id);
      }

      const sandboxCwd = options?.cwd ?? '/';
      const api = new MirageSandboxApi(workspace, id);
      return createSandboxSessionEnv(api, sandboxCwd);
    },
  };
}
```

Pass `mirage(workspace)` as an agent’s `sandbox` to expose mounted resources through a Mirage session keyed by the Flue context id. File stats preserve Mirage’s unknown size or modification time by omitting those fields; `timeoutMs` creates a millisecond timeout signal, caller cancellation takes precedence, and only timeout cancellation becomes an exit-code-124 result. Mirage’s direct filesystem API does not implement recursive or force removal, so the adapter rejects either option before mutation.

## Configure

| Requirement                              | Purpose                                                                                   |
| ---------------------------------------- | ----------------------------------------------------------------------------------------- |
| @struktoai/mirage-node package           | **Required on Node.js** — Provides Node-compatible Mirage Workspace resources.            |
| @struktoai/mirage-browser package        | **Required on Cloudflare** — Provides browser-compatible Workspace resources only.        |
| Application-owned resource configuration | **Required** — Defines mounts, credentials, writable boundaries, and lifetime.            |
| Environment-variable credentials         | **Not required** — Mirage resource credentials are configured by the application instead. |

The generated adapter uses Mirage’s shared workspace contract. Some Mirage resources, such as SSH- or database-oriented Node resources, require the Node runtime and must not be imported into a Cloudflare build.

## Choose this adapter when

Use Mirage when your application wants to assemble a workspace from explicit mounted resources and present that workspace to an agent through a single sandbox boundary. Your application owns resource mounting, credentials, writable boundaries, and workspace lifetime.

See [Sandboxes](https://flueframework.com/docs/guide/sandboxes/), [Deploy on Node.js](https://flueframework.com/docs/ecosystem/deploy/node/), [Deploy on Cloudflare](https://flueframework.com/docs/ecosystem/deploy/cloudflare/), and [Sandbox Adapter API](https://flueframework.com/docs/api/sandbox-api/).

## Docs Navigation

Current page: [Mirage](https://flueframework.com/docs/ecosystem/sandboxes/mirage/)

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