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
 * so this client reaches the App-JWT route `GET /repos/{owner}/{repo}/installation`, used to
 * discover which installation owns a repo (works for both User and Organization owners).
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
 * App JWT and cached. `GET /repos/{owner}/{repo}/installation` works for both User and Organization
 * owners, so every owner routes through the repo — the org-only route (which 404s for user accounts)
 * is gone. The stored `credential.installationId` (the home account's) is the fallback for a single
 * transient lookup failure — used for that one call only, never cached, so the next call retries and
 * a real (non-transient) misconfiguration surfaces rather than being pinned to the wrong installation.
 */
export interface InstallationResolver {
  octokitFor(owner: string, repo: string): Promise<Octokit>;
}

export const createInstallationResolver = (
  credential: Pick<GitHubAppCredential, "appId" | "installationId" | "privateKey">,
  deps: {
    readonly resolveInstallationId?: (owner: string, repo: string) => Promise<number>;
  } = {},
): InstallationResolver => {
  // ponytail: cache the resolved-client promise per owner, no TTL — installation ids are stable;
  // a failed lookup is evicted (below) so the fallback is never pinned; restart clears the cache.
  const cache = new Map<string, Promise<Octokit>>();
  const fallback = Number(credential.installationId);
  const resolveInstallationId =
    deps.resolveInstallationId ??
    (async (owner, repo) => (await githubAppJwtClient(credential).rest.apps.getRepoInstallation({ owner, repo })).data.id);

  return {
    octokitFor: (owner, repo) => {
      const key = owner.toLowerCase();
      const cached = cache.get(key);
      if (cached !== undefined) return cached;
      const pending = resolveInstallationId(owner, repo)
        .then((id) => githubAppClient({ ...credential, installationId: String(id) }))
        .catch((cause: unknown) => {
          // Evict the failed entry so the next call retries the lookup rather than pinning the
          // home installation for the whole process, and use the fallback for this one call only.
          if (cache.get(key) === pending) cache.delete(key);
          console.warn(
            `GitHub installation lookup failed for ${owner}/${repo}; using home installation ${fallback} for this call only.`,
            cause,
          );
          return githubAppClient({ ...credential, installationId: String(fallback) });
        });
      cache.set(key, pending);
      return pending;
    },
  };
};
