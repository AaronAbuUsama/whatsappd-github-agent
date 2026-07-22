import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  configureBrainEffectsRuntime,
  recoverPendingPrompts,
} from "../../packages/agents/src/brain/effects-runtime.ts";
import {
  createPromptSpeakerTool,
  createSettleBrainBatchTool,
  createStaySilentTool,
} from "../../packages/agents/src/brain/tools.ts";
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
