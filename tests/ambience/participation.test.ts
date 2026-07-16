import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vite-plus/test";

import ambience from "../../src/agents/ambience.ts";
import {
  configureIssueManagementRuntime,
  createIssueManagementPolicy,
} from "../../src/capabilities/issue-management/runtime.ts";
import { createIssueOperationStore } from "../../src/capabilities/issue-management/operation-store.ts";
import { createFakeIssueRepository } from "../support/fake-issue-repository.ts";

const root = process.cwd();
const read = async (path: string) => await readFile(join(root, path), "utf8");

describe("WhatsApp Participation capability", () => {
  it("registers the packaged capability on each Ambience instance", async () => {
    configureIssueManagementRuntime({
      repository: createFakeIssueRepository(),
      operations: createIssueOperationStore(":memory:"),
      policy: createIssueManagementPolicy("acme/widgets", ["acme/widgets"]),
    });
    const config = await ambience.initialize({ id: "participation-test@g.us", env: {} });

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
      read("src/agents/ambience.ts"),
      read("src/capabilities/whatsapp-participation/SKILL.md"),
    ]);

    expect(agent).toContain('import whatsappParticipation from "../capabilities/whatsapp-participation/SKILL.md"');
    expect(agent).toContain('with { type: "skill" }');
    expect(agent).toContain("skills: [whatsappParticipation, issueManagement]");
    expect(agent).not.toContain("when older chat context is needed");

    expect(skill).toMatch(/^---\nname: whatsapp-participation\n/m);
    expect(skill).toContain('version: "1.0.0"');
    expect(skill).toContain("Ordinary assistant prose is private");
    expect(skill).toContain("exactly one `say`");
    expect(skill).toContain("current managed chat");
  });

  it("assembles Say, thread-read, and history-search as one chat-bound capability", async () => {
    const [tools, port] = await Promise.all([
      read("src/capabilities/whatsapp-participation/tools.ts"),
      read("src/capabilities/whatsapp-participation/whatsapp-port.ts"),
    ]);

    expect(tools).toContain("createWhatsAppParticipationTools");
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
