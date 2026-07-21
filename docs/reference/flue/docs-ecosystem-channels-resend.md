<!-- source: https://flueframework.com/docs/ecosystem/channels/resend/ -->
---
description: Receive verified Resend webhooks and retrieve inbound email through the official client.
title: Resend | Flue
image: https://flueframework.com/docs/og4.jpg
---

# Resend

AI-generated, awaiting review [ View as Markdown ](https://flueframework.com/docs/ecosystem/channels/resend/index.md) [  @flue/resend ](https://www.npmjs.com/package/@flue/resend) 

## Quickstart

Add verified webhook ingress and application-owned email behavior to an existing Flue project with the [Resend](https://resend.com) blueprint. Run the following command in your terminal or coding agent of choice:

```sh
flue add channel resend
```

## Overview

The Resend blueprint installs `@flue/resend` and the official `resend` SDK, adds the SDK’s declaration-only development dependencies, and creates `channels/resend.ts` in the source-root. It also updates the selected agent to bind a message-retrieval tool to the verified inbound email.

```ts
import { createResendChannel } from '@flue/resend';
import { dispatch } from '@flue/runtime';
import { Resend } from 'resend';
import assistant from '../agents/assistant.ts';

export const client = new Resend(process.env.RESEND_API_KEY!);

export const channel = createResendChannel({
  client,
  webhookSecret: process.env.RESEND_WEBHOOK_SECRET!,
  async webhook({ event, delivery }) {
    if (event.type !== 'email.received') return;
    await dispatch(assistant, {
      id: emailInstanceId(event.data.email_id),
      input: {
        type: 'resend.email.received',
        deliveryId: delivery.id,
        emailId: event.data.email_id,
        from: event.data.from,
        to: event.data.to,
        subject: event.data.subject,
      },
    });
  },
});
```

The abridged example omits the generated local email-id helpers and `retrieveReceivedEmail()` tool. The complete blueprint binds that tool in the agent module, so a verified `email.received` event starts a message-scoped agent instance that can retrieve the full email through the project-owned client. Receiving-domain setup, webhook registration, attachment retrieval, outbound mail, and reply policy remain application-owned.

## Configure

| Variable                | Purpose                                          |
| ----------------------- | ------------------------------------------------ |
| RESEND\_WEBHOOK\_SECRET | **Required** — Verifies inbound deliveries.      |
| RESEND\_API\_KEY        | **Required** — Authenticates outbound SDK calls. |

It installs `@flue/resend` and the official `resend@6.12.4` SDK. The blueprint creates a channel module with named `channel` and project-owned `client`exports.

Configure the webhook URL as:

```txt
https://example.com/channels/resend/webhook
```

The webhook secret and outbound API key are separate credentials.

The SDK’s public declarations reference `Buffer` and React email types. Add `@types/node` and `@types/react` as development dependencies. Both are declaration-only requirements and add no Node or React runtime code to a Worker bundle.

## Channel module

```ts
import { createResendChannel } from '@flue/resend';
import { defineTool, dispatch } from '@flue/runtime';
import { Resend } from 'resend';
import assistant from '../agents/assistant.ts';

const EMAIL_INSTANCE_PREFIX = 'resend-email:';

export const client = new Resend(process.env.RESEND_API_KEY!);

export const channel = createResendChannel({
  client,
  webhookSecret: process.env.RESEND_WEBHOOK_SECRET!,

  // Path: /channels/resend/webhook
  async webhook({ event, delivery }) {
    switch (event.type) {
      case 'email.received': {
        await dispatch(assistant, {
          id: emailInstanceId(event.data.email_id),
          input: {
            type: 'resend.email.received',
            deliveryId: delivery.id,
            emailId: event.data.email_id,
            messageId: event.data.message_id,
            from: event.data.from,
            to: event.data.to,
            cc: event.data.cc,
            subject: event.data.subject,
            attachments: event.data.attachments,
          },
        });
        return;
      }
      default:
        return;
    }
  },
});

export function retrieveReceivedEmail(emailId: string) {
  return defineTool({
    name: 'retrieve_resend_email',
    description: 'Retrieve the complete inbound email already bound to this agent.',
    async run() {
      const result = await client.emails.receiving.get(emailId);
      if (result.error) throw new Error(result.error.message);
      return result.data;
    },
  });
}

export function emailInstanceId(emailId: string): string {
  if (!emailId) throw new TypeError('Resend email id must be non-empty.');
  return `${EMAIL_INSTANCE_PREFIX}${encodeURIComponent(emailId)}`;
}

export function emailIdFromInstanceId(id: string): string {
  if (!id.startsWith(EMAIL_INSTANCE_PREFIX)) {
    throw new TypeError('Expected a local Resend email instance id.');
  }
  const emailId = decodeURIComponent(id.slice(EMAIL_INSTANCE_PREFIX.length));
  if (!emailId) throw new TypeError('Expected a local Resend email instance id.');
  return emailId;
}
```

`@flue/resend` gives `client.webhooks.verify()` the exact request body and the signed `svix-id`, `svix-timestamp`, and `svix-signature` values before invoking `webhook`. Returning nothing produces an empty `200`. A JSON-compatible value becomes the response body, and a normal Hono or Fetch `Response` passes through unchanged. Resend retries every status other than `200`, so return a non-`200`response only when redelivery is intentional.

Every verified delivery is the official `WebhookEventPayload` union, forwarded verbatim. Each event keeps its provider-native `event.type`, `created_at`, and `data` fields, including event types newer than your installed `resend`version. The channel never wraps events in a `type: 'unknown'` envelope, so `switch (event.type)` narrows the modeled variants and a `default` branch handles anything your SDK predates.

## Retrieve message content

The `email.received` webhook includes routing metadata and attachment descriptors. Retrieve the full body, headers, and current attachment metadata later through the project-owned client:

```ts
const email = await client.emails.receiving.get(emailId);
```

Use `client.emails.receiving.attachments` to obtain signed download URLs when attachment content is needed. Fetch only the content authorized for the current application action, and decide separately what may enter model context or durable storage.

## Bind the tool

```ts
import { defineAgent } from '@flue/runtime';
import { emailIdFromInstanceId, retrieveReceivedEmail } from '../channels/resend.ts';

export default defineAgent(({ id }) => {
  const emailId = emailIdFromInstanceId(id);
  return {
    model: 'anthropic/claude-haiku-4-5',
    tools: [retrieveReceivedEmail(emailId)],
  };
});
```

The model can retrieve only the email already bound by trusted application code. Outbound send, forward, or reply tools should likewise bind credentials, sender identity, recipients, and message policy outside model-selected arguments.

The `resend-email:` id is an application convention for one inbound message. The package does not expose a conversation helper because Resend’s `message_id` identifies one message rather than a stable thread root. Define and persist any reply-grouping policy in application code.

## Delivery behavior

Resend delivery is at least once and ordering is not guaranteed. `delivery.id`comes from the `svix-id` Resend documents for deduplication. Claim it in application-owned durable storage before dispatch when duplicate admission is unacceptable.

The channel is stateless. It does not register webhooks, manage receiving domains or MX records, store credentials, deduplicate deliveries, restore ordering, persist messages, retrieve bodies or attachments automatically, or send replies.

## Cloudflare Workers

The official `resend@6.12.4` client and webhook verifier execute in Node and workerd with Flue’s required `nodejs_compat` configuration. Cloudflare projects may initialize secrets through `process.env` or typed Worker bindings, then should verify their complete Worker build.

Test ingress with original synthetic bodies and locally generated Svix-format HMAC signatures over the exact bytes. Test the real client against a local fake `baseUrl` and a Fetch stub that rejects unexpected destinations. Exercise both paths in Node and workerd; tests should never contact Resend.

Receiving-domain configuration, webhook registration, API keys, signing-secret rotation, deduplication, persistence, outbound mail, and reply behavior remain application-owned.

See the [@flue/resend README](https://github.com/withastro/flue/tree/main/packages/resend#readme).

## Docs Navigation

Current page: [Resend](https://flueframework.com/docs/ecosystem/channels/resend/)

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