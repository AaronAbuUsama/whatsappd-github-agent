import type { GitHubWebhookDelivery } from "@flue/github";
import type { DispatchReceipt } from "@flue/runtime";
import * as v from "valibot";

import {
  githubIssueOpenedInputSchema,
  githubPullRequestOpenedInputSchema,
  githubPullRequestReviewSubmittedInputSchema,
  type GitHubIngressInput,
} from "../inputs.ts";
import type { IssueOperationStore } from "./operation-store.ts";
import { getLogger } from "../logging/logging.ts";
import { errorMessage } from "../shared/errors.ts";
import { retry as retryOperation, type RetryPolicy } from "../shared/retry.ts";
import type { GitHubIngressRecord, GitHubIngressStore } from "./ingress-store.ts";

const nonEmptyString = v.pipe(v.string(), v.minLength(1));
const positiveInteger = v.pipe(v.number(), v.integer(), v.minValue(1));
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
  /**
   * Every managed thread's chat id. A supported GitHub event broadcasts to all of them —
   * each Speaker judges relevance itself, staying silent is a valid outcome (#144). A new
   * managed thread receives events automatically, with no per-repo routing config.
   */
  readonly managedChats: readonly string[];
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
  | { readonly status: "uncorrelated"; readonly deliveryId: string; readonly repository: string }
  | { readonly status: "deferred"; readonly deliveryId: string; readonly repository: string; readonly reason: string }
  | { readonly status: "failed"; readonly record: GitHubIngressRecord }
  | { readonly status: "review-launched"; readonly deliveryId: string; readonly repository: string; readonly runId: string }
  | {
      readonly status: "done";
      readonly deliveryId: string;
      readonly repository: string;
      readonly chatId: string;
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

export interface GitHubIngressRetryPolicy extends RetryPolicy {}

const defaultRetryPolicy: GitHubIngressRetryPolicy = {
  attempts: 3,
  delayMs: (attempt) => attempt * 1_000,
};

export const createGitHubIngress = (options: {
  readonly store: GitHubIngressStore;
  readonly managedChats: readonly string[];
  readonly dispatch: (chatId: string, input: GitHubIngressInput) => Promise<DispatchReceipt>;
  readonly operations?: IssueOperationStore;
  readonly review?: {
    readonly repositories: readonly string[];
    readonly launch: (input: { repository: string; pullRequest: number; expectedHeadSha: string }) => Promise<{ runId: string }>;
  };
  readonly logger?: GitHubIngressLogger;
  readonly now?: () => Date;
  readonly retry?: GitHubIngressRetryPolicy;
}) => {
  const logger = options.logger ?? defaultLogger;
  const now = options.now ?? (() => new Date());
  const retry = options.retry ?? defaultRetryPolicy;
  const inFlight = new Set<string>();

  const handle = async (
    delivery: GitHubWebhookDelivery,
    concurrentDuplicate: boolean,
  ): Promise<GitHubIngressResult> => {
    const receivedAt = now().toISOString();
    if (!options.store.claim(delivery.deliveryId, delivery.name, receivedAt)) {
      const record = options.store.get(delivery.deliveryId);
      if (!record) throw new Error(`Claimed GitHub delivery ${delivery.deliveryId} disappeared`);
      if (record.status === "received") {
        if (concurrentDuplicate) {
          logger.info({ event: "github.ingress.duplicate", deliveryId: delivery.deliveryId });
          return { status: "duplicate", record };
        }
        if (record.eventName !== delivery.name) {
          const error = `Delivery identifier was reused for ${delivery.name} after ${record.eventName}`;
          options.store.settle(delivery.deliveryId, { status: "failed", error, settledAt: now().toISOString() });
          logger.error({ event: "github.ingress.failed", deliveryId: delivery.deliveryId, error });
          return { status: "failed", record: options.store.get(delivery.deliveryId)! };
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
    const isPullRequestReviewSubmitted =
      delivery.name === "pull_request_review" && delivery.payload.action === "submitted";
    if (!isIssueOpened && !isPullRequest && !isPullRequestReviewSubmitted) {
      options.store.settle(delivery.deliveryId, {
        status: "unsupported",
        settledAt: now().toISOString(),
      });
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
        : v.safeParse(pullRequestReviewSubmittedPayloadSchema, delivery.payload);
    if (!parsed.success) {
      const event = isIssueOpened
        ? "issues.opened"
        : isPullRequest
          ? `pull_request.${String(delivery.payload.action)}`
          : "pull_request_review.submitted";
      const error = `Verified ${event} delivery did not match the supported application contract`;
      options.store.settle(delivery.deliveryId, {
        status: "unsupported",
        error,
        settledAt: now().toISOString(),
      });
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
    const launchReview = async (pullRequest: number, expectedHeadSha: string) => {
      if (options.review === undefined) return undefined;
      try {
        return await options.review.launch({ repository, pullRequest, expectedHeadSha });
      } catch (cause) {
        const error = errorMessage(cause);
        options.store.settle(delivery.deliveryId, { status: "failed", repository, error, settledAt: now().toISOString() });
        return null;
      }
    };

    if (
      isPullRequest &&
      "pull_request" in payload &&
      "head" in payload.pull_request &&
      !payload.pull_request.draft &&
      payload.action !== "opened" &&
      options.review?.repositories.some((candidate) => candidate.toLowerCase() === repository)
    ) {
      const admitted = await launchReview(payload.pull_request.number, payload.pull_request.head.sha);
      if (admitted === null) return { status: "failed", record: options.store.get(delivery.deliveryId)! };
      if (admitted !== undefined) {
        options.store.settle(delivery.deliveryId, {
          status: "done",
          repository,
          chatId: options.managedChats[0]!,
          ambience: "ambience",
          dispatchId: admitted.runId,
          acceptedAt: receivedAt,
          settledAt: now().toISOString(),
        });
        return { status: "review-launched", deliveryId: delivery.deliveryId, repository, runId: admitted.runId };
      }
    } else if (isPullRequest && "pull_request" in payload && payload.action !== "opened") {
      options.store.settle(delivery.deliveryId, { status: "unsupported", repository, settledAt: now().toISOString() });
      return { status: "unsupported", deliveryId: delivery.deliveryId };
    }

    // Repo-level input factory. Correlation (below, for PRs) is computed once; only the
    // chat id varies per broadcast target, so the payload is built per managed thread.
    let buildInput: (chatId: string) => GitHubIngressInput;
    if (isIssueOpened && "issue" in payload) {
      buildInput = (chatId) =>
        v.parse(githubIssueOpenedInputSchema, {
          type: "github.issue.opened",
          chatId,
          deliveryId: delivery.deliveryId,
          ...(payload.installation ? { installationId: payload.installation.id } : {}),
          repository: {
            owner: payload.repository.owner.login,
            repo: payload.repository.name,
            id: payload.repository.id,
            url: payload.repository.html_url,
          },
          issue: {
            number: payload.issue.number,
            url: payload.issue.html_url,
            title: payload.issue.title,
            state: payload.issue.state,
          },
          sender: payload.sender,
        });
    } else if (isPullRequestReviewSubmitted && "review" in payload) {
      buildInput = (chatId) =>
        v.parse(githubPullRequestReviewSubmittedInputSchema, {
          type: "github.pull-request-review.submitted",
          chatId,
          deliveryId: delivery.deliveryId,
          ...(payload.installation ? { installationId: payload.installation.id } : {}),
          repository: {
            owner: payload.repository.owner.login,
            repo: payload.repository.name,
            id: payload.repository.id,
            url: payload.repository.html_url,
          },
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
        });
    } else if ("pull_request" in payload && "body" in payload.pull_request) {
      const linkedNumbers = linkedIssueNumbers(payload.pull_request.body ?? "", repository);
      const correlation = options.operations?.correlateCreateIssues(repository, linkedNumbers) ?? {
        completedIssueNumbers: [],
        hasPendingCreate: false,
      };
      if (correlation.hasPendingCreate && correlation.completedIssueNumbers.length < linkedNumbers.length) {
        const reason = "referenced issue correlation is waiting for an issue-create operation to settle";
        logger.warn({
          event: "github.ingress.deferred",
          deliveryId: delivery.deliveryId,
          repository,
          ambience: null,
          dispatchId: null,
          reason,
        });
        return { status: "deferred", deliveryId: delivery.deliveryId, repository, reason };
      }
      if (
        !payload.pull_request.draft &&
        options.review?.repositories.some((candidate) => candidate.toLowerCase() === repository)
      ) {
        const admitted = await launchReview(payload.pull_request.number, payload.pull_request.head.sha);
        if (admitted === null) return { status: "failed", record: options.store.get(delivery.deliveryId)! };
      }
      if (correlation.completedIssueNumbers.length === 0) {
        options.store.settle(delivery.deliveryId, {
          status: "uncorrelated",
          repository,
          settledAt: now().toISOString(),
        });
        logger.warn({
          event: "github.ingress.uncorrelated",
          deliveryId: delivery.deliveryId,
          repository,
          ambience: null,
          dispatchId: null,
          reason: "pull request does not close an issue captured by Speaker",
        });
        return { status: "uncorrelated", deliveryId: delivery.deliveryId, repository };
      }
      buildInput = (chatId) =>
        v.parse(githubPullRequestOpenedInputSchema, {
          type: "github.pull-request.opened",
          chatId,
          deliveryId: delivery.deliveryId,
          ...(payload.installation ? { installationId: payload.installation.id } : {}),
          repository: {
            owner: payload.repository.owner.login,
            repo: payload.repository.name,
            id: payload.repository.id,
            url: payload.repository.html_url,
          },
          issues: correlation.completedIssueNumbers.map((number) => ({ number })),
          pullRequest: {
            number: payload.pull_request.number,
            url: payload.pull_request.html_url,
            title: payload.pull_request.title,
            state: payload.pull_request.state,
            // A draft has landed and has a usable link. Preserve that fact instead of waiting for an unsupported
            // ready_for_review transition that would otherwise make the Axis 3 notification impossible.
            draft: payload.pull_request.draft,
          },
          sender: payload.sender,
        });
    } else {
      throw new Error(`Supported GitHub delivery ${delivery.deliveryId} lost its normalized payload variant`);
    }

    // Broadcast: every managed thread's Speaker receives the event exactly once and judges
    // relevance itself (#144). managedChats is non-empty by config invariant.
    const chats = options.managedChats;
    let receipts: readonly DispatchReceipt[];
    try {
      receipts = await Promise.all(
        chats.map((chatId) => retryOperation(() => options.dispatch(chatId, buildInput(chatId)), retry)),
      );
    } catch (cause) {
      const error = errorMessage(cause);
      options.store.settle(delivery.deliveryId, {
        status: "failed",
        repository,
        ambience: "ambience",
        error,
        settledAt: now().toISOString(),
      });
      logger.error({
        event: "github.ingress.failed",
        deliveryId: delivery.deliveryId,
        repository,
        ambience: "ambience",
        dispatchId: null,
        error,
      });
      return { status: "failed", record: options.store.get(delivery.deliveryId)! };
    }

    // ponytail: the single-row ledger predates broadcast; it records the first thread's
    // admission receipt as the delivery's Flue-admission proof, and the whole fan-out in the
    // done log. Per-thread ledger rows only if audit ever needs them.
    const representativeChat = chats[0]!;
    const representativeReceipt = receipts[0]!;
    options.store.settle(delivery.deliveryId, {
      status: "done",
      repository,
      chatId: representativeChat,
      ambience: "ambience",
      dispatchId: representativeReceipt.dispatchId,
      acceptedAt: representativeReceipt.acceptedAt,
      settledAt: now().toISOString(),
    });
    logger.info({
      event: "github.ingress.done",
      deliveryId: delivery.deliveryId,
      repository,
      chatId: representativeChat,
      broadcastChats: chats.length,
      ambience: "ambience",
      dispatchId: representativeReceipt.dispatchId,
      acceptedAt: representativeReceipt.acceptedAt,
      runId: null,
      runIdReason: "agent dispatches are not workflow runs",
    });
    return {
      status: "done",
      deliveryId: delivery.deliveryId,
      repository,
      chatId: representativeChat,
      ambience: "ambience",
      dispatchId: representativeReceipt.dispatchId,
      acceptedAt: representativeReceipt.acceptedAt,
    };
  };

  return async (delivery: GitHubWebhookDelivery): Promise<GitHubIngressResult> => {
    const concurrentDuplicate = inFlight.has(delivery.deliveryId);
    if (!concurrentDuplicate) inFlight.add(delivery.deliveryId);
    try {
      return await handle(delivery, concurrentDuplicate);
    } finally {
      if (!concurrentDuplicate) inFlight.delete(delivery.deliveryId);
    }
  };
};
