import { describe, expect, it, vi } from "vite-plus/test";

import type { CoderGitHub } from "../../packages/agents/src/capabilities/coder/github.ts";
import { createCodingJobRegistry } from "../../packages/agents/src/capabilities/coder/registry.ts";
import { createRepairLauncher } from "../../packages/agents/src/capabilities/coder/continuation.ts";

const job = {
  repository: "acme/widgets",
  prNumber: 42,
  issue: 210,
  branch: "agent/coder/issue-210",
  base: "main",
  maxVerificationRounds: 3,
  maxReviewCycles: 2,
};

const parseRepository = (repository: string) => {
  const [owner, repo] = repository.split("/");
  return { owner: owner!, repo: repo! };
};

/** A github double that records mutations, seeded with the live PR draft state. */
const fakeGitHub = (draft: boolean) => {
  const comments: { id: number; body: string }[] = [];
  const graphqlCalls: string[] = [];
  let nextId = 1;
  const github = {
    graphql: vi.fn(async (query: string) => {
      graphqlCalls.push(query);
      return {};
    }),
    pulls: {
      get: vi.fn(async () => ({ data: { number: 42, node_id: "PR_node", draft, state: "open", html_url: "", title: "", head: { sha: "h", ref: job.branch, repo: { full_name: "acme/widgets" } }, base: { ref: "main" } } })),
    },
    issues: {
      listComments: vi.fn(async () => ({ data: comments })),
      createComment: vi.fn(async ({ body }: { body: string }) => {
        const created = { id: nextId++, body };
        comments.push(created);
        return { data: { id: created.id, html_url: "" } };
      }),
      updateComment: vi.fn(async ({ comment_id, body }: { comment_id: number; body: string }) => {
        const target = comments.find((comment) => comment.id === comment_id)!;
        target.body = body;
        return { data: {} };
      }),
    },
  } as unknown as CoderGitHub;
  return { github, comments, graphqlCalls };
};

describe("repair launcher (#211)", () => {
  it("HARD SAFETY: an unregistered (external/fork) PR is never mutated and launches nothing", async () => {
    const registry = createCodingJobRegistry(":memory:");
    const invokeCoder = vi.fn(async () => ({ runId: "r" }));
    const github = vi.fn(async () => fakeGitHub(false).github);
    try {
      const repair = createRepairLauncher({ registry, github, invokeCoder, parseRepository });
      // No registry row for PR 99 → a contributor's/fork PR the Coder never opened.
      expect(await repair({ repository: "acme/widgets", pullRequest: 99, reviewId: 1 })).toEqual({ status: "unregistered" });
      expect(invokeCoder).not.toHaveBeenCalled();
      expect(github).not.toHaveBeenCalled();
    } finally {
      registry.close();
    }
  });

  it("launches a review_continuation run on the exact live branch for a registered PR", async () => {
    const registry = createCodingJobRegistry(":memory:");
    registry.upsert(job);
    const invokeCoder = vi.fn(async () => ({ runId: "run-1" }));
    const github = vi.fn(async () => fakeGitHub(false).github);
    try {
      const repair = createRepairLauncher({ registry, github, invokeCoder, parseRepository });
      expect(await repair({ repository: "acme/widgets", pullRequest: 42, reviewId: 1 })).toEqual({ status: "launched", runId: "run-1" });
      expect(invokeCoder).toHaveBeenCalledWith({
        mode: "review_continuation",
        repository: "acme/widgets",
        pullRequest: 42,
        maxVerificationRounds: 3,
        maxReviewCycles: 2,
      });
      // No PR mutation on a launch — GitHub is the durable boundary; the run does the writing.
      expect(github).not.toHaveBeenCalled();
    } finally {
      registry.close();
    }
  });

  it("NEGATIVE: exceeding the budget launches no run; it demotes to draft with ONE idempotent comment", async () => {
    const registry = createCodingJobRegistry(":memory:");
    registry.upsert({ ...job, maxReviewCycles: 0 });
    const invokeCoder = vi.fn(async () => ({ runId: "r" }));
    const seam = fakeGitHub(false);
    const github = vi.fn(async () => seam.github);
    try {
      const repair = createRepairLauncher({ registry, github, invokeCoder, parseRepository });
      // First over-budget review: no run, PR converted to draft, one lifecycle comment created.
      expect(await repair({ repository: "acme/widgets", pullRequest: 42, reviewId: 1 })).toEqual({ status: "handled" });
      expect(invokeCoder).not.toHaveBeenCalled();
      expect(seam.graphqlCalls.some((q) => q.includes("convertPullRequestToDraft"))).toBe(true);
      expect(seam.comments).toHaveLength(1);
      const firstBody = seam.comments[0]!.body;

      // A second, distinct over-budget review updates the SAME comment — never a duplicate.
      expect(await repair({ repository: "acme/widgets", pullRequest: 42, reviewId: 2 })).toEqual({ status: "handled" });
      expect(seam.comments).toHaveLength(1);
      expect(seam.comments[0]!.body).toBe(firstBody);
      expect(invokeCoder).not.toHaveBeenCalled();
    } finally {
      registry.close();
    }
  });

  it("NEGATIVE: a repeated identical review event neither launches nor re-comments", async () => {
    const registry = createCodingJobRegistry(":memory:");
    registry.upsert(job);
    const invokeCoder = vi.fn(async () => ({ runId: "run-1" }));
    const seam = fakeGitHub(false);
    const github = vi.fn(async () => seam.github);
    try {
      const repair = createRepairLauncher({ registry, github, invokeCoder, parseRepository });
      await repair({ repository: "acme/widgets", pullRequest: 42, reviewId: 7 });
      expect(await repair({ repository: "acme/widgets", pullRequest: 42, reviewId: 7 })).toEqual({ status: "handled" });
      expect(invokeCoder).toHaveBeenCalledTimes(1);
      expect(seam.comments).toHaveLength(0);
    } finally {
      registry.close();
    }
  });
});
