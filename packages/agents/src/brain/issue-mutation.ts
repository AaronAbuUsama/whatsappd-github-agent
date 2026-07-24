import type { IssueMutation, IssueMutationOutcome } from "@ambient-agent/engine/brain/inbox.ts";
import { errorMessage } from "@ambient-agent/engine/shared/errors.ts";
import { createIssueManagementTools } from "../capabilities/issue-management/tools.ts";
import { isUncertainIssueMutationError } from "../capabilities/issue-management/issue-repository.ts";
import type { IssueManagementRuntime } from "../capabilities/issue-management/runtime.ts";

/** The Operation Identity a mutation carries across crashes: derived from the durable Effect id, so a
 * recovered attempt reconciles the same Operation (strongly-consistent) instead of re-mutating. */
const operationIdFor = (effectId: string): string => `issue-mutation:${effectId}`;

/** Map an issue mutation to the eval-tested capability tool that performs it (packages/agents/src/
 * capabilities/issue-management/tools.ts). Reusing those tools keeps the durable path free of any
 * duplicated GitHub mutation logic — the Brain filer only adds Operation-Identity crash-dedup. */
const toolNameFor = (mutation: IssueMutation): string =>
  mutation.kind === "create-comment"
    ? "github_create_issue_comment"
    : mutation.kind === "update-comment"
      ? "github_update_issue_comment"
      : mutation.kind === "delete-comment"
        ? "github_delete_issue_comment"
        : mutation.kind === "set-issue-state"
          ? "github_set_issue_state"
          : "github_update_issue";

const toolInput = (mutation: IssueMutation): Record<string, unknown> => {
  switch (mutation.kind) {
    case "create-comment":
      return { repository: mutation.repository, number: mutation.number, body: mutation.body };
    case "update-comment":
      return {
        repository: mutation.repository,
        number: mutation.number,
        commentId: mutation.commentId,
        body: mutation.body,
      };
    case "delete-comment":
      return { repository: mutation.repository, number: mutation.number, commentId: mutation.commentId };
    case "set-issue-state":
      return {
        repository: mutation.repository,
        number: mutation.number,
        state: mutation.state,
        reason: mutation.reason,
      };
    case "update-issue":
      return {
        repository: mutation.repository,
        number: mutation.number,
        ...(mutation.title === undefined ? {} : { title: mutation.title }),
        ...(mutation.body === undefined ? {} : { body: mutation.body }),
        ...(mutation.labels === undefined ? {} : { labels: [...mutation.labels] }),
        ...(mutation.assignees === undefined ? {} : { assignees: [...mutation.assignees] }),
        ...(mutation.milestone === undefined ? {} : { milestone: mutation.milestone }),
      };
  }
};

/** Normalize a capability tool result into the durable Effect's terminal outcome. */
const toOutcome = (mutation: IssueMutation, result: Record<string, unknown>): IssueMutationOutcome => {
  const status = result.status as string;
  if (status === "uncertain") return { status: "uncertain", reason: result.reason as string };
  const applied = status === "reconciled" ? ("reconciled" as const) : ("applied" as const);
  if (mutation.kind === "create-comment" || mutation.kind === "update-comment") {
    const comment = result.comment as { id: number; url: string };
    return { status: applied, commentId: comment.id, url: comment.url };
  }
  if (mutation.kind === "delete-comment") return { status: applied, commentId: result.commentId as number };
  const issue = result.issue as { number: number; url: string; state: "open" | "closed" };
  return { status: applied, issueNumber: issue.number, url: issue.url, state: issue.state };
};

/**
 * The Brain's full GitHub issue-mutation write path: run one chosen mutation through the eval-tested
 * capability tool, reduced to a terminal outcome the durable Effect can record. Mirrors createIssueFiler:
 *  - Repository resolution is fail-closed via policy.authorize() (allowlist); the mutation carries its
 *    own explicit repository — routing is the Brain's, never a config default (§8).
 *  - Crash-dedup: the Operation Identity is deterministic in the Effect id. A recovered attempt whose
 *    prior Operation is already begun reconciles by observation instead of re-mutating (which would both
 *    fail the begin on the duplicate id AND risk a duplicate comment).
 *  - Liveness: only genuinely retryable transients rethrow so a live turn (or boot recovery) can retry;
 *    every other failure settles as terminal `uncertain` so the Effect completes and the Batch is not
 *    wedged (§9/§10).
 */
export const createIssueMutator =
  (runtime: IssueManagementRuntime, options: { now?: () => Date } = {}) =>
  async (mutation: IssueMutation, effectId: string): Promise<IssueMutationOutcome> => {
    const now = options.now ?? (() => new Date());
    const operationId = operationIdFor(effectId);
    try {
      const repository = runtime.policy.authorize(mutation.repository);

      // Crash recovery: a prior attempt for this exact Effect already began (and may have applied) the
      // mutation. Never re-mutate — reconcile by observation. GitHub may have applied the mutation even
      // when the local Operation is not `completed` (the completion write was lost to the crash), so
      // observe the provider for BOTH completed and unresolved priors and reconcile whenever the change
      // is actually present. Only a prior with no observable effect settles honestly `uncertain`.
      const prior = runtime.operations.get(operationId);
      if (prior !== undefined) {
        if (mutation.kind === "create-comment" || mutation.kind === "update-comment") {
          const matches = await runtime.repository.findCommentByOperation({
            repository,
            number: mutation.number,
            operation: { id: operationId },
          });
          // Recording the real commentId matters: recordIssueMutation authorizes a later delete/edit only
          // against completed create-comment history, so a lost-completion crash must still reconcile it.
          if (matches.length === 1) return { status: "reconciled", commentId: matches[0]!.id, url: matches[0]!.url };
          if (prior.status === "completed") return { status: "reconciled" };
          return {
            status: "uncertain",
            reason: `A prior attempt to ${mutation.kind} for this Effect did not complete and no matching comment was observed.`,
          };
        }
        if (prior.status !== "completed") {
          return {
            status: "uncertain",
            reason: `A prior attempt to ${mutation.kind} for this Effect did not complete; its outcome is unresolved.`,
          };
        }
        if (mutation.kind === "delete-comment") return { status: "reconciled", commentId: mutation.commentId };
        const issue = await runtime.repository.get({ repository, number: mutation.number });
        return { status: "reconciled", issueNumber: issue.number, url: issue.url, state: issue.state };
      }

      const tool = createIssueManagementTools({ ...runtime, createOperationId: () => operationId, now }).find(
        (candidate) => candidate.name === toolNameFor(mutation),
      );
      if (tool === undefined) throw new Error(`No capability tool for issue mutation ${mutation.kind}.`);
      const result = (await tool.run({ input: toolInput(mutation) })) as Record<string, unknown>;
      return toOutcome(mutation, result);
    } catch (cause) {
      // Retryable transient (timeout/5xx/reset): let the caller retry. Everything else is terminal, so
      // complete the Effect honestly rather than wedging the pipeline.
      if (isUncertainIssueMutationError(cause)) throw cause;
      return { status: "uncertain", reason: errorMessage(cause) };
    }
  };
