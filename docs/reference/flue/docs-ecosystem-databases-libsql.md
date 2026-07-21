<!-- source: https://flueframework.com/docs/ecosystem/databases/libsql/ -->
---
description: Give Flue agents and workflow runs durable state with libSQL — a local SQLite file, a self-hosted libSQL server, or an embedded replica.
title: libSQL | Flue
image: https://flueframework.com/docs/og4.jpg
---

# libSQL

AI-generated, awaiting review [ View as Markdown ](https://flueframework.com/docs/ecosystem/databases/libsql/index.md) [  @flue/libsql ](https://www.npmjs.com/package/@flue/libsql) 

## Quickstart

Add durable libSQL persistence to an existing Flue project with the [libSQL](https://github.com/tursodatabase/libsql) blueprint. Run the following command in your terminal or coding agent of choice:

```sh
flue add database libsql
```

## Overview

The libSQL blueprint installs `@flue/libsql` and `@libsql/client`, creates a source-root `db.ts`, and updates existing environment documentation when the project has it. The generated adapter maps client result sets to plain objects and serializes operations so a local SQLite file does not receive overlapping writes from one process:

```ts
import { libsql } from '@flue/libsql';
import { createClient, type ResultSet } from '@libsql/client';

const client = createClient({ url: process.env.LIBSQL_URL! });

export default libsql({
  query: (text, params = []) => {
    // await client.execute({ sql: text, args: params }))),
    // ...
  }
  transaction: (fn) => {
    // const tx = await client.transaction('write');
    // ...
  }
  close: () => client.close(),
});
```

Flue discovers the adapter at build time and wires it into the generated Node server. On startup, it creates or verifies the required `flue_*` tables. Canonical agent conversations, immutable attachments, accepted submissions, and workflow history then persist in a local SQLite file or self-hosted libSQL server according to `LIBSQL_URL`; application business data remains application-owned. Embedded replicas require additional `syncUrl` client configuration. The blueprint applies only to Node targets because Cloudflare deployments use Durable Object SQLite instead.

## Configure

| Variable    | Purpose                                                                                  |
| ----------- | ---------------------------------------------------------------------------------------- |
| LIBSQL\_URL | **Required** — A local file (file:./data/flue.db) or a libSQL server (http://host:8080). |

`createClient` reads this at runtime — it is not baked into the build. For local development, `flue dev --env <file>` and `flue run --env <file>` load any `.env`\-format file. In production, supply it from your platform’s secret store.

The blueprint installs `@flue/libsql` and the official `@libsql/client`, and writes a source-root `db.ts` that wraps the client. Flue discovers `db.ts` at build time and wires it into the generated Node server. For hosted Turso, use [flue add database turso](https://flueframework.com/docs/ecosystem/databases/turso/) instead — it is the same adapter with a Turso client configuration.

`@flue/libsql` is a **Node.js** adapter. The Cloudflare target uses Durable Object SQLite automatically and rejects a `db.ts` file at build time, so this guide applies to Node deployments. See [Database](https://flueframework.com/docs/guide/database/) for the full picture of how state is stored on each target.

## Bring your own driver

`@flue/libsql` does not pick or bundle a database driver. It runs against a small runner you wrap around your configured [@libsql/client](https://docs.turso.tech/sdk/ts/reference), so you own the client and its connection options. A runner is three functions: `query` (a SQL string with `?` placeholders plus positional params, resolving to result rows), `transaction` (runs its callback inside one `write` transaction), and `close`. `@libsql/client` returns a `ResultSet`, so map its `rows`/`columns` into plain objects:

```ts
import { libsql } from '@flue/libsql';
import { createClient, type ResultSet } from '@libsql/client';

const client = createClient({ url: process.env.LIBSQL_URL! });

const toRows = (rs: ResultSet) =>
  rs.rows.map((row) => Object.fromEntries(rs.columns.map((column) => [column, row[column]])));

let tail: Promise<unknown> = Promise.resolve();
const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
  const result = tail.then(operation, operation);
  tail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
};

export default libsql({
  query: (text, params = []) =>
    serialize(async () => toRows(await client.execute({ sql: text, args: params }))),
  transaction: (fn) =>
    serialize(async () => {
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
    }),
  close: () => client.close(),
});
```

## Connection targets

`createClient` decides where state lives — the adapter is identical across all of them:

| Target                                           | createClient(...)                                                                |
| ------------------------------------------------ | -------------------------------------------------------------------------------- |
| Local SQLite file                                | { url: 'file:./data/flue.db' }                                                   |
| Self-hosted libSQL server (sqld)                 | { url: 'http://127.0.0.1:8080' }                                                 |
| Embedded replica (local file synced to a remote) | { url: 'file:local.db', syncUrl, authToken }                                     |
| Hosted Turso                                     | see the [Turso guide](https://flueframework.com/docs/ecosystem/databases/turso/) |

### Embedded-file concurrency

When `LIBSQL_URL` is a local `file:` database, asynchronous writes can overlap and surface `SQLITE_BUSY`. The runner above serializes all operations from one process so its transactions do not contend with top-level queries. Flue does not promise multi-process or multi-tenant writes to one embedded file. A self-hosted libSQL server and hosted Turso serialize writes server-side.

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

## When to choose libSQL

| Use case                                                    | Adapter                                                                                 |
| ----------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Local development                                           | sqlite() from @flue/runtime/node, or libSQL against a file: database                    |
| Single-host Node deployment                                 | File-backed sqlite() or libSQL file:                                                    |
| Self-hosted SQLite over the network, or an embedded replica | @flue/libsql                                                                            |
| Hosted, replicated SQLite                                   | @flue/libsql against [Turso](https://flueframework.com/docs/ecosystem/databases/turso/) |
| Multi-replica Node deployment on Postgres                   | [@flue/postgres](https://flueframework.com/docs/ecosystem/databases/postgres/)          |

libSQL is the right choice when you want SQLite’s model but reachable over the network or kept close to the app as an embedded replica. For a fully managed, replicated deployment, point the same adapter at [Turso](https://flueframework.com/docs/ecosystem/databases/turso/).

## Docs Navigation

Current page: [libSQL](https://flueframework.com/docs/ecosystem/databases/libsql/)

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