import type { GitHubWebhookDelivery } from "@flue/github";
import type { DispatchReceipt } from "@flue/runtime";
import * as v from "valibot";

import {
  githubIssueOpenedInputSchema,
  githubPullRequestOpenedInputSchema,
  type GitHubIngressInput,
} from "../ambience/events.js";
import type { IssueOperationStore } from "../capabilities/issue-management/operation-store.js";
import { getLogger } from "../logging/logging.js";
import { errorMessage } from "../shared/errors.js";
import { retry as retryOperation, type RetryPolicy } from "../shared/retry.js";
import type { GitHubIngressRecord, GitHubIngressStore } from "./ingress-store.js";

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
const pullRequestOpenedPayloadSchema = v.object({
  action: v.literal("opened"),
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
  }),
  sender: v.object({
    login: nonEmptyString,
    id: positiveInteger,
    type: nonEmptyString,
  }),
});

export interface GitHubIngressSettings {
  readonly databasePath: string;
  readonly routes: ReadonlyMap<string, string>;
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
  readonly routes: ReadonlyMap<string, string>;
  readonly dispatch: (chatId: string, input: GitHubIngressInput) => Promise<DispatchReceipt>;
  readonly operations?: IssueOperationStore;
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
    const isPullRequestOpened = delivery.name === "pull_request" && delivery.payload.action === "opened";
    if (!isIssueOpened && !isPullRequestOpened) {
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
      : v.safeParse(pullRequestOpenedPayloadSchema, delivery.payload);
    if (!parsed.success) {
      const event = isIssueOpened ? "issues.opened" : "pull_request.opened";
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
    const chatId = options.routes.get(repository);
    if (!chatId) {
      options.store.settle(delivery.deliveryId, {
        status: "uncorrelated",
        repository,
        settledAt: now().toISOString(),
      });
      logger.warn({
        event: "github.ingress.uncorrelated",
        deliveryId: delivery.deliveryId,
        repository,
        chatId: null,
        ambience: null,
        dispatchId: null,
      });
      return { status: "uncorrelated", deliveryId: delivery.deliveryId, repository };
    }

    let input: GitHubIngressInput;
    if (isIssueOpened && "issue" in payload) {
      input = v.parse(githubIssueOpenedInputSchema, {
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
    } else if ("pull_request" in payload) {
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
          chatId,
          ambience: null,
          dispatchId: null,
          reason,
        });
        return { status: "deferred", deliveryId: delivery.deliveryId, repository, reason };
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
          chatId,
          ambience: null,
          dispatchId: null,
          reason: "pull request does not close an issue captured by Ambience",
        });
        return { status: "uncorrelated", deliveryId: delivery.deliveryId, repository };
      }
      input = v.parse(githubPullRequestOpenedInputSchema, {
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

    let receipt: DispatchReceipt;
    try {
      receipt = await retryOperation(() => options.dispatch(chatId, input), retry);
    } catch (cause) {
      const error = errorMessage(cause);
      options.store.settle(delivery.deliveryId, {
        status: "failed",
        repository,
        chatId,
        ambience: "ambience",
        error,
        settledAt: now().toISOString(),
      });
      logger.error({
        event: "github.ingress.failed",
        deliveryId: delivery.deliveryId,
        repository,
        chatId,
        ambience: "ambience",
        dispatchId: null,
        error,
      });
      return { status: "failed", record: options.store.get(delivery.deliveryId)! };
    }
    options.store.settle(delivery.deliveryId, {
      status: "done",
      repository,
      chatId,
      ambience: "ambience",
      dispatchId: receipt.dispatchId,
      acceptedAt: receipt.acceptedAt,
      settledAt: now().toISOString(),
    });
    logger.info({
      event: "github.ingress.done",
      deliveryId: delivery.deliveryId,
      repository,
      chatId,
      ambience: "ambience",
      dispatchId: receipt.dispatchId,
      acceptedAt: receipt.acceptedAt,
      runId: null,
      runIdReason: "agent dispatches are not workflow runs",
    });
    return {
      status: "done",
      deliveryId: delivery.deliveryId,
      repository,
      chatId,
      ambience: "ambience",
      dispatchId: receipt.dispatchId,
      acceptedAt: receipt.acceptedAt,
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
