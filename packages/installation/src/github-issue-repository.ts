import { Octokit } from "@octokit/rest";
import { setTimeout as delay } from "node:timers/promises";

import type {
  Issue,
  IssueComment,
  IssueRepository,
  IssueStateReason,
  OperationIdentity,
  RepositoryRef,
} from "@ambient-agent/agents/capabilities/issue-management/issue-repository.ts";
import {
  commentProviderBody,
  issueOperationMarker,
  issueProviderBody,
  parseCommentProviderBody,
  parseIssueProviderBody,
} from "./issue-operation-footer.ts";

export const GITHUB_ISSUE_BODY_LIMIT = 65_536;
export const githubIssueProviderBody = (body: string, markers: readonly string[]): string =>
  issueProviderBody(body, markers, GITHUB_ISSUE_BODY_LIMIT);
const currentAndLatestOperationMarkers = (
  existingMarkers: readonly string[],
  operation: OperationIdentity,
): readonly string[] => [
  ...(existingMarkers.length === 0 ? [] : [existingMarkers[0]!]),
  issueOperationMarker(operation),
];
export const githubIssueUpdateProviderBody = (
  currentProviderBody: string,
  nextPublicBody: string | undefined,
  operation: OperationIdentity,
): string => {
  const current = parseIssueProviderBody(currentProviderBody);
  const markers = currentAndLatestOperationMarkers(current.markers, operation);
  return githubIssueProviderBody(nextPublicBody ?? current.publicBody, markers);
};
const GITHUB_SEARCH_QUERY_LIMIT = 256;
const issueStateReason = (value: unknown): IssueStateReason =>
  value === "completed" || value === "not_planned" || value === "duplicate" || value === "reopened" ? value : null;
export const githubIssueSearchQuery = (repository: RepositoryRef, query: string): string => {
  const qualifiers = ` in:title,body repo:${repository.owner}/${repository.repo} is:issue`;
  const phraseBudget = GITHUB_SEARCH_QUERY_LIMIT - qualifiers.length - 2;
  if (phraseBudget < 1) throw new Error("The authorized repository leaves no room for a GitHub search phrase.");

  let phrase = "";
  for (const character of query.trim()) {
    const escaped = character === "\\" || character === '"' ? `\\${character}` : character;
    if (phrase.length + escaped.length > phraseBudget) break;
    phrase += escaped;
  }
  return `"${phrase}"${qualifiers}`;
};

export const githubIssueRecord = (
  repository: RepositoryRef,
  data: {
    number: number;
    html_url: string;
    title: string;
    body?: string | null;
    state: string;
    state_reason?: string | null;
    labels?: Array<string | { name?: string }>;
    assignees?: Array<{ login: string }> | null;
    milestone?: { number: number; title: string; state: string } | null;
    pull_request?: unknown;
  },
): Issue => {
  if (data.pull_request !== undefined) {
    throw new Error(`GitHub ${repository.owner}/${repository.repo}#${data.number} is a pull request, not an issue.`);
  }
  return {
    repository,
    number: data.number,
    url: data.html_url,
    title: data.title,
    body: parseIssueProviderBody(data.body ?? "").publicBody,
    stateReason: issueStateReason(data.state_reason),
    state: data.state === "closed" ? "closed" : "open",
    labels: (data.labels ?? []).flatMap((label) => {
      const name = typeof label === "string" ? label : label.name;
      return name === undefined ? [] : [name];
    }),
    assignees: (data.assignees ?? []).map((assignee) => assignee.login),
    milestone:
      data.milestone == null
        ? null
        : {
            number: data.milestone.number,
            title: data.milestone.title,
            state: data.milestone.state === "closed" ? "closed" : "open",
          },
  };
};

const githubIssueCommentRecord = (
  repository: RepositoryRef,
  number: number,
  providerAuthor: string,
  data: {
    id: number;
    html_url: string;
    body?: string | null;
    user?: { login: string } | null;
    created_at: string;
    updated_at: string;
  },
): IssueComment => {
  const author = data.user?.login ?? null;
  return {
    repository,
    number,
    id: data.id,
    url: data.html_url,
    body: author === providerAuthor ? parseCommentProviderBody(data.body ?? "").publicBody : (data.body ?? ""),
    author,
    createdAt: data.created_at,
    updatedAt: data.updated_at,
  };
};

export const createSuccessfulPromiseCache = <T>(load: () => Promise<T>): (() => Promise<T>) => {
  let pending: Promise<T> | undefined;
  return () => {
    if (pending !== undefined) return pending;
    const request = load().catch((cause: unknown) => {
      if (pending === request) pending = undefined;
      throw cause;
    });
    pending = request;
    return request;
  };
};

/**
 * Receives an already-authenticated Octokit (App-installation auth via
 * {@link githubAppClient}, a PAT, or a fake in tests) — or a resolver that yields the right
 * installation-scoped Octokit for an issue's repository, so one Speaker identity can file across
 * orgs (multi-org installation resolution). The provider author is the App's `<slug>[bot]`
 * login, derived at runtime from `apps.getAuthenticated()` — App-identity, the same across
 * every installation, so it is cached once against whichever client resolves first.
 */
export const createOctokitIssueRepository = (
  source: Octokit | ((repository: RepositoryRef) => Promise<Octokit>),
): IssueRepository => {
  const resolveOctokit =
    typeof source === "function" ? source : (_repository: RepositoryRef) => Promise.resolve(source);
  let providerAuthorCache: (() => Promise<string>) | undefined;
  const providerAuthor = (octokit: Octokit): Promise<string> => {
    providerAuthorCache ??= createSuccessfulPromiseCache(async () =>
      octokit.rest.apps.getAuthenticated().then((response) => {
        const slug = response.data?.slug;
        if (slug === undefined) throw new Error("GitHub did not return the authenticated App slug.");
        return `${slug}[bot]`;
      }),
    );
    return providerAuthorCache();
  };

  const readIssue = async (repository: RepositoryRef, number: number, signal?: AbortSignal): Promise<Issue> => {
    const octokit = await resolveOctokit(repository);
    const response = await octokit.rest.issues.get({
      owner: repository.owner,
      repo: repository.repo,
      issue_number: number,
      request: { signal },
    });
    return githubIssueRecord(repository, response.data);
  };
  
  const readComments = async (
    repository: RepositoryRef,
    number: number,
    signal?: AbortSignal,
  ): Promise<IssueComment[]> => {
    const octokit = await resolveOctokit(repository);
    const [comments, author] = await Promise.all([
      octokit.paginate(octokit.rest.issues.listComments, {
        owner: repository.owner,
        repo: repository.repo,
        issue_number: number,
        per_page: 100,
        request: { signal },
      }),
      providerAuthor(octokit),
    ]);
    return comments.map((comment) => githubIssueCommentRecord(repository, number, author, comment));
  };
  
  return {
    search: async ({ repository, query, signal }) => {
      const octokit = await resolveOctokit(repository);
      const repositoryUrl = `https://api.github.com/repos/${repository.owner}/${repository.repo}`.toLowerCase();
      const response = await octokit.rest.search.issuesAndPullRequests({
        q: githubIssueSearchQuery(repository, query),
        per_page: 10,
        request: { signal },
      });
      return response.data.items
        .filter((item) => item.pull_request === undefined && item.repository_url.toLowerCase() === repositoryUrl)
        .map((item) => githubIssueRecord(repository, item));
    },
    get: async ({ repository, number, signal }) => {
      return await readIssue(repository, number, signal);
    },
    options: async ({ repository, signal }) => {
      const octokit = await resolveOctokit(repository);
      const [labels, assignees, milestones] = await Promise.all([
        octokit.paginate(octokit.rest.issues.listLabelsForRepo, {
          owner: repository.owner,
          repo: repository.repo,
          per_page: 100,
          request: { signal },
        }),
        octokit.paginate(octokit.rest.issues.listAssignees, {
          owner: repository.owner,
          repo: repository.repo,
          per_page: 100,
          request: { signal },
        }),
        octokit.paginate(octokit.rest.issues.listMilestones, {
          owner: repository.owner,
          repo: repository.repo,
          state: "all",
          per_page: 100,
          request: { signal },
        }),
      ]);
      return {
        labels: labels.map((label) => label.name),
        assignees: assignees.map((assignee) => assignee.login),
        milestones: milestones.map((milestone) => ({
          number: milestone.number,
          title: milestone.title,
          state: milestone.state === "closed" ? "closed" : "open",
        })),
      };
    },
    create: async ({ repository, title, body, operation, signal }) => {
      const octokit = await resolveOctokit(repository);
      const response = await octokit.rest.issues.create({
        owner: repository.owner,
        repo: repository.repo,
        title,
        body: githubIssueProviderBody(body, [issueOperationMarker(operation)]),
        request: { signal },
      });
      return githubIssueRecord(repository, response.data);
    },
    update: async ({ repository, number, changes, operation, signal }) => {
      const octokit = await resolveOctokit(repository);
      const current = await octokit.rest.issues.get({
        owner: repository.owner,
        repo: repository.repo,
        issue_number: number,
        request: { signal },
      });
      githubIssueRecord(repository, current.data);
      const response = await octokit.rest.issues.update({
        owner: repository.owner,
        repo: repository.repo,
        issue_number: number,
        ...(changes.title === undefined ? {} : { title: changes.title }),
        body: githubIssueUpdateProviderBody(current.data.body ?? "", changes.body, operation),
        ...(changes.labels === undefined ? {} : { labels: [...changes.labels] }),
        ...(changes.assignees === undefined ? {} : { assignees: [...changes.assignees] }),
        ...(changes.milestone === undefined ? {} : { milestone: changes.milestone }),
        request: { signal },
      });
      return githubIssueRecord(repository, response.data);
    },
    discussion: async ({ repository, number, signal }) => {
      const [issue, comments] = await Promise.all([
        readIssue(repository, number, signal),
        readComments(repository, number, signal),
      ]);
      return { issue, comments };
    },
    createComment: async ({ repository, number, body, operation, signal }) => {
      const octokit = await resolveOctokit(repository);
      await readIssue(repository, number, signal);
      const response = await octokit.rest.issues.createComment({
        owner: repository.owner,
        repo: repository.repo,
        issue_number: number,
        body: commentProviderBody(body, [issueOperationMarker(operation)]),
        request: { signal },
      });
      return githubIssueCommentRecord(repository, number, await providerAuthor(octokit), response.data);
    },
    updateComment: async ({ repository, number, commentId, body, operation, signal }) => {
      const octokit = await resolveOctokit(repository);
      const discussion = await Promise.all([
        readIssue(repository, number, signal),
        readComments(repository, number, signal),
      ]).then(([, comments]) => comments);
      const existing = discussion.find((comment) => comment.id === commentId);
      if (existing === undefined) {
        throw new Error(`GitHub issue ${repository.owner}/${repository.repo}#${number} has no comment ${commentId}.`);
      }
      const current = await octokit.rest.issues.getComment({
        owner: repository.owner,
        repo: repository.repo,
        comment_id: commentId,
        request: { signal },
      });
      const author = await providerAuthor(octokit);
      if (current.data.user?.login !== author) {
        throw new Error(`GitHub comment ${commentId} is not owned by the configured provider account.`);
      }
      const existingMarkers = parseCommentProviderBody(current.data.body ?? "").markers;
      const markers = currentAndLatestOperationMarkers(existingMarkers, operation);
      const response = await octokit.rest.issues.updateComment({
        owner: repository.owner,
        repo: repository.repo,
        comment_id: commentId,
        body: commentProviderBody(body, markers),
        request: { signal },
      });
      return githubIssueCommentRecord(repository, number, author, response.data);
    },
    deleteComment: async ({ repository, number, commentId, signal }) => {
      const octokit = await resolveOctokit(repository);
      const discussion = await Promise.all([
        readIssue(repository, number, signal),
        readComments(repository, number, signal),
      ]).then(([, comments]) => comments);
      if (!discussion.some((comment) => comment.id === commentId)) {
        throw new Error(`GitHub issue ${repository.owner}/${repository.repo}#${number} has no comment ${commentId}.`);
      }
      await octokit.rest.issues.deleteComment({
        owner: repository.owner,
        repo: repository.repo,
        comment_id: commentId,
        request: { signal },
      });
    },
    setState: async ({ repository, number, state, reason, signal }) => {
      const octokit = await resolveOctokit(repository);
      await readIssue(repository, number, signal);
      if ((state === "open") !== (reason === "reopened")) {
        throw new Error("Opening an issue requires reason reopened; closing requires a closed-state reason.");
      }
      const response = await octokit.rest.issues.update({
        owner: repository.owner,
        repo: repository.repo,
        issue_number: number,
        state,
        state_reason: reason,
        request: { signal },
      });
      return githubIssueRecord(repository, response.data);
    },
    findCommentByOperation: async ({ repository, number, operation, signal }) => {
      const octokit = await resolveOctokit(repository);
      const marker = issueOperationMarker(operation);
      const author = await providerAuthor(octokit);
      for (const waitMillis of [0, 100, 250, 500, 1_000, 2_000]) {
        if (waitMillis > 0) await delay(waitMillis, undefined, { signal });
        const rawComments = await octokit.paginate(octokit.rest.issues.listComments, {
          owner: repository.owner,
          repo: repository.repo,
          issue_number: number,
          per_page: 100,
          request: { signal },
        });
        const observed = rawComments
          .filter(
            (comment) =>
              comment.user?.login === author && parseCommentProviderBody(comment.body ?? "").markers.includes(marker),
          )
          .map((comment) => githubIssueCommentRecord(repository, number, author, comment));
        if (observed.length > 0) return observed;
      }
      return [];
    },
    findCreated: async ({ repository, operation, signal }) => {
      const octokit = await resolveOctokit(repository);
      const marker = issueOperationMarker(operation);
      for (const waitMillis of [0, 100, 250, 500, 1_000, 2_000]) {
        if (waitMillis > 0) await delay(waitMillis, undefined, { signal });
        const response = await octokit.rest.issues.listForRepo({
          owner: repository.owner,
          repo: repository.repo,
          state: "all",
          sort: "created",
          direction: "desc",
          per_page: 100,
          request: { signal },
        });
        const matches = response.data
          .filter(
            (item) =>
              item.pull_request === undefined && parseIssueProviderBody(item.body ?? "").markers.includes(marker),
          )
          .map((item) => githubIssueRecord(repository, item));
        if (matches.length > 0) return matches;
      }
      return [];
    },
  };
};
