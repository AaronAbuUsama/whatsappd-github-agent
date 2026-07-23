import { describe, expect, it, vi } from "vite-plus/test";

import { createInstallationResolver } from "../../packages/installation/src/github-app-client.ts";

const CREDENTIAL = {
  appId: "123456",
  installationId: "7891011", // the home account's installation; the fallback when a lookup fails
  privateKey: "-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----\n",
};

describe("createInstallationResolver — multi-org installation resolution", () => {
  it("resolves a non-home owner to its looked-up installation id", async () => {
    const resolveInstallationId = vi.fn(async () => 424242);
    const resolver = createInstallationResolver(CREDENTIAL, { resolveInstallationId });

    const octokit = await resolver.octokitFor("TheCallApp", "widgets");

    expect(resolveInstallationId).toHaveBeenCalledWith("TheCallApp", "widgets");
    // The Octokit was built (auth is lazy), and it is not the home fallback path — the lookup ran.
    expect(octokit).toBeDefined();
  });

  it("caches per owner: two calls for the same owner do exactly one lookup", async () => {
    const resolveInstallationId = vi.fn(async () => 424242);
    const resolver = createInstallationResolver(CREDENTIAL, { resolveInstallationId });

    const first = await resolver.octokitFor("Xelmar-tech", "a");
    const second = await resolver.octokitFor("xelmar-tech", "b"); // case-insensitive owner key

    expect(first).toBe(second);
    expect(resolveInstallationId).toHaveBeenCalledTimes(1);
  });

  it("falls back to the stored installationId when the lookup fails", async () => {
    const resolveInstallationId = vi.fn(async () => {
      throw new Error("installation lookup unavailable");
    });
    const resolver = createInstallationResolver(CREDENTIAL, { resolveInstallationId });

    // The home account (or a transient outage) still resolves a usable client rather than throwing.
    await expect(resolver.octokitFor("home-owner", "repo")).resolves.toBeDefined();
    expect(resolveInstallationId).toHaveBeenCalledTimes(1);
  });

  it("resolves owner-only (issue ops) through the org-installation lookup, cached per owner", async () => {
    const resolveOwnerInstallationId = vi.fn(async () => 999);
    const resolver = createInstallationResolver(CREDENTIAL, { resolveOwnerInstallationId });

    const first = await resolver.octokitForOwner("TheCallApp");
    const second = await resolver.octokitForOwner("thecallapp");

    expect(first).toBe(second);
    expect(resolveOwnerInstallationId).toHaveBeenCalledTimes(1);
    expect(resolveOwnerInstallationId).toHaveBeenCalledWith("TheCallApp");
  });
});
