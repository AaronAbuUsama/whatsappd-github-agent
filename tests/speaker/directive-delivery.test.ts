import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { FlueObservation } from "@flue/runtime";

import { configureDirectiveDeliveryRuntime } from "../../packages/agents/src/capabilities/directive-delivery/runtime.ts";
import { createSayDirectiveTool } from "../../packages/agents/src/capabilities/directive-delivery/tools.ts";
import { configureWhatsAppParticipationPort } from "../../packages/agents/src/capabilities/whatsapp-participation/whatsapp-port.ts";
import { createAgentActivityReporter } from "../../packages/agents/src/speaker/activity-reporter.ts";
import { createBrainInbox } from "../../packages/engine/src/brain/inbox.ts";
import { createConversationArchive } from "../../packages/engine/src/intake/conversation-archive.ts";
import { conversationSent, type ConversationArrival } from "../../packages/engine/src/intake/conversation-event.ts";
import { createSurfaceDeliveryStore } from "../../packages/engine/src/surfaces/delivery.ts";
import { createSurfaceRegistry } from "../../packages/engine/src/surfaces/registry.ts";

const ACCOUNT = "15550000000:7@s.whatsapp.net";
const CHAT = "team@g.us";
const EVIDENCE = "arrival:team:request";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const fixture = (markAccepted = true) => {
  const root = mkdtempSync(join(tmpdir(), "ambient-directive-delivery-"));
  roots.push(root);
  const databasePath = join(root, "application.sqlite");
  const archive = createConversationArchive(databasePath);
  archive.append({
    id: EVIDENCE,
    kind: "arrival",
    providerMessageId: "request",
    chatId: CHAT,
    senderId: "alice@s.whatsapp.net",
    senderName: "Alice",
    direction: "inbound",
    occurredAt: 1_000,
    payload: { live: true, isGroup: true, messageKind: "text", text: "Can you help?" },
  } satisfies ConversationArrival);
  const surfaces = createSurfaceRegistry(databasePath);
  const [surface] = surfaces.activateConfigured(ACCOUNT, [CHAT]);
  if (surface === undefined) throw new Error("Expected a Surface");
  const inbox = createBrainInbox(databasePath, {
    providerChatIdForSurface: (surfaceId) => surfaces.activeBinding(surfaceId)?.providerChatId,
    now: () => "2026-07-22T12:00:00.000Z",
  });
  inbox.admitIntent({
    sourceSurfaceId: surface.id,
    interpretation: "The request needs clarification.",
    evidenceIds: [EVIDENCE],
  });
  const batch = inbox.claimBatch();
  if (batch === undefined) throw new Error("Expected a Brain Batch");
  inbox.markBatchDispatched(batch.id, {
    dispatchId: "dispatch:brain",
    acceptedAt: "2026-07-22T12:00:01.000Z",
  });
  const effect = inbox.recordPrompt({
    batchId: batch.id,
    surfaceId: surface.id,
    objective: "Ask what help is needed.",
    brief: { summary: "The request omitted its subject.", evidenceIds: [EVIDENCE] },
  });
  if (markAccepted) {
    inbox.markPromptAccepted(effect.id, {
      dispatchId: "dispatch:speaker",
      acceptedAt: "2026-07-22T12:00:02.000Z",
    });
  }
  const deliveries = createSurfaceDeliveryStore(databasePath, {
    providerChatIdForSurface: (surfaceId) => surfaces.activeBinding(surfaceId)?.providerChatId,
    now: () => "2026-07-22T12:00:03.000Z",
  });
  configureDirectiveDeliveryRuntime({ deliveries });
  return { archive, surfaces, inbox, deliveries, surface, effect };
};

describe("Directive Surface Delivery", () => {
  it("can claim the durable pending Directive when Speaker execution wins the acceptance-persistence race", async () => {
    const { archive, surfaces, inbox, deliveries, surface, effect } = fixture(false);
    configureWhatsAppParticipationPort({
      say: async (chatId, text) => {
        const ref = { chatId, id: "provider-message-race", fromMe: true };
        archive.append(conversationSent(ref, { text }, ACCOUNT, 2_000));
        return { delivery: "sent", messageId: ref.id, typing: "cleared" };
      },
      react: async () => ({ delivery: "failed", deliveryError: "not used" }),
      readThread: () => [],
      search: () => [],
    });

    await expect(
      createSayDirectiveTool(CHAT).run({
        input: { directiveId: effect.id, text: "What do you need help with?" },
      }),
    ).resolves.toMatchObject({
      directiveId: effect.id,
      surfaceId: surface.id,
      status: "delivered",
      providerMessageId: "provider-message-race",
    });

    deliveries.close();
    inbox.close();
    surfaces.close();
    archive.close();
  });

  it("records before transport, proves provider and Archive evidence, and never sends an exact retry twice", async () => {
    const { archive, surfaces, inbox, deliveries, surface, effect } = fixture();
    let sends = 0;
    configureWhatsAppParticipationPort({
      say: async (chatId, text) => {
        sends += 1;
        expect(deliveries.delivery(effect.id)).toMatchObject({
          directiveId: effect.id,
          surfaceId: surface.id,
          providerChatId: CHAT,
          text,
          status: "attempting",
        });
        const ref = { chatId, id: "provider-message-1", fromMe: true };
        archive.append(conversationSent(ref, { text }, ACCOUNT, 2_000));
        return { delivery: "sent", messageId: ref.id, typing: "cleared" };
      },
      react: async () => ({ delivery: "failed", deliveryError: "not used" }),
      readThread: () => [],
      search: () => [],
    });

    const tool = createSayDirectiveTool(CHAT);
    const first = await tool.run({ input: { directiveId: effect.id, text: "What do you need help with?" } });
    const retry = await tool.run({ input: { directiveId: effect.id, text: "What do you need help with?" } });

    expect(sends).toBe(1);
    expect(first).toEqual({
      directiveId: effect.id,
      deliveryId: expect.stringMatching(/^surface-delivery:/u),
      surfaceId: surface.id,
      status: "delivered",
      providerMessageId: "provider-message-1",
      conversationEventId: `arrival:${CHAT}:provider-message-1`,
    });
    expect(retry).toEqual(first);
    expect(deliveries.outcome(effect.id)).toEqual(first);

    deliveries.close();
    inbox.close();
    surfaces.close();
    archive.close();
  });

  it("permits only one provider call when an exact retry arrives during the first in-flight attempt", async () => {
    const { archive, surfaces, inbox, deliveries, effect } = fixture();
    let sends = 0;
    let release!: () => void;
    const providerGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    configureWhatsAppParticipationPort({
      say: async (chatId, text) => {
        sends += 1;
        await providerGate;
        const ref = { chatId, id: "provider-concurrent-1", fromMe: true };
        archive.append(conversationSent(ref, { text }, ACCOUNT, 2_000));
        return { delivery: "sent", messageId: ref.id, typing: "cleared" };
      },
      react: async () => ({ delivery: "failed", deliveryError: "not used" }),
      readThread: () => [],
      search: () => [],
    });

    const tool = createSayDirectiveTool(CHAT);
    const first = Promise.resolve(tool.run({ input: { directiveId: effect.id, text: "What do you need help with?" } }));
    await vi.waitFor(() => expect(sends).toBe(1));
    const concurrentRetry = await tool.run({
      input: { directiveId: effect.id, text: "This must not cross the provider boundary." },
    });
    expect(concurrentRetry).toMatchObject({ status: "uncertain" });
    expect(sends).toBe(1);

    release();
    await expect(first).resolves.toMatchObject({ status: "delivered", providerMessageId: "provider-concurrent-1" });
    expect(deliveries.outcome(effect.id)).toMatchObject({
      status: "delivered",
      providerMessageId: "provider-concurrent-1",
    });

    deliveries.close();
    inbox.close();
    surfaces.close();
    archive.close();
  });

  it.each([
    {
      provider: { delivery: "failed" as const, deliveryError: "WhatsApp is offline." },
      status: "failed" as const,
    },
    {
      provider: { delivery: "unknown" as const, deliveryError: "Connection dropped after send." },
      status: "uncertain" as const,
    },
  ])("settles a provider $status once and does not retry transport", async ({ provider, status }) => {
    const { archive, surfaces, inbox, deliveries, surface, effect } = fixture();
    let sends = 0;
    configureWhatsAppParticipationPort({
      say: async () => {
        sends += 1;
        return { ...provider, typing: "cleared" };
      },
      react: async () => ({ delivery: "failed", deliveryError: "not used" }),
      readThread: () => [],
      search: () => [],
    });

    const tool = createSayDirectiveTool(CHAT);
    const first = await tool.run({ input: { directiveId: effect.id, text: "What do you need help with?" } });
    const retry = await tool.run({ input: { directiveId: effect.id, text: "Changed text must not send." } });

    expect(sends).toBe(1);
    expect(first).toEqual({
      directiveId: effect.id,
      deliveryId: expect.stringMatching(/^surface-delivery:/u),
      surfaceId: surface.id,
      status,
      error: provider.deliveryError,
    });
    expect(retry).toEqual(first);

    deliveries.close();
    inbox.close();
    surfaces.close();
    archive.close();
  });

  it("keeps a provider acknowledgement Uncertain when its outbound Archive proof is missing", async () => {
    const { archive, surfaces, inbox, deliveries, surface, effect } = fixture();
    configureWhatsAppParticipationPort({
      say: async () => ({ delivery: "sent", messageId: "unarchived-message", typing: "cleared" }),
      react: async () => ({ delivery: "failed", deliveryError: "not used" }),
      readThread: () => [],
      search: () => [],
    });

    await expect(
      createSayDirectiveTool(CHAT).run({
        input: { directiveId: effect.id, text: "What do you need help with?" },
      }),
    ).resolves.toEqual({
      directiveId: effect.id,
      deliveryId: expect.stringMatching(/^surface-delivery:/u),
      surfaceId: surface.id,
      status: "uncertain",
      providerMessageId: "unarchived-message",
      error: expect.stringContaining("Conversation Archive event is missing"),
    });
    expect(deliveries.delivery(effect.id)).toMatchObject({
      status: "uncertain",
      providerMessageId: "unarchived-message",
    });

    deliveries.close();
    inbox.close();
    surfaces.close();
    archive.close();
  });

  it("turns a crash-gap attempt into Uncertain instead of blindly sending on restart", async () => {
    const { archive, surfaces, inbox, deliveries, surface, effect } = fixture();
    const claim = deliveries.claim(effect.id, CHAT, "What do you need help with?");
    expect(claim.kind).toBe("attempt");
    deliveries.close();

    const reopened = createSurfaceDeliveryStore(join(roots.at(-1)!, "application.sqlite"), {
      providerChatIdForSurface: (surfaceId) => surfaces.activeBinding(surfaceId)?.providerChatId,
      now: () => "2026-07-22T12:00:04.000Z",
    });
    configureDirectiveDeliveryRuntime({ deliveries: reopened });
    let sends = 0;
    configureWhatsAppParticipationPort({
      say: async () => {
        sends += 1;
        return { delivery: "sent", messageId: "must-not-send", typing: "cleared" };
      },
      react: async () => ({ delivery: "failed", deliveryError: "not used" }),
      readThread: () => [],
      search: () => [],
    });

    const outcome = await createSayDirectiveTool(CHAT).run({
      input: { directiveId: effect.id, text: "What do you need help with?" },
    });
    expect(sends).toBe(0);
    expect(outcome).toMatchObject({
      directiveId: effect.id,
      surfaceId: surface.id,
      status: "uncertain",
      error: expect.stringContaining("blind retry is forbidden"),
    });

    reopened.close();
    inbox.close();
    surfaces.close();
    archive.close();
  });

  it("refuses a Directive from a Speaker that is not bound to its selected Surface", async () => {
    const { archive, surfaces, inbox, deliveries, effect } = fixture();
    let sends = 0;
    configureWhatsAppParticipationPort({
      say: async () => {
        sends += 1;
        return { delivery: "sent", messageId: "must-not-send", typing: "cleared" };
      },
      react: async () => ({ delivery: "failed", deliveryError: "not used" }),
      readThread: () => [],
      search: () => [],
    });

    await expect(
      createSayDirectiveTool("other@g.us").run({
        input: { directiveId: effect.id, text: "Wrong Surface." },
      }),
    ).rejects.toThrow("is not the active binding");
    expect(sends).toBe(0);
    expect(deliveries.delivery(effect.id)).toBeUndefined();

    deliveries.close();
    inbox.close();
    surfaces.close();
    archive.close();
  });

  it("records an explicit settled-without-Saying outcome before any later tool retry", async () => {
    const { archive, surfaces, inbox, deliveries, surface, effect } = fixture();
    const silent = deliveries.settleWithoutSay(effect.id, "No message is warranted after local context review.");
    let sends = 0;
    configureWhatsAppParticipationPort({
      say: async () => {
        sends += 1;
        return { delivery: "sent", messageId: "must-not-send", typing: "cleared" };
      },
      react: async () => ({ delivery: "failed", deliveryError: "not used" }),
      readThread: () => [],
      search: () => [],
    });

    expect(silent).toEqual({
      directiveId: effect.id,
      surfaceId: surface.id,
      status: "settled_without_say",
      reason: "No message is warranted after local context review.",
    });
    await expect(
      createSayDirectiveTool(CHAT).run({
        input: { directiveId: effect.id, text: "A late tool call must not send." },
      }),
    ).resolves.toEqual(silent);
    expect(sends).toBe(0);

    deliveries.close();
    inbox.close();
    surfaces.close();
    archive.close();
  });

  it.each([
    { lifecycle: "completed" as const, expected: "settled_without_say" as const },
    { lifecycle: "failed" as const, expected: "failed" as const },
  ])("turns a $lifecycle Directive run without say_directive into a durable Outcome", ({ lifecycle, expected }) => {
    const { archive, surfaces, inbox, deliveries, effect } = fixture();
    const reporter = createAgentActivityReporter({ info: () => undefined, error: () => undefined });
    const unsubscribe = reporter.subscribeDirectives({
      dispatched: () => undefined,
      settledWithoutSay: ({ directiveId }) => {
        deliveries.settleWithoutSay(directiveId, "Speaker completed without calling say_directive.");
      },
      settledFailed: ({ directiveId, error }) => {
        deliveries.failWithoutSay(directiveId, error);
      },
    });
    reporter.accepted(
      { dispatchId: "dispatch:speaker" },
      {
        type: "brain.directive",
        directive: {
          id: effect.id,
          surfaceId: effect.directive.surfaceId,
          objective: effect.directive.objective,
          brief: effect.directive.brief,
        },
      },
    );
    reporter.observed({
      v: 3,
      eventIndex: 2,
      timestamp: new Date().toISOString(),
      type: "operation",
      instanceId: CHAT,
      dispatchId: "dispatch:speaker",
      operationId: "operation:directive",
      operationKind: "prompt",
      durationMs: 10,
      isError: lifecycle === "failed",
      ...(lifecycle === "failed" ? { error: { message: "Speaker model failed." } } : {}),
    } as FlueObservation);

    expect(deliveries.outcome(effect.id)).toMatchObject({
      directiveId: effect.id,
      status: expected,
      ...(expected === "failed" ? { error: "Speaker model failed." } : {}),
    });

    unsubscribe();
    deliveries.close();
    inbox.close();
    surfaces.close();
    archive.close();
  });
});
