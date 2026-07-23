import { execFile } from "node:child_process";

import { githubAppJwtClient } from "@ambient-agent/installation/github-app-client.ts";
import type { GitHubAppTriple } from "@ambient-agent/installation/schema.ts";

import { parseGitHubRepository } from "@ambient-agent/engine/github/repository.ts";

export interface CommandResult {
  readonly stdout: string;
}

export type CommandRunner = (command: string, args: readonly string[]) => Promise<CommandResult>;

const runCommand: CommandRunner = async (command, args) =>
  await new Promise<CommandResult>((resolve, reject) => {
    execFile(command, [...args], { encoding: "utf8" }, (cause, stdout) => {
      if (cause) reject(cause);
      else resolve({ stdout });
    });
  });

export const normalizeGitHubRepository = (input: string): string => {
  const value = input.trim().replace(/\/$/, "");
  let candidate = value;
  for (const prefix of ["https://github.com/", "http://github.com/", "git@github.com:", "ssh://git@github.com/"]) {
    if (value.startsWith(prefix)) {
      candidate = value.slice(prefix.length);
      break;
    }
  }
  candidate = candidate.replace(/\.git$/, "");
  parseGitHubRepository(candidate, () => new Error("Expected a GitHub repository in owner/repository form."));
  return candidate;
};

export const discoverOriginRepository = async (
  options: { readonly run?: CommandRunner } = {},
): Promise<string | undefined> => {
  try {
    const result = await (options.run ?? runCommand)("git", ["config", "--get", "remote.origin.url"]);
    const origin = result.stdout.trim();
    if (!origin || !/(?:github\.com[/:])/.test(origin)) return undefined;
    return normalizeGitHubRepository(origin);
  } catch {
    return undefined;
  }
};

export interface GitHubAppAccessClient {
  readonly apps: {
    getAuthenticated(input?: { readonly request?: { readonly signal?: AbortSignal } }): Promise<unknown>;
    getRepoInstallation(input: {
      readonly owner: string;
      readonly repo: string;
      readonly request?: { readonly signal?: AbortSignal };
    }): Promise<unknown>;
  };
}

/**
 * Verify a pasted GitHub App triple both authenticates (`apps.getAuthenticated`) and is installed
 * on the target repository (`apps.getRepoInstallation`), returning the normalized `owner/name`.
 * Both are App-JWT routes, so verification no longer depends on the pasted `installationId` matching
 * the repo's org — the App may be installed on several orgs, and a repo in any of them proves access
 * (multi-org). Replaces the retired personal-token check. Never echoes the private key on failure.
 */
export const verifyGitHubAppRepositoryAccess = async (input: {
  readonly credential: GitHubAppTriple;
  readonly repository: string;
  readonly client?: GitHubAppAccessClient;
  readonly signal?: AbortSignal;
}): Promise<string> => {
  const repository = normalizeGitHubRepository(input.repository);
  const [owner, repo] = repository.split("/") as [string, string];
  const client = input.client ?? (githubAppJwtClient(input.credential).rest as unknown as GitHubAppAccessClient);
  try {
    input.signal?.throwIfAborted();
    await client.apps.getAuthenticated({ request: { signal: input.signal } });
    await client.apps.getRepoInstallation({ owner, repo, request: { signal: input.signal } });
    return repository;
  } catch {
    throw new Error(`GitHub authentication or repository access could not be verified for ${repository}.`);
  }
};
