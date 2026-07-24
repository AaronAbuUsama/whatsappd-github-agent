import { describe, expect, it } from "vite-plus/test";
import type { GitHubWebhookDelivery } from "@flue/github";

import type { GitHubEventDraft } from "../../packages/engine/src/brain/inbox.ts";
import { createGitHubIngress } from "../../packages/engine/src/github/ingress.ts";
import { createGitHubIngressStore } from "../../packages/engine/src/github/ingress-store.ts";

// #211 ingress gating: only a REQUEST_CHANGES by the configured Reviewer App, on an allowlisted
// repo, on a registered Coder PR, may launch automatic repair. Everything else reaches the Brain.

const quietLogger = { info: () => undefined, warn: () => undefined, error: () => undefined };

const admitRecorder = () => {
  const events: GitHubEventDraft[] = [];
  return {
    events,
    admit: async (event: GitHubEventDraft) => {
      events.push(event);
      return { id: `up:${event.deliveryId}`, admittedAt: "2026-07-24T00:00:01.000Z" };
    },
  };
};

const reviewSubmitted = (
  deliveryId: string,
  options: { readonly senderLogin?: string; readonly state?: string } = {},
): GitHubWebhookDelivery =>
  ({
    name: "pull_request_review",
    deliveryId,
    payload: {
      action: "submitted",
      installation: { id: 77 },
      repository: { id: 101, name: "widgets", html_url: "https://github.com/acme/widgets", owner: { login: "acme" } },
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
        state: options.state ?? "changes_requested",
      },
      sender: { login: options.senderLogin ?? "reviewer[bot]", id: 2, type: "Bot" },
    },
  }) as GitHubWebhookDelivery;

type RepairOutcome =
  | { status: "launched"; runId: string }
  | { status: "handled" }
  | { status: "unregistered" };

const reviewConfig = (repair: (input: { repository: string; pullRequest: number; reviewId: number }) => Promise<RepairOutcome>) => ({
  repositories: ["acme/widgets"],
  launch: async () => ({ runId: "unused" }),
  repair,
  command: {
    appSlug: "reviewer",
    permission: async () => "write",
    pullRequest: async () => ({ state: "open", draft: false, headSha: "h" }),
  },
});

describe("GitHub ingress repair gating (#211)", () => {
  it("launches repair for a Reviewer-App REQUEST_CHANGES; a redelivery is deduped, not relaunched", async () => {
    const store = createGitHubIngressStore(":memory:");
    const { admit, events } = admitRecorder();
    const calls: unknown[] = [];
    try {
      const ingress = createGitHubIngress({
        store,
        admit,
        review: reviewConfig(async (input) => {
          calls.push(input);
          return { status: "launched", runId: "repair-run-1" };
        }),
        logger: quietLogger,
      });
      await expect(ingress(reviewSubmitted("rev-1"))).resolves.toMatchObject({ status: "repair-launched", runId: "repair-run-1" });
      await expect(ingress(reviewSubmitted("rev-1"))).resolves.toMatchObject({ status: "duplicate" });
      expect(calls).toEqual([{ repository: "acme/widgets", pullRequest: 42, reviewId: 501 }]);
      // A repair launch is never broadcast to the Brain up-inbox — the run's result returns on its own.
      expect(events).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it("NEGATIVE: an over-budget/duplicate repair launches nothing and never broadcasts", async () => {
    const store = createGitHubIngressStore(":memory:");
    const { admit, events } = admitRecorder();
    try {
      const ingress = createGitHubIngress({
        store,
        admit,
        review: reviewConfig(async () => ({ status: "handled" })),
        logger: quietLogger,
      });
      await expect(ingress(reviewSubmitted("rev-handled"))).resolves.toMatchObject({ status: "repair-handled" });
      expect(events).toHaveLength(0);
    } finally {
      store.close();
    }
  });

  it("HARD SAFETY: an unregistered (external/fork) PR is never repaired — it reaches the Brain instead", async () => {
    const store = createGitHubIngressStore(":memory:");
    const { admit, events } = admitRecorder();
    try {
      const ingress = createGitHubIngress({
        store,
        admit,
        review: reviewConfig(async () => ({ status: "unregistered" })),
        logger: quietLogger,
      });
      await expect(ingress(reviewSubmitted("rev-unreg"))).resolves.toMatchObject({ status: "done", repository: "acme/widgets" });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ eventName: "pull_request_review", action: "submitted" });
    } finally {
      store.close();
    }
  });

  it("never invokes repair for a non-Reviewer-App sender or a non-REQUEST_CHANGES review", async () => {
    const store = createGitHubIngressStore(":memory:");
    const { admit } = admitRecorder();
    let repairCalls = 0;
    try {
      const ingress = createGitHubIngress({
        store,
        admit,
        review: reviewConfig(async () => {
          repairCalls += 1;
          return { status: "launched", runId: "should-not-run" };
        }),
        logger: quietLogger,
      });
      // A human maintainer's REQUEST_CHANGES — never trusted to launch repair.
      await expect(ingress(reviewSubmitted("rev-human", { senderLogin: "maintainer" }))).resolves.toMatchObject({ status: "done" });
      // The Reviewer App, but an APPROVE — not a rejection.
      await expect(ingress(reviewSubmitted("rev-approved", { state: "approved" }))).resolves.toMatchObject({ status: "done" });
      expect(repairCalls).toBe(0);
    } finally {
      store.close();
    }
  });
});
