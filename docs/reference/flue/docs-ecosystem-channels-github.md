<!-- source: https://flueframework.com/docs/ecosystem/channels/github/ -->
---
description: Receive signed GitHub webhooks and use Octokit from application-owned tools.
title: GitHub | Flue
image: https://flueframework.com/docs/og4.jpg
---

# GitHub

AI-generated, awaiting review [ View as Markdown ](https://flueframework.com/docs/ecosystem/channels/github/index.md) [  @flue/github ](https://www.npmjs.com/package/@flue/github) 

## Quickstart

Add verified webhook ingress and application-owned API behavior to an existing Flue project with the [GitHub](https://github.com) blueprint. Run the following command in your terminal or coding agent of choice:

```sh
flue add channel github
```

## Overview

The blueprint installs `@flue/github` and the official `@octokit/rest` SDK. It creates `<source-root>/channels/github.ts` with a named `channel`, a project-owned Octokit `client`, and an issue-comment tool, then wires that tool into an agent. Adapt the subscribed events, dispatched input, and tool to the application.

```ts
import { Octokit } from '@octokit/rest';
import { createGitHubChannel } from '@flue/github';
import { dispatch } from '@flue/runtime';
import assistant from '../agents/assistant.ts';

export const client = new Octokit({ auth: process.env.GITHUB_TOKEN });

export const channel = createGitHubChannel({
  webhookSecret: process.env.GITHUB_WEBHOOK_SECRET!,
  async webhook({ delivery }) {
    if (delivery.name !== 'issue_comment' || delivery.payload.action !== 'created') return;
    const { repository, issue, comment } = delivery.payload;
    const issueRef = {
      owner: repository.owner.login,
      repo: repository.name,
      issueNumber: issue.number,
    };

    await dispatch(assistant, {
      id: channel.conversationKey(issueRef),
      input: {
        type: 'github.issue_comment.created',
        deliveryId: delivery.deliveryId,
        comment: { id: comment.id, body: comment.body },
      },
    });
  },
});
```

A newly created issue comment is admitted to the agent bound to that repository and issue; other verified deliveries receive an empty successful response. The full generated module also handles pull-request review comments and lets the bound agent post an issue or pull-request comment through Octokit. Cloudflare targets retain the project’s credential convention and run Octokit’s Fetch path under Flue’s `nodejs_compat` configuration.

## Configure

| Variable                | Purpose                                              |
| ----------------------- | ---------------------------------------------------- |
| GITHUB\_WEBHOOK\_SECRET | **Required** — Verifies inbound deliveries.          |
| GITHUB\_TOKEN           | **Required** — Authenticates outbound Octokit calls. |

It installs `@flue/github` for verified ingress and the official `@octokit/rest` SDK for outbound API calls. It creates `src/channels/github.ts` with named `channel` and `client` exports.

Configure the GitHub webhook URL as:

```txt
https://example.com/channels/github/webhook
```

If `flue()` is mounted beneath an outer prefix, include that prefix. Set the content type to `application/json` (ingress is JSON-only; form-encoded deliveries are not accepted), set a webhook secret, and subscribe to the minimum event set the application handles. The example uses **Issue comments**and **Pull request review comments**. Keep both credentials in the project’s existing secret system.

## Channel module

```ts
import { createGitHubChannel } from '@flue/github';
import { defineTool, dispatch } from '@flue/runtime';
import { Octokit } from '@octokit/rest';
import * as v from 'valibot';
import assistant from '../agents/assistant.ts';

export const client = new Octokit({
  auth: process.env.GITHUB_TOKEN,
});

export const channel = createGitHubChannel({
  webhookSecret: process.env.GITHUB_WEBHOOK_SECRET!,

  // Path: /channels/github/webhook
  async webhook({ delivery }) {
    // `delivery.name` is the X-GitHub-Event value and narrows `delivery.payload`
    // to the native @octokit/webhooks-types event. Filtering is application
    // policy: subscribe to the events you want in GitHub and branch here.
    if (delivery.name === 'issue_comment' && delivery.payload.action === 'created') {
      const { repository, issue, comment } = delivery.payload;
      const issueRef = {
        owner: repository.owner.login,
        repo: repository.name,
        issueNumber: issue.number,
      };
      await dispatch(assistant, {
        id: channel.conversationKey(issueRef),
        input: {
          type: 'github.issue_comment.created',
          deliveryId: delivery.deliveryId,
          installationId: delivery.payload.installation?.id,
          issue: issueRef,
          sender: delivery.payload.sender,
          comment: { id: comment.id, body: comment.body },
        },
      });
      return;
    }

    if (delivery.name === 'pull_request_review_comment' && delivery.payload.action === 'created') {
      const { repository, pull_request, comment } = delivery.payload;
      const issueRef = {
        owner: repository.owner.login,
        repo: repository.name,
        issueNumber: pull_request.number,
      };
      await dispatch(assistant, {
        id: channel.conversationKey(issueRef),
        input: {
          type: 'github.pull_request_review_comment.created',
          deliveryId: delivery.deliveryId,
          installationId: delivery.payload.installation?.id,
          issue: issueRef,
          sender: delivery.payload.sender,
          comment: {
            id: comment.id,
            // Replies attach to the top-level review comment in a thread.
            threadId: comment.in_reply_to_id ?? comment.id,
            body: comment.body,
          },
        },
      });
      return;
    }
  },
});

export function commentOnIssue(ref: { owner: string; repo: string; issueNumber: number }) {
  return defineTool({
    name: 'comment_on_github_issue',
    description: 'Comment on the GitHub issue or pull request bound to this agent.',
    input: v.object({ body: v.pipe(v.string(), v.minLength(1)) }),
    async run({ input: { body } }) {
      const result = await client.rest.issues.createComment({
        owner: ref.owner,
        repo: ref.repo,
        issue_number: ref.issueNumber,
        body,
      });
      return { commentId: result.data.id };
    },
  });
}
```

Every verified non-ping delivery is forwarded with its native `@octokit/webhooks-types` payload. `delivery.name` is the `X-GitHub-Event`value and discriminates `delivery.payload`, narrowing it to the matching event type (for example `name: 'issues'` gives an `IssuesEvent` payload). There is no fixed list of supported events and no normalization layer: the payload keeps GitHub’s own field names and nesting (`payload.repository.owner.login`, `payload.issue.number`, `payload.comment.in_reply_to_id`). Choosing which events to act on is application policy — subscribe to them in GitHub and branch on `delivery.name` (and, where it matters, `delivery.payload.action`) in the handler. GitHub `ping` is acknowledged internally and never reaches the callback.

## Bind the tool

```ts
import { defineAgent } from '@flue/runtime';
import { channel, commentOnIssue } from '../channels/github.ts';

export default defineAgent(({ id }) => ({
  model: 'anthropic/claude-haiku-4-5',
  tools: [commentOnIssue(channel.parseConversationKey(id))],
}));
```

Pull requests use their issue number for issue comments. The model selects the comment body; trusted code binds the repository and issue. The channel-agent import cycle is supported because both imported bindings are read only inside deferred callbacks or initializers.

GitHub expects a `2xx` response within ten seconds and does not auto-retry. The package does not enforce a handler deadline; treat the ten-second window as guidance and admit durable work quickly rather than blocking the response on it. The channel is stateless and does not deduplicate delivery ids, so claim `delivery.deliveryId` in application storage before dispatch when duplicate admission matters. Failed deliveries can be inspected and manually redelivered from GitHub with the same delivery id.

Octokit’s REST methods use Fetch and the example’s typed `issues.createComment()` operation is tested in workerd with Flue’s required `nodejs_compat` configuration. Cloudflare projects may initialize credentials through `process.env` or typed Worker bindings and should verify their complete target build.

See the [@flue/github README](https://github.com/withastro/flue/tree/main/packages/github#readme).

## Docs Navigation

Current page: [GitHub](https://flueframework.com/docs/ecosystem/channels/github/)

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