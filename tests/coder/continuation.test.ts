import { describe, expect, it, vi } from "vite-plus/test";

import type { CoderGitHub } from "../../packages/agents/src/capabilities/coder/github.ts";
import { demoteOverBudget, fetchReviewContinuation } from "../../packages/agents/src/capabilities/coder/continuation.ts";

const repo = { owner: "acme", repo: "widgets" };

describe("fetchReviewContinuation (#211)", () => {
  it("carries the live head, the actual base ref, formal reviews, and paginated unresolved threads", async () => {
    const pages = [
      {
        repository: {
          pullRequest: {
            reviews: { nodes: [{ state: "CHANGES_REQUESTED", body: "Fix the guard", author: { login: "reviewer[bot]" } }] },
            reviewThreads: {
              pageInfo: { hasNextPage: true, endCursor: "c1" },
              nodes: [
                { isResolved: false, path: "a.ts", line: 10, comments: { nodes: [{ body: "here", author: { login: "reviewer[bot]" } }] } },
                { isResolved: true, path: "b.ts", line: 3, comments: { nodes: [{ body: "resolved", author: { login: "reviewer[bot]" } }] } },
              ],
            },
          },
        },
      },
      {
        repository: {
          pullRequest: {
            reviews: { nodes: [] },
            reviewThreads: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [{ isResolved: false, path: "c.ts", line: 7, comments: { nodes: [{ body: "and here", author: null }] } }],
            },
          },
        },
      },
    ];
    const graphql = vi.fn(async () => pages.shift());
    const github = {
      graphql,
      pulls: {
        get: vi.fn(async () => ({
          data: {
            number: 42,
            node_id: "PR_node",
            html_url: "https://github.com/acme/widgets/pull/42",
            title: "t",
            draft: false,
            state: "open",
            head: { sha: "h", ref: "agent/coder/issue-210", repo: { full_name: "acme/widgets" } },
            base: { ref: "release-2" },
          },
        })),
      },
    } as unknown as CoderGitHub;

    const state = await fetchReviewContinuation(github, repo, 42);
    // finding 3: the live PR base is carried, not re-derived from the default branch.
    expect(state.baseRef).toBe("release-2");
    expect(state.headRef).toBe("agent/coder/issue-210");
    expect(state.headRepoFull).toBe("acme/widgets");
    expect(state.reviews).toEqual([{ state: "CHANGES_REQUESTED", author: "reviewer[bot]", body: "Fix the guard" }]);
    // Only UNRESOLVED threads, across BOTH pages; the resolved one is dropped.
    expect(state.unresolvedThreads.map((t) => t.path)).toEqual(["a.ts", "c.ts"]);
    expect(graphql).toHaveBeenCalledTimes(2);
  });
});

type Comment = { id: number; body: string; user?: { login?: string; type?: string } | null };

/** A github double that records mutations, seeded with the live PR draft state and any pre-existing comments. */
const fakeGitHub = (draft: boolean, seed: Comment[] = []) => {
  const comments: Comment[] = [...seed];
  const graphqlCalls: string[] = [];
  let nextId = 100;
  const github = {
    graphql: vi.fn(async (query: string) => {
      graphqlCalls.push(query);
      return {};
    }),
    pulls: {
      get: vi.fn(async () => ({ data: { number: 42, node_id: "PR_node", draft, state: "open", html_url: "https://github.com/acme/widgets/pull/42", title: "", head: { sha: "h", ref: "agent/coder/issue-210", repo: { full_name: "acme/widgets" } }, base: { ref: "main" } } })),
    },
    issues: {
      listComments: vi.fn(async () => ({ data: comments })),
      createComment: vi.fn(async ({ body }: { body: string }) => {
        const created: Comment = { id: nextId++, body, user: { login: "ambient-coder[bot]", type: "Bot" } };
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

const BOT = "ambient-coder[bot]";

describe("demoteOverBudget (#211)", () => {
  it("converts a ready PR to draft and upserts exactly ONE idempotent lifecycle comment", async () => {
    const seam = fakeGitHub(false);
    const first = await demoteOverBudget(seam.github, repo, 42, 2, BOT);
    expect(first.prUrl).toBe("https://github.com/acme/widgets/pull/42");
    expect(seam.graphqlCalls.some((q) => q.includes("convertPullRequestToDraft"))).toBe(true);
    expect(seam.comments).toHaveLength(1);
    const body = seam.comments[0]!.body;

    // A retry (crash recovery, or a later over-budget review) updates the SAME comment, never duplicates.
    await demoteOverBudget(seam.github, repo, 42, 2, BOT);
    expect(seam.comments).toHaveLength(1);
    expect(seam.comments[0]!.body).toBe(body);
  });

  it("round-4: never adopts a human comment that quotes the marker — it posts a fresh bot comment", async () => {
    // A human comment whose body contains the exact hidden marker. It must NOT be edited.
    const human: Comment = { id: 1, body: "see <!-- ambient-agent-repair-budget:42 --> above", user: { login: "maintainer", type: "User" } };
    const seam = fakeGitHub(true, [human]);
    await demoteOverBudget(seam.github, repo, 42, 2, BOT);
    // The human comment is untouched; a new bot-authored comment was created.
    expect(seam.comments.find((c) => c.id === 1)!.body).toBe("see <!-- ambient-agent-repair-budget:42 --> above");
    expect(seam.comments).toHaveLength(2);
    expect(seam.comments[1]!.user?.login).toBe(BOT);
  });
});
