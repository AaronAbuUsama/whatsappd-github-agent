import type { ToolContext } from "eve/tools";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockPulls = {
  list: vi.fn(),
  get: vi.fn(),
  listFiles: vi.fn(),
  createReview: vi.fn(),
};

// Read tools like the diff fetcher use resolveRepo (reads aren't allow-listed),
// so no GITHUB_ALLOWED_REPOS setup is needed here.

vi.mock("../../agent/lib/github.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agent/lib/github.ts")>();
  return {
    ...actual,
    getOctokit: () => ({ rest: { pulls: mockPulls } }) as never,
  };
});

const dummyCtx = {} as ToolContext;

describe("github_list_pull_requests", () => {
  beforeEach(() => {
    mockPulls.list.mockReset();
    process.env.GITHUB_REPO = "acme/widgets";
  });

  it("lists open PRs by default", async () => {
    mockPulls.list.mockResolvedValue({
      data: [
        {
          number: 12,
          title: "Add feature",
          state: "open",
          draft: false,
          html_url: "u12",
          user: { login: "octocat" },
          head: { ref: "feature" },
          base: { ref: "main" },
          created_at: "2026-01-01T00:00:00Z",
        },
      ],
    });
    const { default: tool } = await import("../../agent/tools/github_list_pull_requests.ts");

    const result = await tool.execute({}, dummyCtx);

    expect(mockPulls.list).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "acme", repo: "widgets", state: "open", per_page: 20 }),
    );
    expect(result).toEqual([
      {
        number: 12,
        title: "Add feature",
        state: "open",
        draft: false,
        url: "u12",
        author: "octocat",
        headRef: "feature",
        baseRef: "main",
        createdAt: "2026-01-01T00:00:00Z",
      },
    ]);
  });
});

describe("github_get_pull_request", () => {
  beforeEach(() => {
    mockPulls.get.mockReset();
    mockPulls.listFiles.mockReset();
    process.env.GITHUB_REPO = "acme/widgets";
  });

  it("combines PR detail with its changed files", async () => {
    mockPulls.get.mockResolvedValue({
      data: {
        number: 12,
        title: "Add feature",
        state: "open",
        draft: false,
        merged: false,
        body: "does the thing",
        html_url: "u12",
        user: { login: "octocat" },
        head: { ref: "feature" },
        base: { ref: "main" },
        additions: 10,
        deletions: 2,
        changed_files: 2,
      },
    });
    mockPulls.listFiles.mockResolvedValue({
      data: [
        { filename: "a.ts", status: "modified", additions: 8, deletions: 1, changes: 9 },
        { filename: "b.ts", status: "added", additions: 2, deletions: 1, changes: 3 },
      ],
    });
    const { default: tool } = await import("../../agent/tools/github_get_pull_request.ts");

    const result = await tool.execute({ pull_number: 12 }, dummyCtx);

    expect(mockPulls.get).toHaveBeenCalledWith({ owner: "acme", repo: "widgets", pull_number: 12 });
    expect(mockPulls.listFiles).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "acme", repo: "widgets", pull_number: 12 }),
    );
    expect(result).toMatchObject({
      number: 12,
      title: "Add feature",
      additions: 10,
      deletions: 2,
      changedFiles: 2,
      files: [
        { filename: "a.ts", status: "modified", additions: 8, deletions: 1, changes: 9 },
        { filename: "b.ts", status: "added", additions: 2, deletions: 1, changes: 3 },
      ],
      filesTruncated: false,
    });
  });
});

describe("github_review_pull_request", () => {
  beforeEach(() => {
    mockPulls.createReview.mockReset();
    process.env.GITHUB_REPO = "acme/widgets";
  });

  it("submits a COMMENT review", async () => {
    mockPulls.createReview.mockResolvedValue({ data: { id: 1, state: "COMMENTED", html_url: "r1" } });
    const { default: tool } = await import("../../agent/tools/github_review_pull_request.ts");

    const result = await tool.execute(
      { pull_number: 12, event: "COMMENT", body: "looks fine" },
      dummyCtx,
    );

    expect(mockPulls.createReview).toHaveBeenCalledWith(
      expect.objectContaining({ pull_number: 12, event: "COMMENT", body: "looks fine" }),
    );
    expect(result).toEqual({ id: 1, state: "COMMENTED", url: "r1" });
  });

  it("rejects REQUEST_CHANGES without a body before ever calling the API", async () => {
    const { default: tool } = await import("../../agent/tools/github_review_pull_request.ts");

    await expect(tool.execute({ pull_number: 12, event: "REQUEST_CHANGES" }, dummyCtx)).rejects.toThrow(
      /body.*required/i,
    );
    expect(mockPulls.createReview).not.toHaveBeenCalled();
  });

  it("passes inline comments through", async () => {
    mockPulls.createReview.mockResolvedValue({ data: { id: 2, state: "APPROVED", html_url: "r2" } });
    const { default: tool } = await import("../../agent/tools/github_review_pull_request.ts");

    await tool.execute(
      {
        pull_number: 12,
        event: "APPROVE",
        body: "ship it",
        comments: [{ path: "a.ts", line: 3, body: "nice" }],
      },
      dummyCtx,
    );

    expect(mockPulls.createReview).toHaveBeenCalledWith(
      expect.objectContaining({
        comments: [{ path: "a.ts", line: 3, body: "nice" }],
      }),
    );
  });
});

describe("github_get_pull_request_diff", () => {
  beforeEach(() => {
    mockPulls.get.mockReset();
    mockPulls.listFiles.mockReset();
    process.env.GITHUB_REPO = "acme/widgets";
  });

  it("returns the raw diff plus a per-file summary", async () => {
    mockPulls.listFiles.mockResolvedValue({
      data: [{ filename: "a.ts", status: "modified", additions: 3, deletions: 1, changes: 4 }],
    });
    mockPulls.get.mockResolvedValue({ data: "diff --git a/a.ts b/a.ts\n+added line\n" });
    const { default: tool } = await import("../../agent/tools/github_get_pull_request_diff.ts");

    const result = await tool.execute({ pull_number: 12 }, dummyCtx);

    expect(mockPulls.get).toHaveBeenCalledWith(
      expect.objectContaining({ pull_number: 12, mediaType: { format: "diff" } }),
    );
    expect(result).toMatchObject({
      pull_number: 12,
      changedFiles: 1,
      files: [{ filename: "a.ts", status: "modified", additions: 3, deletions: 1 }],
      truncated: false,
      diff: "diff --git a/a.ts b/a.ts\n+added line\n",
    });
  });

  it("truncates a diff that exceeds max_chars and flags it", async () => {
    mockPulls.listFiles.mockResolvedValue({ data: [] });
    mockPulls.get.mockResolvedValue({ data: "X".repeat(100) });
    const { default: tool } = await import("../../agent/tools/github_get_pull_request_diff.ts");

    const result = await tool.execute({ pull_number: 12, max_chars: 10 }, dummyCtx);

    expect(result.truncated).toBe(true);
    expect(result.diff.startsWith("X".repeat(10))).toBe(true);
    expect(result.diff).toContain("truncated 90 chars");
  });
});
