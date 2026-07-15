import { Octokit } from "@octokit/rest";
import { setTimeout as delay } from "node:timers/promises";

import type {
  Issue,
  IssueRepository,
  OperationIdentity,
  RepositoryRef,
} from "../capabilities/issue-management/issue-repository.ts";

const operationMarker = ({ id }: OperationIdentity): string => `<!-- ambience-operation:${id} -->`;
const operationMarkerPattern = /<!-- ambience-operation:[^\r\n]+ -->/g;
export const GITHUB_ISSUE_BODY_LIMIT = 65_536;
export const githubIssueProviderBody = (body: string, markers: readonly string[]): string => {
  const serialized = markers.length === 0 ? body : `${body}\n\n${[...new Set(markers)].join("\n\n")}`;
  if (serialized.length > GITHUB_ISSUE_BODY_LIMIT) {
    throw new Error(`GitHub issue body exceeds ${GITHUB_ISSUE_BODY_LIMIT} characters after Operation Identity.`);
  }
  return serialized;
};
const publicBody = (body: string): string =>
  body.replaceAll(/\n\n<!-- ambience-operation:[^\r\n]+ -->/g, "").replaceAll(operationMarkerPattern, "");
const GITHUB_SEARCH_QUERY_LIMIT = 256;
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
    body: publicBody(data.body ?? ""),
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

export const createOctokitIssueRepository = (token: string): IssueRepository => {
  const octokit = new Octokit({ auth: token, userAgent: "ambient-agent-issue-management" });
  return {
    search: async ({ repository, query, signal }) => {
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
      const response = await octokit.rest.issues.get({
        owner: repository.owner,
        repo: repository.repo,
        issue_number: number,
        request: { signal },
      });
      return githubIssueRecord(repository, response.data);
    },
    options: async ({ repository, signal }) => {
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
      const response = await octokit.rest.issues.create({
        owner: repository.owner,
        repo: repository.repo,
        title,
        body: githubIssueProviderBody(body, [operationMarker(operation)]),
        request: { signal },
      });
      return githubIssueRecord(repository, response.data);
    },
    update: async ({ repository, number, changes, operation, signal }) => {
      const current = await octokit.rest.issues.get({
        owner: repository.owner,
        repo: repository.repo,
        issue_number: number,
        request: { signal },
      });
      githubIssueRecord(repository, current.data);
      const existingMarkers = (current.data.body ?? "").match(operationMarkerPattern) ?? [];
      const markers = [...(existingMarkers.length === 0 ? [] : [existingMarkers[0]!]), operationMarker(operation)];
      const response = await octokit.rest.issues.update({
        owner: repository.owner,
        repo: repository.repo,
        issue_number: number,
        ...(changes.title === undefined ? {} : { title: changes.title }),
        ...(changes.body === undefined ? {} : { body: githubIssueProviderBody(changes.body, markers) }),
        ...(changes.labels === undefined ? {} : { labels: [...changes.labels] }),
        ...(changes.assignees === undefined ? {} : { assignees: [...changes.assignees] }),
        ...(changes.milestone === undefined ? {} : { milestone: changes.milestone }),
        request: { signal },
      });
      return githubIssueRecord(repository, response.data);
    },
    findCreated: async ({ repository, operation, signal }) => {
      const marker = operationMarker(operation);
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
          .filter((item) => item.pull_request === undefined && (item.body ?? "").includes(marker))
          .map((item) => githubIssueRecord(repository, item));
        if (matches.length > 0) return matches;
      }
      return [];
    },
  };
};
