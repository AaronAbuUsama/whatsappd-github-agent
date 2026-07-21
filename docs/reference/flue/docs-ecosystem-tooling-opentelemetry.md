<!-- source: https://flueframework.com/docs/ecosystem/tooling/opentelemetry/ -->
---
description: Export Flue workflows, agents, model calls, and tools with OpenTelemetry GenAI semantics.
title: OpenTelemetry | Flue
image: https://flueframework.com/docs/og4.jpg
---

# OpenTelemetry

AI-generated, awaiting review [ View as Markdown ](https://flueframework.com/docs/ecosystem/tooling/opentelemetry/index.md) [  @flue/opentelemetry ](https://www.npmjs.com/package/@flue/opentelemetry) 

`@flue/opentelemetry` projects Flue’s live runtime observations into standard OpenTelemetry GenAI spans and metrics. It does not configure an SDK, exporter, sampling, credentials, or deployment-specific flushing.

The package implements the Development GenAI conventions pinned at commit `4c8addb53718b544134be47e256237026fe88875`. Its Flue-to-GenAI projection revision is `5` and its Flue extension revision is `3`; the GenAI semantic-convention revision and schema remain unchanged. Updating any revision requires an explicit compatibility review.

## Configure

Install the adapter and OpenTelemetry API alongside an SDK and exporter compatible with your deployment target:

```sh
pnpm add @flue/opentelemetry @opentelemetry/api
```

Configure the SDK first, then register one instrumentation instance:

```ts
import { createOpenTelemetryInstrumentation } from '@flue/opentelemetry';
import { instrument } from '@flue/runtime';

const instrumentation = createOpenTelemetryInstrumentation();
const disposeInstrumentation = instrument(instrumentation);
```

Pass configured tracer, meter, or structural Logger instances when the application owns them. Generated Node applications automatically dispose registrations created while evaluating `app.ts` after admissions and active work drain. Call `await disposeInstrumentation()` yourself only when registering outside that lifecycle, then flush or shut down the application-owned SDK/exporter separately.

## Trace model

| Flue activity          | OpenTelemetry representation          |
| ---------------------- | ------------------------------------- |
| Workflow invocation    | invoke\_workflow <name>               |
| Prompt or skill        | invoke\_agent <agent>                 |
| Delegated task         | one task-owned invoke\_agent <agent>  |
| Provider inference     | chat <requested-model> client span    |
| GenAI tool execution   | execute\_tool <name>                  |
| Caller shell execution | flue.operation shell                  |
| Context compaction     | flue.compaction with child chat spans |

Provider chat spans cover provider inference only. The projection reads canonical model telemetry directly: semantic `request.providerName` becomes `gen_ai.provider.name`, while `request.providerId` remains the Flue registration identity. It does not fall back to removed top-level event fields. Local tools are sibling spans under the agent invocation and correlate with model output through `gen_ai.tool.call.id`.

`gen_ai.conversation.id` identifies one persisted Flue session. It is not a workflow run, submission, dispatch, operation, trace, session name, or provider-affinity key. Flue correlation fields remain under documented `flue.*` attributes when no exact standard field exists.

## Protect content

Content is disabled by default. This excludes implemented model messages, reasoning, system instructions, tool definitions, descriptions, arguments/results, exception messages, and external-content paths. Workflow values are not currently exported even when capture is enabled.

Use one instrumentation-wide policy to enable and redact content:

```ts
const instrumentation = createOpenTelemetryInstrumentation({
  content: {
    enabled: process.env.OTEL_GENAI_CAPTURE_CONTENT === 'true',
    transform(content) {
      return redactSecrets(content);
    },
  },
});
```

The `enabled` value is the global privacy ceiling. A detached converted value passes through `transform` once; returning `undefined` suppresses both destinations. Transforms are trusted application code; Flue does not validate their returned GenAI shape. Structural limits run afterward: `maxMessageParts` retains the first complete parts per input/output message and first top-level system instructions, and `maxToolDefinitions` retains the first definitions. Limit values must be finite nonnegative safe integers.

`externalContent` is a side-effect-only sink for system instructions and input/output messages. It receives a detached, structurally limited clone with a stable `contentType` scope regardless of span sampling or `inline`. Returns and mutations cannot alter inline content, failures only diagnose, and tool content is never delivered. Set `inline: false` to skip serialization while retaining this external delivery.

`maxAttributeBytes` measures the exact final UTF-8 inline string and does not limit external delivery. Object-shaped tool arguments/results use standard `gen_ai.tool.call.*` attributes; strings, arrays, primitives, and `null` use `flue.tool.call.arguments` or `flue.tool.call.result` under the same privacy and size policy. Tool descriptions and plain-text fallbacks remain raw strings. Bounded `flue.telemetry.content.*` attributes mark structural truncation and inline byte omission. The adapter does not invent flattened child keys beneath `gen_ai.*`.

## Metrics and Logs

The instrumentation emits client-operation, token-usage, workflow, agent-invocation, and tool-duration histograms. Metric dimensions exclude execution IDs; review your application-controlled workflow, agent, tool, provider, and model names for appropriate cardinality. Input token totals include cache-read and cache-creation input tokens.

Logs require explicit Logger injection. Failed inference operations emit the standard `gen_ai.client.operation.exception` event at WARN/13\. Error type is always recorded; transformed exception messages are included only when content capture is enabled. Logger absence does not affect traces or metrics.

## Propagation and recovery

Flue validates and persists `traceparent` and optional `tracestate` at workflow and direct-agent admission. Baggage is not persisted. Durable direct-agent processing activates its extracted admission context, and execution interceptors activate owning spans around workflow, agent, model-stream, tool, and task work. `dispatch(...)` does not currently propagate trace context.

Workflow recovery restores the persisted admission carrier as the parent of a new recovery-handling span. The new span begins at `run_resume`; it does not reconstruct or backdate the interrupted span. Recovery does not replay provider or tool execution. Stored stream chunks create no chat spans or usage observations, and synthetic interrupted-tool repairs create no `execute_tool` spans.

## Streaming limitation

Pi does not expose authoritative raw provider stream-item timing. Flue therefore omits time-to-first-chunk and time-per-output-chunk metrics instead of deriving inaccurate values from semantic text/reasoning deltas or recovered chunks.

## Migrate from the observer API

Replace `createOpenTelemetryObserver()` with `createOpenTelemetryInstrumentation()`, register it with `instrument(...)` instead of `observe(...)`, and replace `exportContent` with the global `content` policy. The legacy custom model/tool content attributes are removed rather than emitted alongside the standard fields.

## Unsupported operations

Flue does not emit invented spans for agent creation, planning, embeddings, retrieval, memory operations, remote agent clients, or evaluations. These operations remain absent until Flue exposes a genuine corresponding boundary.

## Verify

Use an in-memory OpenTelemetry exporter in tests to verify hierarchy, names, kinds, status, attributes, metrics, and default content omission. Hosted backend rendering is backend-specific; standards-correct OTel output is the portable contract.

## Docs Navigation

Current page: [OpenTelemetry](https://flueframework.com/docs/ecosystem/tooling/opentelemetry/)

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