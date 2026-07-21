<!-- source: https://flueframework.com/docs/ecosystem/channels/intercom/ -->
---
description: Receive verified Intercom notifications and use a workspace-bound official client from application-owned tools.
title: Intercom | Flue
image: https://flueframework.com/docs/og4.jpg
---

# Intercom

AI-generated, awaiting review [ View as Markdown ](https://flueframework.com/docs/ecosystem/channels/intercom/index.md) [  @flue/intercom ](https://www.npmjs.com/package/@flue/intercom) 

## Quickstart

Add verified webhook ingress and application-owned API behavior to an existing Flue project with the [Intercom](https://developers.intercom.com) blueprint. Run the following command in your terminal or coding agent of choice:

```sh
flue add channel intercom
```

## Overview

The Intercom blueprint installs `@flue/intercom` and the official `intercom-client` SDK, creates a project-owned client factory at the source-root `intercom-client.ts`, and creates `channels/intercom.ts`. It also updates the selected agent to bind a conversation-retrieval tool to the verified workspace and conversation.

```ts
import { createIntercomChannel, type IntercomConversationRef } from '@flue/intercom';
import { dispatch } from '@flue/runtime';
import assistant from '../agents/assistant.ts';
import { createIntercomClient } from '../intercom-client.ts';

export const client = createIntercomClient(process.env.INTERCOM_ACCESS_TOKEN!, { region: 'us' });

export const channel = createIntercomChannel({
  clientSecret: process.env.INTERCOM_CLIENT_SECRET!,
  async webhook({ notification }) {
    if (notification.topic !== 'conversation.user.replied') return;
    const conversationId = conversationIdFromItem(notification.data.item);
    if (!conversationId) return;

    const conversation: IntercomConversationRef = {
      workspaceId: notification.app_id,
      conversationId,
    };
    await dispatch(assistant, {
      id: channel.conversationKey(conversation),
      input: {
        type: 'intercom.conversation.user.replied',
        notificationId: notification.id,
        conversation: notification.data.item,
      },
    });
  },
});
```

The abridged example shows one dispatched topic and omits the generated environment, region, conversation-id, and retrieval-tool helpers. The complete generated module dispatches `conversation.user.created` and `conversation.user.replied`; other verified topics reach the callback and remain subject to application policy. It pins the SDK to its typed API version, selects the configured region, and binds the retrieval tool in the agent module, so dispatched notifications reach a workspace-scoped agent instance that can retrieve the current conversation without exposing workspace ids or credentials to the model.

## Configure

| Variable                 | Purpose                                                               |
| ------------------------ | --------------------------------------------------------------------- |
| INTERCOM\_CLIENT\_SECRET | **Required** — Verifies inbound notifications.                        |
| INTERCOM\_ACCESS\_TOKEN  | **Required** — Authenticates outbound API calls.                      |
| INTERCOM\_WORKSPACE\_ID  | **Required** — Restricts resource identity to one Intercom workspace. |
| INTERCOM\_REGION         | **Optional** — Selects us, eu, or au; defaults to us.                 |

It installs `@flue/intercom` and the official `intercom-client@7.0.3`. The blueprint creates named `channel` and project-owned `client` exports.

Configure one URL in Intercom’s Developer Hub:

```txt
https://example.com/channels/intercom/webhook
```

Intercom validates that URL with `HEAD` and sends notifications to it with `POST`. The client secret and outbound access token are separate credentials.

## Channel module

```ts
import {
  createIntercomChannel,
  type IntercomConversationRef,
  type JsonValue,
} from '@flue/intercom';
import { defineTool, dispatch } from '@flue/runtime';
import assistant from '../agents/assistant.ts';
import { createIntercomClient, type IntercomRegion } from '../intercom-client.ts';

const workspaceId = requiredEnv('INTERCOM_WORKSPACE_ID');

export const client = createIntercomClient(requiredEnv('INTERCOM_ACCESS_TOKEN'), {
  region: intercomRegion(),
});

export const channel = createIntercomChannel({
  clientSecret: requiredEnv('INTERCOM_CLIENT_SECRET'),

  // Path: /channels/intercom/webhook (HEAD, POST)
  async webhook({ notification }) {
    switch (notification.topic) {
      case 'conversation.user.created':
      case 'conversation.user.replied': {
        const conversationId = conversationIdFromItem(notification.data.item);
        if (!conversationId) return;

        const conversation: IntercomConversationRef = {
          workspaceId: notification.app_id,
          conversationId,
        };
        await dispatch(assistant, {
          id: channel.conversationKey(conversation),
          input: {
            type: `intercom.${notification.topic}`,
            notificationId: notification.id,
            createdAt: notification.created_at,
            deliveryAttempts: notification.delivery_attempts,
            conversation: notification.data.item,
          },
        });
        return;
      }
      default:
        return;
    }
  },
});

export function retrieveConversation(ref: IntercomConversationRef) {
  if (ref.workspaceId !== workspaceId) {
    throw new TypeError('Expected the configured Intercom workspace.');
  }
  return defineTool({
    name: 'retrieve_intercom_conversation',
    description: 'Retrieve the current Intercom conversation bound to this agent.',
    async run() {
      const conversation = await client.conversations.find({
        conversation_id: ref.conversationId,
        display_as: 'plaintext',
      });
      return conversation;
    },
  });
}

function conversationIdFromItem(item: JsonValue): string | undefined {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return undefined;
  return typeof item.id === 'string' && item.id.length > 0 ? item.id : undefined;
}

function intercomRegion(): IntercomRegion {
  const value = process.env.INTERCOM_REGION || 'us';
  if (value === 'us' || value === 'eu' || value === 'au') return value;
  throw new Error('INTERCOM_REGION must be us, eu, or au.');
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}
```

The example handles two conversation topics with one grouped switch branch. Intercom’s topic catalog is broad and API-versioned, so the channel keeps `notification.topic` open and represents `notification.data.item` as JSON. Validate the fields used by each selected topic. Verified `ping` and future topics reach the same callback.

The HMAC-verified body already carries `app_id`, so the channel does not re-check workspace identity. Resource ids are not globally unique across Intercom workspaces, so the example combines `notification.app_id` and the conversation id into a canonical key. An app that serves multiple workspaces filters on `notification.app_id` itself, or uses application-owned installation state to select credentials.

## Official client

Keep the REST client in project code:

```ts
import { IntercomClient, IntercomEnvironment } from 'intercom-client';

export type IntercomRegion = 'us' | 'eu' | 'au';

export interface IntercomClientOptions {
  region?: IntercomRegion;
  fetch?: typeof globalThis.fetch;
  maxRetries?: number;
}

export function createIntercomClient(
  token: string,
  options: IntercomClientOptions = {},
): IntercomClient {
  if (!token) throw new TypeError('Intercom access token must be non-empty.');
  return new IntercomClient({
    token,
    version: '2.14',
    environment: environmentForRegion(options.region ?? 'us'),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
  });
}

function environmentForRegion(
  region: IntercomRegion,
): (typeof IntercomEnvironment)[keyof typeof IntercomEnvironment] {
  switch (region) {
    case 'us':
      return IntercomEnvironment.UsProduction;
    case 'eu':
      return IntercomEnvironment.EuProduction;
    case 'au':
      return IntercomEnvironment.AuProduction;
  }
}
```

The SDK supports US, EU, and AU API environments. Select the region in trusted configuration instead of accepting an API host from a model or webhook field.

Pin `version: '2.14'`. `intercom-client@7.0.3` generates its REST request and response types for API version 2.14\. Newer webhook topic documentation does not make those generated REST types compatible with a manually forced 2.15 header. Use a narrow Fetch client for a genuinely 2.15-only operation until the official SDK supports it.

## Bind the tool

```ts
import { defineAgent } from '@flue/runtime';
import { channel, retrieveConversation } from '../channels/intercom.ts';

export default defineAgent(({ id }) => {
  const conversation = channel.parseConversationKey(id);
  return {
    model: 'anthropic/claude-haiku-4-5',
    tools: [retrieveConversation(conversation)],
  };
});
```

The tool retrieves only the conversation already selected from a verified notification. It accepts no workspace, conversation id, token, or API host from the model.

`channel.conversationKey()` creates canonical workspace-scoped identity. Conversation keys remain identifiers, not authorization capabilities. Apply the project’s normal access control to direct agent routes, and verify the workspace again before selecting an installation token.

## Endpoint validation and signatures

The discovered channel serves both:

```txt
HEAD /channels/intercom/webhook
POST /channels/intercom/webhook
```

The unsigned `HEAD` route returns an empty `200` for Intercom’s endpoint validation and never invokes application code.

Notifications require:

```txt
X-Hub-Signature: sha1=<40 hexadecimal characters>
```

Intercom computes HMAC-SHA1 over the exact request body using the developer app client secret. `@flue/intercom` retains and verifies those bytes before UTF-8 decoding or JSON parsing. A changed body, missing or malformed signature, or wrong secret is rejected before `webhook` runs.

The callback receives `{ c, notification }`. The notification is Intercom’s own object, with its native field names and nesting:

* `topic` and workspace-scoped `app_id`;
* nullable `id`;
* `created_at`, `delivery_attempts`, and `first_sent_at`;
* provider-native JSON under `data.item`;
* optional `self`;
* any unmodeled top-level fields, forwarded unchanged.

The envelope is structurally checked, but item fields remain provider-native. Deletion, ticket, conversation-part, and future topics may have different shapes. Do not assume every conversation-related topic has `data.item.id`without validating that topic’s documented payload.

Intercom supplies no signed timestamp or protocol replay window. Signature verification authenticates delivery bytes but does not provide deduplication or freshness.

## Responses and delivery

Returning nothing produces an empty `200`. A JSON-compatible value becomes a JSON response with status `200`. A normal Hono or Fetch `Response` passes through unchanged. A thrown callback surfaces to the framework error handler as `500`.

Intercom acknowledges on any `2xx`. Use `200` for ordinary acknowledgment. Return another status only when its provider behavior is intentional: `410`disables the subscription, while `429` throttles it. Ordinary failures are retried once after approximately one minute.

Intercom expects a `2xx` within about five seconds and otherwise retries the notification once after one minute. The channel does not enforce this with a timer, because a promise timeout cannot cancel arbitrary JavaScript work. Admit durable work quickly — dispatch and return — and defer long-running processing beyond the acknowledgment path.

Notifications can be duplicated and arrive out of order. Use a non-null `notification.id` in application-owned durable storage when duplicate admission is unacceptable, and consider `created_at` when ordering matters. Setup or periodic pings may have a null id.

The package does not install an app, perform OAuth, select permissions, create subscriptions, store tokens, deduplicate notifications, persist conversations, or define outbound inbox policy.

## Cloudflare Workers

The verifier uses Web Crypto. The official `intercom-client@7.0.3` uses Fetch, has no runtime dependencies, and executes in workerd with Flue’s required `nodejs_compat` configuration. The example’s workerd test performs a real `client.conversations.find()` request through injected fake Fetch and confirms the expected EU URL, bearer token, `Intercom-Version: 2.14`, and workerd runtime header.

That execution proves the client operation shown here, not every SDK method. Test each additional operation used by the application against its actual Worker target. Cloudflare projects may use typed bindings instead of `process.env`; `nodejs_compat` is already part of Flue’s Worker configuration.

Create original synthetic notification bodies and local HMAC-SHA1 signatures. Exercise valid and tampered exact bytes, `HEAD`, ping, future topics, malformed JSON, body limits, handler results, a thrown callback surfacing as `500`, and conversation-key round trips in Node and workerd.

For outbound tests, inject fail-closed Fetch into the actual official client, disable retries, assert the exact host, path, method, authorization, version, and region, and reject every unexpected destination. Do not register a webhook, perform OAuth, obtain a real token, or contact Intercom.

See the [@flue/intercom README](https://github.com/withastro/flue/tree/main/packages/intercom#readme).

## Docs Navigation

Current page: [Intercom](https://flueframework.com/docs/ecosystem/channels/intercom/)

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