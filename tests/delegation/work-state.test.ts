import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { createBrainInbox, type BrainInbox } from "../../packages/engine/src/brain/inbox.ts";
import { createConversationArchive } from "../../packages/engine/src/intake/conversation-archive.ts";
import type { ConversationArrival } from "../../packages/engine/src/intake/conversation-event.ts";
import {
  composeWorkItems,
  computeGraphDigest,
  isEmptyDigest,
  MAX_GRAPH_DIGEST_BYTES,
  type DigestWorkItem,
  type GraphDigest,
} from "../../packages/engine/src/graph/digest.ts";
import { createGraphStore } from "../../packages/engine/src/graph/store.ts";
import { configureGraphStore } from "../../packages/agents/src/capabilities/graph/runtime.ts";
import { configureDelegationRuntime } from "../../packages/agents/src/capabilities/delegation/runtime.ts";
import { attachGraphContext } from "../../packages/agents/src/capabilities/graph/digest.ts";
import { createLookupWorkTool } from "../../packages/agents/src/capabilities/delegation/work-tools.ts";
import type { SpeakerInput } from "../../packages/engine/src/inputs.ts";

const SOURCE = "surface:source";
const CHAT = "team@g.us";
const EVIDENCE = "arrival:source:req";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const fixture = (): { databasePath: string; inbox: BrainInbox; batchId: string } => {
  const root = mkdtempSync(join(tmpdir(), "ambient-work-state-"));
  roots.push(root);
  const databasePath = join(root, "application.sqlite");
  const archive = createConversationArchive(databasePath);
  archive.append({
    id: EVIDENCE,
    kind: "arrival",
    providerMessageId: "req",
    chatId: CHAT,
    senderId: "alice@s.whatsapp.net",
    senderName: "Alice",
    direction: "inbound",
    occurredAt: 1_000,
    payload: { live: true, isGroup: true, messageKind: "text", text: "Implement issue 7." },
  } satisfies ConversationArrival);
  archive.close();
  const inbox = createBrainInbox(databasePath, {
    providerChatIdForSurface: (surfaceId) => (surfaceId === SOURCE ? CHAT : undefined),
  });
  inbox.admitIntent({ sourceSurfaceId: SOURCE, interpretation: "Implement issue 7.", evidenceIds: [EVIDENCE] });
  const batch = inbox.claimBatch()!;
  inbox.markBatchDispatched(batch.id, { dispatchId: "d1", acceptedAt: "2026-07-22T16:00:01.000Z" });
  return { databasePath, inbox, batchId: batch.id };
};

const acceptedLaunch = (inbox: BrainInbox, batchId: string, runId = "run:1", sourceSurfaceId = SOURCE) => {
  const launch = inbox.reserveSpecialistLaunch({
    batchId,
    sourceSurfaceId,
    specialist: "coder",
    input: { repository: "acme/widgets", issue: 7 },
  });
  return inbox.markSpecialistLaunchAccepted(launch.id, runId);
};

describe("Down-flow work-state streaming (#319)", () => {
  it("streams start, ordered milestones, and a latest per item; identical notes coalesce", () => {
    const { inbox, batchId } = fixture();
    const launch = acceptedLaunch(inbox, batchId);

    inbox.recordWorkMilestone({ workId: launch.id, note: "planner started" });
    inbox.recordWorkMilestone({ workId: launch.id, note: "coder (round 1) started" });
    inbox.recordWorkMilestone({ workId: launch.id, note: "planner started" }); // duplicate retry
    inbox.recordWorkMilestone({ workId: launch.id, note: "verifier (round 1) started" });

    expect(inbox.workMilestones(launch.id).map((m) => m.note)).toEqual([
      "planner started",
      "coder (round 1) started",
      "verifier (round 1) started",
    ]);
    expect(inbox.latestWorkMilestone(launch.id)?.note).toBe("verifier (round 1) started");
    inbox.close();
  });

  it("NEGATIVE — an accepted work item is never invisible: exactly active-and-visible XOR terminally-resulted", () => {
    const { inbox, batchId } = fixture();
    const launch = acceptedLaunch(inbox, batchId);
    inbox.recordWorkMilestone({ workId: launch.id, note: "coder (round 1) started" });

    // Slow action in flight: visible as an active work item with its latest milestone — no silent gap.
    const active = inbox.activeWorkItems();
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({
      workId: launch.id,
      specialist: "coder",
      sourceSurfaceId: SOURCE,
      latestMilestone: { note: "coder (round 1) started" },
    });
    expect(inbox.specialistResultForWork(launch.id)).toBeUndefined();

    // Terminal: it leaves the active set and becomes a reportable result — still never invisible.
    inbox.admitSpecialistResult({ workId: launch.id, runId: launch.runId!, status: "ok", result: { prNumber: 42 } });
    expect(inbox.activeWorkItems()).toHaveLength(0);
    expect(inbox.specialistResultForWork(launch.id)).toMatchObject({ status: "ok", result: { prNumber: 42 } });

    // At no point was the acked work both absent from the active set AND without a result.
    inbox.close();
  });

  it("survives restart (L5): milestones and active work state reload byte-identically", () => {
    const { databasePath, inbox, batchId } = fixture();
    const launch = acceptedLaunch(inbox, batchId);
    inbox.recordWorkMilestone({ workId: launch.id, note: "planner started" });
    const before = inbox.activeWorkItems();
    inbox.close();

    const reopened = createBrainInbox(databasePath, { providerChatIdForSurface: () => CHAT });
    expect(reopened.activeWorkItems()).toEqual(before);
    expect(reopened.workMilestones(launch.id).map((m) => m.note)).toEqual(["planner started"]);
    reopened.close();
  });
});

describe("Digest composition (#319)", () => {
  const emptyGraph = (): GraphDigest => computeGraphDigest(createGraphStore(":memory:"), { identities: [] });

  it("composes work items onto a digest without replacing its graph content", () => {
    const store = createGraphStore(":memory:");
    store.attest({
      context: { author: { kind: "ingester", id: "fx" }, evidenceIds: ["e1"] },
      claim: { kind: "entity", input: { type: "person", properties: { name: "Alice" }, identity: { platform: "whatsapp", externalId: "alice@s.whatsapp.net" } } },
    });
    const base = computeGraphDigest(store, { identities: [{ platform: "whatsapp", externalId: "alice@s.whatsapp.net" }] });
    expect(base.entities.length).toBeGreaterThan(0);

    const composed = composeWorkItems(base, [{ workId: "brain-work:x", specialist: "coder", sourceSurfaceId: SOURCE, startedAt: "t0" }]);
    expect(composed.entities).toEqual(base.entities); // graph content preserved, not replaced
    expect(composed.workItems).toHaveLength(1);
  });

  it("a digest carrying only work items is not empty — a slow action still spends a turn", () => {
    const base = emptyGraph();
    expect(isEmptyDigest(base)).toBe(true);
    const composed = composeWorkItems(base, [{ workId: "w", specialist: "coder", sourceSurfaceId: SOURCE, startedAt: "t0" }]);
    expect(isEmptyDigest(composed)).toBe(false);
  });

  it("the Speaker funnel attaches active work state onto the input's graphContext", () => {
    const { inbox, batchId } = fixture();
    const launch = acceptedLaunch(inbox, batchId);
    inbox.recordWorkMilestone({ workId: launch.id, note: "coder (round 1) started" });
    configureGraphStore(createGraphStore(":memory:"));
    configureDelegationRuntime({ inbox, wake: async () => undefined, providerChatIdForSurface: () => CHAT });

    const input: SpeakerInput = { type: "brain.directive", directive: { id: "dir", surfaceId: SOURCE, objective: "report", brief: { summary: "s", evidenceIds: ["e"] } } };
    const enriched = attachGraphContext(input);

    expect(enriched.graphContext?.workItems).toEqual([
      { workId: launch.id, specialist: "coder", sourceSurfaceId: SOURCE, startedAt: launch.acceptedAt, latestMilestone: { note: "coder (round 1) started", at: expect.any(String) } },
    ]);
    inbox.close();
  });

  it("NEGATIVE — a Speaker never sees another chat's work items (no cross-surface leak)", () => {
    const OTHER = "surface:other";
    const OTHER_CHAT = "other@g.us";
    // One batch carrying provenance for two Surfaces, so each can launch its own work.
    const root = mkdtempSync(join(tmpdir(), "ambient-work-leak-"));
    roots.push(root);
    const databasePath = join(root, "application.sqlite");
    const archive = createConversationArchive(databasePath);
    for (const [id, chatId] of [["arrival:source:r", CHAT], ["arrival:other:r", OTHER_CHAT]] as const) {
      archive.append({
        id, kind: "arrival", providerMessageId: id, chatId, senderId: "a@s.whatsapp.net", senderName: "A",
        direction: "inbound", occurredAt: 1_000,
        payload: { live: true, isGroup: true, messageKind: "text", text: "Implement issue 7." },
      } satisfies ConversationArrival);
    }
    archive.close();
    const chatFor = (surfaceId: string) => (surfaceId === SOURCE ? CHAT : surfaceId === OTHER ? OTHER_CHAT : undefined);
    const inbox = createBrainInbox(databasePath, { providerChatIdForSurface: chatFor });
    inbox.admitIntent({ sourceSurfaceId: SOURCE, interpretation: "Implement issue 7.", evidenceIds: ["arrival:source:r"] });
    inbox.admitIntent({ sourceSurfaceId: OTHER, interpretation: "Implement issue 7.", evidenceIds: ["arrival:other:r"] });
    const batchId = inbox.claimBatch()!.id;
    inbox.markBatchDispatched(batchId, { dispatchId: "d", acceptedAt: "2026-07-22T16:00:01.000Z" });
    const mine = acceptedLaunch(inbox, batchId, "run:mine", SOURCE);
    const theirs = acceptedLaunch(inbox, batchId, "run:theirs", OTHER);
    configureGraphStore(createGraphStore(":memory:"));
    configureDelegationRuntime({ inbox, wake: async () => undefined, providerChatIdForSurface: chatFor });

    // A whatsapp window in CHAT only sees CHAT's work; the other chat's work id never appears.
    const input: SpeakerInput = {
      type: "whatsapp.window",
      windowId: "w",
      chatId: CHAT,
      reason: "debounce",
      messages: [],
      updates: [],
    };
    const workItems = attachGraphContext(input).graphContext?.workItems ?? [];
    expect(workItems.map((item) => item.workId)).toEqual([mine.id]);
    expect(workItems.some((item) => item.workId === theirs.id)).toBe(false);
    inbox.close();
  });

  it("keeps graphContext within the byte budget with many active work items", () => {
    const base = computeGraphDigest(createGraphStore(":memory:"), { identities: [] });
    const many: DigestWorkItem[] = Array.from({ length: 200 }, (_, i) => ({
      workId: `brain-work:${"a".repeat(64)}:${i}`,
      specialist: "coder",
      sourceSurfaceId: SOURCE,
      startedAt: "2026-01-01T00:00:00.000Z",
      latestMilestone: { note: "verifier (round 1) started ".repeat(120), at: "2026-01-01T00:00:00.000Z" },
    }));
    const composed = composeWorkItems(base, many);
    expect(Buffer.byteLength(JSON.stringify(composed))).toBeLessThanOrEqual(MAX_GRAPH_DIGEST_BYTES);
    expect(composed.workItems!.length).toBeGreaterThan(0);
    expect(composed.workItems!.length).toBeLessThan(many.length); // trimmed to fit
    // Input is oldest-first; the trim must retain the NEWEST work, not the stalest.
    expect(composed.workItems!.some((item) => item.workId === many.at(-1)!.workId)).toBe(true);
    expect(composed.workItems!.some((item) => item.workId === many[0]!.workId)).toBe(false);
  });
});

describe("Speaker pull tool lookup_work (#319)", () => {
  it("returns ordered milestones and the terminal outcome by work id, read-only", async () => {
    const { inbox, batchId } = fixture();
    const launch = acceptedLaunch(inbox, batchId);
    inbox.recordWorkMilestone({ workId: launch.id, note: "planner started" });
    configureDelegationRuntime({ inbox, wake: async () => undefined, providerChatIdForSurface: () => CHAT });
    const tool = createLookupWorkTool(CHAT);

    const active = await tool.run({ input: { workId: launch.id } } as never);
    expect(active).toMatchObject({ found: true, specialist: "coder", status: "active", milestones: [{ note: "planner started" }] });

    inbox.admitSpecialistResult({ workId: launch.id, runId: launch.runId!, status: "ok", result: { prNumber: 9 } });
    const done = await tool.run({ input: { workId: launch.id } } as never);
    expect(done).toMatchObject({ found: true, status: "ok", result: { prNumber: 9 } });

    const missing = await tool.run({ input: { workId: "brain-work:nope" } } as never);
    expect(missing).toMatchObject({ found: false, status: "unknown", milestones: [] });
    inbox.close();
  });

  it("NEGATIVE — lookup_work never returns another chat's work (fail-closed cross-surface)", async () => {
    const OTHER = "surface:other";
    const OTHER_CHAT = "other@g.us";
    const { inbox, batchId } = fixture(); // batch provenance is SOURCE (chat CHAT)
    const mine = acceptedLaunch(inbox, batchId, "run:mine", SOURCE);
    inbox.recordWorkMilestone({ workId: mine.id, note: "planner started" });
    configureDelegationRuntime({
      inbox,
      wake: async () => undefined,
      providerChatIdForSurface: (surfaceId) => (surfaceId === SOURCE ? CHAT : surfaceId === OTHER ? OTHER_CHAT : undefined),
    });

    // A tool bound to the OTHER chat must not read CHAT's work item, even given its exact id.
    const foreignTool = createLookupWorkTool(OTHER_CHAT);
    expect(await foreignTool.run({ input: { workId: mine.id } } as never)).toMatchObject({ found: false, milestones: [] });
    // The owning chat still reads its own work.
    const ownTool = createLookupWorkTool(CHAT);
    expect(await ownTool.run({ input: { workId: mine.id } } as never)).toMatchObject({ found: true, specialist: "coder" });
    inbox.close();
  });
});
