<!-- source: https://flueframework.com/docs/ecosystem/deploy/fly/ -->
---
description: Deploy Flue agents to Fly.io as a long-running Docker app on Fly Machines.
title: Deploy Agents on Fly.io | Flue
image: https://flueframework.com/docs/og4.jpg
---

# Deploy Agents on Fly.io

Last updated Jun 20, 2026 [ View as Markdown ](https://flueframework.com/docs/ecosystem/deploy/fly/index.md) 

A Flue server is a long-running HTTP service, not a serverless function, so deploy it to Fly Machines that stay up rather than scaling to zero between requests. `fly launch` builds the [Flue Docker image](https://flueframework.com/docs/ecosystem/deploy/docker/) and runs it on Machines, which suit a stateful, always-on server well.

## Launch from the Dockerfile

With a [Flue Dockerfile](https://flueframework.com/docs/ecosystem/deploy/docker/) at the project root, `fly launch` detects it, registers the build, and generates a `fly.toml`. The image is built and deployed by `fly deploy` — `fly launch` only records how to build it.

```bash
fly launch
fly deploy
```

The Dockerfile builds `dist/server.mjs` (`npx flue build --target node`) and starts it with `node dist/server.mjs`. The server binds `PORT` (default 3000), so set `ENV PORT` in the image — or whatever port the image exposes — and make `internal_port` in `fly.toml` match it. The build externalizes dependencies, so `node_modules` must be present in the image at runtime.

## fly.toml essentials

`fly launch` writes a starter `fly.toml`. The fields that matter for a Flue server:

```toml
app = "my-flue-agents"
primary_region = "iad"

[http_service]
  internal_port = 8080         # must match the image's PORT / EXPOSE
  force_https = true
  auto_stop_machines = "off"   # keep the server up; see below
  auto_start_machines = true
  min_machines_running = 1

  [[http_service.checks]]
    method = "GET"
    path = "/health"           # must be defined in app.ts; Flue adds none
    interval = "30s"
    timeout = "5s"
    grace_period = "10s"

[[vm]]
  size = "shared-cpu-1x"
  memory = "512mb"
```

`auto_stop_machines` and `auto_start_machines` are meant to move together. Leaving auto-stop on (`"stop"` or `"suspend"`) with `min_machines_running = 0` is scale-to-zero — appropriate for stateless web apps, but wrong for a Flue server: a stopped Machine severs any in-flight streaming connection and discards in-memory session state. Keep at least one Machine running with `auto_stop_machines = "off"` (or `min_machines_running = 1`), and put durable state in Postgres.

## Secrets

Provider keys and model configuration are secrets, exposed to the app as environment variables on every Machine. `fly secrets set` restarts the Machines to apply them; the built server reads only this start-time environment, so a `.env` file is not used in production.

```bash
fly secrets set ANTHROPIC_API_KEY=sk-ant-...
fly secrets set MODEL_SPECIFIER=anthropic/claude-sonnet-4-6
```

Use the env var your provider expects — `ANTHROPIC_API_KEY` for Anthropic, `OPENAI_API_KEY` for OpenAI, and so on. `MODEL_SPECIFIER` is optional and only read if your app consults it.

## Persistence

On Node.js, canonical agent conversations, attachments, and accepted submissions live in memory by default — fine for a single Machine, but lost on restart. Back Flue with Postgres for replacement recovery and shared workflow history. Multiple Machines must route each agent instance to one live owner; shared storage alone does not make same-instance active-active execution safe.

[Fly Managed Postgres](https://fly.io/docs/mpg/) (MPG) is the recommended option; the older unmanaged Fly Postgres (`fly postgres`) still exists, but Fly no longer provides support or guidance for it. `fly mpg create` prompts for a name, region, and plan (or pass `--name` / `--region` / `--plan`); `fly mpg attach` sets `DATABASE_URL` as a secret on the app — the pooled (PgBouncer) connection URL — and restarts it:

```bash
fly mpg create
fly mpg attach <cluster-id> -a my-flue-agents
```

Install the adapter and read `DATABASE_URL` in `db.ts`:

```bash
npm install @flue/postgres
```

```typescript
import { postgres } from '@flue/postgres';

export default postgres(process.env.DATABASE_URL!);
```

Flue discovers `db.ts` at build time and wires it into the generated server. The adapter handles schema creation, canonical conversation streams, immutable attachments, durable submission state, and workflow history. See [Database](https://flueframework.com/docs/guide/database/) for adapter details and [Data Persistence API](https://flueframework.com/docs/api/data-persistence-api/) for the contract.

## Health and streaming

Flue does not generate a `/health` route — define one in `app.ts` for the `[[http_service.checks]]` path above, or drop the check. Fly’s HTTP checks expect a 2xx and do not follow redirects, so with `force_https = true` either run the check over `https` or add `X-Forwarded-Proto = "https"` to its headers.

Exposed workflow runs use long-lived `GET /runs/:runId` reads (long-poll/SSE). Keep at least one Machine running so auto-stop does not cut these connections. For long-running workflows, retain the invocation’s `runId` and read the run from offset `-1` instead of holding one blocking request. See [Workflow HTTP exports](https://flueframework.com/docs/api/workflow-api/#http-exports).

## Going further

* **Regions and scaling.** `fly scale count` adds Machines and `fly scale vm` resizes them. Multi-Machine deployments need shared Postgres for replacement recovery and workflow history, plus routing that keeps each agent instance on one live Machine and prevents overlapping owners.
* **Scheduled workflows.** Use Fly [scheduled Machines](https://fly.io/docs/machines/) to call the deployed application’s authenticated workflow endpoint, or run `npx flue run workflow:<name> --server https://<host>/<flue-mount>`. Remote attachment exercises the deployed application without building and starting another local runtime.

## References

* [fly.toml configuration reference](https://fly.io/docs/reference/configuration/) — `[http_service]`, `[[http_service.checks]]`, `[[vm]]` fields and accepted values
* [Deploy an app](https://fly.io/docs/launch/deploy/) — the `fly launch` / `fly deploy` flow and Dockerfile detection
* [Managed Postgres: create and connect](https://fly.io/docs/mpg/create-and-connect/) — `fly mpg create` / `fly mpg attach` and the `DATABASE_URL` secret
* [Deploying Node.js apps to Fly.io](https://sevic.dev/nodejs-deployment-flyio/) — a community walkthrough of the same Node/Docker deploy path

## Docs Navigation

Current page: [Deploy Agents on Fly.io](https://flueframework.com/docs/ecosystem/deploy/fly/)

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