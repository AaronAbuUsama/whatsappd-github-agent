import { describe, expect, it } from "vite-plus/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { GitHubWebhookDelivery } from "@flue/github";

import { speakerDigestSeeds, type GitHubIngressInput } from "../../packages/engine/src/inputs.ts";
import { createIssueOperationStore } from "../../packages/engine/src/github/operation-store.ts";
import { createGitHubIngress } from "../../packages/engine/src/github/ingress.ts";
import { createGitHubIngressStore } from "../../packages/engine/src/github/ingress-store.ts";
import { serializeReviewerSubmission } from "../../packages/agents/src/capabilities/reviewer/workflow.ts";

const issueOpenedDelivery = (deliveryId: string): GitHubWebhookDelivery =>
  ({
    name: "issues",
    deliveryId,
    payload: {
      action: "opened",
      repository: {
        id: 101,
        name: "widgets",
        html_url: "https://github.com/acme/widgets",
        owner: { login: "acme" },
      },
      issue: {
        number: 29,
        html_url: "https://github.com/acme/widgets/issues/29",
        title: "Admission proof",
        state: "open",
      },
      sender: { login: "octocat", id: 1, type: "User" },
    },
  }) as GitHubWebhookDelivery;

const pullRequestOpenedDelivery = (
  deliveryId: string,
  options: { readonly body?: string; readonly draft?: boolean } = {},
): GitHubWebhookDelivery =>
  ({
    name: "pull_request",
    deliveryId,
    payload: {
      action: "opened",
      installation: { id: 77 },
      repository: {
        id: 101,
        name: "widgets",
        html_url: "https://github.com/acme/widgets",
        owner: { login: "acme" },
      },
      pull_request: {
        number: 42,
        html_url: "https://github.com/acme/widgets/pull/42",
        title: "Fix admission proof",
        body: options.body ?? "Closes #29",
        state: "open",
        draft: options.draft ?? false,
        head: { sha: "head-42" },
      },
      sender: { login: "octocat", id: 1, type: "User" },
    },
  }) as GitHubWebhookDelivery;

const pullRequestReviewSubmittedDelivery = (deliveryId: string): GitHubWebhookDelivery =>
  ({
    name: "pull_request_review",
    deliveryId,
    payload: {
      action: "submitted",
      installation: { id: 77 },
      repository: {
        id: 101,
        name: "widgets",
        html_url: "https://github.com/acme/widgets",
        owner: { login: "acme" },
      },
      pull_request: {
        number: 42,
        html_url: "https://github.com/acme/widgets/pull/42",
        title: "Fix admission proof",
        state: "open",
        draft: false,
      },
      review: {
        id: 501,
        html_url: "https://github.com/acme/widgets/pull/42#pullrequestreview-501",
        state: "changes_requested",
      },
      sender: { login: "reviewer[bot]", id: 2, type: "Bot" },
    },
  }) as GitHubWebhookDelivery;

const reviewCommandDelivery = (
  deliveryId: string,
  options: { readonly body?: string; readonly login?: string; readonly pullRequest?: boolean } = {},
): GitHubWebhookDelivery =>
  ({
    name: "issue_comment",
    deliveryId,
    payload: {
      action: "created",
      repository: {
        id: 101,
        name: "widgets",
        html_url: "https://github.com/acme/widgets",
        owner: { login: "acme" },
      },
      issue: {
        number: 42,
        state: "open",
        ...(options.pullRequest === false ? {} : { pull_request: { url: "https://api.github.com/repos/acme/widgets/pulls/42" } }),
      },
      comment: {
        body: options.body ?? "@tenant-reviewer review",
        user: { login: options.login ?? "maintainer" },
      },
    },
  }) as GitHubWebhookDelivery;
describe("GitHub ingress delivery ledger", () => {
  it.each(["opened", "ready_for_review", "synchronize"] as const)(
    "admits an eligible non-draft PR on %s exactly once per webhook delivery",
    async (action) => {
      const store = createGitHubIngressStore(":memory:");
      const launches: unknown[] = [];
      try {
        const ingress = createGitHubIngress({
          store,
          managedChats: ["chat-42@g.us"],
          dispatch: async () => ({ dispatchId: "speaker", acceptedAt: "2026-07-18T00:00:01.000Z" }),
          review: {
            repositories: ["acme/widgets"],
            launch: async (input) => {
              launches.push(input);
              return { runId: `review-${action}` };
            },
          },
          logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
        });
        const delivery = pullRequestOpenedDelivery(`review-${action}`) as GitHubWebhookDelivery & { payload: { action: string } };
        delivery.payload.action = action;
        await ingress(delivery);
        await ingress(delivery);
        expect(launches).toEqual([{ repository: "acme/widgets", pullRequest: 42, expectedHeadSha: "head-42" }]);
      } finally {
        store.close();
      }
    },
  );

  it("admits the exact configured Reviewer App command with the refetched live head", async () => {
    const store = createGitHubIngressStore(":memory:");
    const launches: unknown[] = [];
    try {
      const ingress = createGitHubIngress({
        store,
        managedChats: ["chat-42@g.us"],
        dispatch: async () => ({ dispatchId: "speaker", acceptedAt: "2026-07-18T00:00:01.000Z" }),
        review: {
          repositories: ["acme/widgets"],
          launch: async (input) => {
            launches.push(input);
            return { runId: "manual-review" };
          },
          command: {
            appSlug: "tenant-reviewer",
            permission: async () => "write",
            pullRequest: async () => ({ state: "open", draft: false, headSha: "live-head" }),
          },
        },
        logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      });
      const delivery = reviewCommandDelivery("manual-review");
      await expect(ingress(delivery)).resolves.toMatchObject({ status: "review-launched", runId: "manual-review" });
      await expect(ingress(delivery)).resolves.toMatchObject({ status: "duplicate" });
      expect(launches).toEqual([{ repository: "acme/widgets", pullRequest: 42, expectedHeadSha: "live-head" }]);
    } finally {
      store.close();
    }
  });

  it("converges concurrent automatic and command admissions on the Reviewer App + PR + head key", async () => {
    const store = createGitHubIngressStore(":memory:");
    let effects = 0;
    let release!: () => void;
    const overlap = new Promise<void>((resolve) => { release = resolve; });
    try {
      const ingress = createGitHubIngress({
        store,
        managedChats: ["chat-42@g.us"],
        dispatch: async () => ({ dispatchId: "speaker", acceptedAt: "now" }),
        review: {
          repositories: ["acme/widgets"],
          launch: async (input) => {
            const key = `tenant-reviewer[bot]:${input.repository}#${input.pullRequest}@${input.expectedHeadSha}`;
            const result = await serializeReviewerSubmission(key, async () => {
              effects += 1;
              await overlap;
              return { status: "approved", prNumber: 42, headSha: "head-42", summary: "Reviewed once." };
            });
            return { runId: `review-${result.headSha}` };
          },
          command: {
            appSlug: "tenant-reviewer",
            permission: async () => "write",
            pullRequest: async () => ({ state: "open", draft: false, headSha: "head-42" }),
          },
        },
        logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      });
      const automatic = pullRequestOpenedDelivery("automatic-race") as GitHubWebhookDelivery & { payload: { action: string } };
      automatic.payload.action = "synchronize";
      const results = Promise.all([
        ingress(automatic),
        ingress(reviewCommandDelivery("manual-race")),
      ]);
      await new Promise((resolve) => setTimeout(resolve, 0));
      release();
      await expect(results).resolves.toEqual([
        expect.objectContaining({ status: "review-launched" }),
        expect.objectContaining({ status: "review-launched" }),
      ]);
      expect(effects).toBe(1);
    } finally {
      release();
      store.close();
    }
  });

  it.each(["write", "maintain", "admin"])("authorizes %s collaborators", async (permission) => {
    const store = createGitHubIngressStore(":memory:");
    let launches = 0;
    try {
      const ingress = createGitHubIngress({
        store,
        managedChats: ["chat-42@g.us"],
        dispatch: async () => ({ dispatchId: "speaker", acceptedAt: "now" }),
        review: {
          repositories: ["acme/widgets"],
          launch: async () => ({ runId: `manual-${++launches}` }),
          command: {
            appSlug: "tenant-reviewer",
            permission: async () => permission,
            pullRequest: async () => ({ state: "open", draft: false, headSha: "live-head" }),
          },
        },
        logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      });
      await expect(ingress(reviewCommandDelivery(`permission-${permission}`))).resolves.toMatchObject({ status: "review-launched" });
      expect(launches).toBe(1);
    } finally {
      store.close();
    }
  });

  it.each([
    [404, "unsupported"],
    [500, "failed"],
  ] as const)("maps a provider permission %s to %s", async (providerStatus, expectedStatus) => {
    const store = createGitHubIngressStore(":memory:");
    let launches = 0;
    try {
      const ingress = createGitHubIngress({
        store,
        managedChats: ["chat-42@g.us"],
        dispatch: async () => ({ dispatchId: "speaker", acceptedAt: "now" }),
        review: {
          repositories: ["acme/widgets"],
          launch: async () => ({ runId: `unexpected-${++launches}` }),
          command: {
            appSlug: "tenant-reviewer",
            permission: async () => {
              throw Object.assign(new Error(`Provider status ${providerStatus}`), { status: providerStatus });
            },
            pullRequest: async () => ({ state: "open", draft: false, headSha: "live-head" }),
          },
        },
        logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      });

      await expect(ingress(reviewCommandDelivery(`permission-provider-${providerStatus}`))).resolves.toMatchObject({
        status: expectedStatus,
      });
      expect(launches).toBe(0);
    } finally {
      store.close();
    }
  });

  it.each([
    ["read", reviewCommandDelivery("unauthorized")],
    ["malformed", reviewCommandDelivery("malformed", { body: "@tenant-reviewer please review" })],
    ["wrong slug", reviewCommandDelivery("wrong-slug", { body: "@global-reviewer review" })],
    ["issue conversation", reviewCommandDelivery("issue-comment", { pullRequest: false })],
  ] as const)("rejects %s review commands without launching", async (_reason, delivery) => {
    const store = createGitHubIngressStore(":memory:");
    let launches = 0;
    try {
      const ingress = createGitHubIngress({
        store,
        managedChats: ["chat-42@g.us"],
        dispatch: async () => ({ dispatchId: "speaker", acceptedAt: "now" }),
        review: {
          repositories: ["acme/widgets"],
          launch: async () => ({ runId: `unexpected-${++launches}` }),
          command: {
            appSlug: "tenant-reviewer",
            permission: async () => "read",
            pullRequest: async () => ({ state: "open", draft: false, headSha: "live-head" }),
          },
        },
        logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      });
      await expect(ingress(delivery)).resolves.toMatchObject({ status: "unsupported" });
      expect(launches).toBe(0);
    } finally {
      store.close();
    }
  });

  it.each([
    ["closed", { state: "closed", draft: false }],
    ["draft", { state: "open", draft: true }],
  ] as const)("rejects a %s pull request after refetch", async (_reason, live) => {
    const store = createGitHubIngressStore(":memory:");
    let launches = 0;
    try {
      const ingress = createGitHubIngress({
        store,
        managedChats: ["chat-42@g.us"],
        dispatch: async () => ({ dispatchId: "speaker", acceptedAt: "now" }),
        review: {
          repositories: ["acme/widgets"],
          launch: async () => ({ runId: `unexpected-${++launches}` }),
          command: {
            appSlug: "tenant-reviewer",
            permission: async () => "admin",
            pullRequest: async () => ({ ...live, headSha: "live-head" }),
          },
        },
        logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      });
      await expect(ingress(reviewCommandDelivery(`ineligible-${_reason}`))).resolves.toMatchObject({ status: "unsupported" });
      expect(launches).toBe(0);
    } finally {
      store.close();
    }
  });

  it("rejects commands outside the review allowlist before provider authorization", async () => {
    const store = createGitHubIngressStore(":memory:");
    let providerReads = 0;
    try {
      const ingress = createGitHubIngress({
        store,
        managedChats: ["chat-42@g.us"],
        dispatch: async () => ({ dispatchId: "speaker", acceptedAt: "now" }),
        review: {
          repositories: ["other/repository"],
          launch: async () => ({ runId: "unexpected" }),
          command: {
            appSlug: "tenant-reviewer",
            permission: async () => {
              providerReads += 1;
              return "admin";
            },
            pullRequest: async () => {
              providerReads += 1;
              return { state: "open", draft: false, headSha: "live-head" };
            },
          },
        },
        logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      });
      await expect(ingress(reviewCommandDelivery("not-allowlisted"))).resolves.toMatchObject({ status: "unsupported" });
      expect(providerReads).toBe(0);
    } finally {
      store.close();
    }
  });

  it("continues opened-PR Speaker ingress when Reviewer admission fails", async () => {
    const store = createGitHubIngressStore(":memory:");
    const operations = createIssueOperationStore(":memory:");
    const dispatched: GitHubIngressInput[] = [];
    try {
      operations.begin({
        operationId: "capture-29",
        kind: "create-issue",
        repository: "acme/widgets",
        startedAt: "2026-07-16T00:00:00.000Z",
      });
      operations.complete("capture-29", 29, "2026-07-16T00:00:01.000Z");
      const ingress = createGitHubIngress({
        store,
        operations,
        managedChats: ["chat-29@g.us"],
        dispatch: async (_chatId, input) => {
          dispatched.push(input);
          return { dispatchId: "speaker-pr-42", acceptedAt: "2026-07-16T00:00:02.000Z" };
        },
        review: {
          repositories: ["acme/widgets"],
          launch: async () => { throw new Error("reviewer temporarily unavailable"); },
        },
        logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      });

      await expect(ingress(pullRequestOpenedDelivery("reviewer-down"))).resolves.toMatchObject({ status: "done" });
      expect(dispatched).toHaveLength(1);
      expect(store.get("reviewer-down")).toMatchObject({ status: "done" });
    } finally {
      operations.close();
      store.close();
    }
  });
  it("broadcasts a supported event to every managed thread exactly once", async () => {
    const store = createGitHubIngressStore(":memory:");
    const dispatched: { readonly chatId: string; readonly input: GitHubIngressInput }[] = [];
    try {
      const managedChats = ["thread-a@g.us", "thread-b@g.us", "thread-c@g.us"];
      const ingress = createGitHubIngress({
        store,
        managedChats,
        dispatch: async (chatId, input) => {
          dispatched.push({ chatId, input });
          return { dispatchId: `dispatch-${chatId}`, acceptedAt: "2026-07-18T00:00:01.000Z" };
        },
        logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      });

      await expect(ingress(issueOpenedDelivery("broadcast-29"))).resolves.toMatchObject({
        status: "done",
        repository: "acme/widgets",
      });
      // Every managed thread's Speaker received the event once, unfiltered by repo.
      expect(dispatched.map((entry) => entry.chatId)).toEqual(managedChats);
      for (const entry of dispatched) {
        expect(entry.input).toMatchObject({ type: "github.issue.opened", chatId: entry.chatId });
      }
      expect(store.get("broadcast-29")).toMatchObject({ status: "done" });
    } finally {
      store.close();
    }
  });

  it("broadcasts even when the event's repository is not the managed default (each Speaker judges)", async () => {
    const store = createGitHubIngressStore(":memory:");
    const dispatched: string[] = [];
    try {
      const managedChats = ["thread-a@g.us", "thread-b@g.us"];
      const unmanagedRepoDelivery = {
        name: "issues",
        deliveryId: "stray-repo",
        payload: {
          action: "opened",
          repository: {
            id: 202,
            name: "unrelated",
            html_url: "https://github.com/other/unrelated",
            owner: { login: "other" },
          },
          issue: {
            number: 7,
            html_url: "https://github.com/other/unrelated/issues/7",
            title: "Stray",
            state: "open",
          },
          sender: { login: "octocat", id: 1, type: "User" },
        },
      } as GitHubWebhookDelivery;
      const ingress = createGitHubIngress({
        store,
        managedChats,
        dispatch: async (chatId) => {
          dispatched.push(chatId);
          return { dispatchId: `dispatch-${chatId}`, acceptedAt: "2026-07-18T00:00:01.000Z" };
        },
        logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      });

      await expect(ingress(unmanagedRepoDelivery)).resolves.toMatchObject({ status: "done" });
      expect(dispatched).toEqual(managedChats);
    } finally {
      store.close();
    }
  });

  it("normalizes a submitted PR review as the #173 continuation wake-up", async () => {
    const store = createGitHubIngressStore(":memory:");
    const dispatched: GitHubIngressInput[] = [];
    try {
      const ingress = createGitHubIngress({
        store,
        managedChats: ["chat-42@g.us"],
        dispatch: async (_chatId, input) => {
          dispatched.push(input);
          return { dispatchId: "dispatch-review-501", acceptedAt: "2026-07-18T00:00:01.000Z" };
        },
        logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      });

      await expect(ingress(pullRequestReviewSubmittedDelivery("review-501"))).resolves.toMatchObject({
        status: "done",
        repository: "acme/widgets",
      });
      expect(dispatched).toEqual([
        {
          type: "github.pull-request-review.submitted",
          chatId: "chat-42@g.us",
          deliveryId: "review-501",
          installationId: 77,
          repository: {
            owner: "acme",
            repo: "widgets",
            id: 101,
            url: "https://github.com/acme/widgets",
          },
          pullRequest: {
            number: 42,
            url: "https://github.com/acme/widgets/pull/42",
            title: "Fix admission proof",
            state: "open",
            draft: false,
          },
          review: {
            id: 501,
            url: "https://github.com/acme/widgets/pull/42#pullrequestreview-501",
            state: "changes_requested",
          },
          sender: { login: "reviewer[bot]", id: 2, type: "Bot" },
        },
      ]);
      expect(speakerDigestSeeds(dispatched[0]!)).toEqual({
        chatId: "chat-42@g.us",
        identities: [
          { platform: "github", externalId: "acme/widgets" },
          { platform: "github", externalId: "reviewer[bot]" },
          { platform: "github", externalId: "acme/widgets#42" },
        ],
      });
      expect(store.get("review-501")).toMatchObject({ status: "done", eventName: "pull_request_review" });
    } finally {
      store.close();
    }
  });

  it("routes a PR link event only when it closes an issue captured by Speaker", async () => {
    const store = createGitHubIngressStore(":memory:");
    const operations = createIssueOperationStore(":memory:");
    const dispatched: GitHubIngressInput[] = [];
    try {
      operations.begin({
        operationId: "capture-29",
        kind: "create-issue",
        repository: "acme/widgets",
        startedAt: "2026-07-16T00:00:00.000Z",
      });
      operations.complete("capture-29", 29, "2026-07-16T00:00:01.000Z");
      const ingress = createGitHubIngress({
        store,
        operations,
        managedChats: ["chat-29@g.us"],
        dispatch: async (_chatId, input) => {
          dispatched.push(input);
          return { dispatchId: "dispatch-pr-42", acceptedAt: "2026-07-16T00:00:02.000Z" };
        },
        logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      });

      await expect(ingress(pullRequestOpenedDelivery("pr-42"))).resolves.toMatchObject({
        status: "done",
        repository: "acme/widgets",
        chatId: "chat-29@g.us",
      });
      expect(dispatched).toEqual([
        {
          type: "github.pull-request.opened",
          chatId: "chat-29@g.us",
          deliveryId: "pr-42",
          installationId: 77,
          repository: {
            owner: "acme",
            repo: "widgets",
            id: 101,
            url: "https://github.com/acme/widgets",
          },
          issues: [{ number: 29 }],
          pullRequest: {
            number: 42,
            url: "https://github.com/acme/widgets/pull/42",
            title: "Fix admission proof",
            state: "open",
            draft: false,
          },
          sender: { login: "octocat", id: 1, type: "User" },
        },
      ]);
    } finally {
      operations.close();
      store.close();
    }
  });

  it("keeps all captured concerns and accepts GitHub's colon-form closing keywords", async () => {
    const store = createGitHubIngressStore(":memory:");
    const operations = createIssueOperationStore(":memory:");
    const dispatched: GitHubIngressInput[] = [];
    try {
      for (const issueNumber of [29, 30]) {
        const operationId = `capture-${issueNumber}`;
        operations.begin({
          operationId,
          kind: "create-issue",
          repository: "acme/widgets",
          startedAt: `2026-07-16T00:00:0${issueNumber - 29}.000Z`,
        });
        operations.complete(operationId, issueNumber, `2026-07-16T00:00:0${issueNumber - 28}.000Z`);
      }
      const ingress = createGitHubIngress({
        store,
        operations,
        managedChats: ["chat-29@g.us"],
        dispatch: async (_chatId, input) => {
          dispatched.push(input);
          return { dispatchId: "dispatch-pr-42", acceptedAt: "2026-07-16T00:00:03.000Z" };
        },
        logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      });

      await expect(
        ingress(
          pullRequestOpenedDelivery("pr-two-issues", {
            body: "Closes: #29\nFixes: acme/widgets#30",
          }),
        ),
      ).resolves.toMatchObject({ status: "done" });
      expect(dispatched).toHaveLength(1);
      expect(dispatched[0]).toMatchObject({
        type: "github.pull-request.opened",
        issues: [{ number: 29 }, { number: 30 }],
      });
    } finally {
      operations.close();
      store.close();
    }
  });

  it("keeps a PR delivery retryable until an uncertain issue create is reconciled", async () => {
    const store = createGitHubIngressStore(":memory:");
    const operations = createIssueOperationStore(":memory:");
    const dispatched: GitHubIngressInput[] = [];
    try {
      operations.begin({
        operationId: "capture-29",
        kind: "create-issue",
        repository: "acme/widgets",
        startedAt: "2026-07-16T00:00:00.000Z",
      });
      operations.uncertain("capture-29", "provider outcome unknown", "2026-07-16T00:00:01.000Z");
      const reviewLaunches: unknown[] = [];
      const ingress = createGitHubIngress({
        store,
        operations,
        managedChats: ["chat-29@g.us"],
        dispatch: async (_chatId, input) => {
          dispatched.push(input);
          return { dispatchId: "dispatch-pr-42", acceptedAt: "2026-07-16T00:00:03.000Z" };
        },
        review: {
          repositories: ["acme/widgets"],
          launch: async (input) => {
            reviewLaunches.push(input);
            return { runId: "review-after-correlation" };
          },
        },
        logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      });
      const delivery = pullRequestOpenedDelivery("pr-after-reconciliation");

      await expect(ingress(delivery)).resolves.toMatchObject({ status: "deferred" });
      await expect(ingress(delivery)).resolves.toMatchObject({ status: "deferred" });
      expect(reviewLaunches).toEqual([]);
      expect(store.get("pr-after-reconciliation")).toMatchObject({ status: "received" });
      expect(dispatched).toEqual([]);

      operations.resolveUncertain({
        operationId: "capture-29",
        status: "completed",
        resolution: "reconciled",
        settledAt: "2026-07-16T00:00:02.000Z",
        issueNumber: 29,
      });
      await expect(ingress(delivery)).resolves.toMatchObject({ status: "done" });
      expect(dispatched).toHaveLength(1);
      expect(store.get("pr-after-reconciliation")).toMatchObject({ status: "done" });
    } finally {
      operations.close();
      store.close();
    }
  });

  it("delivers an opened draft because ready-for-review is not a supported ingress transition", async () => {
    const store = createGitHubIngressStore(":memory:");
    const operations = createIssueOperationStore(":memory:");
    const dispatched: GitHubIngressInput[] = [];
    try {
      operations.begin({
        operationId: "capture-29",
        kind: "create-issue",
        repository: "acme/widgets",
        startedAt: "2026-07-16T00:00:00.000Z",
      });
      operations.complete("capture-29", 29, "2026-07-16T00:00:01.000Z");
      const ingress = createGitHubIngress({
        store,
        operations,
        managedChats: ["chat-29@g.us"],
        dispatch: async (_chatId, input) => {
          dispatched.push(input);
          return { dispatchId: "dispatch-draft-42", acceptedAt: "2026-07-16T00:00:02.000Z" };
        },
        logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      });

      await expect(ingress(pullRequestOpenedDelivery("draft-pr-42", { draft: true }))).resolves.toMatchObject({
        status: "done",
      });
      expect(dispatched[0]).toMatchObject({ pullRequest: { draft: true } });
    } finally {
      operations.close();
      store.close();
    }
  });

  it("does not route a PR that lacks a closing reference to a captured issue", async () => {
    const store = createGitHubIngressStore(":memory:");
    const operations = createIssueOperationStore(":memory:");
    try {
      operations.begin({
        operationId: "capture-29",
        kind: "create-issue",
        repository: "acme/widgets",
        startedAt: "2026-07-16T00:00:00.000Z",
      });
      operations.complete("capture-29", 29, "2026-07-16T00:00:01.000Z");
      const ingress = createGitHubIngress({
        store,
        operations,
        managedChats: ["chat-29@g.us"],
        dispatch: async () => {
          throw new Error("unrelated PR must not dispatch");
        },
        logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      });

      await expect(
        ingress(pullRequestOpenedDelivery("pr-unrelated", { body: "Documents #29" })),
      ).resolves.toEqual({
        status: "uncorrelated",
        deliveryId: "pr-unrelated",
        repository: "acme/widgets",
      });
    } finally {
      operations.close();
      store.close();
    }
  });

  it("atomically claims a delivery identifier only once and persists correlation", () => {
    const store = createGitHubIngressStore(":memory:");
    try {
      expect(store.claim("delivery-29", "issues", "2026-07-13T00:00:00.000Z")).toBe(true);
      expect(store.claim("delivery-29", "issues", "2026-07-13T00:00:01.000Z")).toBe(false);

      store.settle("delivery-29", {
        status: "done",
        repository: "acme/widgets",
        chatId: "chat-29@g.us",
        ambience: "ambience",
        dispatchId: "dispatch-29",
        acceptedAt: "2026-07-13T00:00:01.000Z",
        settledAt: "2026-07-13T00:00:02.000Z",
      });

      expect(store.get("delivery-29")).toEqual({
        githubAppId: "legacy",
        deliveryId: "delivery-29",
        eventName: "issues",
        repository: "acme/widgets",
        chatId: "chat-29@g.us",
        ambience: "ambience",
        dispatchId: "dispatch-29",
        acceptedAt: "2026-07-13T00:00:01.000Z",
        status: "done",
        receivedAt: "2026-07-13T00:00:00.000Z",
        settledAt: "2026-07-13T00:00:02.000Z",
      });
      expect(() =>
        store.settle("delivery-29", { status: "failed", error: "late", settledAt: "2026-07-13T00:00:03.000Z" }),
      ).toThrow("cannot settle as failed");
    } finally {
      store.close();
    }
  });

  it("scopes the tenant ingress identity by GitHub App and delivery GUID", () => {
    const store = createGitHubIngressStore(":memory:");
    try {
      expect(store.claim("shared-guid", "issues", "2026-07-18T00:00:00.000Z", "app-coder")).toBe(true);
      expect(store.claim("shared-guid", "issues", "2026-07-18T00:00:00.000Z", "app-reviewer")).toBe(true);
      expect(store.claim("shared-guid", "issues", "2026-07-18T00:00:01.000Z", "app-coder")).toBe(false);
      expect(store.list().map((record) => `${record.githubAppId}:${record.deliveryId}`)).toEqual([
        "app-coder:shared-guid",
        "app-reviewer:shared-guid",
      ]);
    } finally {
      store.close();
    }
  });

  it("reprocesses an interrupted received delivery when the provider redelivers it", async () => {
    const root = await mkdtemp(join(tmpdir(), "ambient-agent-github-ingress-"));
    const path = join(root, "application.sqlite");
    const interrupted = createGitHubIngressStore(path);
    interrupted.claim("interrupted-29", "issues", "2026-07-13T00:00:00.000Z");
    interrupted.close();
    const store = createGitHubIngressStore(path);
    try {
      let admissions = 0;
      const ingress = createGitHubIngress({
        store,
        managedChats: ["chat-29@g.us"],
        dispatch: async () => {
          admissions += 1;
          return { dispatchId: "dispatch-redelivered", acceptedAt: "2026-07-13T00:00:01.000Z" };
        },
        logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
        now: () => new Date("2026-07-13T00:00:01.000Z"),
      });

      await expect(ingress(issueOpenedDelivery("interrupted-29"))).resolves.toMatchObject({
        status: "done",
        dispatchId: "dispatch-redelivered",
      });
      expect(admissions).toBe(1);
      expect(store.get("interrupted-29")).toMatchObject({ status: "done" });
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("retries a failing dispatch within its bound and then settles the delivery as done", async () => {
    const store = createGitHubIngressStore(":memory:");
    try {
      let admissions = 0;
      const ingress = createGitHubIngress({
        store,
        managedChats: ["chat-56@g.us"],
        dispatch: async () => {
          admissions += 1;
          if (admissions < 3) throw new Error("transient Flue failure");
          return { dispatchId: "dispatch-56", acceptedAt: "2026-07-15T00:00:01.000Z" };
        },
        logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
        retry: { attempts: 3, delayMs: () => 0 },
      });

      await expect(ingress(issueOpenedDelivery("retry-56"))).resolves.toMatchObject({
        status: "done",
        dispatchId: "dispatch-56",
      });
      expect(admissions).toBe(3);
      expect(store.get("retry-56")).toMatchObject({ status: "done", dispatchId: "dispatch-56" });
    } finally {
      store.close();
    }
  });

  it("settles an exhausted dispatch as terminally failed and deduplicates its redelivery", async () => {
    const store = createGitHubIngressStore(":memory:");
    try {
      let admissions = 0;
      const ingress = createGitHubIngress({
        store,
        managedChats: ["chat-56@g.us"],
        dispatch: async () => {
          admissions += 1;
          throw new Error("Flue response was lost");
        },
        logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
        retry: { attempts: 2, delayMs: () => 0 },
      });

      await expect(ingress(issueOpenedDelivery("failed-56"))).resolves.toMatchObject({
        status: "failed",
        record: { status: "failed", error: "Flue response was lost" },
      });
      expect(admissions).toBe(2);
      // A broadcast has no single target, so a failed delivery records the repository but no
      // one chat id; redelivery re-broadcasts to all managed threads (duplicate wakes tolerated).
      expect(store.get("failed-56")).toMatchObject({
        status: "failed",
        repository: "acme/widgets",
      });
      expect(store.get("failed-56")?.chatId).toBeUndefined();
      await expect(ingress(issueOpenedDelivery("failed-56"))).resolves.toMatchObject({ status: "duplicate" });
      expect(admissions).toBe(2);
    } finally {
      store.close();
    }
  });

  it("deduplicates a concurrent redelivery without a second dispatch", async () => {
    const store = createGitHubIngressStore(":memory:");
    try {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let admissions = 0;
      const ingress = createGitHubIngress({
        store,
        managedChats: ["chat-56@g.us"],
        dispatch: async () => {
          admissions += 1;
          await gate;
          return { dispatchId: "dispatch-concurrent", acceptedAt: "2026-07-15T00:00:01.000Z" };
        },
        logger: { info: () => undefined, warn: () => undefined, error: () => undefined },
      });

      const first = ingress(issueOpenedDelivery("concurrent-56"));
      await expect(ingress(issueOpenedDelivery("concurrent-56"))).resolves.toMatchObject({
        status: "duplicate",
        record: { status: "received" },
      });
      release();
      await expect(first).resolves.toMatchObject({ status: "done", dispatchId: "dispatch-concurrent" });
      expect(admissions).toBe(1);
    } finally {
      store.close();
    }
  });

  it("migrates every predecessor ledger status per the ADR 0014 mapping", async () => {
    const root = await mkdtemp(join(tmpdir(), "ambient-agent-github-ingress-migration-"));
    const path = join(root, "application.sqlite");
    try {
      const legacy = new DatabaseSync(path);
      legacy.exec(`
        CREATE TABLE github_ingress_deliveries (
          delivery_id TEXT PRIMARY KEY,
          event_name TEXT NOT NULL,
          repository TEXT,
          chat_id TEXT,
          ambience TEXT,
          dispatch_id TEXT,
          accepted_at TEXT,
          status TEXT NOT NULL CHECK (status IN ('received', 'dispatching', 'unsupported', 'uncorrelated', 'dispatched', 'uncertain', 'failed')),
          error TEXT,
          received_at TEXT NOT NULL,
          settled_at TEXT
        ) STRICT;
        INSERT INTO github_ingress_deliveries
          (delivery_id, event_name, status, received_at)
        VALUES ('legacy-received', 'issues', 'received', '2026-07-14T00:00:00.000Z');
        INSERT INTO github_ingress_deliveries
          (delivery_id, event_name, repository, chat_id, ambience, status, received_at)
        VALUES ('legacy-dispatching', 'issues', 'acme/widgets', 'chat@g.us', 'ambience', 'dispatching', '2026-07-14T00:00:00.000Z');
        INSERT INTO github_ingress_deliveries
          (delivery_id, event_name, repository, chat_id, ambience, status, error, received_at, settled_at)
        VALUES ('legacy-uncertain', 'issues', 'acme/widgets', 'chat@g.us', 'ambience', 'uncertain',
                'Ambience admission outcome unknown', '2026-07-14T00:00:00.000Z', '2026-07-14T00:00:01.000Z');
        INSERT INTO github_ingress_deliveries
          (delivery_id, event_name, repository, chat_id, ambience, dispatch_id, accepted_at, status, received_at, settled_at)
        VALUES ('legacy-dispatched', 'issues', 'acme/widgets', 'chat@g.us', 'ambience', 'dispatch-old',
                '2026-07-14T00:00:00.500Z', 'dispatched', '2026-07-14T00:00:00.000Z', '2026-07-14T00:00:01.000Z');
        INSERT INTO github_ingress_deliveries
          (delivery_id, event_name, status, error, received_at, settled_at)
        VALUES ('legacy-failed', 'issues', 'failed', 'terminal error', '2026-07-14T00:00:00.000Z', '2026-07-14T00:00:01.000Z');
      `);
      legacy.close();

      const store = createGitHubIngressStore(path);
      expect(store.get("legacy-received")).toMatchObject({ status: "received" });
      expect(store.get("legacy-dispatching")).toMatchObject({ status: "received" });
      expect(store.get("legacy-uncertain")).toMatchObject({ status: "received" });
      expect(store.get("legacy-uncertain")?.error).toBeUndefined();
      expect(store.get("legacy-uncertain")?.settledAt).toBeUndefined();
      expect(store.get("legacy-dispatched")).toMatchObject({
        status: "done",
        dispatchId: "dispatch-old",
        acceptedAt: "2026-07-14T00:00:00.500Z",
      });
      expect(store.get("legacy-failed")).toMatchObject({ status: "failed", error: "terminal error" });
      store.close();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("tenant-routed deliveries settle under their own GitHub App id", () => {
  const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };
  const review = (launches?: string[]) => ({
    repositories: ["acme/widgets"],
    launch: async () => {
      launches?.push("launched");
      return { runId: "tenant-review" };
    },
    command: {
      appSlug: "tenant-reviewer",
      permission: async () => "write",
      pullRequest: async () => ({ state: "open", draft: false, headSha: "live-head" }),
    },
  });

  it("settles review-command and synchronize deliveries on the routed app row, not the legacy row", async () => {
    const store = createGitHubIngressStore(":memory:");
    try {
      const ingress = createGitHubIngress({
        store,
        managedChats: ["chat-42@g.us"],
        dispatch: async () => ({ dispatchId: "speaker", acceptedAt: "2026-07-18T00:00:01.000Z" }),
        review: review(),
        logger: quiet,
      });

      const command = { ...reviewCommandDelivery("tenant-command"), githubAppId: "app-reviewer-1" };
      await expect(ingress(command)).resolves.toMatchObject({ status: "review-launched", runId: "tenant-review" });
      expect(store.get("tenant-command", "app-reviewer-1")).toMatchObject({ status: "done", dispatchId: "tenant-review" });
      expect(store.get("tenant-command")).toBeUndefined();

      const sync = pullRequestOpenedDelivery("tenant-sync") as GitHubWebhookDelivery & { payload: { action: string } };
      sync.payload.action = "synchronize";
      await expect(ingress({ ...sync, githubAppId: "app-reviewer-1" })).resolves.toMatchObject({ status: "review-launched" });
      expect(store.get("tenant-sync", "app-reviewer-1")).toMatchObject({ status: "done" });
      expect(store.get("tenant-sync")).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("serves a tenant with GitHub connected but no managed chat paired", async () => {
    const store = createGitHubIngressStore(":memory:");
    try {
      const launches: string[] = [];
      const ingress = createGitHubIngress({
        store,
        managedChats: [],
        dispatch: async () => {
          throw new Error("nothing may dispatch without a managed chat");
        },
        review: review(launches),
        logger: quiet,
      });

      const command = { ...reviewCommandDelivery("chatless-command"), githubAppId: "app-reviewer-1" };
      await expect(ingress(command)).resolves.toMatchObject({ status: "review-launched" });
      expect(launches).toEqual(["launched"]);
      const record = store.get("chatless-command", "app-reviewer-1");
      expect(record).toMatchObject({ status: "done" });
      expect(record?.chatId).toBeUndefined();

      const issue = { ...issueOpenedDelivery("chatless-issue"), githubAppId: "app-coder-1" };
      await expect(ingress(issue)).resolves.toMatchObject({ status: "unsupported" });
      expect(store.get("chatless-issue", "app-coder-1")).toMatchObject({ status: "unsupported" });
    } finally {
      store.close();
    }
  });
});
