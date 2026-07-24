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

  it("falls back to the stored installationId for one call on lookup failure, without caching it", async () => {
    const resolveInstallationId = vi.fn(async () => {
      throw new Error("installation lookup unavailable");
    });
    const resolver = createInstallationResolver(CREDENTIAL, { resolveInstallationId });

    // The home account (or a transient outage) still resolves a usable client rather than throwing.
    await expect(resolver.octokitFor("home-owner", "repo")).resolves.toBeDefined();
    // The failed lookup is NOT pinned: a second call retries the lookup rather than reusing the
    // fallback client, so a transient blip cannot permanently wedge the owner on the wrong client.
    await expect(resolver.octokitFor("home-owner", "repo")).resolves.toBeDefined();
    expect(resolveInstallationId).toHaveBeenCalledTimes(2);
  });

  it("caches the successful lookup after a transient failure recovers", async () => {
    let attempt = 0;
    const resolveInstallationId = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) throw new Error("transient");
      return 424242;
    });
    const resolver = createInstallationResolver(CREDENTIAL, { resolveInstallationId });

    await resolver.octokitFor("TheCallApp", "widgets"); // fails → fallback, uncached
    const recovered = await resolver.octokitFor("TheCallApp", "widgets"); // succeeds → cached
    const cached = await resolver.octokitFor("TheCallApp", "widgets"); // reuses cache, no lookup

    expect(recovered).toBe(cached);
    expect(resolveInstallationId).toHaveBeenCalledTimes(2);
  });
});
