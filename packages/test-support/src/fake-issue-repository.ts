import {
  IssueMutationOutcomeUncertainError,
  type Issue,
  type IssueComment,
  type IssueDraft,
  type IssueMilestone,
  type IssueRepository,
  type IssueRepositoryOptions,
  type IssueStateChangeReason,
  type RepositoryRef,
} from "@ambient-agent/core/capabilities/issue-management/issue-repository.ts";
import { repositoryName } from "@ambient-agent/core/capabilities/issue-management/runtime.ts";
import {
  commentProviderBody,
  issueOperationMarker,
  issueProviderBody,
  parseCommentProviderBody,
  parseIssueProviderBody,
} from "@ambient-agent/core/host/issue-operation-footer.ts";

const publicRecord = (issue: Issue): Issue => ({ ...issue, body: parseIssueProviderBody(issue.body).publicBody });
const FAKE_PROVIDER_AUTHOR = "ambient-agent";
const publicComment = (comment: IssueComment): IssueComment => ({
  ...comment,
  body: comment.author === FAKE_PROVIDER_AUTHOR ? parseCommentProviderBody(comment.body).publicBody : comment.body,
});

export type FakeLifecycleMutationKind = "create-comment" | "update-comment" | "delete-comment" | "set-issue-state";
type FakeMutationKind = "create" | "update" | FakeLifecycleMutationKind;

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
  | { kind: "discussion"; repository: string; number: number; comments: number[] }
  | {
      kind: FakeLifecycleMutationKind;
      repository: string;
      number: number;
      operationId: string;
      outcome: "applied" | "unknown" | "failed";
      commentId?: number;
      error?: string;
    }
  | { kind: "find-operation"; repository: string; operationId: string; matches: number[] }
  | { kind: "find-comment-operation"; repository: string; number: number; operationId: string; matches: number[] };

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
  seedComment(input: {
    readonly repository: RepositoryRef;
    readonly number: number;
    readonly body: string;
    readonly author?: string | null;
  }): IssueComment;
  setOptions(options: IssueRepositoryOptions): void;
  timeoutNextCreate(options: { readonly afterMutation: boolean }): void;
  timeoutNextUpdate(options: { readonly afterMutation: boolean }): void;
  failNextCreate(error: Error): void;
  failNextUpdate(error: Error): void;
  timeoutNextLifecycleMutation(kind: FakeLifecycleMutationKind, options: { readonly afterMutation: boolean }): void;
  failNextLifecycleMutation(kind: FakeLifecycleMutationKind, error: Error): void;
}

export const createFakeIssueRepository = (): FakeIssueRepository => {
  const events: FakeIssueRepositoryEvent[] = [];
  const issues = new Map<string, Map<number, Issue>>();
  const comments = new Map<string, Map<number, IssueComment>>();
  let nextNumber = 1;
  let nextCommentId = 1;
  const lifecycleModes = new Map<FakeMutationKind, MutationMode>();
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
      stateReason: null,
      labels: [...(input.labels ?? [])],
      assignees: [...(input.assignees ?? [])],
      milestone: input.milestone ?? null,
    };
    records(input.repository).set(number, issue);
    return issue;
  };
  const commentRecords = (repository: RepositoryRef, number: number): Map<number, IssueComment> => {
    const key = `${repositoryName(repository).toLowerCase()}#${number}`;
    const existing = comments.get(key);
    if (existing !== undefined) return existing;
    const created = new Map<number, IssueComment>();
    comments.set(key, created);
    return created;
  };
  const seedComment: FakeIssueRepository["seedComment"] = ({ repository, number, body, author = "maintainer" }) => {
    if (!records(repository).has(number)) {
      throw new Error(`Fake issue ${repositoryName(repository)}#${number} was not found`);
    }
    const id = nextCommentId++;
    const timestamp = new Date(id * 1_000).toISOString();
    const comment: IssueComment = {
      repository,
      number,
      id,
      url: `https://github.com/${repositoryName(repository)}/issues/${number}#issuecomment-${id}`,
      body,
      author,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    commentRecords(repository, number).set(id, comment);
    return publicComment(comment);
  };
  const consumeLifecycleMode = (kind: FakeMutationKind): MutationMode => {
    const mode = lifecycleModes.get(kind) ?? { kind: "success" };
    lifecycleModes.delete(kind);
    return mode;
  };
  const lifecycleFailure = (
    kind: FakeLifecycleMutationKind,
    repository: RepositoryRef,
    number: number,
    operationId: string,
    mode: MutationMode,
  ): void => {
    if (mode.kind !== "failure") return;
    events.push({
      kind,
      repository: repositoryName(repository),
      number,
      operationId,
      outcome: "failed",
      error: mode.error.message,
    });
    throw mode.error;
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
      const current = consumeLifecycleMode("create");
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
          seed({ repository, title, body: issueProviderBody(body, [issueOperationMarker(operation)]) });
        }
        events.push({
          kind: "create",
          repository: repositoryName(repository),
          operationId: operation.id,
          outcome: "unknown",
        });
        throw new IssueMutationOutcomeUncertainError("GitHub create request timed out");
      }
      const issue = seed({ repository, title, body: issueProviderBody(body, [issueOperationMarker(operation)]) });
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
      const current = consumeLifecycleMode("update");
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
        const existingMarkers = parseIssueProviderBody(existing.body).markers;
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
                body: issueProviderBody(changes.body, [
                  ...(existingMarkers.length === 0 ? [] : [existingMarkers[0]!]),
                  issueOperationMarker(operation),
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
    discussion: async ({ repository, number }) => {
      const issue = records(repository).get(number);
      if (issue === undefined) throw new Error(`Fake issue ${repositoryName(repository)}#${number} was not found`);
      const listed = [...commentRecords(repository, number).values()].map(publicComment);
      events.push({
        kind: "discussion",
        repository: repositoryName(repository),
        number,
        comments: listed.map((comment) => comment.id),
      });
      return { issue: publicRecord(issue), comments: listed };
    },
    createComment: async ({ repository, number, body, operation }) => {
      const mode = consumeLifecycleMode("create-comment");
      lifecycleFailure("create-comment", repository, number, operation.id, mode);
      const apply = () =>
        seedComment({
          repository,
          number,
          body: commentProviderBody(body, [issueOperationMarker(operation)]),
          author: FAKE_PROVIDER_AUTHOR,
        });
      if (mode.kind === "timeout") {
        if (mode.afterMutation) apply();
        events.push({
          kind: "create-comment",
          repository: repositoryName(repository),
          number,
          operationId: operation.id,
          outcome: "unknown",
        });
        throw new IssueMutationOutcomeUncertainError("GitHub create comment request timed out");
      }
      const comment = apply();
      events.push({
        kind: "create-comment",
        repository: repositoryName(repository),
        number,
        commentId: comment.id,
        operationId: operation.id,
        outcome: "applied",
      });
      return comment;
    },
    updateComment: async ({ repository, number, commentId, body, operation }) => {
      const mode = consumeLifecycleMode("update-comment");
      lifecycleFailure("update-comment", repository, number, operation.id, mode);
      const existing = commentRecords(repository, number).get(commentId);
      if (existing === undefined) {
        throw new Error(`Fake issue ${repositoryName(repository)}#${number} has no comment ${commentId}`);
      }
      if (existing.author !== FAKE_PROVIDER_AUTHOR) {
        throw new Error(`Fake comment ${commentId} is not owned by the configured provider account.`);
      }
      const apply = (): IssueComment => {
        const existingMarkers = parseCommentProviderBody(existing.body).markers;
        const updated: IssueComment = {
          ...existing,
          body: commentProviderBody(body, [
            ...(existingMarkers.length === 0 ? [] : [existingMarkers[0]!]),
            issueOperationMarker(operation),
          ]),
          updatedAt: new Date(Date.parse(existing.updatedAt) + 1_000).toISOString(),
        };
        commentRecords(repository, number).set(commentId, updated);
        return publicComment(updated);
      };
      if (mode.kind === "timeout") {
        if (mode.afterMutation) apply();
        events.push({
          kind: "update-comment",
          repository: repositoryName(repository),
          number,
          commentId,
          operationId: operation.id,
          outcome: "unknown",
        });
        throw new IssueMutationOutcomeUncertainError("GitHub update comment request timed out");
      }
      const comment = apply();
      events.push({
        kind: "update-comment",
        repository: repositoryName(repository),
        number,
        commentId,
        operationId: operation.id,
        outcome: "applied",
      });
      return comment;
    },
    deleteComment: async ({ repository, number, commentId, operation }) => {
      const mode = consumeLifecycleMode("delete-comment");
      lifecycleFailure("delete-comment", repository, number, operation.id, mode);
      if (!commentRecords(repository, number).has(commentId)) {
        throw new Error(`Fake issue ${repositoryName(repository)}#${number} has no comment ${commentId}`);
      }
      const apply = () => commentRecords(repository, number).delete(commentId);
      if (mode.kind === "timeout") {
        if (mode.afterMutation) apply();
        events.push({
          kind: "delete-comment",
          repository: repositoryName(repository),
          number,
          commentId,
          operationId: operation.id,
          outcome: "unknown",
        });
        throw new IssueMutationOutcomeUncertainError("GitHub delete comment request timed out");
      }
      apply();
      events.push({
        kind: "delete-comment",
        repository: repositoryName(repository),
        number,
        commentId,
        operationId: operation.id,
        outcome: "applied",
      });
    },
    setState: async ({ repository, number, state, reason, operation }) => {
      const mode = consumeLifecycleMode("set-issue-state");
      lifecycleFailure("set-issue-state", repository, number, operation.id, mode);
      const existing = records(repository).get(number);
      if (existing === undefined) throw new Error(`Fake issue ${repositoryName(repository)}#${number} was not found`);
      if ((state === "open") !== (reason === "reopened")) {
        throw new Error("Opening an issue requires reason reopened; closing requires a closed-state reason.");
      }
      const apply = (): Issue => {
        const updated = {
          ...existing,
          state,
          stateReason: reason as IssueStateChangeReason,
        };
        records(repository).set(number, updated);
        return publicRecord(updated);
      };
      if (mode.kind === "timeout") {
        if (mode.afterMutation) apply();
        events.push({
          kind: "set-issue-state",
          repository: repositoryName(repository),
          number,
          operationId: operation.id,
          outcome: "unknown",
        });
        throw new IssueMutationOutcomeUncertainError("GitHub set issue state request timed out");
      }
      const issue = apply();
      events.push({
        kind: "set-issue-state",
        repository: repositoryName(repository),
        number,
        operationId: operation.id,
        outcome: "applied",
      });
      return issue;
    },
    findCommentByOperation: async ({ repository, number, operation }) => {
      const marker = issueOperationMarker(operation);
      const matches = [...commentRecords(repository, number).values()].filter(
        (comment) =>
          comment.author === FAKE_PROVIDER_AUTHOR && parseCommentProviderBody(comment.body).markers.includes(marker),
      );
      events.push({
        kind: "find-comment-operation",
        repository: repositoryName(repository),
        number,
        operationId: operation.id,
        matches: matches.map((comment) => comment.id),
      });
      return matches.map(publicComment);
    },
    findCreated: async ({ repository, operation }) => {
      const marker = issueOperationMarker(operation);
      const matches = [...records(repository).values()].filter((issue) =>
        parseIssueProviderBody(issue.body).markers.includes(marker),
      );
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
      comments.clear();
      nextNumber = 1;
      nextCommentId = 1;
      lifecycleModes.clear();
      repositoryOptions = { labels: [], assignees: [], milestones: [] };
    },
    resetEvents: () => {
      events.length = 0;
    },
    seed,
    seedComment,
    setOptions: (options) => {
      repositoryOptions = {
        labels: [...options.labels],
        assignees: [...options.assignees],
        milestones: options.milestones.map((milestone) => ({ ...milestone })),
      };
    },
    timeoutNextCreate: ({ afterMutation }) => {
      lifecycleModes.set("create", { kind: "timeout", afterMutation });
    },
    timeoutNextUpdate: ({ afterMutation }) => {
      lifecycleModes.set("update", { kind: "timeout", afterMutation });
    },
    failNextCreate: (error) => {
      lifecycleModes.set("create", { kind: "failure", error });
    },
    failNextUpdate: (error) => {
      lifecycleModes.set("update", { kind: "failure", error });
    },
    timeoutNextLifecycleMutation: (kind, { afterMutation }) => {
      lifecycleModes.set(kind, { kind: "timeout", afterMutation });
    },
    failNextLifecycleMutation: (kind, error) => {
      lifecycleModes.set(kind, { kind: "failure", error });
    },
  };
};
