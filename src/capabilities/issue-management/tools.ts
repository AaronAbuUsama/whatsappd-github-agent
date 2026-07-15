import { randomUUID } from "node:crypto";

import { defineTool, type ToolDefinition } from "@flue/runtime";
import * as v from "valibot";

import {
  isUncertainIssueMutationError,
  MAX_PUBLIC_ISSUE_BODY_LENGTH,
  type Issue,
  type IssueRepository,
  type IssueRepositoryOptions,
  type IssueSummary,
  type IssueUpdate,
} from "./issue-repository.ts";
import type { IssueOperationStore } from "./operation-store.ts";
import {
  getIssueManagementRuntime,
  repositoryName,
  type IssueManagementPolicy,
  type IssueManagementRuntime,
} from "./runtime.ts";

const nonEmptyString = v.pipe(v.string(), v.trim(), v.minLength(1));
const repositoryInput = v.optional(nonEmptyString);
const issueNumber = v.pipe(v.number(), v.integer(), v.minValue(1));
const stateSchema = v.union([v.literal("open"), v.literal("closed")]);
const summarySchema = v.object({
  repository: v.object({ owner: nonEmptyString, repo: nonEmptyString }),
  number: issueNumber,
  url: v.pipe(v.string(), v.url()),
  title: nonEmptyString,
  state: stateSchema,
});
const milestoneSchema = v.object({
  number: issueNumber,
  title: nonEmptyString,
  state: stateSchema,
});
const issueSchema = v.intersect([
  summarySchema,
  v.object({
    body: v.string(),
    labels: v.array(nonEmptyString),
    assignees: v.array(nonEmptyString),
    milestone: v.nullable(milestoneSchema),
  }),
]);
const optionsSchema = v.object({
  labels: v.array(nonEmptyString),
  assignees: v.array(nonEmptyString),
  milestones: v.array(milestoneSchema),
});
const createOutputSchema = v.union([
  v.object({ status: v.literal("duplicate"), issues: v.array(summarySchema) }),
  v.object({
    status: v.union([v.literal("created"), v.literal("reconciled")]),
    operationId: nonEmptyString,
    issue: issueSchema,
  }),
  v.object({
    status: v.literal("uncertain"),
    operationId: nonEmptyString,
    reason: nonEmptyString,
    issue: v.optional(issueSchema),
  }),
]);
const updateOutputSchema = v.union([
  v.object({
    status: v.union([v.literal("updated"), v.literal("reconciled")]),
    operationId: nonEmptyString,
    issue: issueSchema,
  }),
  v.object({
    status: v.literal("uncertain"),
    operationId: nonEmptyString,
    reason: nonEmptyString,
    issue: v.optional(issueSchema),
  }),
]);

const publicSummary = (issue: IssueSummary): IssueSummary => ({
  repository: issue.repository,
  number: issue.number,
  url: issue.url,
  title: issue.title,
  state: issue.state,
});

const publicIssue = (issue: Issue): Issue => ({
  ...publicSummary(issue),
  body: issue.body,
  labels: [...issue.labels],
  assignees: [...issue.assignees],
  milestone: issue.milestone,
});
const errorMessage = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));
const normalizedTitle = (title: string): string => title.trim().replaceAll(/\s+/g, " ").toLowerCase();

const RECONCILIATION_TIMEOUT_MS = 10_000;
const reconciliationSignal = (signal?: AbortSignal): AbortSignal => {
  const timeout = AbortSignal.timeout(RECONCILIATION_TIMEOUT_MS);
  if (signal === undefined || signal.aborted) return timeout;
  return AbortSignal.any([signal, timeout]);
};

export interface IssueManagementToolOptions extends IssueManagementRuntime {
  readonly createOperationId?: () => string;
  readonly now?: () => Date;
}

const createIssue = async (input: {
  readonly repository: ReturnType<IssueManagementPolicy["authorize"]>;
  readonly kind: "bug" | "feature";
  readonly title: string;
  readonly body: string;
  readonly provider: IssueRepository;
  readonly operations: IssueOperationStore;
  readonly createOperationId: () => string;
  readonly now: () => Date;
  readonly signal?: AbortSignal;
}): Promise<v.InferOutput<typeof createOutputSchema>> => {
  const related = await input.provider.search({
    repository: input.repository,
    query: input.title,
    signal: input.signal,
  });
  const duplicates = related.filter((issue) => normalizedTitle(issue.title) === normalizedTitle(input.title));
  if (duplicates.length > 0) {
    return { status: "duplicate", issues: duplicates.map(publicSummary) };
  }

  const operationId = input.createOperationId();
  const operation = { id: operationId };
  input.operations.begin({
    operationId,
    kind: "create-issue",
    repository: repositoryName(input.repository),
    startedAt: input.now().toISOString(),
  });
  const settleCreated = (issue: Issue, status: "created" | "reconciled"): v.InferOutput<typeof createOutputSchema> => {
    try {
      input.operations.complete(operationId, issue.number, input.now().toISOString());
      return { status, operationId, issue: publicIssue(issue) };
    } catch (cause) {
      try {
        const current = input.operations.get(operationId);
        if (current?.status === "completed") return { status, operationId, issue: publicIssue(issue) };
        const reason = `GitHub issue ${issue.number} exists, but its Operation Identity completion could not be persisted: ${errorMessage(cause)}`;
        if (current?.status === "attempting") {
          input.operations.uncertain(operationId, reason, input.now().toISOString());
          return { status: "uncertain", operationId, reason, issue: publicIssue(issue) };
        }
      } catch (ledgerCause) {
        throw new Error(
          `GitHub issue ${issue.number} exists, but its Operation Identity state could not be recorded. Do not repeat creation.`,
          { cause: ledgerCause },
        );
      }
      throw new Error(
        `GitHub issue ${issue.number} exists with an unresolved Operation Identity state. Do not repeat creation.`,
        { cause },
      );
    }
  };

  let issue: Issue;
  try {
    issue = await input.provider.create({
      repository: input.repository,
      kind: input.kind,
      title: input.title,
      body: input.body,
      operation,
      signal: input.signal,
    });
  } catch (cause) {
    if (!isUncertainIssueMutationError(cause)) {
      input.operations.fail(operationId, errorMessage(cause), input.now().toISOString());
      throw cause;
    }
    try {
      const observed = await input.provider.findCreated({
        repository: input.repository,
        operation,
        signal: reconciliationSignal(input.signal),
      });
      if (observed.length === 1) {
        return settleCreated(observed[0]!, "reconciled");
      }
      const reason =
        observed.length === 0
          ? "GitHub create outcome remained uncertain after Operation Identity observation"
          : `Operation Identity matched ${observed.length} GitHub issues; refusing to guess`;
      input.operations.uncertain(operationId, reason, input.now().toISOString());
      return { status: "uncertain", operationId, reason };
    } catch {
      const reason =
        "GitHub create outcome remained uncertain because Operation Identity observation could not complete";
      input.operations.uncertain(operationId, reason, input.now().toISOString());
      return { status: "uncertain", operationId, reason };
    }
  }
  return settleCreated(issue, "created");
};

const canonicalValues = (requested: readonly string[], existing: readonly string[], kind: string): string[] => {
  const byKey = new Map(existing.map((value) => [value.toLowerCase(), value]));
  const canonical: string[] = [];
  const seen = new Set<string>();
  for (const value of requested) {
    const match = byKey.get(value.toLowerCase());
    if (match === undefined) throw new Error(`GitHub ${kind} "${value}" does not exist in the authorized repository.`);
    const key = match.toLowerCase();
    if (!seen.has(key)) canonical.push(match);
    seen.add(key);
  }
  return canonical;
};

const validatedUpdate = (requested: IssueUpdate, options?: IssueRepositoryOptions): IssueUpdate => {
  if (Object.keys(requested).length === 0) throw new Error("At least one issue field must be supplied for update.");
  const changes: IssueUpdate = {
    ...(requested.title === undefined ? {} : { title: requested.title }),
    ...(requested.body === undefined ? {} : { body: requested.body }),
    ...(requested.labels === undefined
      ? {}
      : { labels: canonicalValues(requested.labels, options?.labels ?? [], "label") }),
    ...(requested.assignees === undefined
      ? {}
      : { assignees: canonicalValues(requested.assignees, options?.assignees ?? [], "assignee") }),
    ...(requested.milestone === undefined ? {} : { milestone: requested.milestone }),
  };
  if (requested.milestone !== undefined && requested.milestone !== null) {
    const milestone = options?.milestones.find((candidate) => candidate.number === requested.milestone);
    if (milestone === undefined) {
      throw new Error(`GitHub milestone #${requested.milestone} does not exist in the authorized repository.`);
    }
  }
  return changes;
};

const sameValues = (left: readonly string[], right: readonly string[]): boolean => {
  const normalize = (values: readonly string[]) => [...values].map((value) => value.toLowerCase()).sort();
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
};

const matchesUpdate = (issue: Issue, changes: IssueUpdate): boolean =>
  (changes.title === undefined || issue.title === changes.title) &&
  (changes.body === undefined || issue.body === changes.body) &&
  (changes.labels === undefined || sameValues(issue.labels, changes.labels)) &&
  (changes.assignees === undefined || sameValues(issue.assignees, changes.assignees)) &&
  (changes.milestone === undefined ||
    issue.milestone?.number === changes.milestone ||
    (issue.milestone === null && changes.milestone === null));

const updateIssue = async (input: {
  readonly repository: ReturnType<IssueManagementPolicy["authorize"]>;
  readonly number: number;
  readonly changes: IssueUpdate;
  readonly provider: IssueRepository;
  readonly operations: IssueOperationStore;
  readonly createOperationId: () => string;
  readonly now: () => Date;
  readonly signal?: AbortSignal;
}): Promise<v.InferOutput<typeof updateOutputSchema>> => {
  await input.provider.get({ repository: input.repository, number: input.number, signal: input.signal });
  const needsOptions =
    input.changes.labels !== undefined ||
    input.changes.assignees !== undefined ||
    input.changes.milestone !== undefined;
  const options = needsOptions
    ? await input.provider.options({ repository: input.repository, signal: input.signal })
    : undefined;
  const changes = validatedUpdate(input.changes, options);
  const operationId = input.createOperationId();
  const operation = { id: operationId };
  input.operations.begin({
    operationId,
    kind: "update-issue",
    repository: repositoryName(input.repository),
    issueNumber: input.number,
    target: { ...changes } as Record<string, unknown>,
    startedAt: input.now().toISOString(),
  });
  const settleUpdated = (issue: Issue, status: "updated" | "reconciled"): v.InferOutput<typeof updateOutputSchema> => {
    try {
      input.operations.complete(operationId, issue.number, input.now().toISOString());
      return { status, operationId, issue: publicIssue(issue) };
    } catch (cause) {
      try {
        const current = input.operations.get(operationId);
        if (current?.status === "completed") return { status, operationId, issue: publicIssue(issue) };
        const reason = `GitHub issue ${issue.number} reflects the update, but its Operation Identity completion could not be persisted: ${errorMessage(cause)}`;
        if (current?.status === "attempting") {
          input.operations.uncertain(operationId, reason, input.now().toISOString());
          return { status: "uncertain", operationId, reason, issue: publicIssue(issue) };
        }
      } catch (ledgerCause) {
        throw new Error(
          `GitHub issue ${issue.number} may reflect the update, but its Operation Identity state could not be recorded. Do not repeat the mutation.`,
          { cause: ledgerCause },
        );
      }
      throw new Error(
        `GitHub issue ${issue.number} may reflect the update with an unresolved Operation Identity state. Do not repeat the mutation.`,
        { cause },
      );
    }
  };

  let issue: Issue;
  try {
    issue = await input.provider.update({
      repository: input.repository,
      number: input.number,
      changes,
      operation,
      signal: input.signal,
    });
  } catch (cause) {
    if (!isUncertainIssueMutationError(cause)) {
      input.operations.fail(operationId, errorMessage(cause), input.now().toISOString());
      throw cause;
    }
    let observed: Issue;
    try {
      observed = await input.provider.get({
        repository: input.repository,
        number: input.number,
        signal: reconciliationSignal(input.signal),
      });
    } catch {
      const reason =
        "GitHub update outcome remained uncertain because exact issue-state observation could not complete";
      input.operations.uncertain(operationId, reason, input.now().toISOString());
      return { status: "uncertain", operationId, reason };
    }
    if (matchesUpdate(observed, changes)) return settleUpdated(observed, "reconciled");
    const reason = "GitHub update outcome remained uncertain after exact issue-state observation";
    input.operations.uncertain(operationId, reason, input.now().toISOString());
    return { status: "uncertain", operationId, reason, issue: publicIssue(observed) };
  }
  return settleUpdated(issue, "updated");
};

export const createIssueManagementTools = (
  options: IssueManagementToolOptions = getIssueManagementRuntime(),
): ToolDefinition[] => {
  const createOperationId = options.createOperationId ?? randomUUID;
  const now = options.now ?? (() => new Date());
  return [
    defineTool({
      name: "github_search_issues",
      description: "Search issues in one authorized GitHub repository before reading or creating work.",
      input: v.object({ repository: repositoryInput, query: nonEmptyString }),
      output: v.object({ issues: v.array(summarySchema) }),
      run: async ({ input, signal }) => {
        const repository = options.policy.authorize(input.repository);
        const issues = await options.repository.search({ repository, query: input.query, signal });
        return { issues: issues.map(publicSummary) };
      },
    }),
    defineTool({
      name: "github_read_issue",
      description: "Read one issue from an authorized GitHub repository.",
      input: v.object({ repository: repositoryInput, number: issueNumber }),
      output: issueSchema,
      run: async ({ input, signal }) => {
        const repository = options.policy.authorize(input.repository);
        return publicIssue(await options.repository.get({ repository, number: input.number, signal }));
      },
    }),
    defineTool({
      name: "github_list_issue_options",
      description: "List existing labels, assignable users, and milestones in one authorized GitHub repository.",
      input: v.object({ repository: repositoryInput }),
      output: optionsSchema,
      run: async ({ input, signal }) => {
        const repository = options.policy.authorize(input.repository);
        const available = await options.repository.options({ repository, signal });
        return {
          labels: [...available.labels],
          assignees: [...available.assignees],
          milestones: available.milestones.map((milestone) => ({ ...milestone })),
        };
      },
    }),
    defineTool({
      name: "github_create_issue",
      description:
        "Search for duplicates, then create one complete bug or feature issue in an authorized GitHub repository.",
      input: v.object({
        repository: repositoryInput,
        kind: v.union([v.literal("bug"), v.literal("feature")]),
        title: v.pipe(nonEmptyString, v.maxLength(256)),
        body: v.pipe(nonEmptyString, v.maxLength(MAX_PUBLIC_ISSUE_BODY_LENGTH)),
      }),
      output: createOutputSchema,
      run: async ({ input, signal }) =>
        await createIssue({
          repository: options.policy.authorize(input.repository),
          kind: input.kind,
          title: input.title,
          body: input.body,
          provider: options.repository,
          operations: options.operations,
          createOperationId,
          now,
          signal,
        }),
    }),
    defineTool({
      name: "github_update_issue",
      description:
        "Read one issue, validate existing repository metadata, then update its title, body, labels, assignees, or milestone.",
      input: v.object({
        repository: repositoryInput,
        number: issueNumber,
        title: v.optional(v.pipe(nonEmptyString, v.maxLength(256))),
        body: v.optional(v.pipe(v.string(), v.maxLength(MAX_PUBLIC_ISSUE_BODY_LENGTH))),
        labels: v.optional(v.array(nonEmptyString)),
        assignees: v.optional(v.array(nonEmptyString)),
        milestone: v.optional(v.nullable(issueNumber)),
      }),
      output: updateOutputSchema,
      run: async ({ input, signal }) =>
        await updateIssue({
          repository: options.policy.authorize(input.repository),
          number: input.number,
          changes: {
            ...(input.title === undefined ? {} : { title: input.title }),
            ...(input.body === undefined ? {} : { body: input.body }),
            ...(input.labels === undefined ? {} : { labels: input.labels }),
            ...(input.assignees === undefined ? {} : { assignees: input.assignees }),
            ...(input.milestone === undefined ? {} : { milestone: input.milestone }),
          },
          provider: options.repository,
          operations: options.operations,
          createOperationId,
          now,
          signal,
        }),
    }),
  ];
};
