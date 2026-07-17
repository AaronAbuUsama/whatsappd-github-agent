export interface RepositoryRef {
  readonly owner: string;
  readonly repo: string;
}

export const MAX_PUBLIC_ISSUE_BODY_LENGTH = 65_000;
export const MAX_PUBLIC_COMMENT_BODY_LENGTH = 65_000;

export type IssueStateReason = "completed" | "not_planned" | "duplicate" | "reopened" | null;
export type IssueStateChangeReason = Exclude<IssueStateReason, null>;

export interface IssueRef {
  readonly repository: RepositoryRef;
  readonly number: number;
}

export interface IssueSummary extends IssueRef {
  readonly url: string;
  readonly title: string;
  readonly state: "open" | "closed";
}

export interface Issue extends IssueSummary {
  readonly body: string;
  readonly stateReason: IssueStateReason;
  readonly labels: string[];
  readonly assignees: string[];
  readonly milestone: IssueMilestone | null;
}

export interface IssueComment extends IssueRef {
  readonly id: number;
  readonly url: string;
  readonly body: string;
  readonly author: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface IssueDiscussion {
  readonly issue: Issue;
  readonly comments: IssueComment[];
}

export interface IssueMilestone {
  readonly number: number;
  readonly title: string;
  readonly state: "open" | "closed";
}

export interface IssueRepositoryOptions {
  readonly labels: string[];
  readonly assignees: string[];
  readonly milestones: IssueMilestone[];
}

export interface IssueUpdate {
  readonly title?: string;
  readonly body?: string;
  readonly labels?: string[];
  readonly assignees?: string[];
  readonly milestone?: number | null;
}

export interface IssueDraft {
  readonly repository: RepositoryRef;
  readonly kind: "bug" | "feature";
  readonly title: string;
  readonly body: string;
}

export interface OperationIdentity {
  readonly id: string;
}

export interface IssueRepository {
  search(input: {
    readonly repository: RepositoryRef;
    readonly query: string;
    readonly signal?: AbortSignal;
  }): Promise<readonly IssueSummary[]>;
  get(input: IssueRef & { readonly signal?: AbortSignal }): Promise<Issue>;
  options(input: {
    readonly repository: RepositoryRef;
    readonly signal?: AbortSignal;
  }): Promise<IssueRepositoryOptions>;
  create(input: IssueDraft & { readonly operation: OperationIdentity; readonly signal?: AbortSignal }): Promise<Issue>;
  update(
    input: IssueRef & {
      readonly changes: IssueUpdate;
      readonly operation: OperationIdentity;
      readonly signal?: AbortSignal;
    },
  ): Promise<Issue>;
  discussion(input: IssueRef & { readonly signal?: AbortSignal }): Promise<IssueDiscussion>;
  createComment(
    input: IssueRef & {
      readonly body: string;
      readonly operation: OperationIdentity;
      readonly signal?: AbortSignal;
    },
  ): Promise<IssueComment>;
  updateComment(
    input: IssueRef & {
      readonly commentId: number;
      readonly body: string;
      readonly operation: OperationIdentity;
      readonly signal?: AbortSignal;
    },
  ): Promise<IssueComment>;
  deleteComment(
    input: IssueRef & {
      readonly commentId: number;
      readonly operation: OperationIdentity;
      readonly signal?: AbortSignal;
    },
  ): Promise<void>;
  setState(
    input: IssueRef & {
      readonly state: "open" | "closed";
      readonly reason: IssueStateChangeReason;
      readonly operation: OperationIdentity;
      readonly signal?: AbortSignal;
    },
  ): Promise<Issue>;
  findCommentByOperation(input: {
    readonly repository: RepositoryRef;
    readonly number: number;
    readonly operation: OperationIdentity;
    readonly signal?: AbortSignal;
  }): Promise<readonly IssueComment[]>;
  findCreated(input: {
    readonly repository: RepositoryRef;
    readonly operation: OperationIdentity;
    readonly signal?: AbortSignal;
  }): Promise<readonly Issue[]>;
}

export class IssueMutationOutcomeUncertainError extends Error {
  override readonly name = "IssueMutationOutcomeUncertainError";
}

export const isUncertainIssueMutationError = (error: unknown): boolean => {
  const uncertainCodes = new Set([
    "ETIMEDOUT",
    "ECONNRESET",
    "EPIPE",
    "UND_ERR_ABORTED",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_BODY_TIMEOUT",
    "UND_ERR_SOCKET",
  ]);
  const pending: unknown[] = [error];
  const seen = new Set<unknown>();
  while (pending.length > 0) {
    const candidate = pending.pop();
    if (candidate === null || (typeof candidate !== "object" && typeof candidate !== "function")) continue;
    if (seen.has(candidate)) continue;
    seen.add(candidate);
    if (candidate instanceof IssueMutationOutcomeUncertainError) return true;
    if (candidate instanceof Error && (candidate.name === "AbortError" || candidate.name === "TimeoutError")) {
      return true;
    }
    const code = Reflect.get(candidate, "code");
    if (typeof code === "string" && uncertainCodes.has(code)) return true;
    const status = Reflect.get(candidate, "status");
    if (typeof status === "number" && (status === 408 || status >= 500)) return true;
    pending.push(Reflect.get(candidate, "cause"));
  }
  return false;
};
