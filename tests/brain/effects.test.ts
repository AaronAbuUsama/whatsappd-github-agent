import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  configureBrainEffectsRuntime,
  deliverIssueFilingEffect,
  recoverPendingIssueFilings,
  recoverPendingPrompts,
} from "../../packages/agents/src/brain/effects-runtime.ts";
import {
  createFileIssueTool,
  createPromptSpeakerTool,
  createSettleBrainBatchTool,
  createStaySilentTool,
} from "../../packages/agents/src/brain/tools.ts";
import { createIssueFiler } from "../../packages/agents/src/brain/issue-filing.ts";
import { createIssueManagementPolicy } from "../../packages/agents/src/capabilities/issue-management/runtime.ts";
import { createIssueOperationStore } from "../../packages/engine/src/github/operation-store.ts";
import { createFakeIssueRepository } from "../../packages/test-support/src/fake-issue-repository.ts";
import { wakeBrain } from "../../packages/agents/src/brain/dispatch.ts";
import { createBrainInbox, type BrainInbox } from "../../packages/engine/src/brain/inbox.ts";
import { createConversationArchive } from "../../packages/engine/src/intake/conversation-archive.ts";
import type { ConversationArrival } from "../../packages/engine/src/intake/conversation-event.ts";

const SURFACE = "surface:team";
const CHAT = "team@g.us";
const EVIDENCE = "arrival:team:greeting";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const openFixture = (): { databasePath: string; inbox: BrainInbox; batchId: string } => {
  const root = mkdtempSync(join(tmpdir(), "ambient-brain-effects-"));
  roots.push(root);
  const databasePath = join(root, "application.sqlite");
  const archive = createConversationArchive(databasePath);
  archive.append({
    id: EVIDENCE,
    kind: "arrival",
    providerMessageId: "greeting",
    chatId: CHAT,
    senderId: "alice@s.whatsapp.net",
    senderName: "Alice",
    direction: "inbound",
    occurredAt: 1_000,
    payload: { live: true, isGroup: true, messageKind: "text", text: "Can you help?" },
  } satisfies ConversationArrival);
  archive.close();
  const inbox = createBrainInbox(databasePath, {
    providerChatIdForSurface: (surfaceId) => surfaceId === SURFACE ? CHAT : undefined,
    now: () => "2026-07-22T12:00:00.000Z",
  });
  inbox.admitIntent({ sourceSurfaceId: SURFACE, interpretation: "Clarification is needed.", evidenceIds: [EVIDENCE] });
  const claimed = inbox.claimBatch();
  if (claimed === undefined) throw new Error("Expected a Brain Batch");
  inbox.markBatchDispatched(claimed.id, {
    dispatchId: "dispatch:brain",
    acceptedAt: "2026-07-22T12:00:01.000Z",
  });
  return { databasePath, inbox, batchId: claimed.id };
};

describe("Brain Effects and settlement", () => {
  it("records a prompt before delivery, admits one Directive, then settles from the durable receipt", async () => {
    const { inbox, batchId } = openFixture();
    const delivered: unknown[] = [];
    configureBrainEffectsRuntime({
      inbox,
      wake: async () => undefined,
      deliverPrompt: async (effect) => {
        expect(inbox.effects(batchId)).toContainEqual(expect.objectContaining({ id: effect.id, status: "pending" }));
        delivered.push(effect.directive);
        return { dispatchId: "dispatch:speaker:1", acceptedAt: "2026-07-22T12:00:02.000Z" };
      },
    });

    const prompt = await createPromptSpeakerTool().run({ input: {
      batchId,
      surfaceId: SURFACE,
      objective: "Ask which deployment failed.",
      brief: { summary: "Alice requested help but did not identify a deployment.", evidenceIds: [EVIDENCE] },
    } });

    expect(prompt).toEqual({
      kind: "prompt_speaker",
      effectId: expect.stringMatching(/^brain-effect:[a-f0-9]{64}$/u),
      status: "accepted",
      dispatchId: "dispatch:speaker:1",
    });
    expect(delivered).toEqual([{
      id: prompt.effectId,
      surfaceId: SURFACE,
      objective: "Ask which deployment failed.",
      brief: { summary: "Alice requested help but did not identify a deployment.", evidenceIds: [EVIDENCE] },
    }]);
    await expect(createSettleBrainBatchTool().run({ input: { batchId } })).resolves.toEqual({
      batchId,
      status: "settled",
      settledAt: "2026-07-22T12:00:00.000Z",
    });
    expect(inbox.claimBatch()).toBeUndefined();
    inbox.close();
  });

  it("records deliberate silence as a completed local effect before settlement", async () => {
    const { inbox, batchId } = openFixture();
    configureBrainEffectsRuntime({
      inbox,
      wake: async () => undefined,
      deliverPrompt: async () => { throw new Error("not expected"); },
    });

    expect(createStaySilentTool().run({ input: { batchId, reason: "No response or work is warranted." } }))
      .toEqual({
        kind: "stay_silent",
        effectId: expect.stringMatching(/^brain-effect:[a-f0-9]{64}$/u),
        status: "completed",
      });
    await expect(createSettleBrainBatchTool().run({ input: { batchId } })).resolves.toMatchObject({ status: "settled" });
    inbox.close();
  });

  it("recovers the same pending prompt after restart and exact retries do not dispatch after acceptance", async () => {
    const { databasePath, inbox, batchId } = openFixture();
    const pending = inbox.recordPrompt({
      batchId,
      surfaceId: SURFACE,
      objective: "Ask which deployment failed.",
      brief: { summary: "Missing deployment identity.", evidenceIds: [EVIDENCE] },
    });
    inbox.close();

    const reopened = createBrainInbox(databasePath, {
      providerChatIdForSurface: (surfaceId) => surfaceId === SURFACE ? CHAT : undefined,
    });
    let deliveries = 0;
    configureBrainEffectsRuntime({
      inbox: reopened,
      wake: async () => undefined,
      deliverPrompt: async (effect) => {
        deliveries += 1;
        expect(effect.id).toBe(pending.id);
        return { dispatchId: "dispatch:recovered", acceptedAt: "2026-07-22T12:01:00.000Z" };
      },
    });

    await recoverPendingPrompts();
    await createPromptSpeakerTool().run({ input: {
      batchId,
      surfaceId: SURFACE,
      objective: "Ask which deployment failed.",
      brief: { summary: "Missing deployment identity.", evidenceIds: [EVIDENCE] },
    } });
    expect(deliveries).toBe(1);
    reopened.close();
  });

  const REPOSITORY = "acme/widgets";
  const filingRuntime = () => {
    const repository = createFakeIssueRepository();
    const operations = createIssueOperationStore(":memory:");
    const policy = createIssueManagementPolicy(REPOSITORY, [REPOSITORY]);
    return { repository, operations, filer: createIssueFiler({ repository, operations, policy }) };
  };

  it("files an issue, completes the effect with number and URL, and lets the Batch settle", async () => {
    const { inbox, batchId } = openFixture();
    const { operations, filer } = filingRuntime();
    configureBrainEffectsRuntime({
      inbox,
      wake: async () => undefined,
      deliverPrompt: async () => { throw new Error("not expected"); },
      fileIssue: filer,
    });

    const filed = await createFileIssueTool().run({ input: {
      batchId,
      surfaceId: SURFACE,
      repository: REPOSITORY,
      kind: "bug",
      title: "The scheduler drops a queued job",
      body: "Expected the queued job to run; it disappears after restart.",
    } });

    expect(filed).toEqual({
      kind: "file_issue",
      effectId: expect.stringMatching(/^brain-effect:[a-f0-9]{64}$/u),
      status: "created",
      issueNumber: 1,
      url: "https://github.com/acme/widgets/issues/1",
    });
    await expect(createSettleBrainBatchTool().run({ input: { batchId } })).resolves.toMatchObject({ status: "settled" });
    operations.close();
    inbox.close();
  });

  it("recovers a pending filing through the duplicate guard without creating a second issue", async () => {
    const { inbox, batchId } = openFixture();
    const { repository, operations, filer } = filingRuntime();
    // Simulate a crash: the effect is pending and the issue was already created before completion landed.
    const pending = inbox.recordIssueFiling({
      batchId,
      sourceSurfaceId: SURFACE,
      repository: REPOSITORY,
      kind: "bug",
      title: "The scheduler drops a queued job",
      body: "Expected the queued job to run; it disappears after restart.",
    });
    repository.seed({
      repository: { owner: "acme", repo: "widgets" },
      title: "The scheduler drops a queued job",
      body: "Expected the queued job to run; it disappears after restart.",
    });
    configureBrainEffectsRuntime({
      inbox,
      wake: async () => undefined,
      deliverPrompt: async () => { throw new Error("not expected"); },
      fileIssue: filer,
    });

    const recovered = await deliverIssueFilingEffect(pending);
    expect(recovered.status).toBe("completed");
    expect(recovered.outcome).toMatchObject({ status: "duplicate" });
    // The guard searched by title and refused a second create — no create event was emitted.
    expect(repository.events().some((event) => event.kind === "create")).toBe(false);
    operations.close();
    inbox.close();
  });

  it("reconciles a recovered filing by Operation Identity without a second create or a title search", async () => {
    const { inbox, batchId } = openFixture();
    const { repository, operations, filer } = filingRuntime();
    configureBrainEffectsRuntime({
      inbox,
      wake: async () => undefined,
      deliverPrompt: async () => { throw new Error("not expected"); },
      fileIssue: filer,
    });
    const pending = inbox.recordIssueFiling({
      batchId,
      sourceSurfaceId: SURFACE,
      repository: REPOSITORY,
      kind: "bug",
      title: "The scheduler drops a queued job",
      body: "Expected the queued job to run; it disappears after restart.",
    });
    // First attempt lands the create and its completed Operation, then the Effect completion is lost to a crash.
    await filer(pending.request, pending.id);
    expect(repository.events().filter((event) => event.kind === "create")).toHaveLength(1);
    repository.resetEvents();

    const recovered = await deliverIssueFilingEffect(pending);
    expect(recovered.status).toBe("completed");
    expect(recovered.outcome).toMatchObject({ status: "reconciled", issueNumber: 1 });
    // Dedup came from strongly-consistent Operation Identity, never the eventually consistent title search.
    expect(repository.events().some((event) => event.kind === "create")).toBe(false);
    expect(repository.events().some((event) => event.kind === "search")).toBe(false);
    operations.close();
    inbox.close();
  });

  it("settles a non-retryable filing failure as uncertain so the Batch is not wedged", async () => {
    const { inbox, batchId } = openFixture();
    const { repository, operations, filer } = filingRuntime();
    configureBrainEffectsRuntime({
      inbox,
      wake: async () => undefined,
      deliverPrompt: async () => { throw new Error("not expected"); },
      fileIssue: filer,
    });
    repository.failNextCreate(Object.assign(new Error("Not Found"), { status: 404 }));

    const filed = await createFileIssueTool().run({ input: {
      batchId,
      surfaceId: SURFACE,
      repository: REPOSITORY,
      kind: "bug",
      title: "Filing into an archived repository",
      body: "The repository was archived after this chat was mapped.",
    } });
    expect(filed).toMatchObject({ kind: "file_issue", status: "uncertain" });
    // The Effect completed terminally, so the Batch settles rather than blocking every later Intent.
    await expect(createSettleBrainBatchTool().run({ input: { batchId } })).resolves.toMatchObject({ status: "settled" });
    operations.close();
    inbox.close();
  });

  it("contains a boot-recovery filing failure instead of killing the runtime", async () => {
    const { inbox, batchId } = openFixture();
    inbox.recordIssueFiling({
      batchId,
      sourceSurfaceId: SURFACE,
      repository: REPOSITORY,
      kind: "bug",
      title: "GitHub was unreachable at boot",
      body: "A transient network failure met the filing during boot recovery.",
    });
    configureBrainEffectsRuntime({
      inbox,
      wake: async () => undefined,
      deliverPrompt: async () => { throw new Error("not expected"); },
      fileIssue: async () => { throw Object.assign(new Error("ETIMEDOUT"), { code: "ETIMEDOUT" }); },
    });
    // A rejection here would be an Effect defect that kills the WhatsApp fiber; recovery must swallow it.
    await expect(recoverPendingIssueFilings()).resolves.toBeUndefined();
    expect(inbox.pendingIssueFilings()).toHaveLength(1);
    inbox.close();
  });

  it("collapses an exact file_issue retry in one Batch to a single durable effect", () => {
    const { inbox, batchId } = openFixture();
    const request = {
      batchId,
      sourceSurfaceId: SURFACE,
      repository: REPOSITORY,
      kind: "bug" as const,
      title: "The scheduler drops a queued job",
      body: "Expected the queued job to run; it disappears after restart.",
    };
    const first = inbox.recordIssueFiling(request);
    const second = inbox.recordIssueFiling(request);
    expect(second.id).toBe(first.id);
    expect(inbox.effects(batchId).filter((effect) => effect.kind === "file_issue")).toHaveLength(1);
    inbox.close();
  });

  it("refuses to file an issue for a Surface that did not originate the Batch", () => {
    const { inbox, batchId } = openFixture();
    // A non-originating Surface must not be able to route a filing to its own repository —
    // same provenance guard as reserveSpecialistLaunch, so a mistaken/hallucinated surfaceId
    // can't silently file into the wrong repo.
    expect(() =>
      inbox.recordIssueFiling({
        batchId,
        sourceSurfaceId: "surface:not-a-contributor",
        repository: REPOSITORY,
        kind: "bug",
        title: "The scheduler drops a queued job",
        body: "Expected the queued job to run; it disappears after restart.",
      }),
    ).toThrow(/is not provenance for Brain Batch/);
    expect(inbox.effects(batchId).filter((effect) => effect.kind === "file_issue")).toHaveLength(0);
    inbox.close();
  });

  it("wakes the next waiting Batch immediately after settlement", async () => {
    const { inbox, batchId } = openFixture();
    const waiting = inbox.admitIntent({
      sourceSurfaceId: SURFACE,
      interpretation: "A second decision arrived while the first Batch was open.",
      evidenceIds: [EVIDENCE],
    });
    const dispatched: unknown[] = [];
    configureBrainEffectsRuntime({
      inbox,
      deliverPrompt: async () => { throw new Error("not expected"); },
      wake: () => wakeBrain(inbox, async (request) => {
        dispatched.push(request);
        return { dispatchId: "dispatch:brain:next", acceptedAt: "2026-07-22T12:02:00.000Z" };
      }),
    });

    inbox.recordSilence(batchId, "The first request requires no response.");
    await createSettleBrainBatchTool().run({ input: { batchId } });

    expect(dispatched).toEqual([expect.objectContaining({
      id: "global",
      input: expect.objectContaining({
        type: "brain.batch",
        batch: expect.objectContaining({ intents: [waiting] }),
      }),
    })]);
    inbox.close();
  });
});
