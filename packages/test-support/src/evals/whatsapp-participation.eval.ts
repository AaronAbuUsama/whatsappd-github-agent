import { expect } from "vitest";
import { describeEval, toolCalls } from "vitest-evals";

import { createFlueAgentHarness } from "./harness.ts";

const harness = createFlueAgentHarness({ agentName: "ambience" });
const window = (text: string): string => `WhatsApp Window for the current managed chat:\nAlice: ${text}`;

describeEval(
  "WhatsApp Participation deterministic contract",
  { harness, skipIf: () => process.env.AMBIENCE_EVAL_LIVE_MODEL === "true" },
  (it) => {
    it("keeps casual group conversation private", async ({ run }) => {
      const result = await run({
        message: window("Beautiful sunset today."),
        fixture: { resetWhatsApp: true },
      });

      expect(toolCalls(result).filter((call) => call.name === "say")).toHaveLength(0);
      expect(result.output.whatsappEvents).toEqual([]);
    });

    it("uses exactly one Say for a useful direct request", async ({ run }) => {
      const result = await run({
        message: window("Ambience, please tell the group that the release call starts at 16:00 UTC."),
        fixture: { resetWhatsApp: true },
      });

      const sayCalls = toolCalls(result).filter((call) => call.name === "say");
      expect(sayCalls).toHaveLength(1);
      expect(sayCalls[0]).toMatchObject({
        status: "ok",
        arguments: { text: "The release call starts at 16:00 UTC." },
      });
      expect(result.output.whatsappEvents.filter((event) => (event as { kind?: string }).kind === "send")).toEqual([
        expect.objectContaining({
          kind: "send",
          chatId: result.output.instanceId,
          text: "The release call starts at 16:00 UTC.",
          outcome: "sent",
        }),
      ]);
    });

    it("searches only the current managed chat", async ({ run }) => {
      const otherChatId = `eval-other-${crypto.randomUUID()}@g.us`;
      const result = await run({
        message: window("Search WhatsApp history for release details before deciding whether to speak."),
        fixture: {
          resetWhatsApp: true,
          history: [
            { scope: "current", text: "CURRENT_CHAT_FACT: release room is Cedar." },
            { scope: "other", chatId: otherChatId, text: "OTHER_CHAT_SECRET: release room is Juniper." },
          ],
        },
      });

      const calls = toolCalls(result);
      const searchCalls = calls.filter((call) => call.name === "whatsapp_search");
      expect(searchCalls).toHaveLength(1);
      expect(searchCalls[0]).toMatchObject({ status: "ok", arguments: { query: "release" } });
      expect(searchCalls[0]?.arguments).not.toHaveProperty("chatId");
      expect(searchCalls[0]?.status).toBe("ok");
      if (searchCalls[0]?.status !== "ok") throw new Error("Expected a settled WhatsApp search");
      const serializedResult = JSON.stringify(searchCalls[0].result);
      expect(serializedResult).toContain(result.output.instanceId);
      expect(serializedResult).toContain("CURRENT_CHAT_FACT");
      expect(serializedResult).not.toContain(otherChatId);
      expect(serializedResult).not.toContain("OTHER_CHAT_SECRET");
      expect(calls.filter((call) => call.name === "say")).toHaveLength(0);
      expect(result.output.whatsappEvents).toEqual([]);
    });
  },
);
