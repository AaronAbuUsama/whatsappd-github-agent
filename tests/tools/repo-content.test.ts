import type { ToolContext } from "eve/tools";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockRepos = { getContent: vi.fn() };
const mockSearch = { code: vi.fn() };

vi.mock("../../agent/lib/github.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agent/lib/github.ts")>();
  return {
    ...actual,
    getOctokit: () => ({ rest: { repos: mockRepos, search: mockSearch } }) as never,
  };
});

const dummyCtx = {} as ToolContext;

describe("github_get_file_contents", () => {
  beforeEach(() => {
    mockRepos.getContent.mockReset();
    process.env.GITHUB_REPO = "acme/widgets";
  });

  it("decodes base64 file content", async () => {
    const content = Buffer.from("console.log('hi');").toString("base64");
    mockRepos.getContent.mockResolvedValue({
      data: { type: "file", path: "src/a.ts", sha: "abc123", size: 19, content, encoding: "base64" },
    });
    const { default: tool } = await import("../../agent/tools/github_get_file_contents.ts");

    const result = await tool.execute({ path: "src/a.ts" }, dummyCtx);

    expect(mockRepos.getContent).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "acme", repo: "widgets", path: "src/a.ts" }),
    );
    expect(result).toEqual({
      type: "file",
      path: "src/a.ts",
      sha: "abc123",
      size: 19,
      content: "console.log('hi');",
      truncated: false,
    });
  });

  it("truncates content past the size cap", async () => {
    const big = "x".repeat(25_000);
    mockRepos.getContent.mockResolvedValue({
      data: {
        type: "file",
        path: "big.txt",
        sha: "sha",
        size: big.length,
        content: Buffer.from(big).toString("base64"),
        encoding: "base64",
      },
    });
    const { default: tool } = await import("../../agent/tools/github_get_file_contents.ts");

    const result = await tool.execute({ path: "big.txt" }, dummyCtx);

    if (result.type !== "file") throw new Error("expected a file result");
    expect(result.truncated).toBe(true);
    expect(result.content.length).toBe(20_000);
  });

  it("lists directory entries when given a directory path", async () => {
    mockRepos.getContent.mockResolvedValue({
      data: [
        { name: "a.ts", path: "src/a.ts", type: "file", size: 10 },
        { name: "sub", path: "src/sub", type: "dir", size: 0 },
      ],
    });
    const { default: tool } = await import("../../agent/tools/github_get_file_contents.ts");

    const result = await tool.execute({ path: "src" }, dummyCtx);

    expect(result).toEqual({
      type: "directory",
      path: "src",
      entries: [
        { name: "a.ts", path: "src/a.ts", type: "file", size: 10 },
        { name: "sub", path: "src/sub", type: "dir", size: 0 },
      ],
    });
  });

  it("rejects non-file, non-directory content (symlink/submodule)", async () => {
    mockRepos.getContent.mockResolvedValue({ data: { type: "symlink", path: "link" } });
    const { default: tool } = await import("../../agent/tools/github_get_file_contents.ts");

    await expect(tool.execute({ path: "link" }, dummyCtx)).rejects.toThrow(/not a regular file/);
  });
});

describe("github_search_code", () => {
  beforeEach(() => {
    mockSearch.code.mockReset();
    process.env.GITHUB_REPO = "acme/widgets";
  });

  it("scopes the query to GITHUB_REPO by default", async () => {
    mockSearch.code.mockResolvedValue({ data: { total_count: 0, items: [] } });
    const { default: tool } = await import("../../agent/tools/github_search_code.ts");

    await tool.execute({ q: "useEffect" }, dummyCtx);

    expect(mockSearch.code).toHaveBeenCalledWith(
      expect.objectContaining({ q: "useEffect repo:acme/widgets" }),
    );
  });

  it("scopes to an explicit owner/repo instead", async () => {
    mockSearch.code.mockResolvedValue({ data: { total_count: 0, items: [] } });
    const { default: tool } = await import("../../agent/tools/github_search_code.ts");

    await tool.execute({ q: "TODO", owner: "other", repo: "thing" }, dummyCtx);

    expect(mockSearch.code).toHaveBeenCalledWith(
      expect.objectContaining({ q: "TODO repo:other/thing" }),
    );
  });

  it("leaves a query with its own repo: qualifier untouched", async () => {
    mockSearch.code.mockResolvedValue({ data: { total_count: 0, items: [] } });
    const { default: tool } = await import("../../agent/tools/github_search_code.ts");

    await tool.execute({ q: "TODO repo:someone-else/other-repo" }, dummyCtx);

    expect(mockSearch.code).toHaveBeenCalledWith(
      expect.objectContaining({ q: "TODO repo:someone-else/other-repo" }),
    );
  });

  // F4: the model echoing the env-var *name* into a complete owner/repo pair
  // must not build a bogus `repo:GITHUB_REPO/GITHUB_REPO` qualifier. Routing
  // through resolveRepo cleans it and defaults hard to GITHUB_REPO.
  it("defaults hard when owner/repo are placeholder echoes (F4)", async () => {
    mockSearch.code.mockResolvedValue({ data: { total_count: 0, items: [] } });
    const { default: tool } = await import("../../agent/tools/github_search_code.ts");

    await tool.execute({ q: "useEffect", owner: "GITHUB_REPO", repo: "GITHUB_REPO" }, dummyCtx);

    expect(mockSearch.code).toHaveBeenCalledWith(
      expect.objectContaining({ q: "useEffect repo:acme/widgets" }),
    );
  });

  it("maps result items to a compact shape", async () => {
    mockSearch.code.mockResolvedValue({
      data: {
        total_count: 1,
        items: [{ path: "src/a.ts", repository: { full_name: "acme/widgets" }, html_url: "u1", sha: "sha1" }],
      },
    });
    const { default: tool } = await import("../../agent/tools/github_search_code.ts");

    const result = await tool.execute({ q: "useEffect" }, dummyCtx);

    expect(result).toEqual({
      totalCount: 1,
      items: [{ path: "src/a.ts", repository: "acme/widgets", url: "u1", sha: "sha1" }],
    });
  });
});
