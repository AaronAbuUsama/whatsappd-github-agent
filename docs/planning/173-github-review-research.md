# #173 GitHub review-continuation research

> Evidence receipt, not the implementation contract. The ratified
> [`173-CODING-WORKFLOW-SPEC.md`](./173-CODING-WORKFLOW-SPEC.md) narrows the automatic
> repair bundle to the submitted formal review plus currently unresolved review threads;
> loose PR conversation comments remain research context only.

Research receipt for the design session only. No product code is proposed here.

## Conclusion

Use `pull_request_review` with action `submitted` as the completion signal for an external GitHub review. Treat that webhook as a wake-up edge, not as the continuation state: start a new coding-workflow run identified by repository + PR number, then fetch a fresh, paginated PR/review snapshot from GitHub.

GitHub has no generic “the bot finished commenting” event for loose PR conversation comments. If the external Reviewer writes only `issue_comment` or individual `pull_request_review_comment` events, #147 must also submit a review (even a `COMMENT` review) or define a separate explicit completion signal.

## Authoritative read surfaces

| Need | API | Required fields / behavior |
|---|---|---|
| PR and write target | `GET /repos/{owner}/{repo}/pulls/{pull_number}` / `octokit.pulls.get` | `state`, `draft`, `head.ref`, `head.sha`, `head.repo`, `base.ref`, `base.sha`. Preserve `head.repo`, not only the branch name: a fork PR's writable head repository differs from the base repository. [GitHub: Get a pull request](https://docs.github.com/en/rest/pulls/pulls#get-a-pull-request) |
| Submitted review records | `GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews` / `pulls.listReviews` | Chronological records containing reviewer, `body`, `state`, `submitted_at`, `commit_id`, and review ID. [GitHub: List reviews](https://docs.github.com/en/rest/pulls/reviews#list-reviews-for-a-pull-request) |
| Inline diff feedback and replies | `GET /repos/{owner}/{repo}/pulls/{pull_number}/comments` / `pulls.listReviewComments` | `pull_request_review_id`, `id`, `in_reply_to_id`, `body`, path/line/diff hunk, commit IDs, author, timestamps. Results default to ascending ID. [GitHub: List review comments](https://docs.github.com/en/rest/pulls/comments#list-review-comments-on-a-pull-request) |
| PR conversation comments | `GET /repos/{owner}/{repo}/issues/{issue_number}/comments` / `issues.listComments` | PRs are issues for this API; records include body, author, timestamps, and ID. Results are ascending ID. [GitHub: List issue comments](https://docs.github.com/en/rest/issues/comments#list-issue-comments) |
| Resolved/unresolved review threads | GraphQL `PullRequest.reviewThreads` | Each thread exposes `id`, `isResolved`, `isOutdated`, `resolvedBy`, and a paginated `comments` connection. REST review comments do not expose thread resolution, so REST alone cannot answer “which findings remain open.” [GitHub GraphQL object reference](https://docs.github.com/en/graphql/reference/objects#pullrequestreviewthread) |

Live GraphQL schema introspection on 2026-07-18 confirmed `PullRequest.reviewThreads(first/after/last/before)` and the thread fields above. `headRefName`, `headRefOid`, and `baseRefName` are also available through GraphQL, but REST `pulls.get` already supplies the PR metadata and is present in the installed Octokit surface.

## Trigger versus snapshot

The installed first-party webhook types define:

```ts
interface PullRequestReviewSubmittedEvent {
  action: "submitted";
  review: PullRequestReview;
  pull_request: SimplePullRequest;
  repository: Repository;
}
```

They also show that the review object has the review body/state/commit but no inline-comment collection, while review-thread changes are separate `pull_request_review_thread` events with `resolved` and `unresolved` actions. GitHub's webhook documentation likewise separates reviews, inline comments, PR conversation comments, and thread activity into `pull_request_review`, `pull_request_review_comment`, `issue_comment`, and `pull_request_review_thread`. [GitHub webhook events](https://docs.github.com/en/webhooks/webhook-events-and-payloads#pull_request_review)

Therefore the submitted payload is insufficient as the Coder's hand-off. It represents one event-time review and can be stale by workflow start; it cannot supply later conversation comments, all inline replies, or current thread resolution. The safe contract is:

```ts
type ReviewContinuationSource = {
  repository: string;
  pullRequest: number;
  triggerDeliveryId?: string;
  triggerReviewId?: number;
};

type ReviewContinuationSnapshot = {
  pullRequest: {
    number: number;
    state: "open" | "closed";
    draft: boolean;
    head: { repository: string; ref: string; sha: string };
    base: { repository: string; ref: string; sha: string };
  };
  reviews: readonly SubmittedReview[];
  reviewComments: readonly ReviewComment[];
  conversationComments: readonly ConversationComment[];
  reviewThreads: readonly {
    id: string;
    isResolved: boolean;
    isOutdated: boolean;
    comments: readonly ReviewComment[];
  }[];
};
```

The trigger IDs are correlation/deduplication hints. GitHub remains authoritative for the snapshot.

## Pagination and ordering

- All REST list calls must paginate; GitHub defaults to 30 and supports up to 100 per page. The installed Octokit has `octokit.paginate`, so no custom paginator is needed. [GitHub REST pagination](https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api)
- Reviews are returned chronologically; review comments and issue comments default to ascending ID. Keep IDs and timestamps rather than relying only on array position.
- GraphQL connections require `first`/`last` (1–100) and cursor traversal via `pageInfo`. Both `reviewThreads` and each thread's `comments` connection can paginate. [GitHub GraphQL pagination](https://docs.github.com/en/graphql/guides/using-pagination-in-the-graphql-api)
- One webhook delivery ID deduplicates a redelivery, not two distinct submitted reviews on the same PR. Separate continuation runs can otherwise overlap; the workflow must either serialize by PR or refuse to publish when the live head SHA no longer matches its fetched starting SHA.

## Current repository gaps

1. `packages/engine/src/github/ingress.ts:169-181` accepts only `issues.opened` and `pull_request.opened`; `pull_request_review.submitted` is currently settled as unsupported.
2. `packages/engine/src/inputs.ts:106-134` has only `github.pull-request.opened`; there is no normalized review-submitted ingress input.
3. `packages/agents/src/capabilities/coder/github.ts:10-82` exposes repository/issue reads plus Git writes and PR list/create/update. It lacks `pulls.get`, review reads, review-comment reads, issue-comment reads, GraphQL, and REST pagination at the adapter boundary.
4. Installed Octokit already supplies `pulls.get`, `pulls.listReviews`, `pulls.listReviewComments`, `issues.listComments`, `paginate`, and core `graphql`; no new GitHub dependency is needed. The future adapter only needs to expose the minimum read methods used by the ratified snapshot.
5. Current Coder branch plumbing assumes the head branch is in the target repository. Review continuation must explicitly reject fork-headed PRs for now or preserve and write to `head.repo`; using only `head.ref` is not sufficient.

## Primary local evidence

- `node_modules/@octokit` installed versions: `@octokit/rest@22.0.1`, `@octokit/openapi-types@27.0.0`, `@octokit/webhooks-types@7.6.1`.
- REST methods: `@octokit/plugin-rest-endpoint-methods/.../method-types.d.ts:6404-6405,9159-9160,9300-9301,9335-9336`.
- Core GraphQL method: `@octokit/core/dist-types/index.d.ts:20-21`.
- Submitted-review and thread-event types: `@octokit/webhooks-types/schema.d.ts:375-385,6481-6538,6582-6590,6902-6926`.
