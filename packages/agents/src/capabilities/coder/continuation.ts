import type { GitHubRepositoryRef } from "@ambient-agent/engine/github/repository.ts";

import type { CoderGitHub } from "./github.ts";

/**
 * #211 review continuation — the live GitHub PR state a repair run is planned from. GitHub is
 * the durable boundary between runs, so NONE of this is stored: it is refetched from the live
 * PR every time a REQUEST_CHANGES review admits a repair. `headRepoFull` is the head-repo
 * identity used for the fork/external guard; `headRef` is the exact live branch to repair.
 */
export interface ReviewContinuationState {
  readonly number: number;
  readonly nodeId: string | undefined;
  readonly state: string;
  readonly draft: boolean;
  readonly headSha: string;
  readonly headRef: string;
  readonly headRepoFull: string | undefined;
  // The live PR's actual base branch — the run must publish against THIS, not a re-derived default
  // branch, or a PR whose base is not the repo default would update the wrong PR (finding 3).
  readonly baseRef: string;
  readonly reviews: readonly { readonly state: string; readonly author: string; readonly body: string }[];
  readonly unresolvedThreads: readonly {
    readonly path: string | undefined;
    readonly line: number | undefined;
    readonly comments: readonly { readonly author: string; readonly body: string }[];
  }[];
}

interface ThreadsQuery {
  repository: {
    pullRequest: {
      reviews: { nodes: { state: string; body: string; author: { login: string } | null }[] };
      reviewThreads: {
        pageInfo: { hasNextPage: boolean; endCursor: string | null };
        nodes: {
          isResolved: boolean;
          path: string | null;
          line: number | null;
          comments: { nodes: { body: string; author: { login: string } | null }[] };
        }[];
      };
    };
  };
}

const REVIEW_THREADS_QUERY = `
  query ReviewContinuation($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
    repository(owner: $owner, name: $repo) {
      pullRequest(number: $number) {
        reviews(first: 100) { nodes { state body author { login } } }
        reviewThreads(first: 50, after: $cursor) {
          pageInfo { hasNextPage endCursor }
          nodes {
            isResolved
            path
            line
            comments(first: 100) { nodes { body author { login } } }
          }
        }
      }
    }
  }
`;

/**
 * Refetch the live PR head, formal reviews, and paginated UNRESOLVED review threads (§ acceptance
 * criterion 1). REST supplies the head sha / branch ref / head-repo identity (the fork guard);
 * one GraphQL query, cursor-paginated over reviewThreads, supplies the reviews and the still-open
 * threads with their inline comments. Nothing here is persisted — the registry keeps only the
 * issue/PR journey and budgets, never GitHub-owned review state.
 *
 * ponytail: formal reviews are read single-page (first 100) — a PR with >100 formal reviews from a
 * finite bot loop does not exist; upgrade to a second cursor if it ever does. Review THREADS are
 * fully paginated because the criterion names them explicitly.
 */
export const fetchReviewContinuation = async (
  github: CoderGitHub,
  repo: GitHubRepositoryRef,
  pullRequest: number,
): Promise<ReviewContinuationState> => {
  const { data: pr } = await github.pulls.get({ owner: repo.owner, repo: repo.repo, pull_number: pullRequest });
  const reviews: Array<ReviewContinuationState["reviews"][number]> = [];
  const unresolvedThreads: Array<ReviewContinuationState["unresolvedThreads"][number]> = [];
  let cursor: string | undefined;
  let seededReviews = false;
  do {
    const page: ThreadsQuery = await github.graphql<ThreadsQuery>(REVIEW_THREADS_QUERY, {
      owner: repo.owner,
      repo: repo.repo,
      number: pullRequest,
      cursor: cursor ?? null,
    });
    const node = page.repository.pullRequest;
    if (!seededReviews) {
      for (const review of node.reviews.nodes) {
        reviews.push({ state: review.state, author: review.author?.login ?? "unknown", body: review.body });
      }
      seededReviews = true;
    }
    for (const thread of node.reviewThreads.nodes) {
      if (thread.isResolved) continue;
      unresolvedThreads.push({
        path: thread.path ?? undefined,
        line: thread.line ?? undefined,
        comments: thread.comments.nodes.map((comment) => ({ author: comment.author?.login ?? "unknown", body: comment.body })),
      });
    }
    cursor = node.reviewThreads.pageInfo.hasNextPage ? node.reviewThreads.pageInfo.endCursor ?? undefined : undefined;
  } while (cursor !== undefined);

  return {
    number: pr.number,
    nodeId: pr.node_id,
    state: pr.state,
    draft: pr.draft ?? false,
    headSha: pr.head.sha,
    headRef: pr.head.ref,
    headRepoFull: pr.head.repo?.full_name,
    baseRef: pr.base.ref,
    reviews,
    unresolvedThreads,
  };
};

/** The Planner framing for a repair run — the triggering feedback and every unresolved thread. */
export const renderReviewContinuation = (state: ReviewContinuationState): string => {
  const reviews = state.reviews
    .filter((review) => review.body.trim() !== "" || review.state === "CHANGES_REQUESTED")
    .map((review) => `- [${review.state}] @${review.author}: ${review.body.trim() || "(no summary)"}`);
  const threads = state.unresolvedThreads.map((thread) => {
    const where = thread.path === undefined ? "(general)" : `${thread.path}${thread.line === undefined ? "" : `:${thread.line}`}`;
    const body = thread.comments.map((comment) => `    @${comment.author}: ${comment.body.trim()}`).join("\n");
    return `- ${where}\n${body}`;
  });
  return (
    "\n\nThis is a REVIEW CONTINUATION. Repair the existing pull request against the standalone Reviewer's " +
    "formal feedback and every still-unresolved review thread below. Address the substance, do not merely " +
    "restate it.\n\nFormal reviews:\n" +
    (reviews.length === 0 ? "(none captured)" : reviews.join("\n")) +
    "\n\nUnresolved review threads:\n" +
    (threads.length === 0 ? "(none)" : threads.join("\n"))
  );
};

const budgetCommentMarker = (prNumber: number): string => `<!-- ambient-agent-repair-budget:${prNumber} -->`;

/** Convert the PR to draft via GraphQL if it is not already a draft. Idempotent. */
export const convertPullRequestToDraft = async (github: CoderGitHub, nodeId: string): Promise<void> => {
  await github.graphql(
    "mutation ConvertPullRequestToDraft($pullRequestId: ID!) { convertPullRequestToDraft(input: { pullRequestId: $pullRequestId }) { pullRequest { isDraft } } }",
    { pullRequestId: nodeId },
  );
};

/**
 * Upsert ONE idempotent lifecycle comment on the PR, keyed on a hidden marker: find the prior
 * marked comment and update it, else create it. A webhook redelivery or explicit retry converges
 * on the same single comment rather than duplicating.
 *
 * The marker match is restricted to OUR OWN bot's comments — by `botLogin` when known, else any
 * Bot author — so a human comment that quotes the marker is never adopted and edited (round-4 finding).
 *
 * ponytail: in the degraded fallback (coderAppSlug unresolved at boot → botLogin undefined), a match is
 * any Bot-authored marker comment. A DIFFERENT bot posting a comment containing our exact private marker
 * could then be adopted — a narrow two-part coincidence, accepted; upgrade path = always resolve the slug.
 */
export const upsertLifecycleComment = async (
  github: CoderGitHub,
  repo: GitHubRepositoryRef,
  prNumber: number,
  body: string,
  botLogin: string | undefined,
): Promise<void> => {
  const marker = budgetCommentMarker(prNumber);
  const fullBody = `${body}\n\n${marker}`;
  const authoredByUs = (comment: { user?: { login?: string; type?: string } | null }): boolean =>
    botLogin === undefined ? comment.user?.type === "Bot" : (comment.user?.login ?? "").toLowerCase() === botLogin;
  for (let page = 1; ; page += 1) {
    const { data } = await github.issues.listComments({ owner: repo.owner, repo: repo.repo, issue_number: prNumber, per_page: 100, page });
    const existing = data.find((comment) => comment.body?.includes(marker) && authoredByUs(comment));
    if (existing !== undefined) {
      await github.issues.updateComment({ owner: repo.owner, repo: repo.repo, comment_id: existing.id, body: fullBody });
      return;
    }
    if (data.length < 100) {
      await github.issues.createComment({ owner: repo.owner, repo: repo.repo, issue_number: prNumber, body: fullBody });
      return;
    }
  }
};

/**
 * The over-budget terminal effect: demote the live PR to draft (if it is not already) and upsert the
 * one idempotent lifecycle comment. Both operations are idempotent, so the Brain tool can safely
 * re-run this on retry without duplicating anything. Returns the PR URL for the Brain to report.
 */
export const demoteOverBudget = async (
  github: CoderGitHub,
  repo: GitHubRepositoryRef,
  prNumber: number,
  maxReviewCycles: number,
  botLogin: string | undefined,
): Promise<{ prUrl: string }> => {
  const { data: pr } = await github.pulls.get({ owner: repo.owner, repo: repo.repo, pull_number: prNumber });
  if ((pr.draft ?? false) === false && pr.node_id !== undefined) {
    await convertPullRequestToDraft(github, pr.node_id);
  }
  await upsertLifecycleComment(
    github,
    repo,
    prNumber,
    `Changes were requested again, but this pull request has reached its configured repair budget of ` +
      `${maxReviewCycles} external review cycle${maxReviewCycles === 1 ? "" : "s"}. No further automatic repair ` +
      `will run; converting to draft for human attention.`,
    botLogin,
  );
  return { prUrl: pr.html_url };
};
