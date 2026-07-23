import { describe, expect, it, vi } from "vite-plus/test";

import {
  discoverOriginRepository,
  normalizeGitHubRepository,
  verifyGitHubAppRepositoryAccess,
} from "../../apps/cli/src/setup/github.ts";

const APP_TRIPLE = {
  appId: "123456",
  installationId: "7891011",
  privateKey: "-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----\n",
};

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

  it("verifies App identity and repository installation across orgs, without leaking the private key", async () => {
    const getAuthenticated = vi.fn(async () => ({ data: { slug: "ambient-planner" } }));
    // The pasted installationId belongs to a different org than the repo; verification succeeds
    // because getRepoInstallation is an App-JWT route (multi-org), not the fixed-installation repos.get.
    const getRepoInstallation = vi.fn(async () => ({ data: { id: 424242 } }));
    await expect(
      verifyGitHubAppRepositoryAccess({
        credential: APP_TRIPLE,
        repository: "https://github.com/other-org/repository.git",
        client: { apps: { getAuthenticated, getRepoInstallation } },
      }),
    ).resolves.toBe("other-org/repository");
    expect(getAuthenticated).toHaveBeenCalledWith({ request: { signal: undefined } });
    expect(getRepoInstallation).toHaveBeenCalledWith({
      owner: "other-org",
      repo: "repository",
      request: { signal: undefined },
    });

    await expect(
      verifyGitHubAppRepositoryAccess({
        credential: { ...APP_TRIPLE, privateKey: "-----BEGIN RSA PRIVATE KEY-----\nmust-not-leak\n-----END" },
        repository: "owner/missing",
        client: {
          apps: {
            getAuthenticated: async () => {
              throw new Error("response contains must-not-leak");
            },
            getRepoInstallation: async () => undefined,
          },
        },
      }),
    ).rejects.not.toThrow("must-not-leak");
  });

  it("passes cancellation through to both GitHub verification requests", async () => {
    const signal = new AbortController().signal;
    const getAuthenticated = vi.fn(async () => undefined);
    const getRepoInstallation = vi.fn(async () => undefined);

    await verifyGitHubAppRepositoryAccess({
      credential: APP_TRIPLE,
      repository: "owner/repository",
      signal,
      client: { apps: { getAuthenticated, getRepoInstallation } },
    });

    expect(getAuthenticated).toHaveBeenCalledWith({ request: { signal } });
    expect(getRepoInstallation).toHaveBeenCalledWith({ owner: "owner", repo: "repository", request: { signal } });
  });
});
