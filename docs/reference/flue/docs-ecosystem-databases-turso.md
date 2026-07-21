<!-- source: https://flueframework.com/docs/ecosystem/databases/turso/ -->
---
description: Give Flue agents and workflow runs durable, hosted state with Turso — managed, replicated libSQL.
title: Turso | Flue
image: https://flueframework.com/docs/og4.jpg
---

# Turso

AI-generated, awaiting review [ View as Markdown ](https://flueframework.com/docs/ecosystem/databases/turso/index.md) [  @flue/libsql ](https://www.npmjs.com/package/@flue/libsql) 

## Quickstart

Add durable, hosted database persistence to an existing Flue project with the [Turso](https://turso.tech) blueprint. Run the following command in your terminal or coding agent of choice:

```sh
flue add database turso
```

## Overview

The Turso blueprint installs `@flue/libsql` and `@libsql/client`, creates a source-root `db.ts`, and updates existing environment documentation when the project has it. It uses the libSQL adapter with Turso’s database URL and auth token:

```ts
import { libsql } from '@flue/libsql';
import { createClient, type ResultSet } from '@libsql/client';

const client = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN!,
});

const toRows = (rs: ResultSet) =>
  rs.rows.map((row) => Object.fromEntries(rs.columns.map((column) => [column, row[column]])));

export default libsql({
  query: async (text, params = []) => toRows(await client.execute({ sql: text, args: params })),
  transaction: async (fn) => {
    const tx = await client.transaction('write');
    // ...
  },
  close: () => client.close(),
});
```

Flue discovers the adapter at build time and wires it into the generated Node server. On startup, it creates or verifies the required `flue_*` tables. Canonical agent conversations, immutable attachments, accepted submissions, and workflow history then survive process replacement in hosted Turso. Replicas may share durable state and workflow history, but each agent instance still requires one live Node owner. Application business data remains application-owned. The blueprint applies only to Node targets because Cloudflare deployments use Durable Object SQLite instead.

## Configure

| Variable             | Purpose                                      |
| -------------------- | -------------------------------------------- |
| TURSO\_DATABASE\_URL | **Required** — The database’s libsql:// URL. |
| TURSO\_AUTH\_TOKEN   | **Required** — Auth token for the database.  |

`createClient` reads these at runtime — they are not baked into the build. For local development, `flue dev --env <file>` and `flue run --env <file>` load any `.env`\-format file. In production, supply them from your platform’s secret store.

Turso is hosted, replicated libSQL. The blueprint installs `@flue/libsql` and the official `@libsql/client`, and writes a source-root `db.ts` that wraps the client with a Turso configuration — it is the **same adapter** as [flue add database libsql](https://flueframework.com/docs/ecosystem/databases/libsql/), pointed at a Turso database. Flue discovers `db.ts` at build time and wires it into the generated Node server.

`@flue/libsql` is a **Node.js** adapter. The Cloudflare target uses Durable Object SQLite automatically and rejects a `db.ts` file at build time, so this guide applies to Node deployments. See [Database](https://flueframework.com/docs/guide/database/) for the full picture of how state is stored on each target.

## Create a database

Create a database and an auth token with the [Turso CLI](https://docs.turso.tech/cli/introduction):

```sh
turso db create flue-agents
turso db show --url flue-agents      # → TURSO_DATABASE_URL (libsql://…)
turso db tokens create flue-agents   # → TURSO_AUTH_TOKEN
```

```ts
import { libsql } from '@flue/libsql';
import { createClient, type ResultSet } from '@libsql/client';

const client = createClient({
  url: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN!,
});

const toRows = (rs: ResultSet) =>
  rs.rows.map((row) => Object.fromEntries(rs.columns.map((column) => [column, row[column]])));

export default libsql({
  query: async (text, params = []) => toRows(await client.execute({ sql: text, args: params })),
  transaction: async (fn) => {
    const tx = await client.transaction('write');
    try {
      const result = await fn({
        query: async (text, params = []) => toRows(await tx.execute({ sql: text, args: params })),
      });
      await tx.commit();
      return result;
    } catch (error) {
      await tx.rollback();
      throw error;
    } finally {
      tx.close();
    }
  },
  close: () => client.close(),
});
```

Turso serializes writes server-side, so there is no embedded-file concurrency concern. The runner shape (`query`, `transaction`, `close`) and the `ResultSet`mapping are explained in the [libSQL guide](https://flueframework.com/docs/ecosystem/databases/libsql/).

## Embedded replicas

For lower read latency, Turso supports **embedded replicas** — a local SQLite file kept in sync with the remote database, so reads hit local disk and writes forward to Turso. Point `url` at a local file and add `syncUrl`:

```ts
const client = createClient({
  url: 'file:flue-replica.db',
  syncUrl: process.env.TURSO_DATABASE_URL!,
  authToken: process.env.TURSO_AUTH_TOKEN!,
});
```

The rest of the `db.ts` is unchanged. Reach for this when read latency matters; the plain remote client above is the default.

## Migrations

The adapter’s `migrate()` hook runs automatically when the generated Node server starts. It creates Flue’s `flue_*` tables idempotently and stamps a schema version, so a fresh database is provisioned on first boot and an existing one is reused on restart. There is no separate migration command to run, and a database written by a newer Flue refuses to start rather than corrupting state.

## What gets stored

A Flue database stores runtime state, not your whole application.

| Stored by Flue                                              | Not stored by Flue                                             |
| ----------------------------------------------------------- | -------------------------------------------------------------- |
| Canonical agent conversation streams and compaction records | Sandbox files and installed dependencies                       |
| Immutable attachment payloads                               | External API side effects                                      |
| Accepted direct prompts and dispatch(...) submissions       | Application-owned business data unless your own tools store it |
| Workflow-run records and persisted events                   | Provider credentials or secrets                                |
| Run indexing for /runs lookups and listRuns()               |                                                                |

See [Durable Agents](https://flueframework.com/docs/concepts/durable-execution/) for how recovery uses submission state, and the [Data Persistence API](https://flueframework.com/docs/api/data-persistence-api/)for the exact adapter contract.

## When to choose Turso

Choose Turso when you want a managed, replicated SQLite without running a server, and optionally embedded replicas for low-latency reads. For a local file or a libSQL server you operate yourself, use the same adapter via the [libSQL guide](https://flueframework.com/docs/ecosystem/databases/libsql/). For external durable storage that supports process or host replacement, see [@flue/postgres](https://flueframework.com/docs/ecosystem/databases/postgres/). Node still requires one live owner per agent instance.

## Docs Navigation

Current page: [Turso](https://flueframework.com/docs/ecosystem/databases/turso/)

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