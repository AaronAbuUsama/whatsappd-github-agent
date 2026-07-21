<!-- source: https://flueframework.com/docs/ecosystem/databases/postgres/ -->
---
description: Give Flue agents and workflow runs durable, shared state with a Postgres database.
title: Postgres | Flue
image: https://flueframework.com/docs/og4.jpg
---

# Postgres

AI-generated, awaiting review [ View as Markdown ](https://flueframework.com/docs/ecosystem/databases/postgres/index.md) [  @flue/postgres ](https://www.npmjs.com/package/@flue/postgres) 

## Quickstart

Add durable, shared Postgres persistence to an existing Flue project with the [Postgres](https://www.postgresql.org) blueprint. Run the following command in your terminal or coding agent of choice:

```sh
flue add database postgres
```

## Overview

The Postgres blueprint installs `@flue/postgres` and reuses an existing Postgres driver, or adds `pg` and the matching `@types/pg` development dependency by default. It creates a source-root `db.ts` and updates existing environment documentation when the project has it. The default generated adapter uses a pool for ordinary queries and keeps each transaction on one checked-out connection:

```ts
import { postgres } from '@flue/postgres';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export default postgres({
  query: async (text, params) => (await pool.query(text, params)).rows,
  transaction: async (fn) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await fn({
        query: async (text, params) => (await client.query(text, params)).rows,
      });
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  },
  close: () => pool.end(),
});
```

Flue discovers the adapter at build time and wires it into the generated Node server. On startup, it creates or verifies the required `flue_*` tables. Canonical agent conversations, immutable attachments, accepted submissions, and workflow history then survive process replacement. Replicas may share durable state and workflow history, but each agent instance still requires one live Node owner; Postgres does not enable active-active same-instance execution. Application business data remains application-owned. The blueprint applies only to Node targets because Cloudflare deployments use Durable Object SQLite instead.

## Configure

| Variable      | Purpose                                                                              |
| ------------- | ------------------------------------------------------------------------------------ |
| DATABASE\_URL | **Required** — Postgres connection string, e.g. postgresql://user:pass@host:5432/db. |

Your driver reads `DATABASE_URL` at runtime — it is not baked into the build. For local development, `flue dev --env <file>` and `flue run --env <file>` load any `.env`\-format file. In production, supply it from your platform’s secret store.

The blueprint installs `@flue/postgres` with `pg` by default and writes a source-root `db.ts` that wraps it. Flue discovers `db.ts` at build time and wires it into the generated Node server. After running the command, canonical agent conversations, immutable attachments, accepted submissions, and workflow-run records persist to Postgres instead of in-memory state.

`@flue/postgres` is a **Node.js** adapter. The Cloudflare target uses Durable Object SQLite automatically and rejects a `db.ts` file at build time, so this guide applies to Node deployments. See [Database](https://flueframework.com/docs/guide/database/) for the full picture of how state is stored on each target.

## Bring your own driver

`@flue/postgres` does not pick or bundle a database driver. It runs against a small runner you wrap around your configured driver, so you own driver choice, pooling, TLS, and every other connection option. A runner is three functions: `query` (a SQL string with numbered `$N` placeholders plus positional params, resolving to result rows), `transaction` (runs its callback inside one transaction on a single connection), and `close`.

With [pg](https://node-postgres.com/) (node-postgres), `transaction` checks out a single client and issues `BEGIN`/`COMMIT`/`ROLLBACK` itself — a pool cannot run a transaction across arbitrary connections:

```ts
import { postgres } from '@flue/postgres';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export default postgres({
  query: async (text, params) => (await pool.query(text, params)).rows,
  transaction: async (fn) => {
    const client = await pool.connect();
    // ...
  },
  close: () => pool.end(),
});
```

The same seam adapts drivers that support interactive transactions on one connection. For Neon, use its WebSocket `Pool`; the HTTP query client cannot implement this callback transaction contract.

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

The submission rows are what make accepted work recoverable after an interruption. See [Durable Agents](https://flueframework.com/docs/concepts/durable-execution/)for how recovery uses them, and the [Data Persistence API](https://flueframework.com/docs/api/data-persistence-api/)for the exact adapter contract.

## When to choose Postgres

| Use case                                                       | Adapter                                                   |
| -------------------------------------------------------------- | --------------------------------------------------------- |
| Local development, or restart persistence is unnecessary       | sqlite() from @flue/runtime/node (file path or in-memory) |
| Single-host Node deployment                                    | File-backed sqlite()                                      |
| Multi-replica Node deployment, or state must survive host loss | @flue/postgres, with one live owner per agent instance    |
| Cloudflare deployment                                          | Built-in Durable Object SQLite (no db.ts)                 |

Choose Postgres when a replacement process must recover accepted work, when replicas need shared workflow history, or when a single host’s disk is not a durable enough home for state. Keep one live owner for each agent instance and use instance-affine routing across replicas. Managed Postgres pairs naturally with the container deploy targets — see [Deploy on AWS](https://flueframework.com/docs/ecosystem/deploy/aws/) for RDS, and the other [deploy guides](https://flueframework.com/docs/ecosystem/deploy/node/) for provisioning a database alongside the server.

## Docs Navigation

Current page: [Postgres](https://flueframework.com/docs/ecosystem/databases/postgres/)

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