import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { createRepairPullRequestTool } from "../../packages/agents/src/capabilities/coder/repair-tool.ts";
import { createCodingJobRegistry, type CodingJobRegistry } from "../../packages/agents/src/capabilities/coder/registry.ts";
import { configureCoderRuntime } from "../../packages/agents/src/capabilities/coder/runtime.ts";
import type { CoderGitHub } from "../../packages/agents/src/capabilities/coder/github.ts";
import { configureDelegationRuntime } from "../../packages/agents/src/capabilities/delegation/runtime.ts";
import { createBrainInbox } from "../../packages/engine/src/brain/inbox.ts";
import { createConversationArchive } from "../../packages/engine/src/intake/conversation-archive.ts";

const SOURCE = "surface:source";
const CHAT = "source@g.us";
const SLUG = "ambient-reviewer";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const job = {
  repository: "acme/widgets",
  prNumber: 42,
  issue: 210,
  branch: "agent/coder/issue-210",
  base: "main",
  maxVerificationRounds: 3,
  maxReviewCycles: 2,
};

/** A github double: the live review the tool re-verifies, plus the over-budget demotion surface. */
const fakeGitHub = (review: { state: string; login: string } = { state: "CHANGES_REQUESTED", login: `${SLUG}[bot]` }) => {
  const comments: { id: number; body: string }[] = [];
  let nextId = 1;
  return {
    graphql: vi.fn(async () => ({})),
    pulls: {
      get: vi.fn(async () => ({ data: { number: 42, node_id: "PR_node", draft: false, state: "open", html_url: "https://github.com/acme/widgets/pull/42", title: "", head: { sha: "h", ref: job.branch, repo: { full_name: "acme/widgets" } }, base: { ref: "main" } } })),
      getReview: vi.fn(async () => ({ data: { state: review.state, user: { login: review.login } } })),
    },
    issues: {
      listComments: vi.fn(async () => ({ data: comments })),
      createComment: vi.fn(async ({ body }: { body: string }) => { comments.push({ id: nextId++, body }); return { data: { id: nextId, html_url: "" } }; }),
      updateComment: vi.fn(async () => ({ data: {} })),
    },
  } as unknown as CoderGitHub;
};

/** Build a Brain Batch that carries ONLY a GitHub review event — no Intent (the real trigger path). */
const fixture = (
  registry: CodingJobRegistry,
  admitWorkflow: (input: Record<string, unknown>) => Promise<{ runId: string }>,
  opts: { readonly github?: CoderGitHub; readonly reviewerAppSlug?: string | undefined } = {},
) => {
  const root = mkdtempSync(join(tmpdir(), "ambient-repair-"));
  roots.push(root);
  const databasePath = join(root, "application.sqlite");
  // The Brain inbox shares the application database; create its conversation schema first.
  createConversationArchive(databasePath).close();
  const inbox = createBrainInbox(databasePath, { providerChatIdForSurface: (s) => (s === SOURCE ? CHAT : undefined), now: () => "2026-07-24T00:00:00.000Z" });
  const event = inbox.admitGitHubEvent({
    githubAppId: "app-reviewer",
    deliveryId: "review-501",
    eventName: "pull_request_review",
    action: "submitted",
    repository: "acme/widgets",
    summary: "Review changes_requested on acme/widgets#42",
    detail: { review: { id: 501, state: "changes_requested" }, pullRequest: { number: 42 } },
  });
  const batch = inbox.claimBatch()!;
  // The Batch carries the github event and NO Intent — this is what the real trigger looks like.
  expect(batch.githubEvents.map((e) => e.id)).toEqual([event.id]);
  expect(batch.intents).toHaveLength(0);
  inbox.markBatchDispatched(batch.id, { dispatchId: "brain-dispatch", acceptedAt: "2026-07-24T00:00:01.000Z" });
  const github = opts.github ?? fakeGitHub();
  configureCoderRuntime({
    github: async () => github,
    sandbox: (() => ({})) as never,
    workspacesRoot: "/tmp",
    registry,
    coderAppSlug: "ambient-coder",
    ...("reviewerAppSlug" in opts ? { reviewerAppSlug: opts.reviewerAppSlug } : { reviewerAppSlug: SLUG }),
  });
  configureDelegationRuntime({
    inbox,
    wake: async () => undefined,
    providerChatIdForSurface: () => CHAT,
    findAdmittedRun: async () => undefined,
    admitWorkflow: async (_workflow, input) => admitWorkflow(input),
  });
  return { inbox, batchId: batch.id, eventId: event.id, github };
};

const call = (batchId: string, eventId: string, reviewId = 501) =>
  createRepairPullRequestTool().run({
    input: { batchId, surfaceId: SOURCE, repository: "acme/widgets", pullRequest: 42, reviewId, evidenceIds: [eventId] },
  } as never) as Promise<Record<string, unknown>>;

describe("repair_pull_request Brain tool (#211)", () => {
  it("FINDING 2: launches from a Batch carrying only a GitHub event (no Intent), through the delegation seam", async () => {
    const registry = createCodingJobRegistry(":memory:");
    registry.upsert(job);
    let launchedInput: Record<string, unknown> | undefined;
    const { inbox, batchId, eventId } = fixture(registry, async (input) => { launchedInput = input; return { runId: "run:repair" }; });
    try {
      const result = await call(batchId, eventId);
      expect(result).toMatchObject({ kind: "repair_pull_request", status: "launched", runId: "run:repair" });
      expect(result.workId).toEqual(expect.stringMatching(/^brain-work:/u));
      // Dispatched through the SAME delegation seam every Brain launch uses; the review event is the provenance.
      // The registered issue rides along so the delegation seam wires Graph context (round-6 fix 2).
      expect(launchedInput).toMatchObject({ mode: "review_continuation", repository: "acme/widgets", pullRequest: 42, issue: 210, brainWorkId: expect.stringMatching(/^brain-work:/u), sourceSurfaceId: SOURCE });
      // The launch reserved with the GitHub event as evidence (not an Intent).
      expect(inbox.specialistLaunch(result.workId as string)!.evidenceIds).toEqual([eventId]);
      // The cycle was atomically reserved and, since the launch succeeded, stays consumed.
      expect(registry.get("acme/widgets", 42)!.reviewCycle).toBe(1);
    } finally {
      inbox.close();
      registry.close();
    }
  });

  it("FINDING 1: refuses a review that is not a REQUEST_CHANGES by the configured Reviewer App", async () => {
    const registry = createCodingJobRegistry(":memory:");
    registry.upsert(job);
    let admissions = 0;
    // A human maintainer's REQUEST_CHANGES — right state, wrong author.
    const { inbox, batchId, eventId } = fixture(registry, async () => { admissions += 1; return { runId: "r" }; }, {
      github: fakeGitHub({ state: "CHANGES_REQUESTED", login: "maintainer" }),
    });
    try {
      const result = await call(batchId, eventId);
      expect(result).toMatchObject({ kind: "repair_pull_request", status: "unauthorized" });
      expect(admissions).toBe(0);
      // Nothing was touched — no cycle consumed, no launch.
      expect(registry.get("acme/widgets", 42)!.reviewCycle).toBe(0);
    } finally {
      inbox.close();
      registry.close();
    }
  });

  it("FINDING 1: refuses a non-REQUEST_CHANGES review even from the Reviewer App", async () => {
    const registry = createCodingJobRegistry(":memory:");
    registry.upsert(job);
    const { inbox, batchId, eventId } = fixture(registry, async () => ({ runId: "r" }), {
      github: fakeGitHub({ state: "APPROVED", login: `${SLUG}[bot]` }),
    });
    try {
      expect(await call(batchId, eventId)).toMatchObject({ kind: "repair_pull_request", status: "unauthorized" });
      expect(registry.get("acme/widgets", 42)!.reviewCycle).toBe(0);
    } finally {
      inbox.close();
      registry.close();
    }
  });

  it("FINDING 1: fails closed when the Reviewer App is unprovisioned (no slug to authorize against)", async () => {
    const registry = createCodingJobRegistry(":memory:");
    registry.upsert(job);
    const { inbox, batchId, eventId } = fixture(registry, async () => ({ runId: "r" }), { reviewerAppSlug: undefined });
    try {
      expect(await call(batchId, eventId)).toMatchObject({ kind: "repair_pull_request", status: "unauthorized" });
    } finally {
      inbox.close();
      registry.close();
    }
  });

  it("HARD SAFETY: an authorized review on an unregistered (external/fork) PR is reported external, never mutated", async () => {
    const registry = createCodingJobRegistry(":memory:");
    let admissions = 0;
    const { inbox, batchId, eventId } = fixture(registry, async () => { admissions += 1; return { runId: "r" }; });
    try {
      expect(await call(batchId, eventId)).toEqual({ kind: "repair_pull_request", status: "external" });
      expect(admissions).toBe(0);
    } finally {
      inbox.close();
      registry.close();
    }
  });

  it("NEGATIVE: a second identical review event launches no duplicate run or cycle", async () => {
    const registry = createCodingJobRegistry(":memory:");
    registry.upsert(job);
    let admissions = 0;
    const { inbox, batchId, eventId } = fixture(registry, async () => { admissions += 1; return { runId: "run:repair" }; });
    try {
      await call(batchId, eventId);
      const again = await call(batchId, eventId);
      expect(again).toEqual({ kind: "repair_pull_request", status: "duplicate", previous: "launched" });
      expect(admissions).toBe(1);
      expect(registry.get("acme/widgets", 42)!.reviewCycle).toBe(1);
    } finally {
      inbox.close();
      registry.close();
    }
  });

  it("NEGATIVE: over budget launches nothing, demotes to draft with a comment, and never consumes a cycle", async () => {
    const registry = createCodingJobRegistry(":memory:");
    registry.upsert({ ...job, maxReviewCycles: 0 });
    let admissions = 0;
    const { inbox, batchId, eventId, github } = fixture(registry, async () => { admissions += 1; return { runId: "r" }; });
    try {
      const result = await call(batchId, eventId);
      expect(result).toMatchObject({ kind: "repair_pull_request", status: "over-budget", prUrl: "https://github.com/acme/widgets/pull/42" });
      expect(admissions).toBe(0);
      expect((github.graphql as ReturnType<typeof vi.fn>).mock.calls.some(([q]) => String(q).includes("convertPullRequestToDraft"))).toBe(true);
      expect((github.issues.createComment as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
      expect(registry.get("acme/widgets", 42)!.reviewCycle).toBe(0);
    } finally {
      inbox.close();
      registry.close();
    }
  });

  it("NEGATIVE (round-1 finding 2): a failed launch releases its reservation, so the review can still be repaired", async () => {
    const registry = createCodingJobRegistry(":memory:");
    registry.upsert(job);
    const { inbox, batchId, eventId } = fixture(registry, async () => { throw new Error("Flue unreachable"); });
    try {
      await expect(call(batchId, eventId)).rejects.toThrow("Flue unreachable");
      // The reservation was released: no cycle consumed, and a fresh reserve of the same review succeeds.
      expect(registry.get("acme/widgets", 42)!.reviewCycle).toBe(0);
      expect(registry.reserveRepair("acme/widgets", 42, 501).status).toBe("within-budget");
    } finally {
      inbox.close();
      registry.close();
    }
  });

  it("FINDING 2 (round 3): an off-batch evidence id is rejected as unauthorized — no reservation, no launch", async () => {
    const registry = createCodingJobRegistry(":memory:");
    registry.upsert(job);
    let admissions = 0;
    const { inbox, batchId } = fixture(registry, async () => { admissions += 1; return { runId: "r" }; });
    try {
      // A second review event that lands in a LATER batch — real, but not evidence for this Batch.
      const offBatch = inbox.admitGitHubEvent({
        githubAppId: "app-reviewer",
        deliveryId: "review-other",
        eventName: "pull_request_review",
        action: "submitted",
        repository: "acme/widgets",
        summary: "unrelated review",
        detail: { review: { id: 501 }, pullRequest: { number: 42 } },
      });
      const result = await (createRepairPullRequestTool().run({
        input: { batchId, surfaceId: SOURCE, repository: "acme/widgets", pullRequest: 42, reviewId: 501, evidenceIds: [offBatch.id] },
      } as never) as Promise<Record<string, unknown>>);
      expect(result).toMatchObject({ kind: "repair_pull_request", status: "unauthorized" });
      expect(admissions).toBe(0);
      // Rejected before reserving — no cycle consumed.
      expect(registry.get("acme/widgets", 42)!.reviewCycle).toBe(0);
    } finally {
      inbox.close();
      registry.close();
    }
  });

  it("FINDING 2 (round 4): rejects cited evidence that IS in the batch but references a different review/PR", async () => {
    const registry = createCodingJobRegistry(":memory:");
    registry.upsert(job);
    let admissions = 0;
    // The batch's one event is the review for #42/501 — but the tool is asked to repair with reviewId 999.
    const { inbox, batchId, eventId } = fixture(registry, async () => { admissions += 1; return { runId: "r" }; });
    try {
      const result = await (createRepairPullRequestTool().run({
        input: { batchId, surfaceId: SOURCE, repository: "acme/widgets", pullRequest: 42, reviewId: 999, evidenceIds: [eventId] },
      } as never) as Promise<Record<string, unknown>>);
      expect(result).toMatchObject({ kind: "repair_pull_request", status: "unauthorized" });
      expect(admissions).toBe(0);
      expect(registry.get("acme/widgets", 42)!.reviewCycle).toBe(0);
    } finally {
      inbox.close();
      registry.close();
    }
  });

  it("round 8: two distinct reviews of the SAME PR in one Batch each launch their own run (no work-id collision)", async () => {
    const registry = createCodingJobRegistry(":memory:");
    registry.upsert(job); // maxReviewCycles 2
    const root = mkdtempSync(join(tmpdir(), "ambient-repair-"));
    roots.push(root);
    const databasePath = join(root, "application.sqlite");
    createConversationArchive(databasePath).close();
    const inbox = createBrainInbox(databasePath, { providerChatIdForSurface: (s) => (s === SOURCE ? CHAT : undefined), now: () => "2026-07-24T00:00:00.000Z" });
    const a = inbox.admitGitHubEvent({ githubAppId: "app-reviewer", deliveryId: "review-501", eventName: "pull_request_review", action: "submitted", repository: "acme/widgets", summary: "r1", detail: { review: { id: 501 }, pullRequest: { number: 42 } } });
    const b = inbox.admitGitHubEvent({ githubAppId: "app-reviewer", deliveryId: "review-502", eventName: "pull_request_review", action: "submitted", repository: "acme/widgets", summary: "r2", detail: { review: { id: 502 }, pullRequest: { number: 42 } } });
    const batch = inbox.claimBatch()!;
    expect(batch.githubEvents.map((e) => e.id).sort()).toEqual([a.id, b.id].sort());
    inbox.markBatchDispatched(batch.id, { dispatchId: "d", acceptedAt: "2026-07-24T00:00:01.000Z" });
    const github = fakeGitHub();
    configureCoderRuntime({ github: async () => github, sandbox: (() => ({})) as never, workspacesRoot: "/tmp", registry, coderAppSlug: "ambient-coder", reviewerAppSlug: SLUG });
    let n = 0;
    const launches: Record<string, unknown>[] = [];
    configureDelegationRuntime({ inbox, wake: async () => undefined, providerChatIdForSurface: () => CHAT, findAdmittedRun: async () => undefined, admitWorkflow: async (_w, input) => { launches.push(input); return { runId: `run:${++n}` }; } });
    const callWith = (reviewId: number, eventId: string) =>
      createRepairPullRequestTool().run({ input: { batchId: batch.id, surfaceId: SOURCE, repository: "acme/widgets", pullRequest: 42, reviewId, evidenceIds: [eventId] } } as never) as Promise<Record<string, unknown>>;
    try {
      const r1 = await callWith(501, a.id);
      const r2 = await callWith(502, b.id);
      expect(r1).toMatchObject({ status: "launched", runId: "run:1" });
      expect(r2).toMatchObject({ status: "launched", runId: "run:2" });
      // Distinct work ids and two real admissions — the second review is NOT deduped into the first.
      expect(r1.workId).not.toBe(r2.workId);
      expect(launches).toHaveLength(2);
      expect(registry.get("acme/widgets", 42)!.reviewCycle).toBe(2);
    } finally {
      inbox.close();
      registry.close();
    }
  });
});
