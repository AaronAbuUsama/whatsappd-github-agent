<!-- source: https://flueframework.com/docs/ecosystem/channels/twilio/ -->
---
description: Receive verified Twilio SMS and MMS webhooks with a project-owned Fetch client.
title: Twilio | Flue
image: https://flueframework.com/docs/og4.jpg
---

# Twilio

AI-generated, awaiting review [ View as Markdown ](https://flueframework.com/docs/ecosystem/channels/twilio/index.md) [  @flue/twilio ](https://www.npmjs.com/package/@flue/twilio) 

## Quickstart

Add verified SMS and MMS webhook ingress and project-owned outbound messaging to an existing Flue project with the [Twilio](https://www.twilio.com/docs/messaging) blueprint. Run the following command in your terminal or coding agent of choice:

```sh
flue add channel twilio
```

## Overview

The Twilio blueprint installs `@flue/twilio`, creates a project-owned Fetch client at the source-root `twilio-client.ts`, and creates `channels/twilio.ts`. It also updates the selected agent to bind the generated reply tool to the verified conversation.

```ts
import { createTwilioChannel } from '@flue/twilio';
import { dispatch } from '@flue/runtime';
import assistant from '../agents/assistant.ts';
import { TwilioClient } from '../twilio-client.ts';

export const client = new TwilioClient({
  accountSid: process.env.TWILIO_ACCOUNT_SID!,
  authToken: process.env.TWILIO_AUTH_TOKEN!,
});

export const channel = createTwilioChannel({
  accountSid: process.env.TWILIO_ACCOUNT_SID!,
  authToken: process.env.TWILIO_AUTH_TOKEN!,
  webhookUrl: process.env.TWILIO_WEBHOOK_URL!,
  destination: {
    type: 'address',
    address: process.env.TWILIO_PHONE_NUMBER!,
  },
  async webhook({ payload, conversation }) {
    if (payload.OptOutType === 'STOP') return;
    await dispatch(assistant, {
      id: channel.conversationKey(conversation),
      input: {
        type: 'twilio.message',
        messageSid: payload.MessageSid,
        from: payload.From,
        text: payload.Body,
      },
    });
  },
});
```

The abridged example omits the generated `postMessage()` tool and the Fetch client implementation. The full blueprint binds that tool to the agent’s parsed conversation, so verified inbound messages reach the corresponding agent instance and replies are sent to the same participant. Cloudflare projects use the generated standards-based client instead of Twilio’s Node-only helper; Messaging Service destinations and optional delivery-status callbacks are configured as secondary changes.

## Configure

| Variable                        | Purpose                                                                                         |
| ------------------------------- | ----------------------------------------------------------------------------------------------- |
| TWILIO\_ACCOUNT\_SID            | **Required** — Restricts inbound requests and identifies outbound API calls.                    |
| TWILIO\_AUTH\_TOKEN             | **Required** — Verifies inbound signatures and authenticates API calls.                         |
| TWILIO\_WEBHOOK\_URL            | **Required** — Supplies the exact public URL used for signature checks.                         |
| TWILIO\_PHONE\_NUMBER           | **Required for an address-based destination** — Binds an address-based destination.             |
| TWILIO\_MESSAGING\_SERVICE\_SID | **Required for a Messaging Service destination** — Binds a Messaging Service destination.       |
| TWILIO\_STATUS\_CALLBACK\_URL   | **Required when status callbacks are enabled** — Supplies the exact public status callback URL. |

It installs `@flue/twilio` for verified ingress and creates an editable Fetch client for outbound Programmable Messaging. The official Twilio Node helper is not the canonical path because it is Node-only; the generated REST client runs in Node and workerd with Flue’s required `nodejs_compat` configuration.

Set the inbound webhook URL to:

```txt
https://example.com/channels/twilio/webhook
```

Set the account SID, auth token, destination, and exact public webhook URL. Twilio signs the external configured URL plus every form parameter. An application behind a proxy cannot reliably reconstruct that URL from the request, so `webhookUrl` is required and must include any outer mount prefix or query string.

A trusted proxy may strip an external path prefix before the request reaches Flue. Signature validation still uses `webhookUrl`; the fixed channel route owns the internal path. The incoming request’s own query string is not re-checked — it is already part of the signed bytes, so any tampering fails signature (`401`).

Connection-override fragments may remain in the configured URL. They are excluded from signature validation because Twilio does not send or sign URL fragments.

For a Messaging Service, configure:

```ts
destination: {
  type: 'messaging-service',
  messagingServiceSid: process.env.TWILIO_MESSAGING_SERVICE_SID!,
},
```

The package rejects signed requests for another account or destination.

## Channel module

```ts
import { createTwilioChannel, type TwilioConversationRef } from '@flue/twilio';
import { defineTool, dispatch } from '@flue/runtime';
import * as v from 'valibot';
import assistant from '../agents/assistant.ts';
import { TwilioClient } from '../twilio-client.ts';

export const client = new TwilioClient({
  accountSid: process.env.TWILIO_ACCOUNT_SID!,
  authToken: process.env.TWILIO_AUTH_TOKEN!,
});

export const channel = createTwilioChannel({
  accountSid: process.env.TWILIO_ACCOUNT_SID!,
  authToken: process.env.TWILIO_AUTH_TOKEN!,
  webhookUrl: process.env.TWILIO_WEBHOOK_URL!,
  destination: {
    type: 'address',
    address: process.env.TWILIO_PHONE_NUMBER!,
  },

  // Path: /channels/twilio/webhook
  async webhook({ payload, conversation }) {
    if (payload.OptOutType === 'STOP') return;
    const numMedia = Number(payload.NumMedia ?? '0');
    await dispatch(assistant, {
      id: channel.conversationKey(conversation),
      input: {
        type: 'twilio.message',
        messageSid: payload.MessageSid,
        from: payload.From,
        text: payload.Body,
        media: Array.from({ length: numMedia }, (_, index) => ({
          index,
          contentType: payload[`MediaContentType${index}`],
        })),
      },
    });
  },
});

export function postMessage(ref: TwilioConversationRef) {
  return defineTool({
    name: 'post_twilio_message',
    description: 'Post to the Twilio conversation bound to this agent.',
    input: v.object({ text: v.pipe(v.string(), v.minLength(1)) }),
    async run({ input: { text } }) {
      const result = await client.messages.create({
        to: ref.participant,
        body: text,
        ...(ref.type === 'messaging-service'
          ? { messagingServiceSid: ref.messagingServiceSid }
          : { from: ref.address }),
      });
      return { messageSid: result.sid };
    },
  });
}
```

The blueprint creates `src/twilio-client.ts` with the Fetch client used above. Bind the tool from the agent with `postMessage(channel.parseConversationKey(id))`.

## Message behavior

Verified messages reach the handler as `{ c, payload, conversation, idempotencyToken? }`. `payload` is the provider-native verified form exactly as Twilio signed it: field names use Twilio’s PascalCase wire spelling (`MessageSid`, `From`, `To`, `Body`, `NumMedia`, `MediaUrl0`, `OptOutType`, …), every value is a `string`, and a parameter Twilio repeats becomes a `readonly string[]`. The channel does not rename, narrow, or coerce fields; new parameters Twilio adds reach the handler through an index signature, so read them directly with their wire names. Parse segment counts, MMS metadata, opt-out state, geographic, and rich-message fields in application code. `conversation` is the canonical ref derived from the verified destination and sender; `idempotencyToken` carries Twilio’s `I-Twilio-Idempotency-Token` when present.

Treat `STOP` as control input rather than dispatching it to an agent or sending an application reply.

Returning nothing produces an empty TwiML `<Response/>` with status `200`. Return an ordinary Hono or Fetch `Response` for explicit TwiML, status, or headers.

MMS URLs require Twilio credentials. Fetch media only in trusted application code and avoid placing authenticated content or raw forms into model context.

## Delivery status

Add `statusCallbackUrl` and `statusCallback` together to publish:

```txt
https://example.com/channels/twilio/status
```

Set the same URL as `StatusCallback` on outbound messages. The status handler input mirrors the inbound shape: `payload` carries the exact `MessageStatus` string forwarded verbatim — never narrowed to a frozen union — alongside every other signed status parameter (sender, recipient, error, channel, and delivery-receipt fields), with the same string / `string[]` rules and index-signature forwarding. `conversation` is present only when the signed fields identify the configured destination: `From` must match an address destination, or `MessagingServiceSid` must match a Messaging Service destination.

Twilio may retry status callbacks with backoff, and may deliver them duplicated or out of order. Persist transitions idempotently by message SID; the channel is stateless and exposes `MessageSid` and `I-Twilio-Idempotency-Token` without claiming durable deduplication. Retried requests can reuse the idempotency token, but applications still own durable idempotency.

Twilio does not guarantee `MessagingServiceSid` in every status callback. The channel still forwards a verified callback when that field is missing or does not match, but omits `conversation`; it derives Messaging Service conversation identity only from an exact signed SID match. Read `payload.MessagingServiceSid`in application code when the raw value matters.

## Deadlines

Twilio applies a 15-second read timeout to webhook responses and recommends acknowledging fast and processing asynchronously. The channel does not enforce a deadline of its own. Inbound message webhooks are not retried by default: on error or timeout Twilio uses the configured Fallback URL instead. Connection overrides on the webhook URL can opt into retries with `rc` (retry count) and `rp` (retry policy), for example `#rc=2&rp=all`; that fragment is excluded from the signed URL. Acknowledge before slow work and make admission idempotent when retries are enabled.

See the [@flue/twilio README](https://github.com/withastro/flue/tree/main/packages/twilio#readme).

## Docs Navigation

Current page: [Twilio](https://flueframework.com/docs/ecosystem/channels/twilio/)

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