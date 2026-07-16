export const GITHUB_REPOSITORY_PATTERN = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/;

export interface GitHubRepositoryRef {
  readonly owner: string;
  readonly repo: string;
}

export const parseGitHubRepository = (value: string, invalid: (value: string) => Error): GitHubRepositoryRef => {
  const match = GITHUB_REPOSITORY_PATTERN.exec(value.trim());
  if (match === null) throw invalid(value);
  return { owner: match[1]!, repo: match[2]! };
};
