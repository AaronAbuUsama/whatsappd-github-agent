import { randomUUID } from "node:crypto";

import type { FileIssueOutcome, FileIssueRequest } from "@ambient-agent/engine/brain/inbox.ts";
import { createIssue } from "../capabilities/issue-management/tools.ts";
import type { IssueManagementRuntime } from "../capabilities/issue-management/runtime.ts";

/**
 * The Brain's single GitHub write: file one issue through the existing durable `createIssue`
 * path (duplicate guard + Operation Identity), then reduce its result to a terminal outcome the
 * durable Effect can record. The Speaker stays GitHub-write-free; this is the only new write.
 */
export const createIssueFiler =
  (runtime: IssueManagementRuntime, options: { createOperationId?: () => string; now?: () => Date } = {}) =>
  async (request: FileIssueRequest): Promise<FileIssueOutcome> => {
    const repository = runtime.policy.authorize(request.repository);
    const result = await createIssue({
      repository,
      kind: request.kind,
      title: request.title,
      body: request.body,
      provider: runtime.repository,
      operations: runtime.operations,
      createOperationId: options.createOperationId ?? randomUUID,
      now: options.now ?? (() => new Date()),
    });
    if (result.status === "duplicate") {
      return {
        status: "duplicate",
        issues: result.issues.map((issue) => ({ number: issue.number, url: issue.url, title: issue.title })),
      };
    }
    if (result.status === "uncertain") return { status: "uncertain", reason: result.reason };
    return { status: result.status, issueNumber: result.issue.number, url: result.issue.url };
  };
