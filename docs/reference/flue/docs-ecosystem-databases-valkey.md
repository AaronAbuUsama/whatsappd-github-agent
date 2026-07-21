<!-- source: https://flueframework.com/docs/ecosystem/databases/valkey/ -->
---
description: Give Flue agents and workflow runs durable, shared state with Valkey.
title: Valkey | Flue
image: https://flueframework.com/docs/og4.jpg
---

# Valkey

AI-generated, awaiting review [ View as Markdown ](https://flueframework.com/docs/ecosystem/databases/valkey/index.md) [  @flue/redis ](https://www.npmjs.com/package/@flue/redis) 

## Quickstart

Add durable, shared state to an existing Flue project with the [Valkey](https://valkey.io) blueprint. Run the following command in your terminal or coding agent of choice:

```sh
flue add database valkey
```

## Overview

The Valkey blueprint installs `@flue/redis` and the official Redis `redis`client, creates a `db.ts` in the project’s source-root, and follows the project’s existing secret convention for `VALKEY_URL`. It does not modify deployment configuration because persistence and recovery settings remain owned by the Valkey deployment.

The primary generated adapter connects the client and translates Flue database operations into Redis-protocol commands supported by Valkey:

```ts
import { redis } from '@flue/redis';
import { createClient } from 'redis';

const client = createClient({ url: process.env.VALKEY_URL });
await client.connect();

export default redis({
  command: (command, args = []) => client.sendCommand([command, ...args.map(String)]),
  eval: (script, keys, args = []) => client.eval(script, { keys, arguments: args.map(String) }),
  close: () => client.close(),
});
```

This abridged excerpt omits the generated pipeline helper, which batches commands and rejects any `Error` result. Flue discovers the adapter during a Node build, checks and migrates its Valkey namespace at server startup, and persists canonical agent conversations, immutable attachments, accepted submissions, workflow runs, and event streams so that they survive Flue process restarts. Durability across Valkey server loss depends on the deployment’s AOF or snapshot configuration.

## Configure

| Variable    | Purpose                                                                                      |
| ----------- | -------------------------------------------------------------------------------------------- |
| VALKEY\_URL | **Required** — Connection URL for a persistent standalone or single-shard Valkey deployment. |

The blueprint installs `@flue/redis` and the official Redis `redis`(node-redis) client, then writes a source-root `db.ts`. Valkey implements the Redis protocol and commands this adapter uses. This support is specific to Valkey and does not imply that every Redis-compatible provider is supported.

This is a **Node.js** adapter. The Cloudflare target uses Durable Object SQLite and rejects `db.ts`.

Set `VALKEY_URL` to a persistent standalone Valkey server or managed single-shard endpoint. Valkey Cluster and cache-only configurations are unsupported. Configure `maxmemory-policy noeviction`, plus AOF with an explicit fsync policy and/or durable snapshots appropriate to your recovery objective. `noeviction` avoids silent eviction; it does not make acknowledged writes durable across server loss.

The canonical runner uses node-redis over Valkey’s Redis protocol:

```ts
import { redis } from '@flue/redis';
import { createClient } from 'redis';

const client = createClient({ url: process.env.VALKEY_URL });
await client.connect();

export default redis({
  command: (command, args = []) => client.sendCommand([command, ...args.map(String)]),
  eval: (script, keys, args = []) =>
    client.eval(script, {
      keys,
      arguments: args.map(String),
    }),
  pipeline: async (commands) => {
    const multi = client.multi();
    for (const { command, args = [] } of commands) multi.addCommand([command, ...args.map(String)]);
    const results = await multi.exec();
    for (const result of results) if (result instanceof Error) throw result;
    return results;
  },
  close: () => client.close(),
});
```

## Inspection and isolation

At startup, `inspectServer` uses `CONFIG GET`, falling back to `INFO`, to verify that Cluster is disabled and the eviction policy is `noeviction`. Startup fails when either requirement cannot be verified. Set `inspectServer: false` only when a managed single-shard provider denies both commands and you have independently verified the configuration.

Use a dedicated Valkey database or pass a stable, unique `keyPrefix` as the adapter’s second argument. The default is `flue`. Changing it selects a separate namespace; it does not move existing keys.

## Migrations and stored data

Flue runs `migrate()` at startup. It initializes schema-version metadata idempotently and refuses data from an unsupported newer schema; there is no separate migration command.

Valkey stores append-only canonical conversation records and compaction facts, immutable attachment payloads, accepted prompts and dispatches, recovery claims and leases, workflow runs and indexes, and persisted event streams. It does not store session transcript snapshots, sandbox files, external API side effects, secrets, or application business data.

## Verify durability

Build the Node target, start it against a throwaway correctly configured Valkey, create state, restart Flue, and confirm the state reloads. Separately test the chosen AOF or snapshot recovery procedure: restarting Flue does not prove that Valkey survives server loss.

## Docs Navigation

Current page: [Valkey](https://flueframework.com/docs/ecosystem/databases/valkey/)

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