import {
  IssueMutationOutcomeUncertainError,
  type Issue,
  type IssueDraft,
  type IssueMilestone,
  type IssueRepository,
  type IssueRepositoryOptions,
  type RepositoryRef,
} from "../capabilities/issue-management/issue-repository.ts";
import { repositoryName } from "../capabilities/issue-management/runtime.ts";

const operationMarker = (operationId: string): string => `<!-- ambience-operation:${operationId} -->`;
const operationMarkerPattern = /<!-- ambience-operation:[^\r\n]+ -->/g;
const providerBody = (body: string, markers: readonly string[]): string => {
  const serialized = markers.length === 0 ? body : `${body}\n\n${[...new Set(markers)].join("\n\n")}`;
  if (serialized.length > 65_536)
    throw new Error("GitHub issue body exceeds 65536 characters after Operation Identity.");
  return serialized;
};
const publicBody = (body: string): string =>
  body.replaceAll(/\n\n<!-- ambience-operation:[^\r\n]+ -->/g, "").replaceAll(operationMarkerPattern, "");
const publicRecord = (issue: Issue): Issue => ({ ...issue, body: publicBody(issue.body) });

export type FakeIssueRepositoryEvent =
  | { kind: "search"; repository: string; query: string; matches: number[] }
  | { kind: "get"; repository: string; number: number }
  | { kind: "list-options"; repository: string }
  | { kind: "create"; repository: string; operationId: string; outcome: "created"; number: number }
  | { kind: "create"; repository: string; operationId: string; outcome: "unknown" }
  | { kind: "create"; repository: string; operationId: string; outcome: "failed"; error: string }
  | { kind: "update"; repository: string; number: number; operationId: string; outcome: "updated" }
  | { kind: "update"; repository: string; number: number; operationId: string; outcome: "unknown" }
  | { kind: "update"; repository: string; number: number; operationId: string; outcome: "failed"; error: string }
  | { kind: "find-operation"; repository: string; operationId: string; matches: number[] };

type MutationMode =
  | { kind: "success" }
  | { kind: "timeout"; afterMutation: boolean }
  | { kind: "failure"; error: Error };

export interface FakeIssueRepository extends IssueRepository {
  events(): readonly FakeIssueRepositoryEvent[];
  reset(): void;
  resetEvents(): void;
  seed(
    input: Omit<IssueDraft, "kind"> & {
      readonly kind?: "bug" | "feature";
      readonly labels?: readonly string[];
      readonly assignees?: readonly string[];
      readonly milestone?: IssueMilestone | null;
    },
  ): Issue;
  setOptions(options: IssueRepositoryOptions): void;
  timeoutNextCreate(options: { readonly afterMutation: boolean }): void;
  timeoutNextUpdate(options: { readonly afterMutation: boolean }): void;
  failNextCreate(error: Error): void;
  failNextUpdate(error: Error): void;
}

export const createFakeIssueRepository = (): FakeIssueRepository => {
  const events: FakeIssueRepositoryEvent[] = [];
  const issues = new Map<string, Map<number, Issue>>();
  let nextNumber = 1;
  let createMode: MutationMode = { kind: "success" };
  let updateMode: MutationMode = { kind: "success" };
  let repositoryOptions: IssueRepositoryOptions = { labels: [], assignees: [], milestones: [] };

  const records = (repository: RepositoryRef): Map<number, Issue> => {
    const key = repositoryName(repository).toLowerCase();
    const existing = issues.get(key);
    if (existing !== undefined) return existing;
    const created = new Map<number, Issue>();
    issues.set(key, created);
    return created;
  };
  const seed: FakeIssueRepository["seed"] = (input) => {
    const number = nextNumber++;
    const issue: Issue = {
      repository: input.repository,
      number,
      url: `https://github.com/${repositoryName(input.repository)}/issues/${number}`,
      title: input.title,
      body: input.body,
      state: "open",
      labels: [...(input.labels ?? [])],
      assignees: [...(input.assignees ?? [])],
      milestone: input.milestone ?? null,
    };
    records(input.repository).set(number, issue);
    return issue;
  };

  return {
    search: async ({ repository, query }) => {
      const normalized = query.trim().toLowerCase();
      const matches = [...records(repository).values()].filter((issue) =>
        `${issue.title}\n${issue.body}`.toLowerCase().includes(normalized),
      );
      events.push({
        kind: "search",
        repository: repositoryName(repository),
        query,
        matches: matches.map((issue) => issue.number),
      });
      return matches.map(publicRecord);
    },
    get: async ({ repository, number }) => {
      const issue = records(repository).get(number);
      if (issue === undefined) throw new Error(`Fake issue ${repositoryName(repository)}#${number} was not found`);
      events.push({ kind: "get", repository: repositoryName(repository), number });
      return publicRecord(issue);
    },
    options: async ({ repository }) => {
      events.push({ kind: "list-options", repository: repositoryName(repository) });
      return {
        labels: [...repositoryOptions.labels],
        assignees: [...repositoryOptions.assignees],
        milestones: repositoryOptions.milestones.map((milestone) => ({ ...milestone })),
      };
    },
    create: async ({ repository, kind: _kind, title, body, operation }) => {
      const current = createMode;
      createMode = { kind: "success" };
      if (current.kind === "failure") {
        events.push({
          kind: "create",
          repository: repositoryName(repository),
          operationId: operation.id,
          outcome: "failed",
          error: current.error.message,
        });
        throw current.error;
      }
      if (current.kind === "timeout") {
        if (current.afterMutation) {
          seed({ repository, title, body: providerBody(body, [operationMarker(operation.id)]) });
        }
        events.push({
          kind: "create",
          repository: repositoryName(repository),
          operationId: operation.id,
          outcome: "unknown",
        });
        throw new IssueMutationOutcomeUncertainError("GitHub create request timed out");
      }
      const issue = seed({ repository, title, body: providerBody(body, [operationMarker(operation.id)]) });
      events.push({
        kind: "create",
        repository: repositoryName(repository),
        operationId: operation.id,
        outcome: "created",
        number: issue.number,
      });
      return publicRecord(issue);
    },
    update: async ({ repository, number, changes, operation }) => {
      const current = updateMode;
      updateMode = { kind: "success" };
      const existing = records(repository).get(number);
      if (existing === undefined) throw new Error(`Fake issue ${repositoryName(repository)}#${number} was not found`);
      if (current.kind === "failure") {
        events.push({
          kind: "update",
          repository: repositoryName(repository),
          number,
          operationId: operation.id,
          outcome: "failed",
          error: current.error.message,
        });
        throw current.error;
      }
      const apply = (): Issue => {
        const existingMarkers = existing.body.match(operationMarkerPattern) ?? [];
        const milestone =
          changes.milestone === undefined
            ? existing.milestone
            : changes.milestone === null
              ? null
              : (repositoryOptions.milestones.find((candidate) => candidate.number === changes.milestone) ?? null);
        const updated: Issue = {
          ...existing,
          ...(changes.title === undefined ? {} : { title: changes.title }),
          ...(changes.body === undefined
            ? {}
            : {
                body: providerBody(changes.body, [
                  ...(existingMarkers.length === 0 ? [] : [existingMarkers[0]!]),
                  operationMarker(operation.id),
                ]),
              }),
          ...(changes.labels === undefined ? {} : { labels: [...changes.labels] }),
          ...(changes.assignees === undefined ? {} : { assignees: [...changes.assignees] }),
          milestone,
        };
        records(repository).set(number, updated);
        return publicRecord(updated);
      };
      if (current.kind === "timeout") {
        if (current.afterMutation) apply();
        events.push({
          kind: "update",
          repository: repositoryName(repository),
          number,
          operationId: operation.id,
          outcome: "unknown",
        });
        throw new IssueMutationOutcomeUncertainError("GitHub update request timed out");
      }
      const updated = apply();
      events.push({
        kind: "update",
        repository: repositoryName(repository),
        number,
        operationId: operation.id,
        outcome: "updated",
      });
      return updated;
    },
    findCreated: async ({ repository, operation }) => {
      const marker = `<!-- ambience-operation:${operation.id} -->`;
      const matches = [...records(repository).values()].filter((issue) => issue.body.includes(marker));
      events.push({
        kind: "find-operation",
        repository: repositoryName(repository),
        operationId: operation.id,
        matches: matches.map((issue) => issue.number),
      });
      return matches.map(publicRecord);
    },
    events: () => [...events],
    reset: () => {
      events.length = 0;
      issues.clear();
      nextNumber = 1;
      createMode = { kind: "success" };
      updateMode = { kind: "success" };
      repositoryOptions = { labels: [], assignees: [], milestones: [] };
    },
    resetEvents: () => {
      events.length = 0;
    },
    seed,
    setOptions: (options) => {
      repositoryOptions = {
        labels: [...options.labels],
        assignees: [...options.assignees],
        milestones: options.milestones.map((milestone) => ({ ...milestone })),
      };
    },
    timeoutNextCreate: ({ afterMutation }) => {
      createMode = { kind: "timeout", afterMutation };
    },
    timeoutNextUpdate: ({ afterMutation }) => {
      updateMode = { kind: "timeout", afterMutation };
    },
    failNextCreate: (error) => {
      createMode = { kind: "failure", error };
    },
    failNextUpdate: (error) => {
      updateMode = { kind: "failure", error };
    },
  };
};
