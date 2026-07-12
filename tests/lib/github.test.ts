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

  it("honors a complete explicit pair as a cross-repo override", () => {
    process.env.GITHUB_REPO = "acme/widgets";
    expect(resolveRepo({ owner: "other", repo: "thing" })).toEqual({ owner: "other", repo: "thing" });
  });

  // F4/F5: default HARD to the configured repo. A *partial* input must never
  // bleed a model-supplied field into the default — a lone `owner` used to
  // produce `ios-design-system/<configured-repo>` and 404. It now defaults hard.
  it("defaults hard to GITHUB_REPO when only one field is given (no per-field mixing)", () => {
    process.env.GITHUB_REPO = "acme/widgets";
    expect(resolveRepo({ owner: "ios-design-system" })).toEqual({ owner: "acme", repo: "widgets" });
    expect(resolveRepo({ repo: "ios-design-system" })).toEqual({ owner: "acme", repo: "widgets" });
  });

  // F4: the model filled the fields with the env-var *name* → `GITHUB_REPO/GITHUB_REPO`.
  it("treats env-var-name echoes as absent and defaults to the configured repo", () => {
    process.env.GITHUB_REPO = "acme/widgets";
    expect(resolveRepo({ owner: "GITHUB_REPO", repo: "GITHUB_REPO" })).toEqual({ owner: "acme", repo: "widgets" });
    expect(resolveRepo({ owner: "github_repo", repo: "github_owner" })).toEqual({ owner: "acme", repo: "widgets" });
  });

  // The old `"" ?? default` leaked the empty string through as the owner/repo.
  it("treats empty / whitespace strings as absent and defaults to the configured repo", () => {
    process.env.GITHUB_REPO = "acme/widgets";
    expect(resolveRepo({ owner: "", repo: "" })).toEqual({ owner: "acme", repo: "widgets" });
    expect(resolveRepo({ owner: "   ", repo: "widgets" })).toEqual({ owner: "acme", repo: "widgets" });
  });

  it("trims a valid explicit pair", () => {
    delete process.env.GITHUB_REPO;
    expect(resolveRepo({ owner: "  acme ", repo: " widgets  " })).toEqual({ owner: "acme", repo: "widgets" });
  });

  it("throws when neither explicit input nor GITHUB_REPO is set", () => {
    delete process.env.GITHUB_REPO;
    expect(() => resolveRepo({})).toThrow(/GITHUB_REPO is not set/);
    // A partial input with no configured default is not a usable override.
    expect(() => resolveRepo({ owner: "ios-design-system" })).toThrow(/GITHUB_REPO is not set/);
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

  // F4 residual, made explicit and intentional: a COMPLETE foreign pair is a
  // legitimate cross-repo *read* override (instructions.md: "reads work on any
  // repo the token can see") — reads across repos are a real feature, so we do
  // not distrust an explicit pair here. The same pair is refused on any *write*
  // by the allow-list, so a hallucinated `ios-design-system/ios-design-system`
  // can at worst cause a read 404, never a write to the wrong repo. The proper
  // cure for the *guessing* is seeding the accessible-repo list into the agent's
  // context so it picks from real repos instead of inventing them (follow-up
  // issue), not second-guessing explicit input in resolveRepo.
  it("honors a complete foreign pair on reads but refuses it on writes", () => {
    process.env.GITHUB_REPO = "acme/widgets";
    delete process.env.GITHUB_ALLOWED_REPOS;
    const foreign = { owner: "ios-design-system", repo: "ios-design-system" };
    expect(resolveRepo(foreign)).toEqual(foreign);
    expect(() => resolveWritableRepo(foreign)).toThrow(/not in the write allow-list/);
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
