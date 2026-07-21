<!-- source: https://flueframework.com/docs/ecosystem/channels/linear/ -->
---
description: Receive verified Linear resource and agent-session webhooks with a project-owned SDK client.
title: Linear | Flue
image: https://flueframework.com/docs/og4.jpg
---

# Linear

AI-generated, awaiting review [ View as Markdown ](https://flueframework.com/docs/ecosystem/channels/linear/index.md) [  @flue/linear ](https://www.npmjs.com/package/@flue/linear) 

## Quickstart

Add verified Linear resource and agent-session webhooks with project-owned outbound Linear API access to an existing Flue project with the [Linear](https://linear.app/developers) blueprint. Run the following command in your terminal or coding agent of choice:

```sh
flue add channel linear
```

## Overview

The blueprint installs `@flue/linear` and the official `@linear/sdk`, creates a source-root `channels/linear.ts` module with named `channel` and project-owned `client` exports, and modifies the selected agent to bind the generated message tool.

```ts
import { createLinearChannel } from '@flue/linear';
import { dispatch } from '@flue/runtime';
import { LinearClient } from '@linear/sdk';
import assistant from '../agents/assistant.ts';

export const client = new LinearClient({
  apiKey: process.env.LINEAR_API_KEY!,
});

export const channel = createLinearChannel({
  webhookSecret: process.env.LINEAR_WEBHOOK_SECRET!,
  async webhook({ payload, deliveryId }) {
    if (payload.type !== 'Comment' || !('body' in payload.data)) return;
    const comment = payload.data;
    if (payload.action !== 'create' || !comment.issueId) return;
    await dispatch(assistant, {
      id: channel.conversationKey({
        type: 'issue',
        organizationId: payload.organizationId,
        issueId: comment.issueId,
        ...(comment.parentId ? { threadCommentId: comment.parentId } : {}),
      }),
      input: { type: 'linear.comment.created', deliveryId, comment },
    });
  },
});
```

The abridged example shows the generated comment path and omits the agent-session branch, reusable type guards, and message tool. Once configured, a new issue comment continues the agent instance for that issue or comment thread, while the bound SDK tool posts replies to the same Linear conversation. The official SDK also supports the generated agent-session path and runs with Flue’s `nodejs_compat` setting on Cloudflare Workers.

## Configure

| Variable                 | Purpose                                                                 |
| ------------------------ | ----------------------------------------------------------------------- |
| LINEAR\_WEBHOOK\_SECRET  | **Required** — Verifies inbound webhook deliveries.                     |
| LINEAR\_API\_KEY         | **Required** — Authenticates the example’s outbound SDK client.         |
| LINEAR\_ORGANIZATION\_ID | **Optional** — Restricts inbound deliveries to one Linear organization. |
| LINEAR\_WEBHOOK\_ID      | **Optional** — Restricts inbound deliveries to one configured webhook.  |

It installs `@flue/linear` for verified ingress and the official `@linear/sdk` for project-owned outbound API access. Linear uses that SDK in its own Cloudflare Workers agent example with `nodejs_compat`, which Flue’s Cloudflare target already enables.

Set the webhook URL to:

```txt
https://example.com/channels/linear/webhook
```

## Channel module

```ts
import {
  createLinearChannel,
  type LinearConversationRef,
  type LinearWebhookPayload,
} from '@flue/linear';
import { defineTool, dispatch } from '@flue/runtime';
import { LinearClient } from '@linear/sdk';
import * as v from 'valibot';
import type {
  AgentSessionEventWebhookPayload,
  EntityWebhookPayloadWithCommentData,
} from '@linear/sdk/webhooks';
import assistant from '../agents/assistant.ts';

const organizationId = process.env.LINEAR_ORGANIZATION_ID;

export const client = new LinearClient({
  apiKey: process.env.LINEAR_API_KEY!,
});

export const channel = createLinearChannel({
  webhookSecret: process.env.LINEAR_WEBHOOK_SECRET!,
  ...(organizationId ? { organizationId } : {}),

  // Path: /channels/linear/webhook
  async webhook({ payload, deliveryId }) {
    if (isCommentEvent(payload)) {
      const comment = payload.data;
      if (payload.action !== 'create' || !comment.issueId) return;
      await dispatch(assistant, {
        id: channel.conversationKey({
          type: 'issue',
          organizationId: payload.organizationId,
          issueId: comment.issueId,
          ...(comment.parentId ? { threadCommentId: comment.parentId } : {}),
        }),
        input: {
          type: 'linear.comment.created',
          deliveryId,
          actor: payload.actor,
          comment,
        },
      });
      return;
    }

    if (isAgentSessionEvent(payload)) {
      await dispatch(assistant, {
        id: channel.conversationKey({
          type: 'agent-session',
          organizationId: payload.organizationId,
          agentSessionId: payload.agentSession.id,
        }),
        input: {
          type: `linear.agent_session.${payload.action}`,
          promptContext: payload.promptContext,
          activity: payload.agentActivity,
        },
      });
    }
  },
});

// Linear's native union has a catch-all member that keeps `type` widened, so a
// literal `type` check alone does not narrow. Combine it with a nested field.
function isCommentEvent(
  payload: LinearWebhookPayload,
): payload is EntityWebhookPayloadWithCommentData {
  return payload.type === 'Comment' && 'body' in payload.data;
}

function isAgentSessionEvent(
  payload: LinearWebhookPayload,
): payload is AgentSessionEventWebhookPayload {
  return payload.type === 'AgentSessionEvent' && 'agentSession' in payload;
}

export function postMessage(ref: LinearConversationRef) {
  return defineTool({
    name: 'post_linear_message',
    description: 'Post to the Linear conversation bound to this agent.',
    input: v.object({ text: v.pipe(v.string(), v.minLength(1)) }),
    async run({ input: { text } }) {
      if (ref.type === 'agent-session') {
        const result = await client.createAgentActivity({
          agentSessionId: ref.agentSessionId,
          content: { type: 'response', body: text },
        });
        return { success: result.success };
      }

      const result = await client.createComment({
        issueId: ref.issueId,
        ...(ref.threadCommentId ? { parentId: ref.threadCommentId } : {}),
        body: text,
      });
      return { success: result.success };
    },
  });
}
```

Use `accessToken` instead of `apiKey` for an installed OAuth application. OAuth installation storage and organization-specific token selection remain application concerns.

## Bind the tool

```ts
import { defineAgent } from '@flue/runtime';
import { channel, postMessage } from '../channels/linear.ts';

export default defineAgent(({ id }) => ({
  model: 'anthropic/claude-haiku-4-5',
  tools: [postMessage(channel.parseConversationKey(id))],
}));
```

Trusted code binds the organization, issue thread, or agent session. The model selects only message text.

## Resource webhooks

Create a Linear webhook for the resource families the application handles, typically Comments, Issues, and Projects. The package verifies the exact body against `Linear-Signature`, rejects signed timestamps outside one minute, and optionally checks configured organization and webhook ids.

The handler receives the provider-native `payload`, typed by Linear’s official `LinearWebhookPayload` union (re-exported from `@linear/sdk/webhooks`). Entity deliveries are discriminated on `type` (`'Comment'`, `'Issue'`, `'Project'`, …) and carry `action` and `data`; Flue forwards the body unmodified, including verified deliveries the union does not model. The union has a catch-all member that keeps `type` widened to `string`, so a literal `type` check alone does not narrow it — pair the literal with a discriminating nested field in a small application-side type guard (as in the channel module above).

The application derives conversation keys from native fields. Top-level comments use the issue conversation; replies pass the root comment id as `threadCommentId` for the nested thread.

## Agent sessions

Enable Agent session events on a Linear OAuth application configured as an app actor. Install it with the scopes required by your operations and `app:mentionable` when users should mention the agent.

`created` events carry the `agentSession` and may include Linear’s formatted `promptContext`, `previousComments`, and `guidance`. `prompted` events carry the new `agentActivity`. The application builds a stable agent-session conversation key from `payload.agentSession.id`.

Linear expects the webhook response within five seconds and a new session to receive an activity or external URL update within ten seconds. Keep the verified handler focused on durable dispatch admission, then use the project-owned SDK client to post progress and results.

## Delivery behavior

Returning nothing produces an empty `200`. Return JSON for a response body or use the Hono context for explicit status control. A failure or non-`200`response asks Linear to retry.

Linear treats a delivery as failed if it does not return `200` within five seconds, then retries after one minute, one hour, and six hours. The channel does not enforce a timer; admit durable work quickly (dispatch, then return) and rely on idempotency rather than blocking on slow work before responding.

The channel requires Linear’s UUID-v4 `Linear-Delivery` header and exposes it for application-owned deduplication, but does not persist delivery state. Conversation keys validate syntax, not authorization.

See the [@flue/linear README](https://github.com/withastro/flue/tree/main/packages/linear#readme).

## Docs Navigation

Current page: [Linear](https://flueframework.com/docs/ecosystem/channels/linear/)

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