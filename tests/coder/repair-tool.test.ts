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
import type { ConversationArrival } from "../../packages/engine/src/intake/conversation-event.ts";

const SOURCE = "surface:source";
const CHAT = "source@g.us";
const EVIDENCE = "arrival:source:work-request";
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

/** A github double for the over-budget demotion path (draft convert + one lifecycle comment). */
const fakeGitHub = () => {
  const comments: { id: number; body: string }[] = [];
  let nextId = 1;
  return {
    graphql: vi.fn(async () => ({})),
    pulls: { get: vi.fn(async () => ({ data: { number: 42, node_id: "PR_node", draft: false, state: "open", html_url: "https://github.com/acme/widgets/pull/42", title: "", head: { sha: "h", ref: job.branch, repo: { full_name: "acme/widgets" } }, base: { ref: "main" } } })) },
    issues: {
      listComments: vi.fn(async () => ({ data: comments })),
      createComment: vi.fn(async ({ body }: { body: string }) => { comments.push({ id: nextId++, body }); return { data: { id: nextId, html_url: "" } }; }),
      updateComment: vi.fn(async () => ({ data: {} })),
    },
  } as unknown as CoderGitHub;
};

const fixture = (registry: CodingJobRegistry, admitWorkflow: (input: Record<string, unknown>) => Promise<{ runId: string }>) => {
  const root = mkdtempSync(join(tmpdir(), "ambient-repair-"));
  roots.push(root);
  const databasePath = join(root, "application.sqlite");
  const archive = createConversationArchive(databasePath);
  archive.append({
    id: EVIDENCE,
    kind: "arrival",
    providerMessageId: "work-request",
    chatId: CHAT,
    senderId: "alice@s.whatsapp.net",
    senderName: "Alice",
    direction: "inbound",
    occurredAt: 1_000,
    payload: { live: true, isGroup: true, messageKind: "text", text: "Review changes requested." },
  } satisfies ConversationArrival);
  archive.close();
  const inbox = createBrainInbox(databasePath, { providerChatIdForSurface: (s) => (s === SOURCE ? CHAT : undefined), now: () => "2026-07-24T00:00:00.000Z" });
  inbox.admitIntent({ sourceSurfaceId: SOURCE, interpretation: "Review changes requested.", evidenceIds: [EVIDENCE] });
  const batch = inbox.claimBatch()!;
  inbox.markBatchDispatched(batch.id, { dispatchId: "brain-dispatch", acceptedAt: "2026-07-24T00:00:01.000Z" });
  const github = fakeGitHub();
  configureCoderRuntime({ github: async () => github, sandbox: (() => ({})) as never, workspacesRoot: "/tmp", registry });
  configureDelegationRuntime({
    inbox,
    wake: async () => undefined,
    providerChatIdForSurface: () => CHAT,
    findAdmittedRun: async () => undefined,
    admitWorkflow: async (_workflow, input) => admitWorkflow(input),
  });
  return { inbox, batchId: batch.id, github };
};

const call = (batchId: string, reviewId: number) =>
  createRepairPullRequestTool().run({
    input: { batchId, surfaceId: SOURCE, repository: "acme/widgets", pullRequest: 42, reviewId },
  } as never) as Promise<Record<string, unknown>>;

describe("repair_pull_request Brain tool (#211)", () => {
  it("HARD SAFETY: an unregistered (external/fork) PR is reported external and never launched or mutated", async () => {
    const registry = createCodingJobRegistry(":memory:");
    let admissions = 0;
    const { inbox } = fixture(registry, async () => { admissions += 1; return { runId: "r" }; });
    try {
      expect(await call("ignored-batch", 1)).toEqual({ kind: "repair_pull_request", status: "external" });
      expect(admissions).toBe(0);
    } finally {
      inbox.close();
      registry.close();
    }
  });

  it("launches a review_continuation through the Brain→delegation seam and consumes a cycle only after launch", async () => {
    const registry = createCodingJobRegistry(":memory:");
    registry.upsert(job);
    let launchedInput: Record<string, unknown> | undefined;
    const { inbox, batchId } = fixture(registry, async (input) => { launchedInput = input; return { runId: "run:repair" }; });
    try {
      const result = await call(batchId, 501);
      expect(result).toMatchObject({ kind: "repair_pull_request", status: "launched", runId: "run:repair" });
      expect(result.workId).toEqual(expect.stringMatching(/^brain-work:/u));
      // Dispatched through the SAME delegation seam every Brain launch uses (brainWorkId reserved).
      expect(launchedInput).toMatchObject({ mode: "review_continuation", repository: "acme/widgets", pullRequest: 42, brainWorkId: expect.stringMatching(/^brain-work:/u), sourceSurfaceId: SOURCE });
      // The cycle is consumed only after the launch was admitted.
      expect(registry.get("acme/widgets", 42)!.reviewCycle).toBe(1);
    } finally {
      inbox.close();
      registry.close();
    }
  });

  it("NEGATIVE: a second identical review event launches no duplicate run or cycle", async () => {
    const registry = createCodingJobRegistry(":memory:");
    registry.upsert(job);
    let admissions = 0;
    const { inbox, batchId } = fixture(registry, async () => { admissions += 1; return { runId: "run:repair" }; });
    try {
      await call(batchId, 501);
      const again = await call(batchId, 501);
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
    const { inbox, batchId, github } = fixture(registry, async () => { admissions += 1; return { runId: "r" }; });
    try {
      const result = await call(batchId, 900);
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

  it("NEGATIVE (finding 2): a failed launch consumes no cycle, so the review can still be repaired on retry", async () => {
    const registry = createCodingJobRegistry(":memory:");
    registry.upsert(job);
    const { inbox, batchId } = fixture(registry, async () => { throw new Error("Flue unreachable"); });
    try {
      await expect(call(batchId, 501)).rejects.toThrow("Flue unreachable");
      // The cycle was NOT consumed and the review is NOT recorded — a retry sees it as repairable again.
      expect(registry.get("acme/widgets", 42)!.reviewCycle).toBe(0);
      expect(registry.checkRepair("acme/widgets", 42, 501).status).toBe("within-budget");
    } finally {
      inbox.close();
      registry.close();
    }
  });
});
