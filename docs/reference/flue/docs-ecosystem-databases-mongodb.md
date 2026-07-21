<!-- source: https://flueframework.com/docs/ecosystem/databases/mongodb/ -->
---
description: Give Flue agents and workflow runs durable, shared state with MongoDB.
title: MongoDB | Flue
image: https://flueframework.com/docs/og4.jpg
---

# MongoDB

AI-generated, awaiting review [ View as Markdown ](https://flueframework.com/docs/ecosystem/databases/mongodb/index.md) [  @flue/mongodb ](https://www.npmjs.com/package/@flue/mongodb) 

## Quickstart

Add durable, shared state to an existing Flue project with the [MongoDB](https://www.mongodb.com) blueprint. Run the following command in your terminal or coding agent of choice:

```sh
flue add database mongodb
```

## Overview

The MongoDB blueprint installs `@flue/mongodb` and the official `mongodb`driver, creates a complete `db.ts` runner in the project’s source-root, and follows the project’s existing secret convention for `MONGODB_URL` and `MONGODB_DATABASE`. The generated adapter connects the driver, selects the database, and passes a project-owned runner to `mongodb()`:

```ts
import { mongodb, type MongoOperations, type MongoRunner } from '@flue/mongodb';
import { MongoClient } from 'mongodb';

const client = new MongoClient(process.env.MONGODB_URL!);
await client.connect();

const db = client.db(process.env.MONGODB_DATABASE);
const runner: MongoRunner = {
  /* ... */
};

export default mongodb(runner);
```

The blueprint does not modify the MongoDB deployment, which must support transactions. Flue discovers the adapter during a Node build and persists canonical agent conversations, immutable attachments, accepted submissions, workflow runs, and event streams so that state survives process replacement. Replicas may share durable state and workflow history, but each agent instance still requires one live Node owner. Application business data remains application-owned.

## Configure

| Variable          | Purpose                                                                                                               |
| ----------------- | --------------------------------------------------------------------------------------------------------------------- |
| MONGODB\_URL      | **Required** — MongoDB connection string, including credentials and TLS options when required.                        |
| MONGODB\_DATABASE | **Optional** — Explicit database name for Flue state; recommended when the URL does not select the intended database. |

The official driver reads these values at runtime. Never commit credentials. For local development, `flue dev --env <file>` and `flue run --env <file>` load any `.env`\-format file; use the deployment platform’s secret store in production.

`client.db(undefined)` can select the database from the connection string (or the driver’s default), but setting `MONGODB_DATABASE` explicitly avoids an ambiguous deployment. Prefer a dedicated database. If Flue must share one, pass a stable unique `collectionPrefix` to `mongodb()`; changing it selects a new namespace rather than moving existing data.

The blueprint installs `@flue/mongodb` and the official `mongodb` driver, then writes a complete source-root `db.ts` runner. Flue discovers the file at build time and wires the adapter into the generated Node server.

This is a **Node.js** adapter. The Cloudflare target uses Durable Object SQLite and rejects `db.ts`, so MongoDB is not used on that target. See [Database](https://flueframework.com/docs/guide/database/) for target-specific persistence behavior.

## Choose a supported deployment

MongoDB transactions require one of these deployments:

* MongoDB Atlas;
* a replica set;
* a transaction-capable sharded cluster; or
* a single-node replica set.

A standalone `mongod` is unsupported. Migration checks the topology before creating collections or stamping the Flue schema version and fails when the deployment cannot run transactions.

For local development, a single-node replica set is one MongoDB server started with replica-set mode enabled and initialized once as a one-member set. Follow the instructions for your existing installation or container setup; the production requirements and operational tradeoffs remain those of a replica set.

## Transactions and the driver runner

`@flue/mongodb` exposes a small driver seam rather than bundling a production client. The generated `db.ts` wraps the official driver with all collection operations, topology inspection, collection and index management, transactions, and `close()`.

Each transaction uses one `ClientSession`, snapshot read concern, and majority write concern. Callback operations are session-bound and serialized because the driver does not support parallel operations inside one transaction. The runner uses separate bounded retry loops: it reruns the full callback for `TransientTransactionError`, while `UnknownTransactionCommitResult` retries only `commitTransaction()`. This avoids repeating application work when only the commit outcome is uncertain.

Keep the complete generated runner when adapting connection options. In particular, do not replace transaction collections with database-level collections or remove the operation queue.

## Migrations and indexes

Flue calls `migrate()` automatically at server startup. After validating the topology, migration creates collections with strict validators and creates the required indexes. It then inspects the actual validator, validation level and action, plus each required index’s key, uniqueness, partial filter, and collation before writing the schema version. Incompatible definitions and data written by a newer Flue version stop startup. There is no separate migration command.

## Large values and staged writes

MongoDB limits a BSON document to 16 MiB. The adapter JSON-serializes arbitrary runtime values and stages them as immutable parts bounded to 4 MiB. A short transaction publishes the completed generation and its manifest, so large values are never made visible partially. Abandoned staged generations and retired values are collected later.

Images keep Flue’s persisted chunk representation and use the same staged value path. Avoid putting large runtime values directly into custom MongoDB documents; that bypasses the adapter’s BSON-limit handling.

## What gets stored

MongoDB stores append-only canonical conversation records, immutable attachment payloads, accepted direct and dispatched submissions, recovery claims and leases, workflow runs and indexes, and persisted event streams. Sessions append for the agent-instance lifetime; there are no session generations, transcript snapshots, per-session deletion, or recursive session-tree cleanup.

The adapter does not store sandbox files, external API side effects, credentials, or application-owned business records.

## Verify

Build the Node target and start it with `MONGODB_URL` and `MONGODB_DATABASE`pointing at a throwaway supported deployment. Confirm migration creates the collections and indexes, create state, restart Flue, and verify the state reloads. Exercise a value larger than 4 MiB to cover multipart staging. A throwaway standalone `mongod` should fail migration before the schema version is stamped. Do not verify against a production database.

## Docs Navigation

Current page: [MongoDB](https://flueframework.com/docs/ecosystem/databases/mongodb/)

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