import { describe, expect, it, vi } from "vite-plus/test";

import {
  coderBranch,
  commitChanges,
  ensureBranch,
  getBranchHead,
  upsertPullRequest,
  type CoderGitHub,
} from "../../packages/agents/src/capabilities/coder/github.ts";

const REPO = { owner: "acme", repo: "widgets" };

const notFound = () => Object.assign(new Error("Not Found"), { status: 404 });

describe("getBranchHead — the relaunch seeding choice (seed FROM the existing head)", () => {
  it("returns the existing branch head sha, so a relaunch seeds the tarball from it", async () => {
    const getRef = vi.fn(async () => ({ data: { object: { sha: "prev-run-head" } } }));
    const gh = { git: { getRef } } as unknown as CoderGitHub;

    const head = await getBranchHead(gh, REPO, coderBranch(158));

    expect(head).toBe("prev-run-head"); // seedSha = existingHead → tested tree == committed tree
    expect(getRef).toHaveBeenCalledWith({ owner: "acme", repo: "widgets", ref: "heads/agent/coder/issue-158" });
  });

  it("returns undefined for a fresh issue, so seeding falls back to the default branch", async () => {
    const getRef = vi.fn(async () => {
      throw notFound();
    });
    const gh = { git: { getRef } } as unknown as CoderGitHub;
    expect(await getBranchHead(gh, REPO, coderBranch(158))).toBeUndefined();
  });

  it("rethrows a non-404 (never treats a real API failure as a fresh issue)", async () => {
    const getRef = vi.fn(async () => {
      throw Object.assign(new Error("boom"), { status: 500 });
    });
    const gh = { git: { getRef } } as unknown as CoderGitHub;
    await expect(getBranchHead(gh, REPO, coderBranch(158))).rejects.toThrow("boom");
  });
});

describe("ensureBranch — idempotent per-issue natural key (check-then-act)", () => {
  it("reuses an existing branch: a relaunch converges, opening no duplicate", async () => {
    const getRef = vi.fn(async () => ({ data: { object: { sha: "existing-sha" } } }));
    const createRef = vi.fn();
    const gh = { git: { getRef, createRef } } as unknown as CoderGitHub;

    const head = await ensureBranch(gh, REPO, coderBranch(42), "base-sha");

    expect(head).toEqual({ sha: "existing-sha", created: false });
    expect(getRef).toHaveBeenCalledWith({ owner: "acme", repo: "widgets", ref: "heads/agent/coder/issue-42" });
    expect(createRef).not.toHaveBeenCalled();
  });

  it("creates the branch off the base sha when it does not exist", async () => {
    const getRef = vi.fn(async () => {
      throw notFound();
    });
    const createRef = vi.fn(async () => ({ data: { ref: "refs/heads/agent/coder/issue-42" } }));
    const gh = { git: { getRef, createRef } } as unknown as CoderGitHub;

    const head = await ensureBranch(gh, REPO, coderBranch(42), "base-sha");

    expect(head).toEqual({ sha: "base-sha", created: true });
    expect(createRef).toHaveBeenCalledWith({
      owner: "acme",
      repo: "widgets",
      ref: "refs/heads/agent/coder/issue-42",
      sha: "base-sha",
    });
  });

  it("rethrows a non-404 (never masks a real API failure as 'missing')", async () => {
    const getRef = vi.fn(async () => {
      throw Object.assign(new Error("boom"), { status: 500 });
    });
    const gh = { git: { getRef, createRef: vi.fn() } } as unknown as CoderGitHub;
    await expect(ensureBranch(gh, REPO, coderBranch(1), "s")).rejects.toThrow("boom");
  });
});

describe("upsertPullRequest — one open PR per head→base", () => {
  it("reuses the open PR and patches its title/body with the model's fresh values (#172 update-if-open)", async () => {
    const list = vi.fn(async () => ({ data: [{ number: 9, node_id: "PR_9", html_url: "https://x/pr/9", draft: true }] }));
    const create = vi.fn();
    const update = vi.fn(async () => ({ data: {} }));
    const graphql = vi.fn(async () => ({}));
    const gh = { graphql, pulls: { list, create, update } } as unknown as CoderGitHub;

    const pr = await upsertPullRequest(gh, REPO, {
      branch: "agent/coder/issue-42",
      base: "main",
      title: "fresh title",
      body: "fresh body",
      draft: false,
    });

    expect(pr).toEqual({ number: 9, url: "https://x/pr/9", created: false, draft: false });
    expect(list).toHaveBeenCalledWith({
      owner: "acme",
      repo: "widgets",
      head: "acme:agent/coder/issue-42",
      base: "main",
      state: "open",
    });
    expect(update).toHaveBeenCalledWith({
      owner: "acme",
      repo: "widgets",
      pull_number: 9,
      title: "fresh title",
      body: "fresh body",
    });
    expect(graphql).toHaveBeenCalledWith(expect.stringContaining("markPullRequestReadyForReview"), { pullRequestId: "PR_9" });
    expect(create).not.toHaveBeenCalled();
  });

  it("transitions a reused ready PR back to draft after exhausted verification", async () => {
    const graphql = vi.fn(async () => ({}));
    const gh = {
      graphql,
      pulls: {
        list: vi.fn(async () => ({ data: [{ number: 9, node_id: "PR_9", html_url: "https://x/pr/9", draft: false }] })),
        create: vi.fn(),
        update: vi.fn(async () => ({ data: {} })),
      },
    } as unknown as CoderGitHub;

    const pr = await upsertPullRequest(gh, REPO, {
      branch: "agent/coder/issue-42",
      base: "main",
      title: "t",
      body: "b",
      draft: true,
    });

    expect(pr.draft).toBe(true);
    expect(graphql).toHaveBeenCalledWith(expect.stringContaining("convertPullRequestToDraft"), { pullRequestId: "PR_9" });
  });

  it("opens a draft PR when none is open and the suite is red", async () => {
    const list = vi.fn(async () => ({ data: [] }));
    const create = vi.fn(async () => ({ data: { number: 10, html_url: "https://x/pr/10" } }));
    const gh = { graphql: vi.fn(), pulls: { list, create } } as unknown as CoderGitHub;

    const pr = await upsertPullRequest(gh, REPO, {
      branch: "agent/coder/issue-42",
      base: "main",
      title: "t",
      body: "b",
      draft: true,
    });

    expect(pr).toEqual({ number: 10, url: "https://x/pr/10", created: true, draft: true });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ head: "agent/coder/issue-42", draft: true }));
  });
});

describe("commitChanges — Git Data API out (blobs → tree → commit → ref)", () => {
  it("commits changed files and deletions onto the branch head", async () => {
    const gh = {
      git: {
        getCommit: vi.fn(async () => ({ data: { tree: { sha: "base-tree" } } })),
        createBlob: vi.fn(async () => ({ data: { sha: "blob-sha" } })),
        createTree: vi.fn(async () => ({ data: { sha: "new-tree" } })),
        createCommit: vi.fn(async () => ({ data: { sha: "new-commit" } })),
        updateRef: vi.fn(async () => ({ data: {} })),
      },
    } as unknown as CoderGitHub;

    const sha = await commitChanges(gh, REPO, {
      branch: "agent/coder/issue-42",
      headSha: "head-sha",
      message: "Coder: issue #42",
      files: [{ path: "src/a.ts" }],
      deletions: ["src/gone.ts"],
      read: async () => new TextEncoder().encode("hello"),
    });

    expect(sha).toBe("new-commit");
    expect(gh.git.createTree).toHaveBeenCalledWith({
      owner: "acme",
      repo: "widgets",
      base_tree: "base-tree",
      tree: [
        { path: "src/a.ts", mode: "100644", type: "blob", sha: "blob-sha" },
        { path: "src/gone.ts", mode: "100644", type: "blob", sha: null },
      ],
    });
    expect(gh.git.createCommit).toHaveBeenCalledWith(
      expect.objectContaining({ tree: "new-tree", parents: ["head-sha"], message: "Coder: issue #42" }),
    );
    expect(gh.git.updateRef).toHaveBeenCalledWith({
      owner: "acme",
      repo: "widgets",
      ref: "heads/agent/coder/issue-42",
      sha: "new-commit",
    });
  });

  it("commits nothing when the change set is empty (the no-op guard)", async () => {
    const createCommit = vi.fn();
    const gh = { git: { getCommit: vi.fn(), createCommit } } as unknown as CoderGitHub;
    const sha = await commitChanges(gh, REPO, {
      branch: "b",
      headSha: "h",
      message: "m",
      files: [],
      deletions: [],
      read: async () => new Uint8Array(),
    });
    expect(sha).toBeUndefined();
    expect(createCommit).not.toHaveBeenCalled();
  });
});
