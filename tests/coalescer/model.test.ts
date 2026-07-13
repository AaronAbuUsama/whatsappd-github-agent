import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  describeSubscriptionModel,
  subscriptionModelSettings,
} from "../../src/model/subscription.ts";

const originalOpenAiApiKey = process.env.OPENAI_API_KEY;
const originalCodexHome = process.env.CODEX_HOME;
let codexHome: string;

beforeEach(() => {
  codexHome = mkdtempSync(join(tmpdir(), "subscription-model-test-"));
  writeFileSync(
    join(codexHome, "auth.json"),
    JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "test-token" } }),
  );
  process.env.CODEX_HOME = codexHome;
});

afterEach(() => {
  if (originalOpenAiApiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalOpenAiApiKey;
  if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = originalCodexHome;
  rmSync(codexHome, { recursive: true, force: true });
});

describe("subscription-only model selection", () => {
  it("ignores OPENAI_API_KEY and keeps the Codex subscription provider", () => {
    process.env.OPENAI_API_KEY = "sk-deliberate-sentinel";

    const settings = subscriptionModelSettings();

    expect((settings.model as { provider?: string }).provider).toBe("codex.responses");
    expect((settings.model as { modelId?: string }).modelId).toBe("gpt-5.6-sol");
    expect(settings.reasoning).toBe("low");
    expect(describeSubscriptionModel()).toContain("ChatGPT subscription");
    expect(describeSubscriptionModel()).not.toContain("OpenAI API key");
  });

  it("keeps every Eve agent config on the Codex provider when an API key is present", async () => {
    process.env.OPENAI_API_KEY = "sk-deliberate-sentinel";
    const [{ default: rootAgent }, { default: githubAgent }] = await Promise.all([
      import("../../agent/agent.ts"),
      import("../../agent/subagents/github/agent.ts"),
    ]);

    for (const agent of [rootAgent, githubAgent]) {
      expect((agent.model as { provider?: string }).provider).toBe("codex.responses");
      expect((agent.model as { modelId?: string }).modelId).toBe("gpt-5.6-sol");
      expect(agent.reasoning).toBe("low");
    }
  });

  it("refuses an API-key Codex login before constructing a model", () => {
    writeFileSync(
      join(codexHome, "auth.json"),
      JSON.stringify({ auth_mode: "api-key", OPENAI_API_KEY: "sk-deliberate-sentinel" }),
    );

    expect(() => subscriptionModelSettings()).toThrow(/ChatGPT subscription login/);
  });
});
