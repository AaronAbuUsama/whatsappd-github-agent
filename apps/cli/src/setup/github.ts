import { execFile } from "node:child_process";

import { Octokit } from "@octokit/rest";

import { parseGitHubRepository } from "@ambient-agent/core/github/repository.ts";

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

export interface DiscoveredGitHubCredential {
  readonly token: string;
  readonly source: string;
}

export const discoverGitHubCredential = async (
  options: {
    readonly environment?: Readonly<Record<string, string | undefined>>;
    readonly run?: CommandRunner;
  } = {},
): Promise<DiscoveredGitHubCredential | undefined> => {
  const environment = options.environment ?? process.env;
  for (const name of ["GH_TOKEN", "GITHUB_TOKEN"] as const) {
    const token = environment[name]?.trim();
    if (token) return { token, source: `environment ${name}` };
  }
  try {
    const token = (await (options.run ?? runCommand)("gh", ["auth", "token"])).stdout.trim();
    return token ? { token, source: "GitHub CLI" } : undefined;
  } catch {
    return undefined;
  }
};

export interface GitHubAccessClient {
  readonly users: {
    getAuthenticated(input?: { readonly request?: { readonly signal?: AbortSignal } }): Promise<unknown>;
  };
  readonly repos: {
    get(input: {
      readonly owner: string;
      readonly repo: string;
      readonly request?: { readonly signal?: AbortSignal };
    }): Promise<unknown>;
  };
}

export const verifyGitHubRepositoryAccess = async (input: {
  readonly token: string;
  readonly repository: string;
  readonly client?: GitHubAccessClient;
  readonly signal?: AbortSignal;
}): Promise<string> => {
  const repository = normalizeGitHubRepository(input.repository);
  const [owner, repo] = repository.split("/") as [string, string];
  const client = input.client ?? (new Octokit({ auth: input.token }) as unknown as GitHubAccessClient);
  try {
    input.signal?.throwIfAborted();
    await client.users.getAuthenticated({ request: { signal: input.signal } });
    await client.repos.get({ owner, repo, request: { signal: input.signal } });
    return repository;
  } catch {
    throw new Error(`GitHub authentication or repository access could not be verified for ${repository}.`);
  }
};
