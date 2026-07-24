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
  createResolveSurfaceTool,
  createSettleBrainBatchTool,
  createStaySilentTool,
} from "../../packages/agents/src/brain/tools.ts";
import { createIssueFiler } from "../../packages/agents/src/brain/issue-filing.ts";
import { brainGraphContext } from "../../packages/agents/src/brain/agent.ts";
import { createGraphTools } from "../../packages/agents/src/capabilities/graph/tools.ts";
import { createGraphStore } from "../../packages/engine/src/graph/store.ts";
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

  it("lets the Brain notify a Surface about a GitHub-only Batch, citing the event's own id as evidence", () => {
    const root = mkdtempSync(join(tmpdir(), "ambient-brain-github-evidence-"));
    roots.push(root);
    const databasePath = join(root, "application.sqlite");
    // A binding exists so the Surface can be prompted, but there is NO conversation_events row —
    // the only evidence is the GitHub event itself, which must be accepted (S1: the Brain must be
    // able to speak about a GitHub event, not only stay silent).
    const archive = createConversationArchive(databasePath);
    archive.close();
    const inbox = createBrainInbox(databasePath, {
      providerChatIdForSurface: (surfaceId) => (surfaceId === SURFACE ? CHAT : undefined),
      now: () => "2026-07-22T12:00:00.000Z",
    });
    const event = inbox.admitGitHubEvent({
      githubAppId: "app-planner",
      deliveryId: "gh-delivery-1",
      eventName: "issues",
      action: "opened",
      repository: "acme/widgets",
      summary: "Issue #7 opened in acme/widgets",
      detail: { issue: { number: 7 } },
    });
    const claimed = inbox.claimBatch();
    if (claimed === undefined) throw new Error("Expected a GitHub-only Brain Batch");
    expect(claimed.githubEvents).toEqual([event]);
    inbox.markBatchDispatched(claimed.id, { dispatchId: "dispatch:brain", acceptedAt: "2026-07-22T12:00:01.000Z" });

    expect(() =>
      inbox.recordPrompt({
        batchId: claimed.id,
        surfaceId: SURFACE,
        objective: "Tell the team a new issue was opened.",
        brief: { summary: "acme/widgets#7 was opened.", evidenceIds: [event.id] },
      }),
    ).not.toThrow();
    // A fabricated evidence id that resolves in neither table is still rejected — the check stays strict.
    expect(() =>
      inbox.recordPrompt({
        batchId: claimed.id,
        surfaceId: SURFACE,
        objective: "Invalid.",
        brief: { summary: "bad.", evidenceIds: ["github-event:does-not-exist"] },
      }),
    ).toThrow(/does not exist/);
    inbox.close();
  });

  it("bridges a repo-correlated thread's chatId to a Surface the Brain can prompt about a GitHub event", async () => {
    const root = mkdtempSync(join(tmpdir(), "ambient-brain-github-notify-"));
    roots.push(root);
    const databasePath = join(root, "application.sqlite");
    const archive = createConversationArchive(databasePath);
    archive.close();
    const inbox = createBrainInbox(databasePath, {
      providerChatIdForSurface: (surfaceId) => (surfaceId === SURFACE ? CHAT : undefined),
      now: () => "2026-07-22T12:00:00.000Z",
    });
    const event = inbox.admitGitHubEvent({
      githubAppId: "app-planner",
      deliveryId: "gh-notify-1",
      eventName: "issues",
      action: "opened",
      repository: "acme/widgets",
      summary: "Issue #7 opened in acme/widgets",
      detail: { issue: { number: 7 } },
    });
    const claimed = inbox.claimBatch();
    if (claimed === undefined) throw new Error("Expected a GitHub-only Brain Batch");
    inbox.markBatchDispatched(claimed.id, { dispatchId: "dispatch:brain", acceptedAt: "2026-07-22T12:00:01.000Z" });

    const delivered: unknown[] = [];
    configureBrainEffectsRuntime({
      inbox,
      wake: async () => undefined,
      deliverPrompt: async (effect) => {
        delivered.push(effect.directive);
        return { dispatchId: "dispatch:speaker:gh", acceptedAt: "2026-07-22T12:00:02.000Z" };
      },
      // The bridge under test: the Graph thread's chatId (CHAT) resolves to its Surface UUID.
      resolveSurfaceForChat: (providerChatId) => (providerChatId === CHAT ? SURFACE : undefined),
    });

    // 1) resolve_surface turns the thread's chatId into a Surface id (not a chatId).
    const resolution = createResolveSurfaceTool().run({ input: { providerChatId: CHAT } });
    expect(resolution).toEqual({ resolved: true, surfaceId: SURFACE });
    // 2) prompt_speaker accepts that Surface id and the GitHub event's own id as evidence.
    const prompt = await createPromptSpeakerTool().run({ input: {
      batchId: claimed.id,
      surfaceId: (resolution as { surfaceId: string }).surfaceId,
      objective: "Tell the team a new issue was opened.",
      brief: { summary: "acme/widgets#7 was opened.", evidenceIds: [event.id] },
    } });
    expect(prompt).toMatchObject({ kind: "prompt_speaker", status: "accepted" });
    expect(delivered).toHaveLength(1);
    // An unknown chat resolves to no Surface — observation never grants participation.
    expect(createResolveSurfaceTool().run({ input: { providerChatId: "stranger@g.us" } })).toEqual({ resolved: false });
    inbox.close();
  });

  it("allow-lists a GitHub event's own id as Graph-write evidence for a GitHub-only Batch", () => {
    const root = mkdtempSync(join(tmpdir(), "ambient-brain-github-graph-"));
    roots.push(root);
    const databasePath = join(root, "application.sqlite");
    createConversationArchive(databasePath).close();
    const inbox = createBrainInbox(databasePath, {
      providerChatIdForSurface: () => undefined,
      now: () => "2026-07-22T12:00:00.000Z",
    });
    const event = inbox.admitGitHubEvent({
      githubAppId: "app-planner",
      deliveryId: "gh-graph-1",
      eventName: "issues",
      action: "opened",
      repository: "acme/widgets",
      summary: "Issue #7 opened in acme/widgets",
      detail: { issue: { number: 7 } },
    });
    const claimed = inbox.claimBatch();
    if (claimed === undefined) throw new Error("Expected a GitHub-only Brain Batch");
    inbox.markBatchDispatched(claimed.id, { dispatchId: "dispatch:brain", acceptedAt: "2026-07-22T12:00:01.000Z" });
    configureBrainEffectsRuntime({
      inbox,
      wake: async () => undefined,
      deliverPrompt: async () => { throw new Error("not expected"); },
    });

    // The Brain's Graph-write context allow-lists the GitHub event's own id.
    const context = brainGraphContext();
    expect(context.evidenceIds).toContain(event.id);

    // So a record_entity ruling citing that id is accepted (not rejected by the evidence gate).
    const graph = createGraphStore(":memory:");
    const recordEntity = createGraphTools(graph, context).find((tool) => tool.name === "record_entity")!;
    const result = recordEntity.run({
      input: { entity: { type: "topic", label: "acme/widgets issue #7", confidence: 0.9 }, evidenceIds: [event.id] },
    });
    expect(result).toMatchObject({ type: "topic" });
    // A fabricated id outside the Batch is still rejected — the gate stays strict.
    expect(() =>
      recordEntity.run({ input: { entity: { type: "topic", label: "x", confidence: 0.9 }, evidenceIds: ["not-in-batch"] } }),
    ).toThrow();
    graph.close();
    inbox.close();
  });

  it("exposes an overdue commitment's durable evidence ids so a chase prompt is accepted (not the provider messageId)", async () => {
    const { inbox, batchId } = openFixture();
    configureBrainEffectsRuntime({
      inbox,
      wake: async () => undefined,
      deliverPrompt: async () => ({ dispatchId: "dispatch:speaker:chase", acceptedAt: "2026-07-22T12:00:02.000Z" }),
    });

    // A commitment derived from the archived conversation message, citing that message's durable event id.
    const graph = createGraphStore(":memory:");
    const tools = createGraphTools(graph, brainGraphContext());
    const recordEntity = tools.find((tool) => tool.name === "record_entity")!;
    const lookup = tools.find((tool) => tool.name === "lookup_graph")!;
    const recorded = recordEntity.run({
      input: {
        entity: { type: "commitment", description: "ship the deploy", status: "open", due: "2020-01-01T00:00:00.000Z", confidence: 0.9 },
        evidenceIds: [EVIDENCE],
      },
    }) as { entityId: string };

    const found = lookup.run({ input: { entityId: recorded.entityId } }) as {
      entities: Array<{ evidenceIds: string[] }>;
    };
    const commitment = found.entities[0]!;
    // The citable evidence is the durable conversation event id (recordPrompt validates it), never a raw
    // provider messageId. lookup_graph now surfaces it directly off the backing Attestations.
    expect(commitment.evidenceIds).toContain(EVIDENCE);

    // recordPrompt accepts the very evidence id the Brain read off the graph — the chase message really lands.
    const prompt = await createPromptSpeakerTool().run({
      input: {
        batchId,
        surfaceId: SURFACE,
        objective: "Chase the overdue commitment.",
        brief: { summary: "The deploy commitment is overdue.", evidenceIds: [commitment.evidenceIds[0]!] },
      },
    });
    expect(prompt.status).toBe("accepted");
    graph.close();
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

  it("fails closed when file_issue omits the repository — never silently files into a default", async () => {
    const { inbox, batchId } = openFixture();
    const { repository, operations, filer } = filingRuntime();
    configureBrainEffectsRuntime({
      inbox,
      wake: async () => undefined,
      deliverPrompt: async () => { throw new Error("not expected"); },
      fileIssue: filer,
    });

    // A chat with no resolvable Graph relation must NOT silently misfile into defaultRepository —
    // routing is the Brain's, never a config default (§8). The omission surfaces a clear error.
    await expect(
      createFileIssueTool().run({ input: {
        batchId,
        surfaceId: SURFACE,
        kind: "bug",
        title: "Unmapped chat needs a repository",
        body: "No Graph relation resolves a repository for this chat.",
      } }),
    ).rejects.toThrow(/requires an explicit repository/);
    // No issue was created and no filing effect was recorded.
    expect(repository.events().some((event) => event.kind === "create")).toBe(false);
    expect(inbox.effects(batchId).filter((effect) => effect.kind === "file_issue")).toHaveLength(0);
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
