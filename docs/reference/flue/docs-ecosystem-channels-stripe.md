<!-- source: https://flueframework.com/docs/ecosystem/channels/stripe/ -->
---
description: Receive verified Stripe webhooks and use the official SDK from application-owned tools.
title: Stripe | Flue
image: https://flueframework.com/docs/og4.jpg
---

# Stripe

AI-generated, awaiting review [ View as Markdown ](https://flueframework.com/docs/ecosystem/channels/stripe/index.md) [  @flue/stripe ](https://www.npmjs.com/package/@flue/stripe) 

## Quickstart

Add verified webhook ingress and application-owned API behavior to an existing Flue project with the [Stripe](https://stripe.com) blueprint. Run the following command in your terminal or coding agent of choice:

```sh
flue add channel stripe
```

## Overview

The blueprint installs `@flue/stripe`, Stripe’s official `stripe` SDK, and its required TypeScript peer when needed. It creates `<source-root>/channels/stripe.ts`, where the named `channel` export verifies snapshot webhook events by default and the project-owned `client` handles outbound API calls. Adapt the selected events, agent, and tool to the application.

```ts
import Stripe from 'stripe';
import { createStripeChannel } from '@flue/stripe';
import { dispatch } from '@flue/runtime';
import billing from '../agents/billing.ts';

export const client = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  httpClient: Stripe.createFetchHttpClient(),
});

export const channel = createStripeChannel({
  client,
  webhookSecret: process.env.STRIPE_WEBHOOK_SECRET!,
  async webhook({ event }) {
    if (event.type !== 'checkout.session.completed') return;
    const session = event.data.object;
    const customerId =
      typeof session.customer === 'string' ? session.customer : session.customer?.id;
    if (!customerId) return;

    await dispatch(billing, {
      id: customerId,
      input: { type: `stripe.${event.type}`, eventId: event.id },
    });
  },
});
```

A matching event is admitted to the billing agent identified by its Stripe customer. Other events receive an empty successful response. The generated module also defines a customer-bound retrieval tool; the blueprint wires that tool into the billing agent. For Cloudflare targets, the same SDK uses its Fetch and Web Crypto implementation.

## Configure

| Variable                | Purpose                                          |
| ----------------------- | ------------------------------------------------ |
| STRIPE\_WEBHOOK\_SECRET | **Required** — Verifies inbound deliveries.      |
| STRIPE\_SECRET\_KEY     | **Required** — Authenticates outbound SDK calls. |

It installs `@flue/stripe` and Stripe’s official `stripe` SDK. The SDK verifies inbound payloads and remains the project-owned client for outbound API calls. The blueprint creates `src/channels/stripe.ts` with named `channel` and `client`exports.

Configure the Stripe event destination as:

```txt
https://example.com/channels/stripe/webhook
```

If `flue()` is mounted beneath an outer prefix, include that prefix. Subscribe only to event types the application handles. Keep both credentials in the project’s existing secret system.

## Channel module

Snapshot events are the default:

```ts
import Stripe from 'stripe';
import { createStripeChannel } from '@flue/stripe';
import { defineTool, dispatch } from '@flue/runtime';
import billing from '../agents/billing.ts';

export const client = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  httpClient: Stripe.createFetchHttpClient(),
});

export const channel = createStripeChannel({
  client,
  webhookSecret: process.env.STRIPE_WEBHOOK_SECRET!,

  // Path: /channels/stripe/webhook
  async webhook({ event }) {
    switch (event.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded': {
        const session = event.data.object;
        const customerId =
          typeof session.customer === 'string' ? session.customer : session.customer?.id;
        if (!customerId) return;

        await dispatch(billing, {
          id: customerId,
          input: {
            type: `stripe.${event.type}`,
            eventId: event.id,
            checkoutSessionId: session.id,
          },
        });
        return;
      }
      default:
        return;
    }
  },
});

export function retrieveCustomer(customerId: string) {
  return defineTool({
    name: 'retrieve_stripe_customer',
    description: 'Retrieve the Stripe customer bound to this billing agent.',
    async run() {
      const customer = await client.customers.retrieve(customerId);
      return 'deleted' in customer
        ? { id: customer.id, deleted: true }
        : { id: customer.id, name: customer.name, email: customer.email };
    },
  });
}
```

`@flue/stripe` gives Stripe’s SDK the exact request bytes and `Stripe-Signature` header before invoking `webhook`. Returning nothing produces an empty `200`. A JSON-compatible value becomes the response body, and a normal Hono or Fetch `Response` passes through unchanged.

The example uses a customer id as the agent instance id for one Stripe account. Stripe has no universal conversation identity. Choose the customer, subscription, account, Checkout Session, or other resource that represents the application’s unit of work. Connect and organization destinations should include the verified `event.account` or `event.context` when their resource namespaces require it.

## Bind the tool

```ts
import { defineAgent } from '@flue/runtime';
import { retrieveCustomer } from '../channels/stripe.ts';

export default defineAgent(({ id: customerId }) => ({
  model: 'anthropic/claude-haiku-4-5',
  tools: [retrieveCustomer(customerId)],
}));
```

The model can invoke the lookup but cannot select another customer, account, or credential. Trusted application code binds those values. The channel-agent import cycle is supported because both imported bindings are read only inside deferred callbacks or initializers.

## Thin event notifications

Set `eventPayload: 'thin'` only for an event destination configured to send Stripe thin event notifications:

```ts
export const channel = createStripeChannel({
  client,
  webhookSecret: process.env.STRIPE_WEBHOOK_SECRET!,
  eventPayload: 'thin',

  // Path: /channels/stripe/webhook
  async webhook({ event }) {
    const relatedObject = await event.fetchRelatedObject();
    await handleRelatedObject(event, relatedObject);
  },
});
```

The callback receives Stripe’s native `Stripe.V2.Core.EventNotification`. Its `fetchEvent()` and `fetchRelatedObject()` methods use the project-owned client and preserve Stripe context. Snapshot and thin destinations use different signed payload shapes; the package rejects a payload that does not match the configured mode.

## Delivery behavior

Stripe retries unsuccessful live-mode webhook deliveries for up to three days and sandbox deliveries three times over several hours. Ordering is not guaranteed and duplicate delivery is possible. Claim `event.id` in application-owned durable storage before dispatch when duplicate admission is unacceptable. Business operations should remain idempotent because separate Event objects can describe the same resource change.

Snapshot event objects are tied to the API version selected for the event destination. Keep that version aligned with the installed SDK types, or narrow and validate resource fields in application code.

Flue forwards a verified event type that is newer than the installed Stripe declarations. Until the project upgrades Stripe, use `switch (event.type as string)` to observe that future type and treat its resource fields as untrusted rather than weakening the native narrowing for every known event.

The official Stripe SDK selects its Fetch and Web Crypto implementation in Cloudflare Workers. The example executes that path in workerd with Flue’s required `nodejs_compat` configuration. Projects may initialize credentials through `process.env` or typed Worker bindings and should still verify their complete target build and workerd tests. Stripe’s declarations reference `@types/node`; that package is type-only and does not add Node code to the Worker bundle.

The channel does not register event destinations, rotate signing secrets, manage OAuth or API keys, deduplicate events, restore ordering, or define generic Stripe tools. It also does not claim support for specialized latency-sensitive workflows such as synchronous real-time Issuing authorization decisions.

See the [@flue/stripe README](https://github.com/withastro/flue/tree/main/packages/stripe#readme).

## Docs Navigation

Current page: [Stripe](https://flueframework.com/docs/ecosystem/channels/stripe/)

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