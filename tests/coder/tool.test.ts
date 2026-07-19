import { describe, expect, it, vi } from "vite-plus/test";

import { createOpenPullRequestTool } from "../../packages/agents/src/capabilities/coder/tool.ts";
import type { CoderGitHub } from "../../packages/agents/src/capabilities/coder/github.ts";
import { parseHashListing, type OpenPrRecord } from "../../packages/agents/src/capabilities/coder/workspace.ts";

const REPO = { owner: "acme", repo: "widgets" };
const notFound = () => Object.assign(new Error("Not Found"), { status: 404 });

/** A `before`/`after` pair where the model changed one tracked file. */
const before = parseHashListing("h1  src/a.ts\nh2  src/keep.ts");
const after = parseHashListing("h1x src/a.ts\nh2  src/keep.ts");

/** A full Git-Data + pulls mock. `branchExists` / `openPr` drive the two idempotency legs. */
const makeGitHub = (opts: { branchExists: boolean; branchHead?: string; openPr?: { number: number; node_id: string; html_url: string; draft: boolean } }) => {
  const getRef = vi.fn(async () => {
    if (opts.branchExists) return { data: { object: { sha: opts.branchHead ?? "seed-head" } } };
    throw notFound();
  });
  const createRef = vi.fn(async () => ({ data: { ref: "refs/heads/agent/coder/issue-42" } }));
  const list = vi.fn(async () => ({ data: opts.openPr === undefined ? [] : [opts.openPr] }));
  const create = vi.fn(async () => ({ data: { number: 100, node_id: "PR_100", html_url: "https://x/pr/100" } }));
  const update = vi.fn(async () => ({ data: {} }));
  const graphql = vi.fn(async () => ({ }));
  const gh = {
    graphql,
    git: {
      getRef,
      createRef,
      getCommit: vi.fn(async () => ({ data: { tree: { sha: "base-tree" } } })),
      createBlob: vi.fn(async () => ({ data: { sha: "blob-sha" } })),
      createTree: vi.fn(async () => ({ data: { sha: "new-tree" } })),
      createCommit: vi.fn(async () => ({ data: { sha: "new-commit" } })),
      updateRef: vi.fn(async () => ({ data: {} })),
    },
    pulls: { list, create, update },
  } as unknown as CoderGitHub;
  return { gh, getRef, createRef, list, create, update, graphql };
};

const buildTool = (
  gh: CoderGitHub,
  record: { pr?: OpenPrRecord },
  options: { snapshotAfter?: () => Promise<ReturnType<typeof parseHashListing>>; verified?: ReturnType<typeof parseHashListing>; requiredDraft?: boolean; seedBranchHead?: string; seedBranchExisted?: boolean } = {},
) =>
  createOpenPullRequestTool({
    github: gh,
    repo: REPO,
    branch: "agent/coder/issue-42",
    base: "main",
    seedBranchHead: options.seedBranchHead ?? "seed-head",
    seedBranchExisted: options.seedBranchExisted ?? false,
    issue: 42,
    issueTitle: "Do the thing",
    before,
    verified: options.verified ?? after,
    requiredDraft: options.requiredDraft ?? false,
    snapshotAfter: options.snapshotAfter ?? (async () => after),
    readFile: async () => new TextEncoder().encode("changed bytes"),
    record,
  });

describe("open_pull_request handler — the model's one safe write (#172)", () => {
  it("draft-iff-not-green: passes the model's `draft` straight through to PR creation", async () => {
    for (const draft of [true, false]) {
      const record: { pr?: OpenPrRecord } = {};
      const { gh, create } = makeGitHub({ branchExists: false });
      const result = (await buildTool(gh, record, { requiredDraft: draft }).run({
        input: { title: "t", body: "rich body", draft },
      })) as { opened: boolean; draft?: boolean };

      expect(result.opened).toBe(true);
      expect(result.draft).toBe(draft);
      expect(create).toHaveBeenCalledWith(expect.objectContaining({ body: "rich body\n\nCloses #42", draft }));
      expect(record.pr?.draft).toBe(draft);
    }
  });

  it("idempotent relaunch: reuses the existing branch and open PR, opening no duplicate", async () => {
    const record: { pr?: OpenPrRecord } = {};
    const { gh, createRef, create } = makeGitHub({
      branchExists: true,
      openPr: { number: 9, node_id: "PR_9", html_url: "https://x/pr/9", draft: false },
    });

    const result = (await buildTool(gh, record).run({
      input: { title: "t", body: "b", draft: false },
    })) as { opened: boolean; number?: number };

    expect(result.opened).toBe(true);
    expect(result.number).toBe(9); // the already-open PR, not a fresh one
    expect(createRef).not.toHaveBeenCalled(); // branch reused
    expect(create).not.toHaveBeenCalled(); // PR reused
    expect(record.pr).toEqual({ url: "https://x/pr/9", number: 9, created: false, draft: false });
  });

  it("commits the diffed change set via the Git Data API before opening the PR", async () => {
    const record: { pr?: OpenPrRecord } = {};
    const { gh } = makeGitHub({ branchExists: false });
    await buildTool(gh, record).run({ input: { title: "t", body: "b", draft: false } });
    expect(gh.git.createCommit).toHaveBeenCalledOnce();
    expect(gh.git.createTree).toHaveBeenCalledWith(
      expect.objectContaining({ tree: [{ path: "src/a.ts", mode: "100644", type: "blob", sha: "blob-sha" }] }),
    );
  });

  it("appends the load-bearing `Closes #N` to the model's body (idempotent)", async () => {
    // Finding 1 (#172): the ingress backstop parses this to correlate the PR webhook to
    // the issue, and a merged PR auto-closes it. Mirrors engine ingress `linkedIssueNumbers`.
    const linkedIssueNumbers = (body: string): number[] => {
      const re = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)(?::\s*|\s+)(?:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)?#([1-9]\d*)\b/gi;
      return [...body.matchAll(re)].map((m) => Number(m[1]));
    };

    const record: { pr?: OpenPrRecord } = {};
    const { gh, create } = makeGitHub({ branchExists: false });
    await buildTool(gh, record).run({ input: { title: "t", body: "Rich model narrative.", draft: false } });
    const sent = (create.mock.calls as unknown as { body: string }[][])[0]![0]!;
    expect(sent.body).toContain("Closes #42");
    expect(linkedIssueNumbers(sent.body)).toContain(42);

    // Idempotent: a body that already closes #42 is left untouched (no double-append).
    const record2: { pr?: OpenPrRecord } = {};
    const gh2 = makeGitHub({ branchExists: false });
    await buildTool(gh2.gh, record2).run({ input: { title: "t", body: "Done. Fixes #42 fully.", draft: false } });
    const sent2 = (gh2.create.mock.calls as unknown as { body: string }[][])[0]![0]!;
    expect(sent2.body).toBe("Done. Fixes #42 fully.");
  });

  it("relaunch onto an open PR: updates its body and transitions draft to ready", async () => {
    const record: { pr?: OpenPrRecord } = {};
    const { gh, update, create, graphql } = makeGitHub({
      branchExists: true,
      openPr: { number: 9, node_id: "PR_9", html_url: "https://x/pr/9", draft: true },
    });

    const result = (await buildTool(gh, record).run({
      input: { title: "fresh title", body: "fresh body", draft: false },
    })) as { opened: boolean; draft?: boolean };

    expect(create).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ pull_number: 9, title: "fresh title", body: expect.stringContaining("fresh body") }),
    );
    expect(graphql).toHaveBeenCalledWith(expect.stringContaining("markPullRequestReadyForReview"), { pullRequestId: "PR_9" });
    expect(result.draft).toBe(false);
    expect(record.pr?.draft).toBe(false);
  });

  it("no committable change: opens nothing and leaves the record empty (→ conductor blocks)", async () => {
    const record: { pr?: OpenPrRecord } = {};
    const { gh, getRef, create } = makeGitHub({ branchExists: false });
    const result = (await buildTool(gh, record, { verified: before, snapshotAfter: async () => before }).run({
      input: { title: "t", body: "b", draft: false },
    })) as { opened: boolean; message?: string };

    expect(result.opened).toBe(false);
    expect(result.message).toContain("No file changes");
    expect(record.pr).toBeUndefined();
    expect(getRef).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("no new diff on a reused branch still refreshes the PR and its draft lifecycle", async () => {
    const record: { pr?: OpenPrRecord } = {};
    const { gh, update, graphql } = makeGitHub({
      branchExists: true,
      openPr: { number: 9, node_id: "PR_9", html_url: "https://x/pr/9", draft: true },
    });

    const result = await buildTool(gh, record, {
      verified: before,
      snapshotAfter: async () => before,
      seedBranchExisted: true,
    }).run({ input: { title: "verified", body: "current evidence", draft: false } });

    expect(result).toMatchObject({ opened: true, number: 9, draft: false });
    expect(gh.git.createCommit).not.toHaveBeenCalled();
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ pull_number: 9, title: "verified" }));
    expect(graphql).toHaveBeenCalledWith(expect.stringContaining("markPullRequestReadyForReview"), { pullRequestId: "PR_9" });
  });

  it("rejects publication when the workspace changed after the final Verifier observation", async () => {
    const record: { pr?: OpenPrRecord } = {};
    const { gh, getRef, create } = makeGitHub({ branchExists: false });
    await expect(buildTool(gh, record, { verified: before }).run({
      input: { title: "t", body: "b", draft: false },
    })).rejects.toThrow("Workspace changed after the final Verifier observation");
    expect(getRef).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects publication when the issue branch moved after the run was seeded", async () => {
    const record: { pr?: OpenPrRecord } = {};
    const { gh, create } = makeGitHub({ branchExists: true, branchHead: "moved-head" });
    await expect(buildTool(gh, record, { seedBranchHead: "seed-head" }).run({
      input: { title: "t", body: "b", draft: false },
    })).rejects.toThrow("Coder branch moved after this run was seeded");
    expect(create).not.toHaveBeenCalled();
  });

  it("rejects a publication draft state that contradicts the final verdict", async () => {
    const record: { pr?: OpenPrRecord } = {};
    const { gh, getRef } = makeGitHub({ branchExists: false });
    await expect(buildTool(gh, record, { requiredDraft: true }).run({
      input: { title: "t", body: "b", draft: false },
    })).rejects.toThrow("Final verification requires draft=true");
    expect(getRef).not.toHaveBeenCalled();
  });
});
