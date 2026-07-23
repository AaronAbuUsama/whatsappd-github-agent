import type { GitHubWebhookDelivery } from "@flue/github";
import * as v from "valibot";

import type { GitHubEventDraft } from "../brain/inbox.ts";
import type { GitHubIngressAdmit } from "./up-inbox.ts";
import type { IssueOperationStore } from "./operation-store.ts";
import { getLogger } from "../logging/logging.ts";
import { errorMessage } from "../shared/errors.ts";
import type { GitHubIngressRecord, GitHubIngressStore } from "./ingress-store.ts";

export type RoutedGitHubWebhookDelivery = GitHubWebhookDelivery & { readonly githubAppId?: string };

const nonEmptyString = v.pipe(v.string(), v.minLength(1));
const positiveInteger = v.pipe(v.number(), v.integer(), v.minValue(1));
const providerStatus = (cause: unknown): number | undefined =>
  typeof cause === "object" && cause !== null && "status" in cause && typeof cause.status === "number"
    ? cause.status
    : undefined;
const issueOpenedPayloadSchema = v.object({
  action: v.literal("opened"),
  installation: v.optional(v.nullable(v.object({ id: positiveInteger }))),
  repository: v.object({
    id: positiveInteger,
    name: nonEmptyString,
    html_url: nonEmptyString,
    owner: v.object({ login: nonEmptyString }),
  }),
  issue: v.object({
    number: positiveInteger,
    html_url: nonEmptyString,
    title: nonEmptyString,
    state: v.literal("open"),
  }),
  sender: v.object({
    login: nonEmptyString,
    id: positiveInteger,
    type: nonEmptyString,
  }),
});
const pullRequestPayloadSchema = v.object({
  action: v.picklist(["opened", "ready_for_review", "synchronize"]),
  installation: v.optional(v.nullable(v.object({ id: positiveInteger }))),
  repository: v.object({
    id: positiveInteger,
    name: nonEmptyString,
    html_url: nonEmptyString,
    owner: v.object({ login: nonEmptyString }),
  }),
  pull_request: v.object({
    number: positiveInteger,
    html_url: nonEmptyString,
    title: nonEmptyString,
    body: v.nullable(v.string()),
    state: v.literal("open"),
    draft: v.boolean(),
    head: v.object({ sha: nonEmptyString }),
  }),
  sender: v.object({
    login: nonEmptyString,
    id: positiveInteger,
    type: nonEmptyString,
  }),
});
const pullRequestCommentPayloadSchema = v.object({
  action: v.literal("created"),
  repository: v.object({
    id: positiveInteger,
    name: nonEmptyString,
    html_url: nonEmptyString,
    owner: v.object({ login: nonEmptyString }),
  }),
  issue: v.object({
    number: positiveInteger,
    state: v.literal("open"),
    pull_request: v.object({ url: nonEmptyString }),
  }),
  comment: v.object({
    body: v.string(),
    user: v.object({ login: nonEmptyString }),
  }),
});
const pullRequestReviewSubmittedPayloadSchema = v.object({
  action: v.literal("submitted"),
  installation: v.optional(v.nullable(v.object({ id: positiveInteger }))),
  repository: v.object({
    id: positiveInteger,
    name: nonEmptyString,
    html_url: nonEmptyString,
    owner: v.object({ login: nonEmptyString }),
  }),
  pull_request: v.object({
    number: positiveInteger,
    html_url: nonEmptyString,
    title: nonEmptyString,
    state: v.union([v.literal("open"), v.literal("closed")]),
    draft: v.boolean(),
  }),
  review: v.object({
    id: positiveInteger,
    html_url: nonEmptyString,
    state: v.union([
      v.literal("commented"),
      v.literal("changes_requested"),
      v.literal("approved"),
      v.literal("dismissed"),
    ]),
  }),
  sender: v.object({
    login: nonEmptyString,
    id: positiveInteger,
    type: nonEmptyString,
  }),
});

export interface GitHubIngressSettings {
  readonly databasePath: string;
}

const repositoryKey = (owner: string, repo: string): string => `${owner.trim()}/${repo.trim()}`.toLowerCase();

const linkedIssueNumbers = (body: string, repository: string): readonly number[] => {
  const numbers = new Set<number>();
  const shorthand = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)(?::\s*|\s+)(?:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+))?#([1-9]\d*)\b/gi;
  for (const match of body.matchAll(shorthand)) {
    if (match[1] === undefined || match[1].toLowerCase() === repository) numbers.add(Number(match[2]));
  }
  const fullUrl = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)(?::\s*|\s+)https:\/\/github\.com\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/issues\/([1-9]\d*)\b/gi;
  for (const match of body.matchAll(fullUrl)) {
    if (match[1]!.toLowerCase() === repository) numbers.add(Number(match[2]));
  }
  return [...numbers];
};
export type GitHubIngressResult =
  | { readonly status: "duplicate"; readonly record: GitHubIngressRecord }
  | { readonly status: "unsupported"; readonly deliveryId: string }
  | { readonly status: "deferred"; readonly deliveryId: string; readonly repository: string; readonly reason: string }
  | { readonly status: "failed"; readonly record: GitHubIngressRecord }
  | { readonly status: "review-launched"; readonly deliveryId: string; readonly repository: string; readonly runId: string }
  | {
      // The event was admitted to the single Brain up-inbox (§4); the Brain — not the ingress —
      // decides which Surface(s) hear it. `dispatchId` is the up-inbox admission id.
      readonly status: "done";
      readonly deliveryId: string;
      readonly repository: string;
      readonly ambience: "ambience";
      readonly dispatchId: string;
      readonly acceptedAt: string;
    };

export interface GitHubIngressLogger {
  info(record: Readonly<Record<string, unknown>>): void;
  warn(record: Readonly<Record<string, unknown>>): void;
  error(record: Readonly<Record<string, unknown>>): void;
}

const defaultLogger: GitHubIngressLogger = {
  info: (record) => getLogger("github").info(record, String(record.event)),
  warn: (record) => getLogger("github").warn(record, String(record.event)),
  error: (record) => getLogger("github").error(record, String(record.event)),
};

export const createGitHubIngress = (options: {
  readonly store: GitHubIngressStore;
  /** Admit the event to the single Brain up-inbox (§4). The Brain decides which Surface(s) hear it.
   * Resolving to undefined means the up-inbox is not wired yet — the delivery defers and retries. */
  readonly admit: GitHubIngressAdmit;
  readonly operations?: IssueOperationStore;
  readonly review?: {
    readonly repositories: readonly string[];
    readonly launch: (input: { repository: string; pullRequest: number; expectedHeadSha: string }) => Promise<{ runId: string }>;
    readonly command?: {
      readonly appSlug: string;
      readonly permission: (input: { owner: string; repo: string; username: string }) => Promise<string>;
      readonly pullRequest: (input: { owner: string; repo: string; pullRequest: number }) => Promise<{
        state: string;
        draft: boolean;
        headSha: string;
      }>;
    };
  };
  readonly logger?: GitHubIngressLogger;
  readonly now?: () => Date;
}) => {
  const logger = options.logger ?? defaultLogger;
  const now = options.now ?? (() => new Date());
  const inFlight = new Set<string>();

  const handle = async (
    delivery: RoutedGitHubWebhookDelivery,
    concurrentDuplicate: boolean,
  ): Promise<GitHubIngressResult> => {
    const githubAppId = delivery.githubAppId ?? "legacy";
    const receivedAt = now().toISOString();
    // Every ledger access for this delivery goes through these bindings so no call site
    // can drop the tenant routing key and silently fall back to the "legacy" app row.
    const settle = (update: Parameters<GitHubIngressStore["settle"]>[1]): void =>
      options.store.settle(delivery.deliveryId, update, githubAppId);
    const getRecord = (): GitHubIngressRecord | undefined => options.store.get(delivery.deliveryId, githubAppId);
    if (!options.store.claim(delivery.deliveryId, delivery.name, receivedAt, githubAppId)) {
      const record = getRecord();
      if (!record) throw new Error(`Claimed GitHub delivery ${delivery.deliveryId} disappeared`);
      if (record.status === "received") {
        if (concurrentDuplicate) {
          logger.info({ event: "github.ingress.duplicate", deliveryId: delivery.deliveryId });
          return { status: "duplicate", record };
        }
        if (record.eventName !== delivery.name) {
          const error = `Delivery identifier was reused for ${delivery.name} after ${record.eventName}`;
          settle({ status: "failed", error, settledAt: now().toISOString() });
          logger.error({ event: "github.ingress.failed", deliveryId: delivery.deliveryId, error });
          return { status: "failed", record: getRecord()! };
        }
        logger.info({ event: "github.ingress.resumed", deliveryId: delivery.deliveryId });
      } else {
        logger.info({
          event: "github.ingress.duplicate",
          deliveryId: delivery.deliveryId,
          repository: record.repository ?? null,
          chatId: record.chatId ?? null,
          ambience: record.ambience ?? null,
          dispatchId: record.dispatchId ?? null,
        });
        return { status: "duplicate", record };
      }
    }

    const isIssueOpened = delivery.name === "issues" && delivery.payload.action === "opened";
    const isPullRequest = delivery.name === "pull_request" &&
      ["opened", "ready_for_review", "synchronize"].includes(String(delivery.payload.action));
    const isPullRequestComment = delivery.name === "issue_comment" && delivery.payload.action === "created";
    const isPullRequestReviewSubmitted =
      delivery.name === "pull_request_review" && delivery.payload.action === "submitted";
    if (!isIssueOpened && !isPullRequest && !isPullRequestComment && !isPullRequestReviewSubmitted) {
      settle({ status: "unsupported", settledAt: now().toISOString() });
      logger.warn({
        event: "github.ingress.unsupported",
        deliveryId: delivery.deliveryId,
        eventName: delivery.name,
      });
      return { status: "unsupported", deliveryId: delivery.deliveryId };
    }

    const parsed = isIssueOpened
      ? v.safeParse(issueOpenedPayloadSchema, delivery.payload)
      : isPullRequest
        ? v.safeParse(pullRequestPayloadSchema, delivery.payload)
        : isPullRequestComment
          ? v.safeParse(pullRequestCommentPayloadSchema, delivery.payload)
          : v.safeParse(pullRequestReviewSubmittedPayloadSchema, delivery.payload);
    if (!parsed.success) {
      const event = isIssueOpened
        ? "issues.opened"
        : isPullRequest
          ? `pull_request.${String(delivery.payload.action)}`
          : isPullRequestComment
            ? "issue_comment.created"
            : "pull_request_review.submitted";
      const error = `Verified ${event} delivery did not match the supported application contract`;
      settle({ status: "unsupported", error, settledAt: now().toISOString() });
      logger.warn({
        event: "github.ingress.unsupported",
        deliveryId: delivery.deliveryId,
        eventName: delivery.name,
        reason: error,
      });
      return { status: "unsupported", deliveryId: delivery.deliveryId };
    }

    const payload = parsed.output;
    const repository = repositoryKey(payload.repository.owner.login, payload.repository.name);
    let reviewLaunchError: string | undefined;
    const launchReview = async (pullRequest: number, expectedHeadSha: string) => {
      if (options.review === undefined) return undefined;
      try {
        return await options.review.launch({ repository, pullRequest, expectedHeadSha });
      } catch (cause) {
        reviewLaunchError = errorMessage(cause);
        return null;
      }
    };

    if ("comment" in payload && "issue" in payload) {
      const command = options.review?.command;
      const allowlisted = options.review?.repositories.some((candidate) => candidate.toLowerCase() === repository);
      if (
        command === undefined ||
        !allowlisted ||
        payload.comment.body !== `@${command.appSlug} review`
      ) {
        settle({ status: "unsupported", repository, settledAt: now().toISOString() });
        return { status: "unsupported", deliveryId: delivery.deliveryId };
      }
      try {
        let providerPermission: string;
        try {
          providerPermission = await command.permission({
            owner: payload.repository.owner.login,
            repo: payload.repository.name,
            username: payload.comment.user.login,
          });
        } catch (cause) {
          if (providerStatus(cause) !== 404) throw cause;
          settle({ status: "unsupported", repository, settledAt: now().toISOString() });
          return { status: "unsupported", deliveryId: delivery.deliveryId };
        }
        if (!["write", "maintain", "admin"].includes(providerPermission.toLowerCase())) {
          settle({ status: "unsupported", repository, settledAt: now().toISOString() });
          return { status: "unsupported", deliveryId: delivery.deliveryId };
        }
        const live = await command.pullRequest({
          owner: payload.repository.owner.login,
          repo: payload.repository.name,
          pullRequest: payload.issue.number,
        });
        if (live.state !== "open" || live.draft) {
          settle({ status: "unsupported", repository, settledAt: now().toISOString() });
          return { status: "unsupported", deliveryId: delivery.deliveryId };
        }
        const admitted = await launchReview(payload.issue.number, live.headSha);
        if (admitted === null) throw new Error(reviewLaunchError);
        if (admitted === undefined) {
          settle({ status: "unsupported", repository, settledAt: now().toISOString() });
          return { status: "unsupported", deliveryId: delivery.deliveryId };
        }
        settle({
          status: "done",
          repository,

          ambience: "ambience",
          dispatchId: admitted.runId,
          acceptedAt: receivedAt,
          settledAt: now().toISOString(),
        });
        return { status: "review-launched", deliveryId: delivery.deliveryId, repository, runId: admitted.runId };
      } catch (cause) {
        const error = errorMessage(cause);
        settle({ status: "failed", repository, error, settledAt: now().toISOString() });
        return { status: "failed", record: getRecord()! };
      }
    }

    if (
      isPullRequest &&
      "pull_request" in payload &&
      "head" in payload.pull_request &&
      !payload.pull_request.draft &&
      payload.action !== "opened" &&
      options.review?.repositories.some((candidate) => candidate.toLowerCase() === repository)
    ) {
      const admitted = await launchReview(payload.pull_request.number, payload.pull_request.head.sha);
      if (admitted === null) {
        settle({ status: "failed", repository, error: reviewLaunchError!, settledAt: now().toISOString() });
        return { status: "failed", record: getRecord()! };
      }
      if (admitted !== undefined) {
        settle({
          status: "done",
          repository,

          ambience: "ambience",
          dispatchId: admitted.runId,
          acceptedAt: receivedAt,
          settledAt: now().toISOString(),
        });
        return { status: "review-launched", deliveryId: delivery.deliveryId, repository, runId: admitted.runId };
      }
    } else if (isPullRequest && "pull_request" in payload && payload.action !== "opened") {
      settle({ status: "unsupported", repository, settledAt: now().toISOString() });
      return { status: "unsupported", deliveryId: delivery.deliveryId };
    }

    // One immutable, provenance-bearing event for the single Brain up-inbox (§4). Routing is the
    // Brain's — the ingress no longer knows or chooses a Surface. The event carries its full
    // normalized detail so the Brain decides who, if anyone, hears it.
    const repositoryDetail = {
      owner: payload.repository.owner.login,
      repo: payload.repository.name,
      id: payload.repository.id,
      url: payload.repository.html_url,
    };
    let event: GitHubEventDraft;
    if (isIssueOpened && "issue" in payload) {
      event = {
        githubAppId,
        deliveryId: delivery.deliveryId,
        eventName: delivery.name,
        action: "opened",
        repository,
        summary: `Issue #${payload.issue.number} opened in ${repository}: ${payload.issue.title}`,
        detail: {
          ...(payload.installation ? { installationId: payload.installation.id } : {}),
          repository: repositoryDetail,
          issue: {
            number: payload.issue.number,
            url: payload.issue.html_url,
            title: payload.issue.title,
            state: payload.issue.state,
          },
          sender: payload.sender,
        },
      };
    } else if (isPullRequestReviewSubmitted && "review" in payload) {
      event = {
        githubAppId,
        deliveryId: delivery.deliveryId,
        eventName: delivery.name,
        action: "submitted",
        repository,
        summary: `Review ${payload.review.state} on ${repository}#${payload.pull_request.number}`,
        detail: {
          ...(payload.installation ? { installationId: payload.installation.id } : {}),
          repository: repositoryDetail,
          pullRequest: {
            number: payload.pull_request.number,
            url: payload.pull_request.html_url,
            title: payload.pull_request.title,
            state: payload.pull_request.state,
            draft: payload.pull_request.draft,
          },
          review: {
            id: payload.review.id,
            url: payload.review.html_url,
            state: payload.review.state,
          },
          sender: payload.sender,
        },
      };
    } else if ("pull_request" in payload && "body" in payload.pull_request) {
      const linkedNumbers = linkedIssueNumbers(payload.pull_request.body ?? "", repository);
      const correlation = options.operations?.correlateCreateIssues(repository, linkedNumbers) ?? {
        completedIssueNumbers: [],
        hasPendingCreate: false,
      };
      if (correlation.hasPendingCreate && correlation.completedIssueNumbers.length < linkedNumbers.length) {
        const reason = "referenced issue correlation is waiting for an issue-create operation to settle";
        logger.warn({ event: "github.ingress.deferred", deliveryId: delivery.deliveryId, repository, reason });
        return { status: "deferred", deliveryId: delivery.deliveryId, repository, reason };
      }
      if (
        !payload.pull_request.draft &&
        options.review?.repositories.some((candidate) => candidate.toLowerCase() === repository)
      ) {
        const admitted = await launchReview(payload.pull_request.number, payload.pull_request.head.sha);
        if (admitted === null) {
          logger.warn({
            event: "github.ingress.review-launch-failed",
            deliveryId: delivery.deliveryId,
            repository,
            reason: reviewLaunchError!,
          });
        }
      }
      // Uncorrelated PRs are no longer dropped: they land in the up-inbox with whatever closing
      // references we could resolve, and the Brain decides (§4 — home of last resort).
      const closes = correlation.completedIssueNumbers.map((number) => ({ number }));
      event = {
        githubAppId,
        deliveryId: delivery.deliveryId,
        eventName: delivery.name,
        action: String(payload.action),
        repository,
        summary:
          `Pull request #${payload.pull_request.number} ${String(payload.action)} in ${repository}: ` +
          payload.pull_request.title +
          (closes.length > 0 ? ` (closes ${closes.map((issue) => `#${issue.number}`).join(", ")})` : ""),
        detail: {
          ...(payload.installation ? { installationId: payload.installation.id } : {}),
          repository: repositoryDetail,
          ...(closes.length > 0 ? { issues: closes } : {}),
          pullRequest: {
            number: payload.pull_request.number,
            url: payload.pull_request.html_url,
            title: payload.pull_request.title,
            state: payload.pull_request.state,
            draft: payload.pull_request.draft,
          },
          sender: payload.sender,
        },
      };
    } else {
      throw new Error(`Supported GitHub delivery ${delivery.deliveryId} lost its normalized payload variant`);
    }

    let admission: Awaited<ReturnType<typeof options.admit>>;
    try {
      admission = await options.admit(event);
    } catch (cause) {
      const error = errorMessage(cause);
      settle({ status: "failed", repository, ambience: "ambience", error, settledAt: now().toISOString() });
      logger.error({ event: "github.ingress.failed", deliveryId: delivery.deliveryId, repository, error });
      return { status: "failed", record: getRecord()! };
    }
    if (admission === undefined) {
      // The up-inbox is not wired yet (boot race). Leave the ledger 'received' so provider
      // redelivery reprocesses it — a deferral, never a drop (§10).
      const reason = "the Brain up-inbox is not configured yet; awaiting provider redelivery";
      logger.warn({ event: "github.ingress.deferred", deliveryId: delivery.deliveryId, repository, reason });
      return { status: "deferred", deliveryId: delivery.deliveryId, repository, reason };
    }
    settle({
      status: "done",
      repository,
      ambience: "ambience",
      dispatchId: admission.id,
      acceptedAt: admission.admittedAt,
      settledAt: now().toISOString(),
    });
    logger.info({
      event: "github.ingress.done",
      deliveryId: delivery.deliveryId,
      repository,
      ambience: "ambience",
      dispatchId: admission.id,
      acceptedAt: admission.admittedAt,
    });
    return {
      status: "done",
      deliveryId: delivery.deliveryId,
      repository,
      ambience: "ambience",
      dispatchId: admission.id,
      acceptedAt: admission.admittedAt,
    };
  };

  return async (delivery: RoutedGitHubWebhookDelivery): Promise<GitHubIngressResult> => {
    const identity = `${delivery.githubAppId ?? "legacy"}:${delivery.deliveryId}`;
    const concurrentDuplicate = inFlight.has(identity);
    if (!concurrentDuplicate) inFlight.add(identity);
    try {
      return await handle(delivery, concurrentDuplicate);
    } finally {
      if (!concurrentDuplicate) inFlight.delete(identity);
    }
  };
};
