import { randomUUID } from "node:crypto";

import { Octokit } from "@octokit/rest";
import { describe, expect, it } from "vite-plus/test";

import { createIssueOperationStore } from "@ambient-agent/core/capabilities/issue-management/operation-store.ts";
import { createIssueManagementPolicy } from "@ambient-agent/core/capabilities/issue-management/runtime.ts";
import { createIssueManagementTools } from "@ambient-agent/core/capabilities/issue-management/tools.ts";
import { createOctokitIssueRepository } from "@ambient-agent/core/host/github-issue-repository.ts";

const token = process.env.ISSUE_MANAGEMENT_SANDBOX_TOKEN?.trim();
const sandbox = process.env.ISSUE_MANAGEMENT_SANDBOX_REPOSITORY?.trim();

describe.skipIf(!token || !sandbox)("Issue Management sandbox contract", () => {
  it("creates, corrects, discusses, closes, and reopens one issue through the real GitHub adapter", async () => {
    const operationId = `sandbox-${randomUUID()}`;
    const title = `[Ambient Agent sandbox] ${operationId}`;
    const operations = createIssueOperationStore(":memory:");
    const repository = createOctokitIssueRepository(token!);
    const create = createIssueManagementTools({
      repository,
      operations,
      policy: createIssueManagementPolicy(sandbox!, [sandbox!]),
      createOperationId: () => operationId,
    }).find((tool) => tool.name === "github_create_issue")!;
    let issueNumber: number | undefined;
    try {
      const result = await create.run({
        input: {
          kind: "feature",
          title,
          body: "Gated provider contract for the Ambient Agent production Issue Management path.",
        },
      });
      expect(result).toMatchObject({
        status: "created",
        operationId,
        issue: { title, state: "open" },
      });
      if (!("issue" in result)) throw new Error("Expected one created sandbox issue");
      const createdNumber = result.issue.number;
      issueNumber = createdNumber;
      expect(operations.get(operationId)).toMatchObject({ status: "completed", issueNumber: createdNumber });

      const [owner, repo] = sandbox!.split("/") as [string, string];
      await expect(repository.get({ repository: { owner, repo }, number: createdNumber })).resolves.toMatchObject({
        number: createdNumber,
        title,
        state: "open",
      });
      await expect(
        repository.findCreated({ repository: { owner, repo }, operation: { id: operationId } }),
      ).resolves.toEqual([expect.objectContaining({ number: createdNumber, title })]);

      const available = await repository.options({ repository: { owner, repo } });
      const updateOperationId = `sandbox-update-${randomUUID()}`;
      const correctedTitle = `${title} corrected`;
      const correctedBody = "Gated provider contract updated through production Issue Management.";
      const update = createIssueManagementTools({
        repository,
        operations,
        policy: createIssueManagementPolicy(sandbox!, [sandbox!]),
        createOperationId: () => updateOperationId,
      }).find((tool) => tool.name === "github_update_issue")!;
      await expect(
        update.run({
          input: {
            number: createdNumber,
            title: correctedTitle,
            body: correctedBody,
            labels: available.labels.slice(0, 1),
          },
        }),
      ).resolves.toMatchObject({
        status: "updated",
        operationId: updateOperationId,
        issue: { number: createdNumber, title: correctedTitle, body: correctedBody },
      });
      expect(operations.get(updateOperationId)).toMatchObject({
        kind: "update-issue",
        issueNumber: createdNumber,
        status: "completed",
      });
      await expect(repository.get({ repository: { owner, repo }, number: createdNumber })).resolves.toMatchObject({
        title: correctedTitle,
        body: correctedBody,
        labels: available.labels.slice(0, 1),
      });
      await expect(
        repository.findCreated({ repository: { owner, repo }, operation: { id: operationId } }),
      ).resolves.toEqual([expect.objectContaining({ number: createdNumber, body: correctedBody })]);
      await expect(
        repository.findCreated({ repository: { owner, repo }, operation: { id: updateOperationId } }),
      ).resolves.toEqual([expect.objectContaining({ number: createdNumber, body: correctedBody })]);

      const lifecycleIds = [
        `sandbox-comment-create-${randomUUID()}`,
        `sandbox-comment-update-${randomUUID()}`,
        `sandbox-comment-delete-${randomUUID()}`,
        `sandbox-close-${randomUUID()}`,
        `sandbox-reopen-${randomUUID()}`,
      ];
      const lifecycleTools = createIssueManagementTools({
        repository,
        operations,
        policy: createIssueManagementPolicy(sandbox!, [sandbox!]),
        createOperationId: () => lifecycleIds.shift()!,
      });
      const tool = (name: string) => lifecycleTools.find((candidate) => candidate.name === name)!;
      await expect(
        tool("github_read_issue_discussion").run({ input: { number: createdNumber } }),
      ).resolves.toMatchObject({ issue: { number: createdNumber }, comments: [] });

      const createdComment = await tool("github_create_issue_comment").run({
        input: { number: createdNumber, body: "Sandbox discussion comment." },
      });
      expect(createdComment).toMatchObject({ status: "created", comment: { body: "Sandbox discussion comment." } });
      if (!("comment" in createdComment)) throw new Error("Expected one created sandbox comment");
      const commentId = (createdComment.comment as { id: number }).id;
      await expect(
        tool("github_update_issue_comment").run({
          input: { number: createdNumber, commentId, body: "Sandbox discussion comment, corrected." },
        }),
      ).resolves.toMatchObject({
        status: "updated",
        comment: { id: commentId, body: "Sandbox discussion comment, corrected." },
      });
      await expect(
        repository.discussion({ repository: { owner, repo }, number: createdNumber }),
      ).resolves.toMatchObject({
        comments: [expect.objectContaining({ id: commentId, body: "Sandbox discussion comment, corrected." })],
      });
      await expect(
        tool("github_delete_issue_comment").run({ input: { number: createdNumber, commentId } }),
      ).resolves.toMatchObject({ status: "deleted", commentId });
      await expect(
        repository.discussion({ repository: { owner, repo }, number: createdNumber }),
      ).resolves.toMatchObject({ comments: [] });

      await expect(
        tool("github_set_issue_state").run({
          input: { number: createdNumber, state: "closed", reason: "completed" },
        }),
      ).resolves.toMatchObject({ issue: { state: "closed", stateReason: "completed" } });
      await expect(
        tool("github_set_issue_state").run({
          input: { number: createdNumber, state: "open", reason: "reopened" },
        }),
      ).resolves.toMatchObject({ issue: { state: "open", stateReason: "reopened" } });
      expect(operations.list().filter((operation) => operation.issueNumber === createdNumber)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ kind: "create-comment", status: "completed" }),
          expect.objectContaining({ kind: "update-comment", status: "completed" }),
          expect.objectContaining({ kind: "delete-comment", status: "completed" }),
          expect.objectContaining({ kind: "set-issue-state", status: "completed", target: { state: "closed", reason: "completed" } }),
          expect.objectContaining({ kind: "set-issue-state", status: "completed", target: { state: "open", reason: "reopened" } }),
        ]),
      );
    } finally {
      if (issueNumber !== undefined) {
        const [owner, repo] = sandbox!.split("/") as [string, string];
        await new Octokit({ auth: token }).rest.issues.update({
          owner,
          repo,
          issue_number: issueNumber,
          state: "closed",
          state_reason: "not_planned",
        });
      }
      operations.close();
    }
  }, 60_000);
});
