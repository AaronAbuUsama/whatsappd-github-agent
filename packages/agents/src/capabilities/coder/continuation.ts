import type { GitHubRepositoryRef } from "@ambient-agent/engine/github/repository.ts";

import type { CoderGitHub } from "./github.ts";
import type { CodingJobRegistry } from "./registry.ts";

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
 */
export const upsertLifecycleComment = async (
  github: CoderGitHub,
  repo: GitHubRepositoryRef,
  prNumber: number,
  body: string,
): Promise<void> => {
  const marker = budgetCommentMarker(prNumber);
  const fullBody = `${body}\n\n${marker}`;
  for (let page = 1; ; page += 1) {
    const { data } = await github.issues.listComments({ owner: repo.owner, repo: repo.repo, issue_number: prNumber, per_page: 100, page });
    const existing = data.find((comment) => comment.body?.includes(marker));
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

/** The ingress-facing repair outcome: a launched run, an idempotently-handled non-launch, or an unowned PR. */
export type RepairLaunchResult =
  | { readonly status: "launched"; readonly runId: string }
  | { readonly status: "handled" }
  | { readonly status: "unregistered" };

/**
 * The trusted, idempotent repair entry point wired into the GitHub ingress. It admits one
 * REQUEST_CHANGES review through the registry (which atomically dedups on review id and consumes
 * a repair cycle only when within budget), then either invokes a `review_continuation` Coder run
 * on the exact live branch, or — when the qualifying rejection would exceed the budget — launches
 * NO run and instead demotes the PR to draft with one idempotent lifecycle comment. An unregistered
 * PR (external contributor / fork) is never touched and falls through to the Brain.
 */
export const createRepairLauncher = (deps: {
  readonly registry: CodingJobRegistry;
  readonly github: (repo: GitHubRepositoryRef) => Promise<CoderGitHub>;
  readonly invokeCoder: (input: Record<string, unknown>) => Promise<{ runId: string }>;
  readonly parseRepository: (repository: string) => GitHubRepositoryRef;
}) => async (input: { repository: string; pullRequest: number; reviewId: number }): Promise<RepairLaunchResult> => {
  const decision = deps.registry.admitRepair(input.repository, input.pullRequest, input.reviewId);
  if (decision.status === "unregistered") return { status: "unregistered" };
  if (decision.status === "duplicate") return { status: "handled" };

  if (decision.status === "launched") {
    const { runId } = await deps.invokeCoder({
      mode: "review_continuation",
      repository: decision.job.repository,
      pullRequest: input.pullRequest,
      maxVerificationRounds: decision.job.maxVerificationRounds,
      maxReviewCycles: decision.job.maxReviewCycles,
    });
    return { status: "launched", runId };
  }

  // over-budget: launch nothing; demote to draft and post the one idempotent lifecycle comment.
  const repo = deps.parseRepository(decision.job.repository);
  const github = await deps.github(repo);
  const { data: pr } = await github.pulls.get({ owner: repo.owner, repo: repo.repo, pull_number: input.pullRequest });
  if ((pr.draft ?? false) === false && pr.node_id !== undefined) {
    await convertPullRequestToDraft(github, pr.node_id);
  }
  await upsertLifecycleComment(
    github,
    repo,
    input.pullRequest,
    `The standalone Reviewer requested changes again, but this pull request has reached its configured repair budget ` +
      `of ${decision.job.maxReviewCycles} external review cycle${decision.job.maxReviewCycles === 1 ? "" : "s"}. ` +
      `No further automatic repair will run; converting to draft for human attention.`,
  );
  return { status: "handled" };
};
