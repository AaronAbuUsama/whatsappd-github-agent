import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import {
  isUncertainIssueMutationError,
  type Issue,
  type IssueRepository,
  type IssueStateChangeReason,
  type IssueUpdate,
  type RepositoryRef,
} from "../capabilities/issue-management/issue-repository.js";
import type {
  IssueOperationKind,
  IssueOperationRecord,
  IssueOperationStore,
} from "../capabilities/issue-management/operation-store.js";

/** Only GitHub mutations remain Uncertain work; Window delivery is at-least-once (ADR 0014). */
export type UncertainWorkRef = `mutation:${string}`;

export interface UncertainWorkStatus {
  readonly health: "healthy" | "degraded";
  readonly externalMutations: number;
  readonly total: number;
  readonly mutationKinds: Readonly<Partial<Record<IssueOperationKind, number>>>;
}

export type UncertainEvidence =
  | "operation-identity"
  | "desired-state-only"
  | "no-attributable-evidence"
  | "ambiguous-operation-identity"
  | "provider-read-failed";

export interface UncertainDiagnosis {
  readonly ref: UncertainWorkRef;
  readonly kind?: IssueOperationKind;
  readonly outcome: "reconciled" | "observed" | "unresolved" | "error";
  readonly evidence: UncertainEvidence;
}

export interface UncertainDoctorReport {
  readonly before: UncertainWorkStatus;
  readonly after: UncertainWorkStatus;
  readonly examined: number;
  readonly deferred: number;
  readonly diagnoses: readonly UncertainDiagnosis[];
}

export interface UncertainActionResult {
  readonly ref: UncertainWorkRef;
  readonly outcome: "reconciled" | "accepted" | "retried" | "abandoned" | "uncertain" | "failed";
  readonly replacementRef?: UncertainWorkRef;
}

export interface UncertainWorkController {
  status(): UncertainWorkStatus;
  diagnose(): Promise<UncertainDoctorReport>;
  retry(ref: UncertainWorkRef): Promise<UncertainActionResult>;
  abandon(ref: UncertainWorkRef): UncertainActionResult;
  acceptObserved(ref: UncertainWorkRef): Promise<UncertainActionResult>;
  close(): void;
}

export interface UncertainWorkControllerOptions {
  readonly operations: IssueOperationStore;
  readonly repository: IssueRepository;
  readonly createOperationId?: () => string;
  readonly now?: () => Date;
}

export const inspectUncertainWorkStatus = (databasePath: string): UncertainWorkStatus => {
  if (!existsSync(databasePath)) {
    return { health: "healthy", externalMutations: 0, total: 0, mutationKinds: {} };
  }
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const mutationKinds: Partial<Record<IssueOperationKind, number>> = {};
    const tableExists =
      database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'github_issue_operations'").get() !==
      undefined;
    if (tableExists) {
      const rows = database
        .prepare(
          "SELECT kind, COUNT(*) AS count FROM github_issue_operations WHERE status IN ('uncertain', 'attempting') GROUP BY kind",
        )
        .all() as unknown as Array<{ readonly kind: IssueOperationKind; readonly count: number }>;
      for (const row of rows) mutationKinds[row.kind] = Number(row.count);
    }
    const externalMutations = Object.values(mutationKinds).reduce((total, count) => total + (count ?? 0), 0);
    return {
      health: externalMutations === 0 ? "healthy" : "degraded",
      externalMutations,
      total: externalMutations,
      mutationKinds,
    };
  } finally {
    database.close();
  }
};

const operationRef = (operationId: string): UncertainWorkRef => `mutation:${operationId}`;

const parseRef = (ref: UncertainWorkRef): string => {
  const separator = ref.indexOf(":");
  const category = ref.slice(0, separator);
  const id = ref.slice(separator + 1).trim();
  if (!id || category !== "mutation") {
    throw new Error("Uncertain work must be identified as mutation:<operationId>.");
  }
  return id;
};

const repositoryRef = (value: string): RepositoryRef => {
  const match = /^([^/]+)\/([^/]+)$/.exec(value);
  if (match === null) throw new Error("The stored GitHub repository is malformed.");
  return { owner: match[1]!, repo: match[2]! };
};

const sameValues = (left: readonly string[], right: readonly string[]): boolean => {
  const normalize = (values: readonly string[]): string[] => [...values].map((value) => value.toLowerCase()).sort();
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
};

const numberValue = (target: Readonly<Record<string, unknown>>, key: string): number => {
  const value = target[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`The stored ${key} is not retryable.`);
  }
  return value;
};

const stringValue = (target: Readonly<Record<string, unknown>>, key: string): string => {
  const value = target[key];
  if (typeof value !== "string" || !value) throw new Error(`The stored ${key} is not retryable.`);
  return value;
};

const textValue = (target: Readonly<Record<string, unknown>>, key: string): string => {
  const value = target[key];
  if (typeof value !== "string") throw new Error(`The stored ${key} is not retryable.`);
  return value;
};

const matchesIssueUpdate = (issue: Issue, target: Readonly<Record<string, unknown>>): boolean => {
  const title = target.title;
  const body = target.body;
  const labels = target.labels;
  const assignees = target.assignees;
  const milestone = target.milestone;
  return (
    (title === undefined || (typeof title === "string" && issue.title === title)) &&
    (body === undefined || (typeof body === "string" && issue.body === body)) &&
    (labels === undefined ||
      (Array.isArray(labels) &&
        labels.every((value) => typeof value === "string") &&
        sameValues(issue.labels, labels))) &&
    (assignees === undefined ||
      (Array.isArray(assignees) &&
        assignees.every((value) => typeof value === "string") &&
        sameValues(issue.assignees, assignees))) &&
    (milestone === undefined ||
      (milestone === null
        ? issue.milestone === null
        : typeof milestone === "number" && issue.milestone?.number === milestone))
  );
};

const issueUpdate = (target: Readonly<Record<string, unknown>>): IssueUpdate => ({
  ...(target.title === undefined ? {} : { title: stringValue(target, "title") }),
  ...(target.body === undefined ? {} : { body: textValue(target, "body") }),
  ...(target.labels === undefined ? {} : { labels: target.labels as string[] }),
  ...(target.assignees === undefined ? {} : { assignees: target.assignees as string[] }),
  ...(target.milestone === undefined ? {} : { milestone: target.milestone as number | null }),
});

const operationTarget = (operation: IssueOperationRecord): Readonly<Record<string, unknown>> => {
  if (operation.target === undefined) {
    throw new Error(`Issue operation ${operation.operationId} predates durable retry inputs and cannot be retried.`);
  }
  return operation.target;
};

const boundedSignal = (): AbortSignal => AbortSignal.timeout(10_000);
const MAX_DIAGNOSES_PER_RUN = 25;

export const createUncertainWorkController = (options: UncertainWorkControllerOptions): UncertainWorkController => {
  const now = options.now ?? (() => new Date());
  const createOperationId = options.createOperationId ?? randomUUID;
  const currentStatus = (): UncertainWorkStatus => {
    const uncertain = options.operations.list().filter((operation) => operation.status === "uncertain");
    const mutationKinds: Partial<Record<IssueOperationKind, number>> = {};
    for (const operation of uncertain) mutationKinds[operation.kind] = (mutationKinds[operation.kind] ?? 0) + 1;
    return {
      health: uncertain.length === 0 ? "healthy" : "degraded",
      externalMutations: uncertain.length,
      total: uncertain.length,
      mutationKinds,
    };
  };

  const complete = (operation: IssueOperationRecord, issueNumber: number): UncertainDiagnosis => {
    options.operations.resolveUncertain({
      operationId: operation.operationId,
      status: "completed",
      resolution: "reconciled",
      settledAt: now().toISOString(),
      issueNumber,
    });
    return {
      ref: operationRef(operation.operationId),
      kind: operation.kind,
      outcome: "reconciled",
      evidence: "operation-identity",
    };
  };

  const diagnosis = (
    operation: IssueOperationRecord,
    outcome: UncertainDiagnosis["outcome"],
    evidence: UncertainEvidence,
  ): UncertainDiagnosis => ({
    ref: operationRef(operation.operationId),
    kind: operation.kind,
    outcome,
    evidence,
  });

  const diagnoseMutation = async (operation: IssueOperationRecord): Promise<UncertainDiagnosis> => {
    const repository = repositoryRef(operation.repository);
    const signal = boundedSignal();
    try {
      if (operation.kind === "create-issue" || operation.kind === "update-issue") {
        const matches = await options.repository.findCreated({
          repository,
          operation: { id: operation.operationId },
          signal,
        });
        const attributable =
          operation.kind === "create-issue"
            ? matches
            : matches.filter((issue) => issue.number === operation.issueNumber);
        if (attributable.length === 1) return complete(operation, attributable[0]!.number);
        if (attributable.length > 1) return diagnosis(operation, "unresolved", "ambiguous-operation-identity");
        if (
          operation.kind === "create-issue" ||
          operation.issueNumber === undefined ||
          operation.target === undefined
        ) {
          return diagnosis(operation, "unresolved", "no-attributable-evidence");
        }
        const issue = await options.repository.get({ repository, number: operation.issueNumber, signal });
        return matchesIssueUpdate(issue, operation.target)
          ? diagnosis(operation, "observed", "desired-state-only")
          : diagnosis(operation, "unresolved", "no-attributable-evidence");
      }

      if (operation.issueNumber === undefined) return diagnosis(operation, "unresolved", "no-attributable-evidence");
      if (operation.kind === "create-comment" || operation.kind === "update-comment") {
        const matches = await options.repository.findCommentByOperation({
          repository,
          number: operation.issueNumber,
          operation: { id: operation.operationId },
          signal,
        });
        const attributable =
          operation.kind === "update-comment" && operation.target !== undefined
            ? matches.filter((comment) => comment.id === operation.target?.commentId)
            : matches;
        if (attributable.length === 1) return complete(operation, operation.issueNumber);
        return diagnosis(
          operation,
          "unresolved",
          attributable.length > 1 ? "ambiguous-operation-identity" : "no-attributable-evidence",
        );
      }

      const target = operationTarget(operation);
      if (operation.kind === "delete-comment") {
        const commentId = numberValue(target, "commentId");
        const discussion = await options.repository.discussion({ repository, number: operation.issueNumber, signal });
        return discussion.comments.some((comment) => comment.id === commentId)
          ? diagnosis(operation, "unresolved", "no-attributable-evidence")
          : diagnosis(operation, "observed", "desired-state-only");
      }

      const issue = await options.repository.get({ repository, number: operation.issueNumber, signal });
      const state = stringValue(target, "state");
      const reason = stringValue(target, "reason");
      return issue.state === state && issue.stateReason === reason
        ? diagnosis(operation, "observed", "desired-state-only")
        : diagnosis(operation, "unresolved", "no-attributable-evidence");
    } catch {
      return diagnosis(operation, "error", "provider-read-failed");
    }
  };

  const diagnoseRef = async (ref: UncertainWorkRef): Promise<UncertainDiagnosis> => {
    const operationId = parseRef(ref);
    const operation = options.operations.get(operationId);
    if (operation?.status !== "uncertain") throw new Error(`Issue operation ${operationId} is not Uncertain.`);
    return await diagnoseMutation(operation);
  };

  const retryMutation = async (operation: IssueOperationRecord): Promise<UncertainActionResult> => {
    const target = operationTarget(operation);
    const repository = repositoryRef(operation.repository);
    const replacementOperationId = createOperationId();
    const startedAt = now().toISOString();
    const { replacement } = options.operations.retryUncertain({
      operationId: operation.operationId,
      replacementOperationId,
      startedAt,
    });
    const operationIdentity = { id: replacementOperationId };
    let issueNumber: number;
    try {
      switch (replacement.kind) {
        case "create-issue": {
          const kind = stringValue(target, "kind");
          if (kind !== "bug" && kind !== "feature") throw new Error("The stored issue kind is not retryable.");
          const issue = await options.repository.create({
            repository,
            kind,
            title: stringValue(target, "title"),
            body: stringValue(target, "body"),
            operation: operationIdentity,
            signal: boundedSignal(),
          });
          issueNumber = issue.number;
          break;
        }
        case "update-issue": {
          if (replacement.issueNumber === undefined) throw new Error("The stored issue number is not retryable.");
          const issue = await options.repository.update({
            repository,
            number: replacement.issueNumber,
            changes: issueUpdate(target),
            operation: operationIdentity,
            signal: boundedSignal(),
          });
          issueNumber = issue.number;
          break;
        }
        case "create-comment": {
          if (replacement.issueNumber === undefined) throw new Error("The stored issue number is not retryable.");
          await options.repository.createComment({
            repository,
            number: replacement.issueNumber,
            body: stringValue(target, "body"),
            operation: operationIdentity,
            signal: boundedSignal(),
          });
          issueNumber = replacement.issueNumber;
          break;
        }
        case "update-comment": {
          if (replacement.issueNumber === undefined) throw new Error("The stored issue number is not retryable.");
          await options.repository.updateComment({
            repository,
            number: replacement.issueNumber,
            commentId: numberValue(target, "commentId"),
            body: stringValue(target, "body"),
            operation: operationIdentity,
            signal: boundedSignal(),
          });
          issueNumber = replacement.issueNumber;
          break;
        }
        case "delete-comment": {
          if (replacement.issueNumber === undefined) throw new Error("The stored issue number is not retryable.");
          await options.repository.deleteComment({
            repository,
            number: replacement.issueNumber,
            commentId: numberValue(target, "commentId"),
            operation: operationIdentity,
            signal: boundedSignal(),
          });
          issueNumber = replacement.issueNumber;
          break;
        }
        case "set-issue-state": {
          if (replacement.issueNumber === undefined) throw new Error("The stored issue number is not retryable.");
          const state = stringValue(target, "state");
          const reason = stringValue(target, "reason") as IssueStateChangeReason;
          if (state !== "open" && state !== "closed") throw new Error("The stored issue state is not retryable.");
          await options.repository.setState({
            repository,
            number: replacement.issueNumber,
            state,
            reason,
            operation: operationIdentity,
            signal: boundedSignal(),
          });
          issueNumber = replacement.issueNumber;
          break;
        }
      }
    } catch (cause) {
      if (isUncertainIssueMutationError(cause)) {
        options.operations.uncertain(
          replacementOperationId,
          "Explicit retry outcome remained uncertain after the bounded provider call",
          now().toISOString(),
        );
        return {
          ref: operationRef(operation.operationId),
          outcome: "uncertain",
          replacementRef: operationRef(replacementOperationId),
        };
      }
      options.operations.fail(
        replacementOperationId,
        cause instanceof Error ? cause.message : String(cause),
        now().toISOString(),
      );
      return {
        ref: operationRef(operation.operationId),
        outcome: "failed",
        replacementRef: operationRef(replacementOperationId),
      };
    }
    try {
      options.operations.complete(replacementOperationId, issueNumber!, now().toISOString());
      return {
        ref: operationRef(operation.operationId),
        outcome: "retried",
        replacementRef: operationRef(replacementOperationId),
      };
    } catch (completionCause) {
      try {
        const current = options.operations.get(replacementOperationId);
        if (current?.status === "completed") {
          return {
            ref: operationRef(operation.operationId),
            outcome: "retried",
            replacementRef: operationRef(replacementOperationId),
          };
        }
        if (current?.status === "attempting") {
          options.operations.uncertain(
            replacementOperationId,
            "GitHub returned success, but the replacement Operation Identity completion could not be persisted",
            now().toISOString(),
          );
          return {
            ref: operationRef(operation.operationId),
            outcome: "uncertain",
            replacementRef: operationRef(replacementOperationId),
          };
        }
        if (current?.status === "uncertain") {
          return {
            ref: operationRef(operation.operationId),
            outcome: "uncertain",
            replacementRef: operationRef(replacementOperationId),
          };
        }
      } catch (ledgerCause) {
        throw new AggregateError(
          [completionCause, ledgerCause],
          "GitHub returned success, but its replacement Operation Identity state could not be recorded. Do not retry automatically.",
        );
      }
      throw completionCause;
    }
  };

  return {
    status: currentStatus,
    diagnose: async () => {
      const before = currentStatus();
      const operations = options.operations.uncertainForDiagnosis(MAX_DIAGNOSES_PER_RUN);
      const diagnoses: UncertainDiagnosis[] = [];
      for (const operation of operations) {
        options.operations.markExamined(operation.operationId, now().toISOString());
        diagnoses.push(await diagnoseMutation(operation));
      }
      return {
        before,
        after: currentStatus(),
        examined: diagnoses.length,
        deferred: Math.max(0, before.total - diagnoses.length),
        diagnoses,
      };
    },
    retry: async (ref) => {
      const operationId = parseRef(ref);
      const observed = await diagnoseRef(ref);
      if (observed.outcome === "reconciled") return { ref, outcome: "reconciled" };
      if (observed.outcome === "observed") {
        throw new Error(`Observed desired state for ${ref}; use --accept-observed or --abandon instead of retrying.`);
      }
      const operation = options.operations.get(operationId)!;
      return await retryMutation(operation);
    },
    abandon: (ref) => {
      const operationId = parseRef(ref);
      options.operations.resolveUncertain({
        operationId,
        status: "abandoned",
        resolution: "abandoned",
        settledAt: now().toISOString(),
      });
      return { ref, outcome: "abandoned" };
    },
    acceptObserved: async (ref) => {
      const operationId = parseRef(ref);
      const observed = await diagnoseRef(ref);
      if (observed.outcome === "reconciled") return { ref, outcome: "reconciled" };
      if (observed.outcome !== "observed") {
        throw new Error(`No desired-state observation is available for ${ref}.`);
      }
      const operation = options.operations.get(operationId)!;
      options.operations.resolveUncertain({
        operationId,
        status: "completed",
        resolution: "accepted-observed",
        settledAt: now().toISOString(),
        issueNumber: operation.issueNumber,
      });
      return { ref, outcome: "accepted" };
    },
    close: () => {
      options.operations.close();
    },
  };
};
