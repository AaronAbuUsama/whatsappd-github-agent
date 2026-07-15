import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  createIssueOperationStore,
  type IssueOperationKind,
} from "../../src/capabilities/issue-management/operation-store.ts";
import { createFakeIssueRepository } from "../../src/host/fake-issue-repository.ts";
import { commentProviderBody, issueOperationMarker, issueProviderBody } from "../../src/host/issue-operation-footer.ts";
import { createUncertainWorkController, inspectUncertainWorkStatus } from "../../src/managed/uncertain-work.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const fixture = (): string => {
  const root = mkdtempSync(join(tmpdir(), "ambient-uncertain-work-"));
  roots.push(root);
  return join(root, "application.sqlite");
};

const seedUncertainOperation = (
  operations: ReturnType<typeof createIssueOperationStore>,
  input: {
    readonly operationId: string;
    readonly kind: IssueOperationKind;
    readonly issueNumber?: number;
    readonly target?: Readonly<Record<string, unknown>>;
  },
): void => {
  operations.begin({
    ...input,
    repository: "acme/widgets",
    startedAt: "2026-07-15T01:00:00.000Z",
  });
  operations.uncertain(input.operationId, "private provider failure detail", "2026-07-15T01:01:00.000Z");
};

describe("Uncertain work operator boundary", () => {
  it("diagnoses every external mutation kind with reads only and separates attributable from observed success", async () => {
    const path = fixture();
    const operations = createIssueOperationStore(path);
    const repository = createFakeIssueRepository();
    const ref = { owner: "acme", repo: "widgets" } as const;

    repository.seed({
      repository: ref,
      title: "Created issue",
      body: issueProviderBody("private issue body", [issueOperationMarker({ id: "create-issue" })]),
    });
    const updated = repository.seed({ repository: ref, title: "Observed update", body: "private updated body" });
    const discussion = repository.seed({ repository: ref, title: "Discussion", body: "private body" });
    repository.seedComment({
      repository: ref,
      number: discussion.number,
      body: commentProviderBody("private comment", [issueOperationMarker({ id: "create-comment" })]),
      author: "ambient-agent",
    });
    const editedComment = repository.seedComment({
      repository: ref,
      number: discussion.number,
      body: commentProviderBody("private edit", [issueOperationMarker({ id: "update-comment" })]),
      author: "ambient-agent",
    });
    repository.seedComment({
      repository: ref,
      number: discussion.number,
      body: commentProviderBody("different comment", [issueOperationMarker({ id: "update-comment" })]),
      author: "ambient-agent",
    });
    const stateIssue = repository.seed({ repository: ref, title: "State", body: "private body" });
    await repository.setState({
      repository: ref,
      number: stateIssue.number,
      state: "closed",
      reason: "completed",
      operation: { id: "seed-state" },
    });
    repository.resetEvents();

    seedUncertainOperation(operations, {
      operationId: "create-issue",
      kind: "create-issue",
      target: { kind: "bug", title: "Created issue", body: "private issue body" },
    });
    seedUncertainOperation(operations, {
      operationId: "update-issue",
      kind: "update-issue",
      issueNumber: updated.number,
      target: { title: "Observed update", body: "private updated body" },
    });
    seedUncertainOperation(operations, {
      operationId: "create-comment",
      kind: "create-comment",
      issueNumber: discussion.number,
      target: { body: "private comment" },
    });
    seedUncertainOperation(operations, {
      operationId: "update-comment",
      kind: "update-comment",
      issueNumber: discussion.number,
      target: { commentId: editedComment.id, body: "private edit" },
    });
    seedUncertainOperation(operations, {
      operationId: "delete-comment",
      kind: "delete-comment",
      issueNumber: discussion.number,
      target: { commentId: 999_999 },
    });
    seedUncertainOperation(operations, {
      operationId: "set-state",
      kind: "set-issue-state",
      issueNumber: stateIssue.number,
      target: { state: "closed", reason: "completed" },
    });

    const controller = createUncertainWorkController({
      operations,
      repository,
      now: () => new Date("2026-07-15T02:00:00.000Z"),
    });
    expect(controller.status()).toEqual({
      health: "degraded",
      externalMutations: 6,
      total: 6,
      mutationKinds: {
        "create-issue": 1,
        "update-issue": 1,
        "create-comment": 1,
        "update-comment": 1,
        "delete-comment": 1,
        "set-issue-state": 1,
      },
    });

    const report = await controller.diagnose();
    expect(report.diagnoses).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ref: "mutation:create-issue",
          outcome: "reconciled",
          evidence: "operation-identity",
        }),
        expect.objectContaining({ ref: "mutation:update-issue", outcome: "observed", evidence: "desired-state-only" }),
        expect.objectContaining({
          ref: "mutation:create-comment",
          outcome: "reconciled",
          evidence: "operation-identity",
        }),
        expect.objectContaining({
          ref: "mutation:update-comment",
          outcome: "reconciled",
          evidence: "operation-identity",
        }),
        expect.objectContaining({
          ref: "mutation:delete-comment",
          outcome: "observed",
          evidence: "desired-state-only",
        }),
        expect.objectContaining({ ref: "mutation:set-state", outcome: "observed", evidence: "desired-state-only" }),
      ]),
    );
    expect(
      repository
        .events()
        .some((event) =>
          ["create", "update", "create-comment", "update-comment", "delete-comment", "set-issue-state"].includes(
            event.kind,
          ),
        ),
    ).toBe(false);
    expect(JSON.stringify(report)).not.toContain("private");
    expect(report.after).toMatchObject({ externalMutations: 3, total: 3 });

    await expect(controller.acceptObserved("mutation:update-issue")).resolves.toMatchObject({ outcome: "accepted" });
    await expect(controller.acceptObserved("mutation:delete-comment")).resolves.toMatchObject({ outcome: "accepted" });
    await expect(controller.acceptObserved("mutation:set-state")).resolves.toMatchObject({ outcome: "accepted" });
    expect(controller.status()).toMatchObject({ health: "healthy", externalMutations: 0, total: 0 });
    controller.close();
  });

  it("requires an explicit retry, creates a replacement identity, and preserves the prior audit record", async () => {
    const path = fixture();
    const operations = createIssueOperationStore(path);
    const repository = createFakeIssueRepository();
    const issue = repository.seed({ repository: { owner: "acme", repo: "widgets" }, title: "Issue", body: "Body" });
    seedUncertainOperation(operations, {
      operationId: "comment-before-retry",
      kind: "create-comment",
      issueNumber: issue.number,
      target: { body: "Retry this exact comment" },
    });
    const controller = createUncertainWorkController({
      operations,
      repository,
      createOperationId: () => "comment-after-retry",
      now: () => new Date("2026-07-15T03:00:00.000Z"),
    });

    await controller.diagnose();
    expect(repository.events().some((event) => event.kind === "create-comment")).toBe(false);
    await expect(controller.retry("mutation:comment-before-retry")).resolves.toEqual({
      ref: "mutation:comment-before-retry",
      outcome: "retried",
      replacementRef: "mutation:comment-after-retry",
    });
    expect(repository.events()).toContainEqual(
      expect.objectContaining({ kind: "create-comment", operationId: "comment-after-retry", outcome: "applied" }),
    );
    expect(operations.get("comment-before-retry")).toMatchObject({
      status: "abandoned",
      resolution: "retried",
      replacementOperationId: "comment-after-retry",
    });
    expect(operations.get("comment-after-retry")).toMatchObject({ status: "completed" });
    expect(controller.status()).toMatchObject({ health: "healthy", total: 0 });
    controller.close();
  });

  it("rejects the retired admission:<windowId> ref form", async () => {
    const operations = createIssueOperationStore(fixture());
    const controller = createUncertainWorkController({
      operations,
      repository: createFakeIssueRepository(),
    });

    await expect(controller.retry("admission:window-1" as never)).rejects.toThrow(
      "Uncertain work must be identified as mutation:<operationId>.",
    );
    expect(() => controller.abandon("admission:window-1" as never)).toThrow(
      "Uncertain work must be identified as mutation:<operationId>.",
    );
    controller.close();
  });

  it("abandons an unresolved mutation without deleting its audit", () => {
    const path = fixture();
    const operations = createIssueOperationStore(path);
    seedUncertainOperation(operations, {
      operationId: "mutation-abandon",
      kind: "delete-comment",
      issueNumber: 1,
      target: { commentId: 9 },
    });
    const controller = createUncertainWorkController({
      operations,
      repository: createFakeIssueRepository(),
      now: () => new Date("2026-07-15T04:00:00.000Z"),
    });

    expect(controller.abandon("mutation:mutation-abandon")).toMatchObject({ outcome: "abandoned" });
    expect(operations.get("mutation-abandon")).toMatchObject({
      status: "abandoned",
      resolution: "abandoned",
    });
    expect(controller.status()).toMatchObject({ health: "healthy", total: 0 });
    controller.close();
  });

  it("reports stopped in-flight mutations as degraded and promotes orphans before diagnosis", async () => {
    const path = fixture();
    const interrupted = createIssueOperationStore(path);
    interrupted.begin({
      operationId: "attempting-operation",
      kind: "create-issue",
      repository: "acme/widgets",
      target: { kind: "bug", title: "Interrupted", body: "Private body" },
      startedAt: "2026-07-15T05:00:00.000Z",
    });
    interrupted.close();

    expect(inspectUncertainWorkStatus(path)).toMatchObject({
      health: "degraded",
      externalMutations: 1,
      total: 1,
    });

    const operations = createIssueOperationStore(path);
    expect(operations.get("attempting-operation")).toMatchObject({
      status: "uncertain",
      error: "Process restarted after the provider mutation began",
    });
    const repository = createFakeIssueRepository();
    const controller = createUncertainWorkController({ operations, repository });
    await controller.diagnose();
    expect(repository.events().some((event) => event.kind === "create")).toBe(false);
    controller.close();
  });

  it("keeps a successful retry Uncertain when only local completion persistence fails", async () => {
    const path = fixture();
    const persisted = createIssueOperationStore(path);
    const repository = createFakeIssueRepository();
    const issue = repository.seed({ repository: { owner: "acme", repo: "widgets" }, title: "Issue", body: "Body" });
    seedUncertainOperation(persisted, {
      operationId: "comment-before-settlement-failure",
      kind: "create-comment",
      issueNumber: issue.number,
      target: { body: "Provider accepts this" },
    });
    const operations = {
      ...persisted,
      complete: () => {
        throw new Error("injected local completion failure");
      },
    };
    const controller = createUncertainWorkController({
      operations,
      repository,
      createOperationId: () => "comment-after-settlement-failure",
      now: () => new Date("2026-07-15T06:00:00.000Z"),
    });

    await expect(controller.retry("mutation:comment-before-settlement-failure")).resolves.toMatchObject({
      outcome: "uncertain",
      replacementRef: "mutation:comment-after-settlement-failure",
    });
    expect(repository.events()).toContainEqual(
      expect.objectContaining({
        kind: "create-comment",
        operationId: "comment-after-settlement-failure",
        outcome: "applied",
      }),
    );
    expect(persisted.get("comment-after-settlement-failure")).toMatchObject({
      status: "uncertain",
      error: expect.stringContaining("completion could not be persisted"),
    });
    controller.close();
  });

  it("retries a validated empty issue body and rotates bounded diagnosis fairly", async () => {
    const path = fixture();
    const operations = createIssueOperationStore(path);
    const repository = createFakeIssueRepository();
    for (let index = 0; index < 30; index += 1) {
      seedUncertainOperation(operations, {
        operationId: `mutation-fair-${index}`,
        kind: "delete-comment",
        issueNumber: 1,
        target: { commentId: 1_000 + index },
      });
    }
    const issue = repository.seed({ repository: { owner: "acme", repo: "widgets" }, title: "Clear body", body: "Old" });
    seedUncertainOperation(operations, {
      operationId: "clear-body",
      kind: "update-issue",
      issueNumber: issue.number,
      target: { body: "" },
    });
    const controller = createUncertainWorkController({
      operations,
      repository,
      createOperationId: () => "clear-body-retry",
      now: () => new Date("2026-07-15T07:00:00.000Z"),
    });

    const first = await controller.diagnose();
    expect(first.examined).toBe(25);
    expect(first.deferred).toBe(6);
    const firstRefs = new Set(first.diagnoses.map((item) => item.ref));
    const second = await controller.diagnose();
    expect(second.diagnoses.some((item) => !firstRefs.has(item.ref))).toBe(true);

    await expect(controller.retry("mutation:clear-body")).resolves.toMatchObject({ outcome: "retried" });
    await expect(
      repository.get({ repository: { owner: "acme", repo: "widgets" }, number: issue.number }),
    ).resolves.toMatchObject({ body: "" });
    controller.close();
  });
});
