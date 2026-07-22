import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { configureIntentEscalationRuntime } from "../../packages/agents/src/capabilities/intent-escalation/runtime.ts";
import { createEscalateIntentTool } from "../../packages/agents/src/capabilities/intent-escalation/tools.ts";
import { createBrainInbox } from "../../packages/engine/src/brain/inbox.ts";
import { createConversationArchive } from "../../packages/engine/src/intake/conversation-archive.ts";
import { conversationArrival } from "../../packages/engine/src/intake/conversation-event.ts";
import { createSurfaceRegistry } from "../../packages/engine/src/surfaces/registry.ts";

const ACCOUNT = "15550000000:7@s.whatsapp.net";
const CHAT = "team@g.us";
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Speaker Intent escalation tool", () => {
  it("binds the Speaker's trusted chat to a Surface and admits selected Window evidence", async () => {
    const root = mkdtempSync(join(tmpdir(), "ambient-speaker-intent-"));
    roots.push(root);
    const databasePath = join(root, "application.sqlite");
    const evidenceId = `arrival:${CHAT}:message-1`;
    const archive = createConversationArchive(databasePath);
    archive.append(conversationArrival({
      id: "message-1",
      chatId: CHAT,
      from: "alice@s.whatsapp.net",
      pushName: "Alice",
      fromMe: false,
      timestamp: 1_000,
      live: true,
      isGroup: true,
      kind: "text",
      text: "Please investigate the deployment failure.",
    }));
    archive.close();

    const surfaces = createSurfaceRegistry(databasePath);
    const [surface] = surfaces.activateConfigured(ACCOUNT, [CHAT]);
    const inbox = createBrainInbox(databasePath, {
      providerChatIdForSurface: (surfaceId) => surfaces.activeBinding(surfaceId)?.providerChatId,
    });
    let wakes = 0;
    configureIntentEscalationRuntime({
      inbox,
      surfaceIdForSpeaker: (speakerId) => surfaces.activeSurface(ACCOUNT, speakerId)?.id,
      wake: async () => {
        wakes += 1;
      },
    });

    const result = await createEscalateIntentTool(CHAT).run({
      input: {
        interpretation: "The team wants the deployment failure investigated.",
        evidenceIds: [evidenceId],
      },
    });

    expect(result).toEqual({ intentId: expect.stringMatching(/^intent:[a-f0-9]{64}$/u) });
    expect(inbox.pendingIntents()).toEqual([
      expect.objectContaining({
        id: result.intentId,
        sourceSurfaceId: surface!.id,
        evidenceIds: [evidenceId],
      }),
    ]);
    expect(wakes).toBe(1);
    inbox.close();
    surfaces.close();
  });

  it("fails closed when the bound Speaker has no active Surface", async () => {
    configureIntentEscalationRuntime({
      inbox: { admitIntent: () => { throw new Error("must not admit"); } },
      surfaceIdForSpeaker: () => undefined,
      wake: async () => undefined,
    });

    await expect(createEscalateIntentTool("unknown@g.us").run({
      input: { interpretation: "Do something.", evidenceIds: ["arrival:unknown:g"] },
    })).rejects.toThrow("has no active Surface");
  });
});
