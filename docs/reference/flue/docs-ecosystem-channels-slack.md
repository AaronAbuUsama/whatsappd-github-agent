<!-- source: https://flueframework.com/docs/ecosystem/channels/slack/ -->
---
description: Receive verified Slack events and use the Slack Web API from application code.
title: Slack | Flue
image: https://flueframework.com/docs/og4.jpg
---

# Slack

Last updated Jun 13, 2026 [ View as Markdown ](https://flueframework.com/docs/ecosystem/channels/slack/index.md) [  @flue/slack ](https://www.npmjs.com/package/@flue/slack) 

## Quickstart

Add verified HTTP ingress and application-owned Web API behavior to an existing Flue project with the [Slack](https://slack.com) blueprint. Run the following command in your terminal or coding agent of choice:

```sh
flue add channel slack
```

## Overview

The Slack blueprint installs `@flue/slack` and Slack’s official `@slack/web-api` SDK, then creates `channels/slack.ts` in the source-root. It also updates the selected agent to bind the generated thread-reply tool to the verified Slack conversation.

```ts
import { dispatch } from '@flue/runtime';
import { createSlackChannel } from '@flue/slack';
import { WebClient } from '@slack/web-api';
import assistant from '../agents/assistant.ts';

export const client = new WebClient(process.env.SLACK_BOT_TOKEN);

export const channel = createSlackChannel({
  signingSecret: process.env.SLACK_SIGNING_SECRET!,
  async events({ payload }) {
    if (payload.type !== 'event_callback') return;
    if (payload.event.type !== 'app_mention') return;

    const event = payload.event;
    await dispatch(assistant, {
      id: channel.conversationKey({
        teamId: payload.team_id,
        channelId: event.channel,
        threadTs: event.thread_ts ?? event.ts,
      }),
      input: {
        type: 'slack.app_mention',
        eventId: payload.event_id,
        text: event.text,
      },
    });
  },
});
```

The abridged example omits the generated `replyInThread()` tool. The complete blueprint binds that tool in the agent module, so verified app mentions reach a thread-scoped agent instance and replies return to the same thread. Interactivity and slash-command callbacks are optional secondary additions: each callback publishes its corresponding route only when enabled.

## Configure

| Variable               | Purpose                                                    |
| ---------------------- | ---------------------------------------------------------- |
| SLACK\_SIGNING\_SECRET | **Required** — Verifies inbound request bytes.             |
| SLACK\_BOT\_TOKEN      | **Required** — Authenticates outbound Slack Web API calls. |

The blueprint installs and configures `@flue/slack` for inbound requests, along with Slack’s official `@slack/web-api` SDK for making outbound API calls. After running the command, you will have a new `src/channels/slack.ts` channel with new `/channels/slack/*` webhook routes set up and ready to receive events.

## Supported Webhooks

| Slack surface                                                                       | Webhook path                 |
| ----------------------------------------------------------------------------------- | ---------------------------- |
| [Event Subscriptions](https://docs.slack.dev/apis/events-api/)                      | /channels/slack/events       |
| [Interactivity](https://docs.slack.dev/interactivity/handling-user-interaction/)    | /channels/slack/interactions |
| [Slash commands](https://docs.slack.dev/interactivity/implementing-slash-commands/) | /channels/slack/commands     |

Add only the Slack surfaces your application handles.

Omitting a callback from `createSlackChannel()` omits its route. Slack URL verification is answered internally after signature verification.

### Events

```ts
import { dispatch } from '@flue/runtime';
import { createSlackChannel } from '@flue/slack';
import assistant from '../agents/assistant.ts';

export const channel = createSlackChannel({
  signingSecret: process.env.SLACK_SIGNING_SECRET!,

  // Path: /channels/slack/events
  async events({ payload }) {
    if (payload.type !== 'event_callback') return;

    switch (payload.event.type) {
      case 'app_mention': {
        const event = payload.event;
        const thread = {
          teamId: payload.team_id,
          channelId: event.channel,
          threadTs: event.thread_ts ?? event.ts,
        };
        await dispatch(assistant, {
          id: channel.conversationKey(thread),
          input: {
            type: 'slack.app_mention',
            eventId: payload.event_id,
            text: event.text,
          },
        });
        return;
      }
      default:
        return;
    }
  },
});
```

`payload` is Slack’s outer Events API delivery. For `event_callback`, `payload.event` uses the official `SlackEvent` union from `@slack/types`. Switching on `payload.event.type` narrows events such as `app_mention`, `reaction_added`, Assistant events, and `message`. Message subtypes remain available through `payload.event.subtype`.

The channel does not filter bot messages, message subtypes, or event families. Your handler decides which authenticated events affect the application. `app_rate_limited` notifications also reach the callback.

The signing secret authenticates the Slack app. Workspace and enterprise identity remain in the provider payload so applications can enforce an allowlist when they need one. The channel does not impose a single-workspace installation model.

### Interactions

Enable this surface only when the application handles interactions:

```ts
export const channel = createSlackChannel({
  signingSecret: process.env.SLACK_SIGNING_SECRET!,

  // Path: /channels/slack/interactions
  async interactions({ payload }) {
    switch (payload.type) {
      case 'block_actions':
        await handleActions(payload.actions);
        return;
      case 'view_submission':
        return {
          response_action: 'errors',
          errors: { email: 'Enter a valid email address.' },
        };
      default:
        return;
    }
  },
});
```

Interaction payloads preserve Slack’s snake\_case wire fields. `trigger_id`, `response_url`, and view `response_urls` are short-lived capabilities. Keep them in immediate trusted request handling, not dispatch input, model context, logs, or durable session history.

### Commands

Enable this surface only when the application handles slash commands:

```ts
export const channel = createSlackChannel({
  signingSecret: process.env.SLACK_SIGNING_SECRET!,

  // Path: /channels/slack/commands
  async commands({ c, payload }) {
    switch (payload.command) {
      case '/triage':
        await startTriage(payload.text);
        return c.json({ response_type: 'ephemeral', text: 'Triage started.' });
      default:
        return c.json({ response_type: 'ephemeral', text: 'Unknown command.' });
    }
  },
});
```

Command payloads preserve Slack’s snake\_case wire fields. `trigger_id` and `response_url` are also short-lived capabilities and should remain in immediate trusted request handling.

Returning nothing produces an empty `200`. Return JSON-compatible data for a JSON response, or use the Hono context for explicit status, headers, and body. Thrown errors flow through normal Hono error handling. Slack expects prompt acknowledgements, so admit durable work quickly instead of performing slow operations before returning.

## Outbound

Outbound Slack behavior belongs to the exported SDK client:

```ts
import { WebClient } from '@slack/web-api';

export const client = new WebClient(process.env.SLACK_BOT_TOKEN);
```

## Slack Tools

Use the client to define application-owned tools:

```ts
import { defineTool } from '@flue/runtime';
import * as v from 'valibot';

export function replyInThread(ref: { channelId: string; threadTs: string }) {
  return defineTool({
    name: 'reply_in_slack_thread',
    description: 'Reply in the Slack thread bound to this agent.',
    input: v.object({ text: v.pipe(v.string(), v.minLength(1)) }),
    async run({ input: { text } }) {
      const result = await client.chat.postMessage({
        channel: ref.channelId,
        thread_ts: ref.threadTs,
        text,
      });
      return { channel: result.channel ?? null, ts: result.ts ?? null };
    },
  });
}
```

Bind the destination in trusted code:

```ts
import { defineAgent } from '@flue/runtime';
import { channel, replyInThread } from '../channels/slack.ts';

export default defineAgent(({ id }) => ({
  model: 'anthropic/claude-haiku-4-5',
  tools: [replyInThread(channel.parseConversationKey(id))],
}));
```

The model selects message text. It does not select arbitrary workspaces, channels, credentials, or Web API methods.

## Show Assistant status

For Slack Assistant threads, use the SDK directly:

```ts
await client.assistant.threads.setStatus({
  channel_id: channelId,
  thread_ts: threadTs,
  status: 'is thinking...',
});
```

This is a Slack Web API capability, not behavior implemented by `@flue/slack`.

## Stream a reply

The v8 client exposes `chatStream()` over Slack’s streaming message APIs:

```ts
const stream = client.chatStream({
  channel: channelId,
  thread_ts: threadTs,
  recipient_team_id: teamId,
  recipient_user_id: userId,
});

await stream.append({ markdown_text: 'First part' });
await stream.append({ markdown_text: ' and the rest.' });
await stream.stop();
```

The example executes `chat.postMessage`, `assistant.threads.setStatus`, and the start/append/stop streaming sequence against fake Fetch responses in workerd. No test contacts Slack.

## Handle retries

Slack may retry failed or timed-out Events API deliveries. Read `x-slack-retry-num` and `x-slack-retry-reason` from `c.req.header(...)`. Preserve `payload.event_id` for tracing, and claim it in application-owned durable storage before dispatch when duplicate admission is unacceptable.

OAuth installation storage, workspace authorization, Socket Mode, and token rotation remain application concerns.

The Fetch-based Slack Web API v8 release candidate runs in Node and in Cloudflare Workers with Flue’s required `nodejs_compat` setting.

## Docs Navigation

Current page: [Slack](https://flueframework.com/docs/ecosystem/channels/slack/)

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