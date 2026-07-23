import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import * as v from "valibot";
import { describe, expect, it } from "vite-plus/test";

import speaker from "../../packages/agents/src/speaker/agent.ts";
import {
  configureIssueManagementRuntime,
  createIssueManagementPolicy,
} from "../../packages/agents/src/capabilities/issue-management/runtime.ts";
import { createIssueOperationStore } from "../../packages/engine/src/github/operation-store.ts";
import { createReactTool, createSayTool } from "../../packages/agents/src/capabilities/whatsapp-participation/tools.ts";
import { createFakeIssueRepository } from "../../packages/test-support/src/fake-issue-repository.ts";

const root = process.cwd();
const read = async (path: string) => await readFile(join(root, path), "utf8");

describe("WhatsApp Participation capability", () => {
  it("registers the packaged capability on each Speaker instance", async () => {
    configureIssueManagementRuntime({
      repository: createFakeIssueRepository(),
      operations: createIssueOperationStore(":memory:"),
      policy: createIssueManagementPolicy("acme/widgets", ["acme/widgets"]),
    });
    const config = await speaker.initialize({ id: "participation-test@g.us", env: {} });

    expect(config.skills).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          __flueSkillReference: true,
          name: "whatsapp-participation",
        }),
      ]),
    );
  });

  it("registers a versioned packaged skill instead of embedding participation policy in standing instructions", async () => {
    const [agent, skill] = await Promise.all([
      read("packages/agents/src/speaker/agent.ts"),
      read("packages/agents/src/capabilities/whatsapp-participation/SKILL.md"),
    ]);

    expect(agent).toContain('import whatsappParticipation from "../capabilities/whatsapp-participation/SKILL.md"');
    expect(agent).toContain('with { type: "skill" }');
    expect(agent).toContain("skills: [whatsappParticipation]");
    expect(agent).not.toContain("when older chat context is needed");

    expect(skill).toMatch(/^---\nname: whatsapp-participation\n/m);
    expect(skill).toContain('version: "2.2.0"');
    expect(skill).toContain("Always close what you acknowledged");
    expect(skill).toContain("Participate as a teammate, not a bot");
    expect(skill).toContain("Shape an issue request before you escalate");
    expect(skill).toContain("Always engage an explicit address");
    expect(skill).toContain("every message prefixed with `SMOKE `");
    expect(skill).toContain("Send one message per concern, threaded by reply-to to the source message");
  });

  it("keeps React and Say chat-bound while exposing only message IDs at the tool boundary", () => {
    const react = createReactTool("participation-test@g.us");
    const say = createSayTool("participation-test@g.us");

    expect(v.safeParse(react.input, { messageId: "source-31", emoji: "👀" }).success).toBe(true);
    expect(v.safeParse(react.input, { messageId: "source-31", emoji: "👨‍👩‍👧‍👦" }).success).toBe(true);
    expect(v.safeParse(react.input, { messageId: "source-31", emoji: "" }).success).toBe(false);
    expect(v.safeParse(react.input, { messageId: "source-31", emoji: "123456789" }).success).toBe(false);
    expect(v.safeParse(react.input, { messageId: "source-31", emoji: `a${"\u0301".repeat(64)}` }).success).toBe(false);
    const chatOverride = v.safeParse(react.input, {
      chatId: "other@g.us",
      messageId: "source-31",
      emoji: "👀",
    });
    expect(chatOverride).toMatchObject({ success: true, output: { messageId: "source-31", emoji: "👀" } });
    if (chatOverride.success) expect(chatOverride.output).not.toHaveProperty("chatId");

    expect(v.safeParse(say.input, { text: "Threaded answer", replyTo: "source-31" }).success).toBe(true);
    expect(
      v.safeParse(say.input, {
        text: "Provider details must stay private",
        replyTo: { messageId: "source-31", fromMe: false },
      }).success,
    ).toBe(false);
  });

  it("assembles React, Say, thread-read, and history-search as one chat-bound capability", async () => {
    const [tools, port] = await Promise.all([
      read("packages/agents/src/capabilities/whatsapp-participation/tools.ts"),
      read("packages/agents/src/capabilities/whatsapp-participation/whatsapp-port.ts"),
    ]);

    expect(tools).toContain("createWhatsAppParticipationTools");
    expect(tools).toContain("createReactTool(chatId)");
    expect(tools).toContain("createSayTool(chatId)");
    expect(tools).toContain("createReadWhatsAppThreadTool(chatId)");
    expect(tools).toContain("createSearchWhatsAppHistoryTool(chatId)");
    expect(tools).not.toMatch(/chatId:\s*v\./);
    expect(port).toContain("interface WhatsAppParticipationPort");
    expect(port).toContain("configureWhatsAppParticipationPort");

    for (const obsolete of [
      "src/host/whatsapp-host.ts",
      "src/host/whatsapp-history.ts",
      "src/tools/whatsapp/say.ts",
      "src/tools/whatsapp/history.ts",
    ]) {
      await expect(stat(join(root, obsolete))).rejects.toMatchObject({ code: "ENOENT" });
    }
  });
});
