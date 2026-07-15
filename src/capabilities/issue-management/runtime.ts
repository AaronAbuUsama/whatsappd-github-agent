import type { IssueRepository, RepositoryRef } from "./issue-repository.ts";
import type { IssueOperationStore } from "./operation-store.ts";

const parseRepository = (value: string): RepositoryRef => {
  const match = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/.exec(value.trim());
  if (!match) throw new Error(`GitHub repository must be owner/repo, got ${value}`);
  return { owner: match[1]!, repo: match[2]! };
};

export const repositoryName = ({ owner, repo }: RepositoryRef): string => `${owner}/${repo}`;

export interface IssueManagementSettings {
  readonly token: string;
  readonly defaultRepository: string;
  readonly allowedRepositories: readonly string[];
  readonly operationDatabasePath: string;
}

export const loadIssueManagementSettings = (
  env: Readonly<Record<string, string | undefined>>,
): IssueManagementSettings => {
  const token = env.GITHUB_TOKEN?.trim();
  if (!token) throw new Error("GITHUB_TOKEN is required for Issue Management");
  const defaultRepository = env.GITHUB_REPO?.trim();
  if (!defaultRepository) throw new Error("GITHUB_REPO is required for Issue Management");
  parseRepository(defaultRepository);
  const allowedRepositories = (env.GITHUB_ALLOWED_REPOS ?? "")
    .split(",")
    .map((repository) => repository.trim())
    .filter(Boolean);
  for (const repository of allowedRepositories) parseRepository(repository);
  const operationDatabasePath = env.GITHUB_ISSUE_OPERATIONS_DB_PATH?.trim();
  if (!operationDatabasePath) {
    throw new Error("GITHUB_ISSUE_OPERATIONS_DB_PATH is required for durable Issue Management operations");
  }
  return { token, defaultRepository, allowedRepositories, operationDatabasePath };
};

export interface IssueManagementPolicy {
  authorize(requested?: string): RepositoryRef;
}

export const createIssueManagementPolicy = (
  defaultRepository: string,
  allowedRepositories: readonly string[],
): IssueManagementPolicy => {
  parseRepository(defaultRepository);
  const configured = allowedRepositories.length === 0 ? [defaultRepository] : allowedRepositories;
  const allowed = new Set(configured.map((repository) => repositoryName(parseRepository(repository)).toLowerCase()));
  return {
    authorize: (requested = defaultRepository) => {
      const repository = parseRepository(requested);
      const key = repositoryName(repository).toLowerCase();
      if (!allowed.has(key)) {
        throw new Error(`Refusing ${key}: not in the configured GitHub write allowlist (${[...allowed].join(", ")})`);
      }
      return repository;
    },
  };
};

export interface IssueManagementRuntime {
  readonly repository: IssueRepository;
  readonly operations: IssueOperationStore;
  readonly policy: IssueManagementPolicy;
}

let configured: IssueManagementRuntime | undefined;

export const configureIssueManagementRuntime = (runtime: IssueManagementRuntime): void => {
  configured = runtime;
};

export const getIssueManagementRuntime = (): IssueManagementRuntime => {
  if (configured === undefined) throw new Error("Issue Management runtime is not configured");
  return configured;
};
