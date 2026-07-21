<!-- source: https://flueframework.com/docs/ecosystem/databases/supabase/ -->
---
description: Give Flue agents and workflow runs durable, shared state with Supabase Postgres.
title: Supabase | Flue
image: https://flueframework.com/docs/og4.jpg
---

# Supabase

AI-generated, awaiting review [ View as Markdown ](https://flueframework.com/docs/ecosystem/databases/supabase/index.md) [  @flue/postgres ](https://www.npmjs.com/package/@flue/postgres) 

## Quickstart

Add durable, shared Postgres persistence to an existing Flue project with the [Supabase](https://supabase.com) blueprint. Run the following command in your terminal or coding agent of choice:

```sh
flue add database supabase
```

## Overview

The Supabase blueprint installs `@flue/postgres` and `pg`, adds the matching `@types/pg` development dependency, and creates a transaction-safe `db.ts` in the project’s source-root. It uses the project’s existing secret convention and updates an existing environment example or environment documentation when one is present.

The primary generated adapter uses one checked-out `pg` client for every query in a transaction:

```ts
import { postgres } from '@flue/postgres';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.SUPABASE_DATABASE_URL });

export default postgres({
  query: async (text, params) => (await pool.query(text, params)).rows,
  transaction: async (fn) => {
    const client = await pool.connect();
    // ...
  },
  close: () => pool.end(),
});
```

Flue discovers the adapter during a Node build, runs its migrations at server startup, and persists canonical agent conversations, immutable attachments, accepted submissions, workflow runs, and event state in Supabase so that state survives process replacement. Replicas may share durable state and workflow history, but each agent instance still requires one live Node owner. Application business data remains application-owned.

## Configure

| Variable                | Purpose                                                                 |
| ----------------------- | ----------------------------------------------------------------------- |
| SUPABASE\_DATABASE\_URL | **Required** — Connection string from **Supabase Dashboard > Connect**. |

The blueprint installs the existing `@flue/postgres` adapter with `pg` and writes a source-root `db.ts`. There is no Supabase-specific Flue package. Flue discovers the file at build time and wires it into the generated Node server.

This integration is **Node.js only**. The Cloudflare target uses Durable Object SQLite automatically and rejects `db.ts` at build time. See [Database](https://flueframework.com/docs/guide/database/) for persistence by target.

Copy a connection string from **Supabase Dashboard > Connect** and provide it at runtime as `SUPABASE_DATABASE_URL`:

| Deployment                           | Recommended connection        |
| ------------------------------------ | ----------------------------- |
| Persistent, IPv6-capable Node server | Direct connection             |
| Persistent, IPv4-only Node server    | Shared pooler in session mode |

The provider-specific environment variable makes the secret’s source clear. If your project already uses another database variable convention, use it consistently in `db.ts` instead. Supply the value through your platform’s secret store and never commit it. For local development, `flue dev --env <file>` and `flue run --env <file>` load any `.env`\-format file.

Transaction-mode pooling is not the default. It can preserve an explicit transaction performed on one checked-out client and does not inherently break `BEGIN`/`COMMIT`, but it does not support prepared statements or session state. If your deployment requires transaction mode, keep `pg` queries unnamed as in the example: do not pass a `name` in query configuration or otherwise enable named prepared statements, and do not depend on session state.

## Use the transaction-safe runner

`@flue/postgres` accepts a runner so the application owns driver configuration, pooling, TLS, and credentials. The canonical `pg` runner checks out one client for the entire transaction callback:

```ts
import { postgres } from '@flue/postgres';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.SUPABASE_DATABASE_URL });

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

Every query in the callback uses the checked-out client. Sending those queries through the pool could move work onto another connection and outside the transaction. `@flue/postgres` uses transaction-scoped `pg_advisory_xact_lock`, not session advisory locks, to serialize session updates; each lock is released with its transaction.

## Migrations

The adapter’s `migrate()` hook runs automatically when the generated Node server starts. It creates Flue’s `flue_*` tables idempotently and stamps a schema version, so a fresh Supabase database is provisioned on first boot and an existing one is reused on restart. There is no separate migration command, and a database written by a newer Flue version refuses to start rather than risking incompatible writes.

## What gets stored

A Flue database stores runtime state, not the application’s whole data model.

| Stored by Flue                                                                                | Not stored by Flue                       |
| --------------------------------------------------------------------------------------------- | ---------------------------------------- |
| Canonical agent conversation streams and compaction records                                   | Sandbox files and installed dependencies |
| Immutable attachment payloads                                                                 | External API side effects                |
| Accepted direct prompts and dispatch(...) submissions                                         | Application-owned business data          |
| Durable submission claims and leases, workflow-run records, persisted events, and run indexes | Provider credentials or secrets          |
| Recovery state for accepted work                                                              | Provider credentials or secrets          |

See [Durable Agents](https://flueframework.com/docs/concepts/durable-execution/) for recovery behavior and the [Data Persistence API](https://flueframework.com/docs/api/data-persistence-api/) for the adapter contract.

## Verify

Build the configured Node target and confirm `db.ts` is discovered. Against a non-production Supabase project, start the server and confirm the `flue_*`tables are created. Create agent or workflow state, restart the server, and confirm that state is reloaded. If you use the shared pooler, verify that its mode matches the deployment and that transaction mode, when explicitly chosen, uses no named prepared statements or session state.

## When to choose Supabase

Choose Supabase when your persistent Node deployment needs durable shared Flue state and Supabase already provides its managed Postgres. Use the direct connection where IPv6 is available, or session-mode shared pooling for an IPv4-only server. For another managed or self-hosted Postgres deployment, use the general [Postgres guide](https://flueframework.com/docs/ecosystem/databases/postgres/).

## Docs Navigation

Current page: [Supabase](https://flueframework.com/docs/ecosystem/databases/supabase/)

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