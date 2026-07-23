import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";

import type { GitHubAppCredential } from "./schema.ts";

type OctokitRequestOptions = NonNullable<ConstructorParameters<typeof Octokit>[0]>["request"];

/**
 * Build an Octokit that authenticates as a GitHub App installation. `@octokit/auth-app`'s
 * `createAppAuth` mints and auto-refreshes the 1-hour installation access token in memory,
 * so every Specialist reuses one credential file → its own visible `<slug>[bot]` identity.
 *
 * Issue management never learns about App auth: it receives the Octokit this returns
 * (ADR 0012's "adapter added without changing the Issue Management interface").
 */
export const githubAppClient = (
  credential: Pick<GitHubAppCredential, "appId" | "installationId" | "privateKey">,
  request?: OctokitRequestOptions,
): Octokit =>
  new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: Number(credential.appId),
      installationId: Number(credential.installationId),
      privateKey: credential.privateKey,
    },
    userAgent: "ambient-agent-issue-management",
    request,
  });

/**
 * An Octokit that authenticates as the App itself (a signed JWT), not as one installation.
 * `@octokit/auth-app` omits the installation token entirely when no `installationId` is given,
 * so this client reaches the App-JWT routes — `GET /repos/{owner}/{repo}/installation` and
 * `GET /orgs/{owner}/installation` — used to discover which installation owns a repo/org.
 */
export const githubAppJwtClient = (
  credential: Pick<GitHubAppCredential, "appId" | "privateKey">,
  request?: OctokitRequestOptions,
): Octokit =>
  new Octokit({
    authStrategy: createAppAuth,
    auth: { appId: Number(credential.appId), privateKey: credential.privateKey },
    userAgent: "ambient-agent-issue-management",
    request,
  });

/**
 * Resolves the right installation-scoped Octokit for whichever org owns a repo. `@octokit/auth-app`
 * pins one Octokit to one installation for its whole life — a single client cannot be redirected
 * per request — so multi-org access means one client per installation, resolved by owner via the
 * App JWT and cached. The stored `credential.installationId` (the home account's) is the fallback
 * when a lookup is transiently unavailable, so a single-org deployment behaves identically.
 */
export interface InstallationResolver {
  octokitFor(owner: string, repo: string): Promise<Octokit>;
  octokitForOwner(owner: string): Promise<Octokit>;
}

export const createInstallationResolver = (
  credential: Pick<GitHubAppCredential, "appId" | "installationId" | "privateKey">,
  deps: {
    readonly resolveInstallationId?: (owner: string, repo: string) => Promise<number>;
    readonly resolveOwnerInstallationId?: (owner: string) => Promise<number>;
  } = {},
): InstallationResolver => {
  // ponytail: cache per owner, no TTL — installation ids are stable; restart clears it.
  const cache = new Map<string, Octokit>();
  const fallback = Number(credential.installationId);
  const resolveInstallationId =
    deps.resolveInstallationId ??
    (async (owner, repo) => (await githubAppJwtClient(credential).rest.apps.getRepoInstallation({ owner, repo })).data.id);
  const resolveOwnerInstallationId =
    deps.resolveOwnerInstallationId ??
    (async (owner) => (await githubAppJwtClient(credential).rest.apps.getOrgInstallation({ org: owner })).data.id);

  const octokitFor = async (owner: string, resolve: () => Promise<number>): Promise<Octokit> => {
    const key = owner.toLowerCase();
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const id = await resolve().catch(() => fallback);
    const octokit = githubAppClient({ ...credential, installationId: String(id) });
    cache.set(key, octokit);
    return octokit;
  };

  return {
    octokitFor: (owner, repo) => octokitFor(owner, () => resolveInstallationId(owner, repo)),
    octokitForOwner: (owner) => octokitFor(owner, () => resolveOwnerInstallationId(owner)),
  };
};
