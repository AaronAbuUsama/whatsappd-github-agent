import { describe, expect, it } from "vite-plus/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { GitHubWebhookDelivery } from "@flue/github";

import type { GitHubEventDraft } from "../../packages/engine/src/brain/inbox.ts";
import { createIssueOperationStore } from "../../packages/engine/src/github/operation-store.ts";
import { createGitHubIngress } from "../../packages/engine/src/github/ingress.ts";
import { createGitHubIngressStore } from "../../packages/engine/src/github/ingress-store.ts";
import { createGraphStore } from "../../packages/engine/src/graph/store.ts";
import { seedRepositoryFacts } from "../../packages/agents/src/capabilities/graph/seed-repositories.ts";
import { serializeReviewerSubmission } from "../../packages/agents/src/capabilities/reviewer/workflow.ts";

// A recording Brain up-inbox admission port. The ingress hands each event here; the Brain — never
// the ingress — later decides which Surface(s) hear it, so no chat id crosses this seam.
const admitRecorder = () => {
  const events: GitHubEventDraft[] = [];
  return {
    events,
    admit: async (event: GitHubEventDraft) => {
      events.push(event);
      return { id: `up-inbox:${event.githubAppId}:${event.deliveryId}`, admittedAt: "2026-07-18T00:00:01.000Z" };
    },
  };
};
const quietLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

const issueOpenedDelivery = (deliveryId: string, repository = "widgets", owner = "acme"): GitHubWebhookDelivery =>
  ({
    name: "issues",
    deliveryId,
    payload: {
      action: "opened",
      repository: {
        id: 101,
        name: repository,
        html_url: `https://github.com/${owner}/${repository}`,
        owner: { login: owner },
      },
      issue: {
        number: 29,
        html_url: `https://github.com/${owner}/${repository}/issues/29`,
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

describe("GitHub events route through the single Brain up-inbox", () => {
  it("admits an opened issue to the up-inbox and never dispatches it to a chat", async () => {
    const store = createGitHubIngressStore(":memory:");
    const { admit, events } = admitRecorder();
    try {
      const ingress = createGitHubIngress({ store, admit, logger: quietLogger });
      const result = await ingress(issueOpenedDelivery("issue-29"));
      expect(result).toMatchObject({ status: "done", repository: "acme/widgets" });
      // The event landed in the up-inbox exactly once, carrying its repository as provenance and NO chat id.
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        deliveryId: "issue-29",
        eventName: "issues",
        action: "opened",
        repository: "acme/widgets",
        detail: { issue: { number: 29, title: "Admission proof" } },
      });
      expect(events[0]).not.toHaveProperty("chatId");
      const record = store.get("issue-29");
      expect(record).toMatchObject({ status: "done", repository: "acme/widgets" });
      // No routing target: the Brain, not the ledger, decides which Surface hears it.
      expect(record?.chatId).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("carries canonical repository casing so the Brain's Graph lookup resolves a mixed-case repo", async () => {
    const store = createGitHubIngressStore(":memory:");
    const graph = createGraphStore(":memory:");
    const { admit, events } = admitRecorder();
    try {
      // #19 seeds the Graph repository entity in its configured casing; resolveIdentity is exact-match.
      seedRepositoryFacts(graph, {
        allowedRepositories: ["TheCallApp/ios-app"],
        surfaceRepositories: [{ chat: "team@g.us", repository: "TheCallApp/ios-app" }],
      });
      const ingress = createGitHubIngress({ store, admit, logger: quietLogger });
      await expect(ingress(issueOpenedDelivery("mixed-case", "ios-app", "TheCallApp"))).resolves.toMatchObject({
        status: "done",
      });
      // The event carries GitHub's canonical casing, not the lower-cased internal key.
      expect(events[0]!.repository).toBe("TheCallApp/ios-app");
      // So the Brain's lookup_graph on it resolves the seeded entity — the routing chain works.
      expect(graph.resolveIdentity("github", events[0]!.repository, "repository")).toBeDefined();
      // The lower-cased key would NOT resolve — the casing fix is load-bearing.
      expect(graph.resolveIdentity("github", events[0]!.repository.toLowerCase(), "repository")).toBeUndefined();
    } finally {
      graph.close();
      store.close();
    }
  });

  it("admits an event from any repository without routing it to a chat (negative: no cross-company leak)", async () => {
    const store = createGitHubIngressStore(":memory:");
    const { admit, events } = admitRecorder();
    try {
      const ingress = createGitHubIngress({ store, admit, logger: quietLogger });
      // An event correlated to org "other" is admitted, but reaches NO chat — the Brain owns routing,
      // so it can never appear in another org's chat by broadcast.
      await expect(ingress(issueOpenedDelivery("stray", "unrelated", "other"))).resolves.toMatchObject({
        status: "done",
        repository: "other/unrelated",
      });
      expect(events).toHaveLength(1);
      expect(events[0]!.repository).toBe("other/unrelated");
      expect(store.get("stray")?.chatId).toBeUndefined();
    } finally {
      store.close();
    }
  });

  it("normalizes a submitted PR review as an immutable up-inbox event", async () => {
    const store = createGitHubIngressStore(":memory:");
    const { admit, events } = admitRecorder();
    try {
      const ingress = createGitHubIngress({ store, admit, logger: quietLogger });
      await expect(ingress(pullRequestReviewSubmittedDelivery("review-501"))).resolves.toMatchObject({
        status: "done",
        repository: "acme/widgets",
      });
      expect(events).toEqual([
        {
          githubAppId: "legacy",
          deliveryId: "review-501",
          eventName: "pull_request_review",
          action: "submitted",
          repository: "acme/widgets",
          summary: "Review changes_requested on acme/widgets#42",
          detail: {
            installationId: 77,
            repository: { owner: "acme", repo: "widgets", id: 101, url: "https://github.com/acme/widgets" },
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
        },
      ]);
      expect(store.get("review-501")).toMatchObject({ status: "done", eventName: "pull_request_review" });
    } finally {
      store.close();
    }
  });

  it("admits a PR carrying the issues it closes when Speaker captured them", async () => {
    const store = createGitHubIngressStore(":memory:");
    const operations = createIssueOperationStore(":memory:");
    const { admit, events } = admitRecorder();
    try {
      operations.begin({
        operationId: "capture-29",
        kind: "create-issue",
        repository: "acme/widgets",
        startedAt: "2026-07-16T00:00:00.000Z",
      });
      operations.complete("capture-29", 29, "2026-07-16T00:00:01.000Z");
      const ingress = createGitHubIngress({ store, operations, admit, logger: quietLogger });
      await expect(ingress(pullRequestOpenedDelivery("pr-42"))).resolves.toMatchObject({
        status: "done",
        repository: "acme/widgets",
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        deliveryId: "pr-42",
        eventName: "pull_request",
        action: "opened",
        repository: "acme/widgets",
        detail: {
          issues: [{ number: 29 }],
          pullRequest: { number: 42, title: "Fix admission proof" },
        },
      });
    } finally {
      operations.close();
      store.close();
    }
  });

  it("keeps all captured concerns and accepts GitHub's colon-form closing keywords", async () => {
    const store = createGitHubIngressStore(":memory:");
    const operations = createIssueOperationStore(":memory:");
    const { admit, events } = admitRecorder();
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
      const ingress = createGitHubIngress({ store, operations, admit, logger: quietLogger });
      await expect(
        ingress(pullRequestOpenedDelivery("pr-two-issues", { body: "Closes: #29\nFixes: acme/widgets#30" })),
      ).resolves.toMatchObject({ status: "done" });
      expect(events).toHaveLength(1);
      expect(events[0]!.detail).toMatchObject({ issues: [{ number: 29 }, { number: 30 }] });
    } finally {
      operations.close();
      store.close();
    }
  });

  it("admits an uncorrelated PR to the up-inbox instead of dropping it (negative: zero drops)", async () => {
    const store = createGitHubIngressStore(":memory:");
    const operations = createIssueOperationStore(":memory:");
    const { admit, events } = admitRecorder();
    try {
      operations.begin({
        operationId: "capture-29",
        kind: "create-issue",
        repository: "acme/widgets",
        startedAt: "2026-07-16T00:00:00.000Z",
      });
      operations.complete("capture-29", 29, "2026-07-16T00:00:01.000Z");
      const ingress = createGitHubIngress({ store, operations, admit, logger: quietLogger });
      // A PR that closes no captured issue used to drop as "uncorrelated"; it must now land in the inbox.
      await expect(
        ingress(pullRequestOpenedDelivery("pr-unrelated", { body: "Documents #29" })),
      ).resolves.toMatchObject({ status: "done", repository: "acme/widgets" });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ deliveryId: "pr-unrelated", repository: "acme/widgets" });
      expect(events[0]!.detail).not.toHaveProperty("issues");
    } finally {
      operations.close();
      store.close();
    }
  });

  it("admits an opened draft because ready-for-review is not a supported ingress transition", async () => {
    const store = createGitHubIngressStore(":memory:");
    const operations = createIssueOperationStore(":memory:");
    const { admit, events } = admitRecorder();
    try {
      operations.begin({
        operationId: "capture-29",
        kind: "create-issue",
        repository: "acme/widgets",
        startedAt: "2026-07-16T00:00:00.000Z",
      });
      operations.complete("capture-29", 29, "2026-07-16T00:00:01.000Z");
      const ingress = createGitHubIngress({ store, operations, admit, logger: quietLogger });
      await expect(ingress(pullRequestOpenedDelivery("draft-pr-42", { draft: true }))).resolves.toMatchObject({
        status: "done",
      });
      expect(events[0]!.detail).toMatchObject({ pullRequest: { draft: true } });
    } finally {
      operations.close();
      store.close();
    }
  });

  it("keeps a PR delivery retryable until an uncertain issue create is reconciled", async () => {
    const store = createGitHubIngressStore(":memory:");
    const operations = createIssueOperationStore(":memory:");
    const { admit, events } = admitRecorder();
    try {
      operations.begin({
        operationId: "capture-29",
        kind: "create-issue",
        repository: "acme/widgets",
        startedAt: "2026-07-16T00:00:00.000Z",
      });
      operations.uncertain("capture-29", "provider outcome unknown", "2026-07-16T00:00:01.000Z");
      const ingress = createGitHubIngress({ store, operations, admit, logger: quietLogger });
      const delivery = pullRequestOpenedDelivery("pr-after-reconciliation");

      await expect(ingress(delivery)).resolves.toMatchObject({ status: "deferred" });
      await expect(ingress(delivery)).resolves.toMatchObject({ status: "deferred" });
      expect(events).toEqual([]);
      expect(store.get("pr-after-reconciliation")).toMatchObject({ status: "received" });

      operations.resolveUncertain({
        operationId: "capture-29",
        status: "completed",
        resolution: "reconciled",
        settledAt: "2026-07-16T00:00:02.000Z",
        issueNumber: 29,
      });
      await expect(ingress(delivery)).resolves.toMatchObject({ status: "done" });
      expect(events).toHaveLength(1);
      expect(store.get("pr-after-reconciliation")).toMatchObject({ status: "done" });
    } finally {
      operations.close();
      store.close();
    }
  });

  it("defers (retryable) instead of dropping when the up-inbox is not wired yet (boot race)", async () => {
    const store = createGitHubIngressStore(":memory:");
    try {
      // admit resolves to undefined = the Brain up-inbox port is not configured yet.
      const ingress = createGitHubIngress({ store, admit: async () => undefined, logger: quietLogger });
      const delivery = issueOpenedDelivery("boot-race-29");
      // Deferred, not failed: the ledger stays 'received' so the provider redelivery reprocesses it.
      await expect(ingress(delivery)).resolves.toMatchObject({ status: "deferred", repository: "acme/widgets" });
      expect(store.get("boot-race-29")).toMatchObject({ status: "received" });

      // Once the port is wired, the same redelivery admits normally — nothing was lost.
      const { admit, events } = admitRecorder();
      const wired = createGitHubIngress({ store, admit, logger: quietLogger });
      await expect(wired(delivery)).resolves.toMatchObject({ status: "done" });
      expect(events).toHaveLength(1);
      expect(store.get("boot-race-29")).toMatchObject({ status: "done" });
    } finally {
      store.close();
    }
  });

  it("settles a delivery as failed when up-inbox admission throws, then deduplicates its redelivery", async () => {
    const store = createGitHubIngressStore(":memory:");
    try {
      let admissions = 0;
      const ingress = createGitHubIngress({
        store,
        admit: async () => {
          admissions += 1;
          throw new Error("up-inbox unavailable");
        },
        logger: quietLogger,
      });
      await expect(ingress(issueOpenedDelivery("failed-56"))).resolves.toMatchObject({
        status: "failed",
        record: { status: "failed", error: "up-inbox unavailable" },
      });
      expect(admissions).toBe(1);
      expect(store.get("failed-56")).toMatchObject({ status: "failed", repository: "acme/widgets" });
      await expect(ingress(issueOpenedDelivery("failed-56"))).resolves.toMatchObject({ status: "duplicate" });
      expect(admissions).toBe(1);
    } finally {
      store.close();
    }
  });

  it("deduplicates a concurrent redelivery without a second admission", async () => {
    const store = createGitHubIngressStore(":memory:");
    try {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let admissions = 0;
      const ingress = createGitHubIngress({
        store,
        admit: async (event) => {
          admissions += 1;
          await gate;
          return { id: `up:${event.deliveryId}`, admittedAt: "2026-07-15T00:00:01.000Z" };
        },
        logger: quietLogger,
      });

      const first = ingress(issueOpenedDelivery("concurrent-56"));
      await expect(ingress(issueOpenedDelivery("concurrent-56"))).resolves.toMatchObject({
        status: "duplicate",
        record: { status: "received" },
      });
      release();
      await expect(first).resolves.toMatchObject({ status: "done" });
      expect(admissions).toBe(1);
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
        admit: async (event) => {
          admissions += 1;
          return { id: `up:${event.deliveryId}`, admittedAt: "2026-07-13T00:00:01.000Z" };
        },
        logger: quietLogger,
        now: () => new Date("2026-07-13T00:00:01.000Z"),
      });

      await expect(ingress(issueOpenedDelivery("interrupted-29"))).resolves.toMatchObject({ status: "done" });
      expect(admissions).toBe(1);
      expect(store.get("interrupted-29")).toMatchObject({ status: "done" });
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("GitHub ingress review launches (unchanged, never broadcast)", () => {
  it.each(["opened", "ready_for_review", "synchronize"] as const)(
    "admits an eligible non-draft PR on %s exactly once per webhook delivery",
    async (action) => {
      const store = createGitHubIngressStore(":memory:");
      const { admit } = admitRecorder();
      const launches: unknown[] = [];
      try {
        const ingress = createGitHubIngress({
          store,
          admit,
          review: {
            repositories: ["acme/widgets"],
            launch: async (input) => {
              launches.push(input);
              return { runId: `review-${action}` };
            },
          },
          logger: quietLogger,
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
    const { admit } = admitRecorder();
    const launches: unknown[] = [];
    try {
      const ingress = createGitHubIngress({
        store,
        admit,
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
        logger: quietLogger,
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
    const { admit } = admitRecorder();
    let effects = 0;
    let release!: () => void;
    const overlap = new Promise<void>((resolve) => { release = resolve; });
    try {
      const ingress = createGitHubIngress({
        store,
        admit,
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
        logger: quietLogger,
      });
      const automatic = pullRequestOpenedDelivery("automatic-race") as GitHubWebhookDelivery & { payload: { action: string } };
      automatic.payload.action = "synchronize";
      const results = Promise.all([ingress(automatic), ingress(reviewCommandDelivery("manual-race"))]);
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
    const { admit } = admitRecorder();
    let launches = 0;
    try {
      const ingress = createGitHubIngress({
        store,
        admit,
        review: {
          repositories: ["acme/widgets"],
          launch: async () => ({ runId: `manual-${++launches}` }),
          command: {
            appSlug: "tenant-reviewer",
            permission: async () => permission,
            pullRequest: async () => ({ state: "open", draft: false, headSha: "live-head" }),
          },
        },
        logger: quietLogger,
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
    const { admit } = admitRecorder();
    let launches = 0;
    try {
      const ingress = createGitHubIngress({
        store,
        admit,
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
        logger: quietLogger,
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
    const { admit } = admitRecorder();
    let launches = 0;
    try {
      const ingress = createGitHubIngress({
        store,
        admit,
        review: {
          repositories: ["acme/widgets"],
          launch: async () => ({ runId: `unexpected-${++launches}` }),
          command: {
            appSlug: "tenant-reviewer",
            permission: async () => "read",
            pullRequest: async () => ({ state: "open", draft: false, headSha: "live-head" }),
          },
        },
        logger: quietLogger,
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
    const { admit } = admitRecorder();
    let launches = 0;
    try {
      const ingress = createGitHubIngress({
        store,
        admit,
        review: {
          repositories: ["acme/widgets"],
          launch: async () => ({ runId: `unexpected-${++launches}` }),
          command: {
            appSlug: "tenant-reviewer",
            permission: async () => "admin",
            pullRequest: async () => ({ ...live, headSha: "live-head" }),
          },
        },
        logger: quietLogger,
      });
      await expect(ingress(reviewCommandDelivery(`ineligible-${_reason}`))).resolves.toMatchObject({ status: "unsupported" });
      expect(launches).toBe(0);
    } finally {
      store.close();
    }
  });

  it("rejects commands outside the review allowlist before provider authorization", async () => {
    const store = createGitHubIngressStore(":memory:");
    const { admit } = admitRecorder();
    let providerReads = 0;
    try {
      const ingress = createGitHubIngress({
        store,
        admit,
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
        logger: quietLogger,
      });
      await expect(ingress(reviewCommandDelivery("not-allowlisted"))).resolves.toMatchObject({ status: "unsupported" });
      expect(providerReads).toBe(0);
    } finally {
      store.close();
    }
  });

  it("still admits the opened PR to the up-inbox when Reviewer admission fails", async () => {
    const store = createGitHubIngressStore(":memory:");
    const operations = createIssueOperationStore(":memory:");
    const { admit, events } = admitRecorder();
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
        admit,
        review: {
          repositories: ["acme/widgets"],
          launch: async () => { throw new Error("reviewer temporarily unavailable"); },
        },
        logger: quietLogger,
      });

      await expect(ingress(pullRequestOpenedDelivery("reviewer-down"))).resolves.toMatchObject({ status: "done" });
      expect(events).toHaveLength(1);
      expect(store.get("reviewer-down")).toMatchObject({ status: "done" });
    } finally {
      operations.close();
      store.close();
    }
  });

  it("settles review-command and synchronize deliveries on the routed app row, not the legacy row", async () => {
    const store = createGitHubIngressStore(":memory:");
    const { admit } = admitRecorder();
    try {
      const ingress = createGitHubIngress({
        store,
        admit,
        review: {
          repositories: ["acme/widgets"],
          launch: async () => ({ runId: "tenant-review" }),
          command: {
            appSlug: "tenant-reviewer",
            permission: async () => "write",
            pullRequest: async () => ({ state: "open", draft: false, headSha: "live-head" }),
          },
        },
        logger: quietLogger,
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
});

describe("GitHub ingress delivery ledger", () => {
  it("atomically claims a delivery identifier only once and persists correlation", () => {
    const store = createGitHubIngressStore(":memory:");
    try {
      expect(store.claim("delivery-29", "issues", "2026-07-13T00:00:00.000Z")).toBe(true);
      expect(store.claim("delivery-29", "issues", "2026-07-13T00:00:01.000Z")).toBe(false);

      store.settle("delivery-29", {
        status: "done",
        repository: "acme/widgets",
        ambience: "ambience",
        dispatchId: "up-inbox:legacy:delivery-29",
        acceptedAt: "2026-07-13T00:00:01.000Z",
        settledAt: "2026-07-13T00:00:02.000Z",
      });

      expect(store.get("delivery-29")).toEqual({
        githubAppId: "legacy",
        deliveryId: "delivery-29",
        eventName: "issues",
        repository: "acme/widgets",
        ambience: "ambience",
        dispatchId: "up-inbox:legacy:delivery-29",
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
