<!-- source: https://flueframework.com/docs/ecosystem/databases/mysql/ -->
---
description: Give Flue agents and workflow runs durable, shared state with MySQL 8 and InnoDB.
title: MySQL | Flue
image: https://flueframework.com/docs/og4.jpg
---

# MySQL

AI-generated, awaiting review [ View as Markdown ](https://flueframework.com/docs/ecosystem/databases/mysql/index.md) [  @flue/mysql ](https://www.npmjs.com/package/@flue/mysql) 

## Quickstart

Add durable, shared MySQL persistence to an existing Flue project with the [MySQL](https://www.mysql.com) blueprint. Run the following command in your terminal or coding agent of choice:

```sh
flue add database mysql
```

## Overview

The MySQL blueprint installs `@flue/mysql` and `mysql2` and creates a source-root `db.ts`. The generated adapter uses a pool for ordinary queries and keeps each transaction on one checked-out connection:

```ts
import { mysql, type MysqlQuery } from '@flue/mysql';
import mysql2 from 'mysql2/promise';

const pool = mysql2.createPool(process.env.MYSQL_URL!);

const toRows = (result: unknown): Record<string, unknown>[] =>
  Array.isArray(result) ? result.map((row) => ({ ...row })) : [];

export default mysql({
  query: async (text, params = []) => {
    const [result] = await pool.execute(text, params);
    return toRows(result);
  },
  transaction: async <T>(fn: (tx: { query: MysqlQuery }) => Promise<T>) => {
    const connection = await pool.getConnection();
    await connection.beginTransaction();
    // ...
  },
  close: () => pool.end(),
});
```

Flue discovers the adapter at build time and wires it into the generated Node server. On startup, it creates and verifies the required MySQL 8 InnoDB tables. Canonical agent conversations, immutable attachments, accepted submissions, and workflow history then survive process replacement. Replicas may share durable state and workflow history, but each agent instance still requires one live Node owner. Application business data remains application-owned. The blueprint applies only to Node targets because Cloudflare deployments use Durable Object SQLite instead.

## Configure

| Variable   | Purpose                                                                     |
| ---------- | --------------------------------------------------------------------------- |
| MYSQL\_URL | **Required** — MySQL connection string, supplied by your database provider. |

The driver reads this value at runtime. Supply it through your platform’s secret store, never commit it, and configure `mysql2` TLS options when your provider requires them. For local development, `flue dev --env <file>` and `flue run --env <file>` load any `.env`\-format file.

The blueprint installs `@flue/mysql` and `mysql2`, then writes a source-root `db.ts`. Flue discovers that file at build time and wires it into the generated Node server.

`@flue/mysql` supports **MySQL 8 with InnoDB** on the **Node.js target**. The Cloudflare target uses Durable Object SQLite automatically and rejects `db.ts`at build time. See [Database](https://flueframework.com/docs/guide/database/) for persistence by target.

## Bring your own driver

`@flue/mysql` does not bundle a production driver. It accepts a runner so your application owns pooling, TLS, credentials, and connection lifecycle. The canonical `mysql2` runner uses `pool.execute()` for normal queries and one checked-out connection for each callback transaction:

```ts
import { mysql, type MysqlQuery } from '@flue/mysql';
import mysql2 from 'mysql2/promise';

const pool = mysql2.createPool(process.env.MYSQL_URL!);

const toRows = (result: unknown): Record<string, unknown>[] =>
  Array.isArray(result) ? result.map((row) => ({ ...row })) : [];

export default mysql({
  query: async (text, params = []) => {
    const [result] = await pool.execute(text, params);
    return toRows(result);
  },
  transaction: async <T>(fn: (tx: { query: MysqlQuery }) => Promise<T>) => {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const result = await fn({
        query: async (text, params = []) => {
          const [rows] = await connection.execute(text, params);
          return toRows(rows);
        },
      });
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  },
  close: () => pool.end(),
});
```

The runner uses `?` placeholders and returns plain row objects. Every query in a transaction callback must use the checked-out connection; issuing those calls through the pool could move work onto another connection and outside the transaction.

## Migrations

The adapter’s `migrate()` hook runs automatically when the generated Node server starts. It creates Flue’s `flue_*` tables idempotently, verifies the complete schema, and then stamps its version. All transactional tables use InnoDB. There is no separate migration command, and a database written by a newer Flue version refuses to start rather than risking incompatible writes.

## What gets stored

A Flue database stores runtime state, not your whole application.

| Stored by Flue                                              | Not stored by Flue                       |
| ----------------------------------------------------------- | ---------------------------------------- |
| Canonical agent conversation streams and compaction records | Sandbox files and installed dependencies |
| Immutable attachment payloads                               | External API side effects                |
| Accepted direct prompts and dispatch(...) submissions       | Application-owned business data          |
| Durable submission claims and leases                        | Provider credentials or secrets          |
| Workflow-run records, persisted events, and run indexes     |                                          |

See [Durable Agents](https://flueframework.com/docs/concepts/durable-execution/) for recovery behavior and the [Data Persistence API](https://flueframework.com/docs/api/data-persistence-api/) for the adapter contract.

## When to choose MySQL

Choose MySQL when your Node deployment already operates MySQL 8, or when replacement processes and multiple replicas need durable agent state and shared workflow history in an InnoDB-backed database. Preserve one live owner per agent instance. For single-host persistence, file-backed `sqlite()` may be simpler. Choose [@flue/postgres](https://flueframework.com/docs/ecosystem/databases/postgres/) when Postgres is your existing operational standard, or [@flue/libsql](https://flueframework.com/docs/ecosystem/databases/libsql/) for SQLite and libSQL workloads.

## Docs Navigation

Current page: [MySQL](https://flueframework.com/docs/ecosystem/databases/mysql/)

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