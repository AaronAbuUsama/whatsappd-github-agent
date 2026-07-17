import type { IssueRepository, RepositoryRef } from "./issue-repository.ts";
import type { IssueOperationStore } from "./operation-store.ts";
import { parseGitHubRepository } from "../../github/repository.js";

const parseRepository = (value: string): RepositoryRef =>
  parseGitHubRepository(value, (invalid) => new Error(`GitHub repository must be owner/repo, got ${invalid}`));

export const repositoryName = ({ owner, repo }: RepositoryRef): string => `${owner}/${repo}`;

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

const ISSUE_MANAGEMENT_RUNTIME = Symbol.for("ambient-agent.issue-management-runtime");
const runtimeGlobal = globalThis as typeof globalThis & { [ISSUE_MANAGEMENT_RUNTIME]?: IssueManagementRuntime };

export const configureIssueManagementRuntime = (runtime: IssueManagementRuntime): void => {
  runtimeGlobal[ISSUE_MANAGEMENT_RUNTIME] = runtime;
};

export const getIssueManagementRuntime = (): IssueManagementRuntime => {
  const runtime = runtimeGlobal[ISSUE_MANAGEMENT_RUNTIME];
  if (runtime === undefined) throw new Error("Issue Management runtime is not configured");
  return runtime;
};
