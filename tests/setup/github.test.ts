import { describe, expect, it, vi } from "vite-plus/test";

import {
  discoverGitHubCredential,
  discoverOriginRepository,
  normalizeGitHubRepository,
  verifyGitHubRepositoryAccess,
} from "@ambient-agent/cli/setup/github.ts";

describe("first-run GitHub discovery", () => {
  it.each([
    ["owner/repository", "owner/repository"],
    ["https://github.com/owner/repository.git", "owner/repository"],
    ["git@github.com:owner/repository.git", "owner/repository"],
    ["ssh://git@github.com/owner/repository", "owner/repository"],
  ])("normalizes %s", (input, expected) => {
    expect(normalizeGitHubRepository(input)).toBe(expected);
  });

  it("rejects ambiguous, non-GitHub, and multi-segment repositories", () => {
    for (const input of ["repository", "owner/repository/extra", "https://example.com/owner/repository"]) {
      expect(() => normalizeGitHubRepository(input)).toThrow("owner/repository");
    }
  });

  it("discovers an unambiguous GitHub origin without guessing", async () => {
    const run = vi.fn(async () => ({ stdout: "git@github.com:Ambient-Co/agent.git\n" }));
    await expect(discoverOriginRepository({ run })).resolves.toBe("Ambient-Co/agent");
    expect(run).toHaveBeenCalledWith("git", ["config", "--get", "remote.origin.url"]);

    await expect(
      discoverOriginRepository({
        run: async () => ({ stdout: "https://gitlab.com/other/project.git\n" }),
      }),
    ).resolves.toBeUndefined();
  });

  it("discovers only explicit environment or GitHub CLI credential sources", async () => {
    await expect(
      discoverGitHubCredential({
        environment: { GH_TOKEN: "environment-secret", GITHUB_TOKEN: "fallback-secret" },
        run: async () => ({ stdout: "cli-secret\n" }),
      }),
    ).resolves.toEqual({ token: "environment-secret", source: "environment GH_TOKEN" });

    await expect(
      discoverGitHubCredential({
        environment: {},
        run: async () => ({ stdout: "cli-secret\n" }),
      }),
    ).resolves.toEqual({ token: "cli-secret", source: "GitHub CLI" });

    await expect(
      discoverGitHubCredential({
        environment: {},
        run: async () => {
          throw new Error("gh unavailable");
        },
      }),
    ).resolves.toBeUndefined();
  });

  it("verifies both credential identity and normalized repository access without leaking secrets", async () => {
    const getAuthenticated = vi.fn(async () => ({ data: { login: "operator" } }));
    const getRepository = vi.fn(async () => ({ data: { full_name: "owner/repository" } }));
    await expect(
      verifyGitHubRepositoryAccess({
        token: "must-not-leak",
        repository: "https://github.com/owner/repository.git",
        client: { users: { getAuthenticated }, repos: { get: getRepository } },
      }),
    ).resolves.toBe("owner/repository");
    expect(getAuthenticated).toHaveBeenCalledWith({ request: { signal: undefined } });
    expect(getRepository).toHaveBeenCalledWith({
      owner: "owner",
      repo: "repository",
      request: { signal: undefined },
    });

    await expect(
      verifyGitHubRepositoryAccess({
        token: "must-not-leak",
        repository: "owner/missing",
        client: {
          users: {
            getAuthenticated: async () => {
              throw new Error("response contains must-not-leak");
            },
          },
          repos: { get: async () => undefined },
        },
      }),
    ).rejects.not.toThrow("must-not-leak");
  });

  it("passes cancellation through to both GitHub verification requests", async () => {
    const signal = new AbortController().signal;
    const getAuthenticated = vi.fn(async () => undefined);
    const getRepository = vi.fn(async () => undefined);

    await verifyGitHubRepositoryAccess({
      token: "must-not-leak",
      repository: "owner/repository",
      signal,
      client: { users: { getAuthenticated }, repos: { get: getRepository } },
    });

    expect(getAuthenticated).toHaveBeenCalledWith({ request: { signal } });
    expect(getRepository).toHaveBeenCalledWith({ owner: "owner", repo: "repository", request: { signal } });
  });
});
