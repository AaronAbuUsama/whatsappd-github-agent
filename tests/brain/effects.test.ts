import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";
import * as v from "valibot";

import {
  configureBrainEffectsRuntime,
  deliverIssueFilingEffect,
  deliverIssueMutationEffect,
  recoverPendingIssueFilings,
  recoverPendingPrompts,
} from "../../packages/agents/src/brain/effects-runtime.ts";
import {
  createCreateIssueCommentTool,
  createDeleteIssueCommentTool,
  createFileIssueTool,
  createPromptSpeakerTool,
  createSetIssueStateTool,
  createSettleBrainBatchTool,
  createStaySilentTool,
  createUpdateIssueCommentTool,
  createUpdateIssueTool,
} from "../../packages/agents/src/brain/tools.ts";
import { createIssueFiler } from "../../packages/agents/src/brain/issue-filing.ts";
import { createIssueMutator } from "../../packages/agents/src/brain/issue-mutation.ts";
import brain from "../../packages/agents/src/brain/agent.ts";
import { commentProviderBody, issueOperationMarker } from "../../packages/installation/src/issue-operation-footer.ts";
import { brainGraphContext } from "../../packages/agents/src/brain/agent.ts";
import { createGraphTools } from "../../packages/agents/src/capabilities/graph/tools.ts";
import { createGraphStore } from "../../packages/engine/src/graph/store.ts";
import { createSurfaceRegistry } from "../../packages/engine/src/surfaces/registry.ts";
import { resolveEntitySurface } from "../../apps/runtime/src/host/whatsapp-runtime.ts";
import { createIssueManagementPolicy } from "../../packages/agents/src/capabilities/issue-management/runtime.ts";
import { createIssueReadTools } from "../../packages/agents/src/capabilities/issue-management/tools.ts";
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
      target: { surfaceId: SURFACE },
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

  it("resolves a Brain-chosen target entity (thread/person) to a Surface, and stays fail-closed for an unknown one", async () => {
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

    const THREAD_ENTITY = "thread:acme-widgets";
    const delivered: unknown[] = [];
    configureBrainEffectsRuntime({
      inbox,
      wake: async () => undefined,
      deliverPrompt: async (effect) => {
        delivered.push(effect.directive);
        return { dispatchId: "dispatch:speaker:gh", acceptedAt: "2026-07-22T12:00:02.000Z" };
      },
      // The seam under test: a known target entity resolves to its Surface UUID; anything else does not.
      resolveSurfaceForEntity: (entityId) =>
        entityId === THREAD_ENTITY ? { surfaceId: SURFACE, release: () => undefined } : undefined,
    });

    // prompt_speaker takes the thread's entity id directly (no chatId hop) and resolves it in admission.
    const prompt = await createPromptSpeakerTool().run({ input: {
      batchId: claimed.id,
      target: { entityId: THREAD_ENTITY },
      objective: "Tell the team a new issue was opened.",
      brief: { summary: "acme/widgets#7 was opened.", evidenceIds: [event.id] },
    } });
    expect(prompt).toMatchObject({ kind: "prompt_speaker", status: "accepted" });
    expect(delivered).toHaveLength(1);
    // An unknown/unaddressable entity resolves to no Surface — observation never grants participation,
    // so prompt_speaker fails closed rather than dispatching anything.
    await expect(
      createPromptSpeakerTool().run({ input: {
        batchId: claimed.id,
        target: { entityId: "person:stranger" },
        objective: "Should never send.",
        brief: { summary: "unknown person.", evidenceIds: [event.id] },
      } }),
    ).rejects.toThrow(/resolves to no Surface/);
    expect(delivered).toHaveLength(1);
    inbox.close();
  });

  it("rolls back a DM Surface opened during a prompt whose admission then fails — no orphaned binding", async () => {
    const root = mkdtempSync(join(tmpdir(), "ambient-brain-dm-rollback-"));
    roots.push(root);
    const databasePath = join(root, "application.sqlite");
    createConversationArchive(databasePath).close();
    const surfaces = createSurfaceRegistry(databasePath);
    const graph = createGraphStore(databasePath);
    const ACCOUNT = "15550000000@s.whatsapp.net";
    const PERSON_DM = "person-dm-77@lid";
    const attested = graph.attest({
      context: { author: { kind: "brain", id: "brain" }, evidenceIds: ["test:dm"] },
      claim: { kind: "entity", input: { type: "person", properties: {}, identity: { platform: "whatsapp", externalId: PERSON_DM } } },
    });
    if (attested.kind !== "entity") throw new Error("Expected a person Entity Attestation.");
    const inbox = createBrainInbox(databasePath, {
      providerChatIdForSurface: (surfaceId) => surfaces.activeBinding(surfaceId)?.providerChatId,
    });
    configureBrainEffectsRuntime({
      inbox,
      wake: async () => undefined,
      deliverPrompt: async () => {
        throw new Error("Delivery must never run: admission rejects first.");
      },
      resolveSurfaceForEntity: (entityId) => resolveEntitySurface({ graph, surfaces, accountJid: ACCOUNT }, entityId),
    });

    // The chat has no Surface yet. prompt_speaker targets the known person against a Batch that is not open
    // and dispatched, so recordPrompt rejects — AFTER resolution opened the DM Surface.
    expect(surfaces.activeSurface(ACCOUNT, PERSON_DM)).toBeUndefined();
    await expect(
      createPromptSpeakerTool().run({ input: {
        batchId: "brain-batch:never-dispatched",
        target: { entityId: attested.entity.entityId },
        objective: "Should never be admitted.",
        brief: { summary: "stale batch.", evidenceIds: [EVIDENCE] },
      } }),
    ).rejects.toThrow(/not open and dispatched/);
    // Materialization stayed atomic with admission: the opened DM binding was rolled back, so the intake
    // gate will NOT admit this chat behind a prompt that was never accepted.
    expect(surfaces.activeSurface(ACCOUNT, PERSON_DM)).toBeUndefined();

    inbox.close();
    surfaces.close();
    graph.close();
  });

  it("rejects a prompt_speaker target carrying both surfaceId and entityId as invalid input", () => {
    const schema = createPromptSpeakerTool().input;
    const base = { batchId: "b", objective: "o", brief: { summary: "s", evidenceIds: ["e"] } };
    // Ambiguous: a target must be exactly one of surfaceId / entityId — both is invalid, not first-wins.
    expect(v.safeParse(schema, { ...base, target: { surfaceId: "s1", entityId: "e1" } }).success).toBe(false);
    expect(v.safeParse(schema, { ...base, target: {} }).success).toBe(false);
    // Each single-field target is still accepted.
    expect(v.safeParse(schema, { ...base, target: { surfaceId: "s1" } }).success).toBe(true);
    expect(v.safeParse(schema, { ...base, target: { entityId: "e1" } }).success).toBe(true);
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
        target: { surfaceId: SURFACE },
        objective: "Chase the overdue commitment.",
        brief: { summary: "The deploy commitment is overdue.", evidenceIds: [commitment.evidenceIds[0]!] },
      },
    });
    expect(prompt.status).toBe("accepted");
    graph.close();
    inbox.close();
  });

  it("mounts the read-only issue tools on the Brain so it can resolve exact numbers before mutating", async () => {
    const config = await brain.initialize({ id: "global", env: {} });
    const toolNames = config.tools?.map((tool) => tool.name);
    // The Brain's instructions tell it to read the issue first; those tools must actually be mounted.
    expect(toolNames).toContain("github_read_issue");
    expect(toolNames).toContain("github_read_issue_discussion");
    // Alongside the five mutation tools it wires as down-flow Effects.
    for (const name of [
      "create_issue_comment",
      "update_issue",
      "update_issue_comment",
      "delete_issue_comment",
      "set_issue_state",
    ]) {
      expect(toolNames).toContain(name);
    }
  });

  it("fails the read tools closed when the repository is omitted — same no-default discipline as mutations", async () => {
    // A read that silently defaulted the repo would hand back numbers from the WRONG repo that then flow
    // into a real mutation, bypassing the no-default-routing discipline (S1/#249). Both reads fail closed.
    const [readIssue, readDiscussion] = createIssueReadTools();
    await expect(readIssue!.run({ input: { number: 1 } })).rejects.toThrow(/requires an explicit repository/);
    await expect(readDiscussion!.run({ input: { number: 1 } })).rejects.toThrow(/requires an explicit repository/);
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
      target: { surfaceId: SURFACE },
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

  const REPO_REF = { owner: "acme", repo: "widgets" } as const;
  const mutationRuntime = () => {
    const repository = createFakeIssueRepository();
    const operations = createIssueOperationStore(":memory:");
    const policy = createIssueManagementPolicy(REPOSITORY, [REPOSITORY]);
    return { repository, operations, mutator: createIssueMutator({ repository, operations, policy }) };
  };

  it("posts a comment as a durable down-flow effect, completes it, and lets the Batch settle", async () => {
    const { inbox, batchId } = openFixture();
    const { repository, operations, mutator } = mutationRuntime();
    const issue = repository.seed({ repository: REPO_REF, title: "A real issue", body: "Body" });
    configureBrainEffectsRuntime({
      inbox,
      wake: async () => undefined,
      deliverPrompt: async () => { throw new Error("not expected"); },
      mutateIssue: mutator,
    });

    const commented = await createCreateIssueCommentTool().run({ input: {
      batchId,
      surfaceId: SURFACE,
      repository: REPOSITORY,
      number: issue.number,
      body: "Working on this now.",
    } });
    expect(commented).toMatchObject({
      kind: "create_issue_comment",
      effectId: expect.stringMatching(/^brain-effect:[a-f0-9]{64}$/u),
      outcome: { status: "applied", commentId: expect.any(Number) },
    });
    await expect(createSettleBrainBatchTool().run({ input: { batchId } })).resolves.toMatchObject({ status: "settled" });
    operations.close();
    inbox.close();
  });

  it("closes an issue with a reason and reopens it as durable state-change effects", async () => {
    const { inbox, batchId } = openFixture();
    const { repository, operations, mutator } = mutationRuntime();
    const issue = repository.seed({ repository: REPO_REF, title: "Closeable", body: "Body" });
    configureBrainEffectsRuntime({
      inbox,
      wake: async () => undefined,
      deliverPrompt: async () => { throw new Error("not expected"); },
      mutateIssue: mutator,
    });

    const closed = await createSetIssueStateTool().run({ input: {
      batchId, surfaceId: SURFACE, repository: REPOSITORY, number: issue.number, state: "closed", reason: "completed",
    } });
    expect(closed).toMatchObject({ kind: "set_issue_state", outcome: { status: "applied", state: "closed" } });
    operations.close();
    inbox.close();
  });

  it("updates an existing issue's title and body as a durable mutation effect", async () => {
    const { inbox, batchId } = openFixture();
    const { repository, operations, mutator } = mutationRuntime();
    const issue = repository.seed({ repository: REPO_REF, title: "Old title", body: "Old body" });
    configureBrainEffectsRuntime({
      inbox,
      wake: async () => undefined,
      deliverPrompt: async () => { throw new Error("not expected"); },
      mutateIssue: mutator,
    });

    const updated = await createUpdateIssueTool().run({ input: {
      batchId, surfaceId: SURFACE, repository: REPOSITORY, number: issue.number, title: "New title", body: "New body",
    } });
    expect(updated).toMatchObject({
      kind: "update_issue",
      outcome: { status: "applied", issueNumber: issue.number, state: "open" },
    });
    operations.close();
    inbox.close();
  });

  it("fails closed when an issue mutation omits the repository — never silently targets a default", async () => {
    const { inbox, batchId } = openFixture();
    const { repository, operations, mutator } = mutationRuntime();
    repository.seed({ repository: REPO_REF, title: "Needs a repo", body: "Body" });
    configureBrainEffectsRuntime({
      inbox,
      wake: async () => undefined,
      deliverPrompt: async () => { throw new Error("not expected"); },
      mutateIssue: mutator,
    });

    await expect(
      createCreateIssueCommentTool().run({ input: { batchId, surfaceId: SURFACE, number: 1, body: "No repo." } }),
    ).rejects.toThrow(/requires an explicit repository/);
    // No mutation effect was recorded and no comment was posted.
    expect(inbox.effects(batchId).filter((effect) => effect.kind === "issue_mutation")).toHaveLength(0);
    expect(repository.events().some((event) => event.kind === "create-comment")).toBe(false);
    operations.close();
    inbox.close();
  });

  it("refuses to delete or edit a human's comment; a hallucinated commentId never records a destructive effect", async () => {
    const { inbox, batchId } = openFixture();
    const { repository, operations, mutator } = mutationRuntime();
    const issue = repository.seed({ repository: REPO_REF, title: "Has a human comment", body: "Body" });
    const human = repository.seedComment({ repository: REPO_REF, number: issue.number, body: "A maintainer note", author: "maintainer" });
    configureBrainEffectsRuntime({
      inbox,
      wake: async () => undefined,
      deliverPrompt: async () => { throw new Error("not expected"); },
      mutateIssue: mutator,
    });

    // Delete of a comment the Brain never created is refused at admission — no effect, no provider call.
    await expect(
      createDeleteIssueCommentTool().run({ input: {
        batchId, surfaceId: SURFACE, repository: REPOSITORY, number: issue.number, commentId: human.id,
      } }),
    ).rejects.toThrow(/restricted to the Brain's own prior comments/i);
    // Edit of a human's comment is refused the same way.
    await expect(
      createUpdateIssueCommentTool().run({ input: {
        batchId, surfaceId: SURFACE, repository: REPOSITORY, number: issue.number, commentId: human.id, body: "Rewritten.",
      } }),
    ).rejects.toThrow(/restricted to the Brain's own prior comments/i);
    expect(inbox.effects(batchId).filter((effect) => effect.kind === "issue_mutation")).toHaveLength(0);
    expect(repository.events().some((event) => event.kind === "delete-comment" || event.kind === "update-comment")).toBe(false);
    operations.close();
    inbox.close();
  });

  it("lets the Brain delete a comment it itself created, verified against recorded filing history", async () => {
    const { inbox, batchId } = openFixture();
    const { repository, operations, mutator } = mutationRuntime();
    const issue = repository.seed({ repository: REPO_REF, title: "Brain will self-delete", body: "Body" });
    configureBrainEffectsRuntime({
      inbox,
      wake: async () => undefined,
      deliverPrompt: async () => { throw new Error("not expected"); },
      mutateIssue: mutator,
    });

    const commented = await createCreateIssueCommentTool().run({ input: {
      batchId, surfaceId: SURFACE, repository: REPOSITORY, number: issue.number, body: "Temporary note.",
    } });
    const commentId = (commented.outcome as { commentId: number }).commentId;
    const deleted = await createDeleteIssueCommentTool().run({ input: {
      batchId, surfaceId: SURFACE, repository: REPOSITORY, number: issue.number, commentId,
    } });
    expect(deleted).toMatchObject({ kind: "delete_issue_comment", outcome: { status: "applied", commentId } });
    operations.close();
    inbox.close();
  });

  it("reconciles a recovered comment mutation by Operation Identity without posting a second comment", async () => {
    const { inbox, batchId } = openFixture();
    const { repository, operations, mutator } = mutationRuntime();
    const issue = repository.seed({ repository: REPO_REF, title: "Reconcilable", body: "Body" });
    configureBrainEffectsRuntime({
      inbox,
      wake: async () => undefined,
      deliverPrompt: async () => { throw new Error("not expected"); },
      mutateIssue: mutator,
    });
    const pending = inbox.recordIssueMutation({
      batchId,
      sourceSurfaceId: SURFACE,
      mutation: { kind: "create-comment", repository: REPOSITORY, number: issue.number, body: "Once only." },
    });
    // First attempt posts the comment and completes its Operation, then the Effect completion is lost to a crash.
    await mutator(pending.mutation, pending.id);
    expect(repository.events().filter((event) => event.kind === "create-comment")).toHaveLength(1);
    repository.resetEvents();

    const recovered = await deliverIssueMutationEffect(pending);
    expect(recovered.status).toBe("completed");
    expect(recovered.outcome).toMatchObject({ status: "reconciled", commentId: expect.any(Number) });
    // Dedup came from strongly-consistent Operation Identity — no second comment was ever posted.
    expect(repository.events().some((event) => event.kind === "create-comment")).toBe(false);
    operations.close();
    inbox.close();
  });

  it("reconciles a recovered comment mutation GitHub already applied even when completion was lost to a crash", async () => {
    const { inbox, batchId } = openFixture();
    const { repository, operations, mutator } = mutationRuntime();
    const issue = repository.seed({ repository: REPO_REF, title: "Crash mid-comment", body: "Body" });
    configureBrainEffectsRuntime({
      inbox,
      wake: async () => undefined,
      deliverPrompt: async () => { throw new Error("not expected"); },
      mutateIssue: mutator,
    });
    const pending = inbox.recordIssueMutation({
      batchId,
      sourceSurfaceId: SURFACE,
      mutation: { kind: "create-comment", repository: REPOSITORY, number: issue.number, body: "Posted before the crash." },
    });
    const operationId = `issue-mutation:${pending.id}`;
    // GitHub applied the comment (Operation-Identity marker embedded), but the local completion write was
    // lost to a crash — the operation is left non-completed (uncertain), yet the comment is observable.
    const seeded = repository.seedComment({
      repository: REPO_REF,
      number: issue.number,
      author: "ambient-agent",
      body: commentProviderBody("Posted before the crash.", [issueOperationMarker({ id: operationId })]),
    });
    operations.begin({
      operationId,
      kind: "create-comment",
      repository: REPOSITORY,
      issueNumber: issue.number,
      target: { body: "Posted before the crash." },
      startedAt: "2026-07-22T12:00:00.000Z",
    });
    operations.uncertain(operationId, "Process restarted after the provider mutation began", "2026-07-22T12:00:01.000Z");

    const recovered = await deliverIssueMutationEffect(pending);
    // Recovery observes the real comment and reconciles WITH its commentId — never settles blind `uncertain`.
    expect(recovered.status).toBe("completed");
    expect(recovered.outcome).toMatchObject({ status: "reconciled", commentId: seeded.id });
    expect(repository.events().some((event) => event.kind === "create-comment")).toBe(false);
    // The consequence that makes this matter: a completed create-comment record now authorizes deleting it.
    expect(() =>
      inbox.recordIssueMutation({
        batchId,
        sourceSurfaceId: SURFACE,
        mutation: { kind: "delete-comment", repository: REPOSITORY, number: issue.number, commentId: seeded.id },
      }),
    ).not.toThrow();
    operations.close();
    inbox.close();
  });

  it("reconciles a recovered issue update GitHub already applied even when completion was lost to a crash", async () => {
    const { inbox, batchId } = openFixture();
    const { repository, operations, mutator } = mutationRuntime();
    const issue = repository.seed({ repository: REPO_REF, title: "Old title", body: "Old body" });
    configureBrainEffectsRuntime({
      inbox,
      wake: async () => undefined,
      deliverPrompt: async () => { throw new Error("not expected"); },
      mutateIssue: mutator,
    });
    const pending = inbox.recordIssueMutation({
      batchId,
      sourceSurfaceId: SURFACE,
      mutation: { kind: "update-issue", repository: REPOSITORY, number: issue.number, title: "New title", body: "New body" },
    });
    const operationId = `issue-mutation:${pending.id}`;
    // GitHub applied the update, but the local completion write was lost to a crash: the issue already
    // reflects the requested title/body, yet the Operation is left non-completed (uncertain).
    await repository.update({
      repository: REPO_REF,
      number: issue.number,
      changes: { title: "New title", body: "New body" },
      operation: { id: `${operationId}:provider` },
    });
    repository.resetEvents();
    operations.begin({
      operationId,
      kind: "update-issue",
      repository: REPOSITORY,
      issueNumber: issue.number,
      target: { title: "New title", body: "New body" },
      startedAt: "2026-07-22T12:00:00.000Z",
    });
    operations.uncertain(operationId, "Process restarted after the provider mutation began", "2026-07-22T12:00:01.000Z");

    const recovered = await deliverIssueMutationEffect(pending);
    // Recovery observes the issue and reconciles because it already reflects the request — not blind uncertain.
    expect(recovered.status).toBe("completed");
    expect(recovered.outcome).toMatchObject({ status: "reconciled", issueNumber: issue.number });
    // No second update was issued — the observed end-state was proof enough.
    expect(repository.events().some((event) => event.kind === "update")).toBe(false);
    operations.close();
    inbox.close();
  });

  it("settles a recovered issue update as uncertain when the issue does not reflect the requested change", async () => {
    const { inbox, batchId } = openFixture();
    const { repository, operations, mutator } = mutationRuntime();
    const issue = repository.seed({ repository: REPO_REF, title: "Unchanged title", body: "Unchanged body" });
    configureBrainEffectsRuntime({
      inbox,
      wake: async () => undefined,
      deliverPrompt: async () => { throw new Error("not expected"); },
      mutateIssue: mutator,
    });
    const pending = inbox.recordIssueMutation({
      batchId,
      sourceSurfaceId: SURFACE,
      mutation: { kind: "update-issue", repository: REPOSITORY, number: issue.number, title: "Never applied" },
    });
    const operationId = `issue-mutation:${pending.id}`;
    // The mutation began but GitHub never applied it (the issue still shows the old title) and the crash
    // left the Operation non-completed — recovery has no evidence of success, so it stays uncertain.
    operations.begin({
      operationId,
      kind: "update-issue",
      repository: REPOSITORY,
      issueNumber: issue.number,
      target: { title: "Never applied" },
      startedAt: "2026-07-22T12:00:00.000Z",
    });
    operations.uncertain(operationId, "Process restarted after the provider mutation began", "2026-07-22T12:00:01.000Z");

    const recovered = await deliverIssueMutationEffect(pending);
    expect(recovered.status).toBe("completed");
    expect(recovered.outcome).toMatchObject({ status: "uncertain" });
    operations.close();
    inbox.close();
  });

  it("does not reconcile a recovered set-issue-state when another actor closed it with a different reason", async () => {
    const { inbox, batchId } = openFixture();
    const { repository, operations, mutator } = mutationRuntime();
    const issue = repository.seed({ repository: REPO_REF, title: "Contested close", body: "Body" });
    configureBrainEffectsRuntime({
      inbox,
      wake: async () => undefined,
      deliverPrompt: async () => { throw new Error("not expected"); },
      mutateIssue: mutator,
    });
    const pending = inbox.recordIssueMutation({
      batchId,
      sourceSurfaceId: SURFACE,
      mutation: { kind: "set-issue-state", repository: REPOSITORY, number: issue.number, state: "closed", reason: "duplicate" },
    });
    const operationId = `issue-mutation:${pending.id}`;
    // A DIFFERENT actor closed the issue as `completed` while the Brain's close-as-`duplicate` crashed
    // mid-flight. The issue is `closed`, but NOT for the reason the Brain requested — reconciling here
    // would durably record the wrong reason as if the Brain's specific request had landed.
    await repository.setState({
      repository: REPO_REF,
      number: issue.number,
      state: "closed",
      reason: "completed",
      operation: { id: "other-actor" },
    });
    repository.resetEvents();
    operations.begin({
      operationId,
      kind: "set-issue-state",
      repository: REPOSITORY,
      issueNumber: issue.number,
      target: { state: "closed", reason: "duplicate" },
      startedAt: "2026-07-22T12:00:00.000Z",
    });
    operations.uncertain(operationId, "Process restarted after the provider mutation began", "2026-07-22T12:00:01.000Z");

    const recovered = await deliverIssueMutationEffect(pending);
    expect(recovered.status).toBe("completed");
    // State matches (closed) but the reason does not (completed != duplicate) — stay honestly uncertain.
    expect(recovered.outcome).toMatchObject({ status: "uncertain" });
    operations.close();
    inbox.close();
  });

  it("preserves a created comment's id on an uncertain result, so a later delete of it is authorized", async () => {
    const { inbox, batchId } = openFixture();
    const repository = createFakeIssueRepository();
    const operations = createIssueOperationStore(":memory:");
    // Fail only `complete`: GitHub really creates the comment, but its Operation Identity completion cannot
    // be persisted — the capability honestly reports `uncertain` while still surfacing the created comment.
    const flakyOperations = {
      ...operations,
      complete: () => { throw new Error("Operation ledger write failed"); },
    } as typeof operations;
    const policy = createIssueManagementPolicy(REPOSITORY, [REPOSITORY]);
    const mutator = createIssueMutator({ repository, operations: flakyOperations, policy });
    const issue = repository.seed({ repository: REPO_REF, title: "Uncertain create", body: "Body" });
    configureBrainEffectsRuntime({
      inbox,
      wake: async () => undefined,
      deliverPrompt: async () => { throw new Error("not expected"); },
      mutateIssue: mutator,
    });

    const commented = await createCreateIssueCommentTool().run({ input: {
      batchId, surfaceId: SURFACE, repository: REPOSITORY, number: issue.number, body: "Landed but uncertain.",
    } });
    // Uncertain — but the real commentId is preserved in the durable outcome, not discarded.
    expect(commented.outcome.status).toBe("uncertain");
    const commentId = (commented.outcome as { commentId: number }).commentId;
    expect(commentId).toEqual(expect.any(Number));

    // Because a completed effect now carries that commentId, deleting the Brain's own comment is authorized.
    expect(() =>
      inbox.recordIssueMutation({
        batchId,
        sourceSurfaceId: SURFACE,
        mutation: { kind: "delete-comment", repository: REPOSITORY, number: issue.number, commentId },
      }),
    ).not.toThrow();
    operations.close();
    inbox.close();
  });

  it("settles a non-retryable issue-mutation failure as uncertain so the Batch is not wedged", async () => {
    const { inbox, batchId } = openFixture();
    const { repository, operations, mutator } = mutationRuntime();
    const issue = repository.seed({ repository: REPO_REF, title: "Will fail", body: "Body" });
    configureBrainEffectsRuntime({
      inbox,
      wake: async () => undefined,
      deliverPrompt: async () => { throw new Error("not expected"); },
      mutateIssue: mutator,
    });
    repository.failNextLifecycleMutation("create-comment", Object.assign(new Error("Not Found"), { status: 404 }));

    const commented = await createCreateIssueCommentTool().run({ input: {
      batchId, surfaceId: SURFACE, repository: REPOSITORY, number: issue.number, body: "Doomed.",
    } });
    expect(commented).toMatchObject({ kind: "create_issue_comment", outcome: { status: "uncertain" } });
    await expect(createSettleBrainBatchTool().run({ input: { batchId } })).resolves.toMatchObject({ status: "settled" });
    operations.close();
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
