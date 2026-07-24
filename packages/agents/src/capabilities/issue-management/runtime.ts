import type { IssueRepository, RepositoryRef } from "./issue-repository.ts";
import type { IssueOperationStore } from "@ambient-agent/engine/github/operation-store.ts";
import { createFlueGlobal } from "@ambient-agent/engine/shared/flue-global.ts";
import { parseGitHubRepository } from "@ambient-agent/engine/github/repository.ts";

const parseRepository = (value: string): RepositoryRef =>
  parseGitHubRepository(value, (invalid) => new Error(`GitHub repository must be owner/repo, got ${invalid}`));

export const repositoryName = ({ owner, repo }: RepositoryRef): string => `${owner}/${repo}`;

export interface IssueManagementPolicy {
  authorize(requested?: string): RepositoryRef;
  /**
   * Live-reload the write allowlist in place (#179). The default repository is fixed at construction
   * (a restart-only knob); only the allowlist Set is rebuilt, so `authorize` — already captured by
   * the Speaker's issue tools — enforces the new allowlist with no restart.
   */
  reload(allowedRepositories: readonly string[]): void;
}

export const createIssueManagementPolicy = (
  defaultRepository: string,
  allowedRepositories: readonly string[],
): IssueManagementPolicy => {
  parseRepository(defaultRepository);
  const allowed = new Set<string>();
  const load = (repositories: readonly string[]): void => {
    const configured = repositories.length === 0 ? [defaultRepository] : repositories;
    allowed.clear();
    for (const repository of configured) allowed.add(repositoryName(parseRepository(repository)).toLowerCase());
  };
  load(allowedRepositories);
  return {
    authorize: (requested = defaultRepository) => {
      const repository = parseRepository(requested);
      const key = repositoryName(repository).toLowerCase();
      if (!allowed.has(key)) {
        throw new Error(`Refusing ${key}: not in the configured GitHub write allowlist (${[...allowed].join(", ")})`);
      }
      return repository;
    },
    reload: (repositories) => load(repositories),
  };
};

export interface IssueManagementRuntime {
  readonly repository: IssueRepository;
  readonly operations: IssueOperationStore;
  readonly policy: IssueManagementPolicy;
}

const runtimeSlot = createFlueGlobal<IssueManagementRuntime>(
  "issue-management-runtime",
  "Issue Management runtime is not configured",
);

export const configureIssueManagementRuntime = (runtime: IssueManagementRuntime): void => runtimeSlot.set(runtime);
export const getIssueManagementRuntime = (): IssueManagementRuntime => runtimeSlot.get();
