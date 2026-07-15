import { randomUUID } from "node:crypto";

import { Octokit } from "@octokit/rest";
import { describe, expect, it } from "vite-plus/test";

import { createIssueOperationStore } from "../../src/capabilities/issue-management/operation-store.ts";
import { createIssueManagementPolicy } from "../../src/capabilities/issue-management/runtime.ts";
import { createIssueManagementTools } from "../../src/capabilities/issue-management/tools.ts";
import { createOctokitIssueRepository } from "../../src/host/github-issue-repository.ts";

const token = process.env.ISSUE_MANAGEMENT_SANDBOX_TOKEN?.trim();
const sandbox = process.env.ISSUE_MANAGEMENT_SANDBOX_REPOSITORY?.trim();

describe.skipIf(!token || !sandbox)("Issue Management sandbox contract", () => {
  it("creates, observes, and corrects one issue through the real GitHub adapter", async () => {
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
  }, 45_000);
});
