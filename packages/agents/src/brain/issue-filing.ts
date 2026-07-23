import type { FileIssueOutcome, FileIssueRequest } from "@ambient-agent/engine/brain/inbox.ts";
import { errorMessage } from "@ambient-agent/engine/shared/errors.ts";
import { createIssue } from "../capabilities/issue-management/tools.ts";
import { isUncertainIssueMutationError } from "../capabilities/issue-management/issue-repository.ts";
import type { IssueManagementRuntime } from "../capabilities/issue-management/runtime.ts";

/** The Operation Identity a filing carries across crashes: derived from the durable Effect id, so a
 * recovered attempt reconciles the same Operation (strongly-consistent) instead of minting a new one. */
const operationIdFor = (effectId: string): string => `issue-filing:${effectId}`;

/**
 * The Brain's single GitHub write: file one issue through the existing durable `createIssue`
 * path (duplicate guard + Operation Identity), then reduce its result to a terminal outcome the
 * durable Effect can record. The Speaker stays GitHub-write-free; this is the only new write.
 *
 * Robustness the durable Effect depends on:
 *  - Crash-dedup: the Operation Identity is deterministic in the Effect id, so a recovered filing
 *    reconciles by `operations.get` / `findCreated` (strongly consistent) before ever re-creating —
 *    the leading title search is eventually consistent and would file a duplicate at a fast restart.
 *  - Liveness: only genuinely retryable transients (`isUncertainIssueMutationError`) are rethrown so
 *    a live in-turn Brain (or boot recovery) can retry; every other failure — a removed-allowlist
 *    repo, 404/410/403, a non-indexed search error — settles as a terminal `uncertain` outcome so the
 *    Effect completes and the Brain reports honestly instead of wedging the pipeline (§9/§10).
 */
export const createIssueFiler =
  (runtime: IssueManagementRuntime, options: { now?: () => Date } = {}) =>
  async (request: FileIssueRequest, effectId: string): Promise<FileIssueOutcome> => {
    const now = options.now ?? (() => new Date());
    const operationId = operationIdFor(effectId);
    try {
      const repository = runtime.policy.authorize(request.repository);

      // Crash recovery: a prior attempt for this exact Effect already began (and may have created)
      // the issue. Reconcile by Operation Identity before re-creating — never trust the eventually
      // consistent title search to notice a create that landed seconds before the restart.
      const prior = runtime.operations.get(operationId);
      if (prior !== undefined) {
        if (prior.status === "completed" && prior.issueNumber !== undefined) {
          const issue = await runtime.repository.get({ repository, number: prior.issueNumber });
          return { status: "reconciled", issueNumber: issue.number, url: issue.url };
        }
        const observed = await runtime.repository.findCreated({ repository, operation: { id: operationId } });
        if (observed.length >= 1) {
          return { status: "reconciled", issueNumber: observed[0]!.number, url: observed[0]!.url };
        }
        return {
          status: "uncertain",
          reason: "A prior attempt to file this issue did not create it and its outcome is unresolved.",
        };
      }

      const result = await createIssue({
        repository,
        kind: request.kind,
        title: request.title,
        body: request.body,
        provider: runtime.repository,
        operations: runtime.operations,
        createOperationId: () => operationId,
        now,
      });
      if (result.status === "duplicate") {
        return {
          status: "duplicate",
          issues: result.issues.map((issue) => ({ number: issue.number, url: issue.url, title: issue.title })),
        };
      }
      if (result.status === "uncertain") return { status: "uncertain", reason: result.reason };
      return { status: result.status, issueNumber: result.issue.number, url: result.issue.url };
    } catch (cause) {
      // Retryable transient (timeout/5xx/reset): let the caller retry — a live turn re-runs it and
      // boot recovery leaves it pending. Everything else is terminal, so complete the Effect honestly.
      if (isUncertainIssueMutationError(cause)) throw cause;
      return { status: "uncertain", reason: errorMessage(cause) };
    }
  };
