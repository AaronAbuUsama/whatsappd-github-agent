import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  allowedWriteRepos,
  getOctokit,
  resetOctokitForTests,
  resolveRepo,
  resolveWritableRepo,
} from "../../agent/lib/github.ts";

describe("resolveRepo", () => {
  const originalRepo = process.env.GITHUB_REPO;

  afterEach(() => {
    if (originalRepo === undefined) delete process.env.GITHUB_REPO;
    else process.env.GITHUB_REPO = originalRepo;
  });

  it("uses explicit owner/repo when both are given", () => {
    process.env.GITHUB_REPO = "fallback-owner/fallback-repo";
    expect(resolveRepo({ owner: "acme", repo: "widgets" })).toEqual({
      owner: "acme",
      repo: "widgets",
    });
  });

  it("falls back to GITHUB_REPO when owner/repo are omitted", () => {
    process.env.GITHUB_REPO = "acme/widgets";
    expect(resolveRepo({})).toEqual({ owner: "acme", repo: "widgets" });
  });

  it("mixes explicit fields with the fallback per-field", () => {
    process.env.GITHUB_REPO = "acme/widgets";
    expect(resolveRepo({ owner: "other" })).toEqual({ owner: "other", repo: "widgets" });
  });

  it("throws when neither explicit input nor GITHUB_REPO is set", () => {
    delete process.env.GITHUB_REPO;
    expect(() => resolveRepo({})).toThrow(/GITHUB_REPO is not set/);
  });

  it("throws when GITHUB_REPO is malformed", () => {
    process.env.GITHUB_REPO = "not-a-valid-repo-spec";
    expect(() => resolveRepo({})).toThrow(/must be "owner\/repo"/);
  });
});

describe("resolveWritableRepo (write allow-list)", () => {
  const originalRepo = process.env.GITHUB_REPO;
  const originalAllowed = process.env.GITHUB_ALLOWED_REPOS;

  afterEach(() => {
    if (originalRepo === undefined) delete process.env.GITHUB_REPO;
    else process.env.GITHUB_REPO = originalRepo;
    if (originalAllowed === undefined) delete process.env.GITHUB_ALLOWED_REPOS;
    else process.env.GITHUB_ALLOWED_REPOS = originalAllowed;
  });

  it("allows the configured GITHUB_REPO by default", () => {
    process.env.GITHUB_REPO = "acme/widgets";
    delete process.env.GITHUB_ALLOWED_REPOS;
    expect(resolveWritableRepo({})).toEqual({ owner: "acme", repo: "widgets" });
  });

  it("matches the allow-list case-insensitively but refuses anything outside it", () => {
    process.env.GITHUB_REPO = "acme/widgets";
    delete process.env.GITHUB_ALLOWED_REPOS;
    expect(resolveWritableRepo({ owner: "Acme", repo: "Widgets" })).toEqual({ owner: "Acme", repo: "Widgets" });
    expect(() => resolveWritableRepo({ owner: "evil", repo: "repo" })).toThrow(/not in the write allow-list/);
  });

  it("honors a multi-repo GITHUB_ALLOWED_REPOS list", () => {
    process.env.GITHUB_REPO = "acme/widgets";
    process.env.GITHUB_ALLOWED_REPOS = "acme/widgets, acme/other";
    expect(resolveWritableRepo({ owner: "acme", repo: "other" })).toEqual({ owner: "acme", repo: "other" });
    expect(allowedWriteRepos().has("acme/other")).toBe(true);
  });

  it("throws when no writable repos are configured at all", () => {
    delete process.env.GITHUB_REPO;
    delete process.env.GITHUB_ALLOWED_REPOS;
    expect(() => resolveWritableRepo({ owner: "a", repo: "b" })).toThrow(/No writable repos configured/);
  });
});

describe("getOctokit", () => {
  const originalToken = process.env.GITHUB_TOKEN;

  beforeEach(() => resetOctokitForTests());
  afterEach(() => {
    resetOctokitForTests();
    if (originalToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = originalToken;
  });

  it("throws a clear error when GITHUB_TOKEN is unset", () => {
    delete process.env.GITHUB_TOKEN;
    expect(() => getOctokit()).toThrow(/GITHUB_TOKEN is not set/);
  });

  it("constructs and memoizes a client once GITHUB_TOKEN is set", () => {
    process.env.GITHUB_TOKEN = "ghp_test_token";
    const first = getOctokit();
    const second = getOctokit();
    expect(first).toBe(second);
  });
});
