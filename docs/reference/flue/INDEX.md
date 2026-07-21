# Flue Framework Documentation (vendored)

Full local mirror of <https://flueframework.com/docs> — 99 pages, fetched 2026-07-19 from each page's `index.md` variant.
Each file's first line is an HTML comment with its source URL.

## Introduction

| Title | File | Source | Covers |
|---|---|---|---|
| Why Flue? | [`docs-introduction-why-flue.md`](./docs-introduction-why-flue.md) | https://flueframework.com/docs/introduction/why-flue/ | Build autonomous AI agents and powerful workflows with a programmable TypeScript harness, and run them anywhere. |

## Getting Started

| Title | File | Source | Covers |
|---|---|---|---|
| Getting Started | [`docs-getting-started-quickstart.md`](./docs-getting-started-quickstart.md) | https://flueframework.com/docs/getting-started/quickstart/ | Set up a Flue project automatically or create your first agent manually. |

## Concepts

| Title | File | Source | Covers |
|---|---|---|---|
| What is an agent? | [`docs-concepts-agents.md`](./docs-concepts-agents.md) | https://flueframework.com/docs/concepts/agents/ | What an AI agent actually is, why a model alone isn't one, and what makes a Flue agent different. |
| Durable Agents | [`docs-concepts-durable-execution.md`](./docs-concepts-durable-execution.md) | https://flueframework.com/docs/concepts/durable-execution/ | Understand how Flue agents and workflows handle server restarts, interrupted connections, and other disruptions. |

## Guide

| Title | File | Source | Covers |
|---|---|---|---|
| Actions | [`docs-guide-actions.md`](./docs-guide-actions.md) | https://flueframework.com/docs/guide/actions/ | Define finite agent-backed operations that can be reused by workflows and agents. |
| Agents | [`docs-guide-building-agents.md`](./docs-guide-building-agents.md) | https://flueframework.com/docs/guide/building-agents/ | Create an agent, configure its capabilities, and send it messages over time. |
| Channels | [`docs-guide-channels.md`](./docs-guide-channels.md) | https://flueframework.com/docs/guide/channels/ | Receive verified provider events and connect them to Flue applications. |
| Database | [`docs-guide-database.md`](./docs-guide-database.md) | https://flueframework.com/docs/guide/database/ | Configure database-backed state for Flue agents and workflow runs. |
| Evals | [`docs-guide-evals.md`](./docs-guide-evals.md) | https://flueframework.com/docs/guide/evals/ | Evaluate Flue agents with repeatable Vitest suites using vitest-evals. |
| LLM (Models &amp; Providers) | [`docs-guide-models.md`](./docs-guide-models.md) | https://flueframework.com/docs/guide/models/ | Select models, configure providers, and tune reasoning behavior in Flue agents. |
| Observability | [`docs-guide-observability.md`](./docs-guide-observability.md) | https://flueframework.com/docs/guide/observability/ | Inspect workflow runs, monitor agent activity, and export telemetry from your application. |
| Project Layout | [`docs-guide-project-layout.md`](./docs-guide-project-layout.md) | https://flueframework.com/docs/guide/project-layout/ | Understand the source files and generated output in a Flue project. |
| React | [`docs-guide-react.md`](./docs-guide-react.md) | https://flueframework.com/docs/guide/react/ | Build React interfaces for live agent conversations and workflow runs. |
| Routing | [`docs-guide-routing.md`](./docs-guide-routing.md) | https://flueframework.com/docs/guide/routing/ | Compose Flue with application routes, middleware, and custom HTTP ingress. |
| Sandboxes | [`docs-guide-sandboxes.md`](./docs-guide-sandboxes.md) | https://flueframework.com/docs/guide/sandboxes/ | Give agents a workspace for files and command-driven work. |
| Schedules | [`docs-guide-schedules.md`](./docs-guide-schedules.md) | https://flueframework.com/docs/guide/schedules/ | Invoke Flue workflows or dispatch agent input on a schedule with Cloudflare or Node.js. |
| Skills | [`docs-guide-skills.md`](./docs-guide-skills.md) | https://flueframework.com/docs/guide/skills/ | Add Agent Skills to Flue agents and invoke them from sessions. |
| Subagents | [`docs-guide-subagents.md`](./docs-guide-subagents.md) | https://flueframework.com/docs/guide/subagents/ | Let agents delegate focused work to named specialists. |
| Cloudflare | [`docs-guide-targets-cloudflare.md`](./docs-guide-targets-cloudflare.md) | https://flueframework.com/docs/guide/targets/cloudflare/ | Understand the Cloudflare-specific runtime behavior and APIs for Flue applications. |
| Node.js | [`docs-guide-targets-node.md`](./docs-guide-targets-node.md) | https://flueframework.com/docs/guide/targets/node/ | Understand the Node.js-specific runtime behavior and APIs for Flue applications. |
| Tools | [`docs-guide-tools.md`](./docs-guide-tools.md) | https://flueframework.com/docs/guide/tools/ | Give agents application capabilities through custom tools and MCP servers. |
| Workflows | [`docs-guide-workflows.md`](./docs-guide-workflows.md) | https://flueframework.com/docs/guide/workflows/ | Create, invoke, and expose finite agent-backed operations. |

## API Reference

| Title | File | Source | Covers |
|---|---|---|---|
| Action API | [`docs-api-action-api.md`](./docs-api-action-api.md) | https://flueframework.com/docs/api/action-api/ | Reference for defining reusable finite Actions with @flue/runtime. |
| Agent API | [`docs-api-agent-api.md`](./docs-api-agent-api.md) | https://flueframework.com/docs/api/agent-api/ | Reference for defining agents and running agent operations with @flue/runtime. |
| Data Persistence API | [`docs-api-data-persistence-api.md`](./docs-api-data-persistence-api.md) | https://flueframework.com/docs/api/data-persistence-api/ | Reference for Flue persistence adapters and stores. |
| Errors Reference | [`docs-api-errors-reference.md`](./docs-api-errors-reference.md) | https://flueframework.com/docs/api/errors-reference/ | Reference Flue transport errors, runtime failures, and development diagnostics. |
| Events Reference | [`docs-api-events-reference.md`](./docs-api-events-reference.md) | https://flueframework.com/docs/api/events-reference/ | Reference runtime activity, attached-agent event types, and global observation APIs. |
| Provider API | [`docs-api-provider-api.md`](./docs-api-provider-api.md) | https://flueframework.com/docs/api/provider-api/ | Register custom model providers and override built-in provider transport. |
| Routing API | [`docs-api-routing-api.md`](./docs-api-routing-api.md) | https://flueframework.com/docs/api/routing-api/ | Compose Flue routes in an authored application entrypoint. |
| Sandbox Adapter API | [`docs-api-sandbox-api.md`](./docs-api-sandbox-api.md) | https://flueframework.com/docs/api/sandbox-api/ | Adapt a provider sandbox SDK into Flue's public sandbox contract. |
| Streaming Protocol | [`docs-api-streaming-protocol.md`](./docs-api-streaming-protocol.md) | https://flueframework.com/docs/api/streaming-protocol/ | Reference for reading Flue agent conversations and workflow events over Durable Streams. |
| Workflow API | [`docs-api-workflow-api.md`](./docs-api-workflow-api.md) | https://flueframework.com/docs/api/workflow-api/ | Reference for creating and invoking workflows with @flue/runtime. |

## Reference

| Title | File | Source | Covers |
|---|---|---|---|
| Configuration | [`docs-reference-configuration.md`](./docs-reference-configuration.md) | https://flueframework.com/docs/reference/configuration/ | Reference for flue.config.ts options. |

## CLI

| Title | File | Source | Covers |
|---|---|---|---|
| flue add | [`docs-cli-add.md`](./docs-cli-add.md) | https://flueframework.com/docs/cli/add/ | Reference for discovering and applying Flue implementation blueprints. |
| flue build | [`docs-cli-build.md`](./docs-cli-build.md) | https://flueframework.com/docs/cli/build/ | Reference for creating deployable Flue application artifacts. |
| flue dev | [`docs-cli-dev.md`](./docs-cli-dev.md) | https://flueframework.com/docs/cli/dev/ | Reference for starting a watch-mode local Flue development server. |
| flue docs | [`docs-cli-docs.md`](./docs-cli-docs.md) | https://flueframework.com/docs/cli/docs/ | Reference for listing, reading, and searching the bundled Flue documentation. |
| flue init | [`docs-cli-init.md`](./docs-cli-init.md) | https://flueframework.com/docs/cli/init/ | Reference for creating an initial Flue project configuration file. |
| CLI | [`docs-cli-overview.md`](./docs-cli-overview.md) | https://flueframework.com/docs/cli/overview/ | Use the Flue CLI to configure, develop, exercise, inspect, and build an application. |
| flue run | [`docs-cli-run.md`](./docs-cli-run.md) | https://flueframework.com/docs/cli/run/ | Reference for executing one agent prompt or workflow invocation from the command line. |
| flue update | [`docs-cli-update.md`](./docs-cli-update.md) | https://flueframework.com/docs/cli/update/ | Reference for updating integrations from newer Flue blueprint upgrade guides. |

## SDK

| Title | File | Source | Covers |
|---|---|---|---|
| client.agents | [`docs-sdk-agents.md`](./docs-sdk-agents.md) | https://flueframework.com/docs/sdk/agents/ | Invoke persistent agent instances and read their conversations. |
| createFlueClient(...) | [`docs-sdk-client.md`](./docs-sdk-client.md) | https://flueframework.com/docs/sdk/client/ | Configure an SDK client for a deployed Flue application. |
| Errors | [`docs-sdk-errors.md`](./docs-sdk-errors.md) | https://flueframework.com/docs/sdk/errors/ | SDK HTTP and stream error types. |
| Events and records | [`docs-sdk-events.md`](./docs-sdk-events.md) | https://flueframework.com/docs/sdk/events/ | SDK event, workflow-run record, and normalized model-turn types. |
| SDK overview | [`docs-sdk-overview.md`](./docs-sdk-overview.md) | https://flueframework.com/docs/sdk/overview/ | Reference for consuming deployed Flue agents and workflows with @flue/sdk. |
| client.runs | [`docs-sdk-runs.md`](./docs-sdk-runs.md) | https://flueframework.com/docs/sdk/runs/ | Inspect and stream HTTP-exposed workflow runs. |
| client.workflows | [`docs-sdk-workflows.md`](./docs-sdk-workflows.md) | https://flueframework.com/docs/sdk/workflows/ | Start workflow runs and receive their run ID. |

## Ecosystem — Channels

| Title | File | Source | Covers |
|---|---|---|---|
| Discord | [`docs-ecosystem-channels-discord.md`](./docs-ecosystem-channels-discord.md) | https://flueframework.com/docs/ecosystem/channels/discord/ | Receive verified Discord interactions and use a project-owned REST client. |
| GitHub | [`docs-ecosystem-channels-github.md`](./docs-ecosystem-channels-github.md) | https://flueframework.com/docs/ecosystem/channels/github/ | Receive signed GitHub webhooks and use Octokit from application-owned tools. |
| Google Chat | [`docs-ecosystem-channels-google-chat.md`](./docs-ecosystem-channels-google-chat.md) | https://flueframework.com/docs/ecosystem/channels/google-chat/ | Receive authenticated Google Chat interactions and Workspace Events with a project-owned REST client. |
| Intercom | [`docs-ecosystem-channels-intercom.md`](./docs-ecosystem-channels-intercom.md) | https://flueframework.com/docs/ecosystem/channels/intercom/ | Receive verified Intercom notifications and use a workspace-bound official client from application-owned tools. |
| Linear | [`docs-ecosystem-channels-linear.md`](./docs-ecosystem-channels-linear.md) | https://flueframework.com/docs/ecosystem/channels/linear/ | Receive verified Linear resource and agent-session webhooks with a project-owned SDK client. |
| Facebook Messenger | [`docs-ecosystem-channels-messenger.md`](./docs-ecosystem-channels-messenger.md) | https://flueframework.com/docs/ecosystem/channels/messenger/ | Receive verified Messenger Page events with a project-owned Graph API client. |
| Notion | [`docs-ecosystem-channels-notion.md`](./docs-ecosystem-channels-notion.md) | https://flueframework.com/docs/ecosystem/channels/notion/ | Receive signed Notion webhook events and use the official client from application-owned tools. |
| Resend | [`docs-ecosystem-channels-resend.md`](./docs-ecosystem-channels-resend.md) | https://flueframework.com/docs/ecosystem/channels/resend/ | Receive verified Resend webhooks and retrieve inbound email through the official client. |
| Salesforce Marketing Cloud | [`docs-ecosystem-channels-salesforce-marketing-cloud.md`](./docs-ecosystem-channels-salesforce-marketing-cloud.md) | https://flueframework.com/docs/ecosystem/channels/salesforce-marketing-cloud/ | Receive verified Marketing Cloud Engagement ENS batches and compose a tenant-bound Fetch client. |
| Shopify | [`docs-ecosystem-channels-shopify.md`](./docs-ecosystem-channels-shopify.md) | https://flueframework.com/docs/ecosystem/channels/shopify/ | Receive verified Shopify webhooks and use a shop-bound Admin GraphQL client from application-owned tools. |
| Slack | [`docs-ecosystem-channels-slack.md`](./docs-ecosystem-channels-slack.md) | https://flueframework.com/docs/ecosystem/channels/slack/ | Receive verified Slack events and use the Slack Web API from application code. |
| Stripe | [`docs-ecosystem-channels-stripe.md`](./docs-ecosystem-channels-stripe.md) | https://flueframework.com/docs/ecosystem/channels/stripe/ | Receive verified Stripe webhooks and use the official SDK from application-owned tools. |
| Microsoft Teams | [`docs-ecosystem-channels-teams.md`](./docs-ecosystem-channels-teams.md) | https://flueframework.com/docs/ecosystem/channels/teams/ | Receive authenticated Teams activities and use a project-owned Bot Connector client. |
| Telegram | [`docs-ecosystem-channels-telegram.md`](./docs-ecosystem-channels-telegram.md) | https://flueframework.com/docs/ecosystem/channels/telegram/ | Receive verified Telegram Bot API Updates with a project-owned grammY client. |
| Twilio | [`docs-ecosystem-channels-twilio.md`](./docs-ecosystem-channels-twilio.md) | https://flueframework.com/docs/ecosystem/channels/twilio/ | Receive verified Twilio SMS and MMS webhooks with a project-owned Fetch client. |
| WhatsApp | [`docs-ecosystem-channels-whatsapp.md`](./docs-ecosystem-channels-whatsapp.md) | https://flueframework.com/docs/ecosystem/channels/whatsapp/ | Receive verified WhatsApp Business Cloud deliveries with a project-owned Fetch client. |
| Zendesk | [`docs-ecosystem-channels-zendesk.md`](./docs-ecosystem-channels-zendesk.md) | https://flueframework.com/docs/ecosystem/channels/zendesk/ | Receive verified Zendesk events and use a ticket-bound Fetch client from application-owned tools. |

## Ecosystem — Databases

| Title | File | Source | Covers |
|---|---|---|---|
| libSQL | [`docs-ecosystem-databases-libsql.md`](./docs-ecosystem-databases-libsql.md) | https://flueframework.com/docs/ecosystem/databases/libsql/ | Give Flue agents and workflow runs durable state with libSQL — a local SQLite file, a self-hosted libSQL server, or an embedded replica. |
| MongoDB | [`docs-ecosystem-databases-mongodb.md`](./docs-ecosystem-databases-mongodb.md) | https://flueframework.com/docs/ecosystem/databases/mongodb/ | Give Flue agents and workflow runs durable, shared state with MongoDB. |
| MySQL | [`docs-ecosystem-databases-mysql.md`](./docs-ecosystem-databases-mysql.md) | https://flueframework.com/docs/ecosystem/databases/mysql/ | Give Flue agents and workflow runs durable, shared state with MySQL 8 and InnoDB. |
| Postgres | [`docs-ecosystem-databases-postgres.md`](./docs-ecosystem-databases-postgres.md) | https://flueframework.com/docs/ecosystem/databases/postgres/ | Give Flue agents and workflow runs durable, shared state with a Postgres database. |
| Redis | [`docs-ecosystem-databases-redis.md`](./docs-ecosystem-databases-redis.md) | https://flueframework.com/docs/ecosystem/databases/redis/ | Give Flue agents and workflow runs durable, shared state with Redis. |
| Supabase | [`docs-ecosystem-databases-supabase.md`](./docs-ecosystem-databases-supabase.md) | https://flueframework.com/docs/ecosystem/databases/supabase/ | Give Flue agents and workflow runs durable, shared state with Supabase Postgres. |
| Turso | [`docs-ecosystem-databases-turso.md`](./docs-ecosystem-databases-turso.md) | https://flueframework.com/docs/ecosystem/databases/turso/ | Give Flue agents and workflow runs durable, hosted state with Turso — managed, replicated libSQL. |
| Valkey | [`docs-ecosystem-databases-valkey.md`](./docs-ecosystem-databases-valkey.md) | https://flueframework.com/docs/ecosystem/databases/valkey/ | Give Flue agents and workflow runs durable, shared state with Valkey. |

## Ecosystem — Deploy

| Title | File | Source | Covers |
|---|---|---|---|
| Deploy Agents on AWS | [`docs-ecosystem-deploy-aws.md`](./docs-ecosystem-deploy-aws.md) | https://flueframework.com/docs/ecosystem/deploy/aws/ | Run the Flue Docker image on AWS — ECS Express Mode, EC2, or ECS on Fargate — with managed Postgres for durable state. |
| Deploy to Cloudflare | [`docs-ecosystem-deploy-cloudflare.md`](./docs-ecosystem-deploy-cloudflare.md) | https://flueframework.com/docs/ecosystem/deploy/cloudflare/ | Build and deploy Flue agents on Cloudflare Workers. |
| Deploy Agents with Docker | [`docs-ecosystem-deploy-docker.md`](./docs-ecosystem-deploy-docker.md) | https://flueframework.com/docs/ecosystem/deploy/docker/ | Package the Flue Node.js build as a portable container image. |
| Deploy Agents on Fly.io | [`docs-ecosystem-deploy-fly.md`](./docs-ecosystem-deploy-fly.md) | https://flueframework.com/docs/ecosystem/deploy/fly/ | Deploy Flue agents to Fly.io as a long-running Docker app on Fly Machines. |
| Build Agents for GitHub Actions | [`docs-ecosystem-deploy-github-actions.md`](./docs-ecosystem-deploy-github-actions.md) | https://flueframework.com/docs/ecosystem/deploy/github-actions/ | Build and run Flue agents in GitHub Actions. |
| Build Agents for GitLab CI/CD | [`docs-ecosystem-deploy-gitlab-ci.md`](./docs-ecosystem-deploy-gitlab-ci.md) | https://flueframework.com/docs/ecosystem/deploy/gitlab-ci/ | Build and run Flue agents in GitLab CI/CD pipelines. |
| Deploy Agents on Node.js | [`docs-ecosystem-deploy-node.md`](./docs-ecosystem-deploy-node.md) | https://flueframework.com/docs/ecosystem/deploy/node/ | Build and deploy Flue agents as a Node.js server. |
| Deploy Agents on Railway | [`docs-ecosystem-deploy-railway.md`](./docs-ecosystem-deploy-railway.md) | https://flueframework.com/docs/ecosystem/deploy/railway/ | Run the Flue Node server as a long-running Railway service. |
| Deploy Agents on Render | [`docs-ecosystem-deploy-render.md`](./docs-ecosystem-deploy-render.md) | https://flueframework.com/docs/ecosystem/deploy/render/ | Run the Flue Node server as a long-running Render web service. |
| Deploy Agents on SST | [`docs-ecosystem-deploy-sst.md`](./docs-ecosystem-deploy-sst.md) | https://flueframework.com/docs/ecosystem/deploy/sst/ | Deploy Flue agents to AWS with SST as a long-running Fargate container service. |

## Ecosystem — Sandboxes

| Title | File | Source | Covers |
|---|---|---|---|
| boxd | [`docs-ecosystem-sandboxes-boxd.md`](./docs-ecosystem-sandboxes-boxd.md) | https://flueframework.com/docs/ecosystem/sandboxes/boxd/ | Connect a Flue agent to an application-owned boxd Linux VM. |
| Cloudflare Shell | [`docs-ecosystem-sandboxes-cloudflare-shell.md`](./docs-ecosystem-sandboxes-cloudflare-shell.md) | https://flueframework.com/docs/ecosystem/sandboxes/cloudflare-shell/ | Use a durable Cloudflare Workspace with code-oriented agent operations. |
| Cloudflare Sandbox | [`docs-ecosystem-sandboxes-cloudflare.md`](./docs-ecosystem-sandboxes-cloudflare.md) | https://flueframework.com/docs/ecosystem/sandboxes/cloudflare/ | Run Flue agent work inside Cloudflare container-backed sandboxes. |
| Daytona | [`docs-ecosystem-sandboxes-daytona.md`](./docs-ecosystem-sandboxes-daytona.md) | https://flueframework.com/docs/ecosystem/sandboxes/daytona/ | Connect a Flue agent to an application-owned Daytona sandbox. |
| E2B | [`docs-ecosystem-sandboxes-e2b.md`](./docs-ecosystem-sandboxes-e2b.md) | https://flueframework.com/docs/ecosystem/sandboxes/e2b/ | Connect a Flue agent to an E2B Linux sandbox. |
| exe.dev | [`docs-ecosystem-sandboxes-exedev.md`](./docs-ecosystem-sandboxes-exedev.md) | https://flueframework.com/docs/ecosystem/sandboxes/exedev/ | Connect a Node-target Flue application to an exe.dev VM over SSH. |
| islo | [`docs-ecosystem-sandboxes-islo.md`](./docs-ecosystem-sandboxes-islo.md) | https://flueframework.com/docs/ecosystem/sandboxes/islo/ | Connect a Node-target Flue application to a named islo sandbox through its CLI. |
| Mirage | [`docs-ecosystem-sandboxes-mirage.md`](./docs-ecosystem-sandboxes-mirage.md) | https://flueframework.com/docs/ecosystem/sandboxes/mirage/ | Connect Flue agents to Mirage workspaces and mounted resources. |
| Modal | [`docs-ecosystem-sandboxes-modal.md`](./docs-ecosystem-sandboxes-modal.md) | https://flueframework.com/docs/ecosystem/sandboxes/modal/ | Connect a Flue agent to an application-owned Modal Sandbox. |
| Vercel Sandbox | [`docs-ecosystem-sandboxes-vercel.md`](./docs-ecosystem-sandboxes-vercel.md) | https://flueframework.com/docs/ecosystem/sandboxes/vercel/ | Connect a Flue agent to an application-owned Vercel Sandbox environment. |

## Ecosystem — Tooling

| Title | File | Source | Covers |
|---|---|---|---|
| Braintrust | [`docs-ecosystem-tooling-braintrust.md`](./docs-ecosystem-tooling-braintrust.md) | https://flueframework.com/docs/ecosystem/tooling/braintrust/ | Trace Flue workflows, model turns, tools, tasks, and compactions in Braintrust. |
| OpenTelemetry | [`docs-ecosystem-tooling-opentelemetry.md`](./docs-ecosystem-tooling-opentelemetry.md) | https://flueframework.com/docs/ecosystem/tooling/opentelemetry/ | Export Flue workflows, agents, model calls, and tools with OpenTelemetry GenAI semantics. |
| Sentry | [`docs-ecosystem-tooling-sentry.md`](./docs-ecosystem-tooling-sentry.md) | https://flueframework.com/docs/ecosystem/tooling/sentry/ | Report Flue workflow failures and explicit error logs to Sentry on Node.js and Cloudflare. |
| Vitest Evals | [`docs-ecosystem-tooling-vitest-evals.md`](./docs-ecosystem-tooling-vitest-evals.md) | https://flueframework.com/docs/ecosystem/tooling/vitest-evals/ | Add repeatable agent and workflow evals to a Flue project with vitest-evals. |

## Ecosystem

| Title | File | Source | Covers |
|---|---|---|---|
| Ecosystem | [`docs-ecosystem.md`](./docs-ecosystem.md) | https://flueframework.com/docs/ecosystem/ | Browse deployment guides, channels, databases, sandbox adapters, and developer tooling for Flue applications. |

## Root

| Title | File | Source | Covers |
|---|---|---|---|
| Getting Started | [`docs.md`](./docs.md) | https://flueframework.com/docs/ | Set up a Flue project automatically or create your first agent manually. |
