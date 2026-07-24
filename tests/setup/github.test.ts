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

  it("verifies App identity, repo installation, and a mintable installation token across orgs", async () => {
    const getAuthenticated = vi.fn(async () => ({ data: { slug: "ambient-planner" } }));
    // The pasted installationId belongs to a different org than the repo; verification succeeds
    // because getRepoInstallation is an App-JWT route (multi-org), not the fixed-installation repos.get.
    const getRepoInstallation = vi.fn(async () => ({ data: { id: 424242 } }));
    const reposGet = vi.fn(async () => ({ data: {} }));
    const installationClient = vi.fn(() => ({ repos: { get: reposGet } }));
    await expect(
      verifyGitHubAppRepositoryAccess({
        credential: APP_TRIPLE,
        repository: "https://github.com/other-org/repository.git",
        client: { apps: { getAuthenticated, getRepoInstallation } },
        installationClient,
      }),
    ).resolves.toBe("other-org/repository");
    expect(getAuthenticated).toHaveBeenCalledWith({ request: { signal: undefined } });
    expect(getRepoInstallation).toHaveBeenCalledWith({
      owner: "other-org",
      repo: "repository",
      request: { signal: undefined },
    });
    // The stored installationId is exercised — a token is minted and used, the runtime's real path.
    expect(installationClient).toHaveBeenCalledWith(APP_TRIPLE.installationId);
    expect(reposGet).toHaveBeenCalledWith({
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
            getRepoInstallation: async () => ({ data: { id: 1 } }),
          },
        },
      }),
    ).rejects.not.toThrow("must-not-leak");
  });

  it("fails verification when the installation token cannot be minted or used", async () => {
    const getAuthenticated = vi.fn(async () => ({ data: { slug: "ambient-planner" } }));
    const getRepoInstallation = vi.fn(async () => ({ data: { id: 424242 } }));
    // A mistyped/suspended installation authenticates as the App and shows an installation, but the
    // installation-scoped call fails — this must fail verification, not pass and only break at runtime.
    const reposGet = vi.fn(async () => {
      throw new Error("Not Found");
    });
    await expect(
      verifyGitHubAppRepositoryAccess({
        credential: APP_TRIPLE,
        repository: "other-org/repository",
        client: { apps: { getAuthenticated, getRepoInstallation } },
        installationClient: () => ({ repos: { get: reposGet } }),
      }),
    ).rejects.toThrow("could not be verified");
    expect(reposGet).toHaveBeenCalledTimes(1);
  });

  it("passes cancellation through to every GitHub verification request", async () => {
    const signal = new AbortController().signal;
    const getAuthenticated = vi.fn(async () => undefined);
    const getRepoInstallation = vi.fn(async () => ({ data: { id: 424242 } }));
    const reposGet = vi.fn(async () => ({ data: {} }));

    await verifyGitHubAppRepositoryAccess({
      credential: APP_TRIPLE,
      repository: "owner/repository",
      signal,
      client: { apps: { getAuthenticated, getRepoInstallation } },
      installationClient: () => ({ repos: { get: reposGet } }),
    });

    expect(getAuthenticated).toHaveBeenCalledWith({ request: { signal } });
    expect(getRepoInstallation).toHaveBeenCalledWith({ owner: "owner", repo: "repository", request: { signal } });
    expect(reposGet).toHaveBeenCalledWith({ owner: "owner", repo: "repository", request: { signal } });
  });
});
