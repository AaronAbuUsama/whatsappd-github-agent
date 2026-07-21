<!-- source: https://flueframework.com/docs/ecosystem/tooling/vitest-evals/ -->
---
description: Add repeatable agent and workflow evals to a Flue project with vitest-evals.
title: Vitest Evals | Flue
image: https://flueframework.com/docs/og4.jpg
---

# Vitest Evals

Last updated Jun 18, 2026 [ View as Markdown ](https://flueframework.com/docs/ecosystem/tooling/vitest-evals/index.md) 

## Quickstart

Add the [vitest-evals](https://vitest-evals.sentry.dev/docs) setup blueprint to an existing Flue project:

```sh
flue add tooling vitest-evals
```

The blueprint guides your coding agent through installing the test dependencies, creating a dedicated eval configuration, adapting Flue’s public SDK to a `vitest-evals` harness, and writing a starter case for behavior already defined by your application.

## Overview

`vitest-evals` adds eval harnesses, judges, normalized reports, and CI reporting to Vitest. The Flue integration evaluates the same public HTTP boundary used by a deployed application rather than importing Flue runtime internals.

The generated harness:

* prompts an HTTP-exposed agent through `@flue/sdk`;
* gives each eval case a fresh agent instance;
* captures the prompt’s event sequence using its server-provided offset and submission ID;
* records response text, model usage, costs, and tool calls in the normalized eval result;
* supports local servers and deployed applications through `FLUE_BASE_URL`.

The blueprint does not expose an existing agent automatically. Confirm that the agent’s `route` export and its authentication are appropriate before evaluating it over HTTP.

## Run evals

Start the Flue application in one terminal:

```sh
pnpm exec flue dev
```

After the server is ready, run evals in another terminal:

```sh
pnpm run evals
```

The server process needs the application’s normal model-provider credentials. To evaluate a deployment, set its public mount URL:

```sh
FLUE_BASE_URL=https://preview.example.com pnpm run evals
```

Configure a token or request headers in the SDK client when the target is protected. Never commit provider or application credentials.

## Reports

The blueprint adds commands for compact terminal output, detailed tool and usage output, and a JSON artifact. Open the JSON report locally with:

```sh
pnpm exec vitest-evals serve vitest-results.json
```

The same artifact can be published by the `getsentry/vitest-evals` GitHub Action. Reports can contain prompts, outputs, tool arguments and results, errors, and application metadata; review retention and access requirements before uploading them.

`vitest-evals` does not include a Braintrust reporter. Flue’s [Braintrust integration](https://flueframework.com/docs/ecosystem/tooling/braintrust/) can independently trace the application execution, but those traces do not replace eval cases, assertions, judges, or CI gates.

## Next steps

See [Evals](https://flueframework.com/docs/guide/evals/) for designing cases, choosing deterministic assertions or judges, evaluating workflows, and understanding the harness. A complete runnable project is available in [examples/vitest-evals](https://github.com/withastro/flue/tree/main/examples/vitest-evals).

## Docs Navigation

Current page: [Vitest Evals](https://flueframework.com/docs/ecosystem/tooling/vitest-evals/)

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