import type { Context } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import {
  FRAMEWORK_TOOL_EXCLUSION_SUPPORTED,
  createSandboxSessionEnv,
  defineAgent,
  defineAgentProfile,
  defineTool,
  registerProvider,
  type SandboxApi,
} from "@flue/runtime";
import { createFlueContext } from "@flue/runtime/internal";
import { describe, expect, it } from "vite-plus/test";
import * as v from "valibot";

const sandbox: SandboxApi = {
  readFile: async () => "",
  readFileBuffer: async () => new Uint8Array(),
  writeFile: async () => {},
  stat: async () => ({ isFile: true, isDirectory: false, size: 0 }),
  readdir: async () => [],
  exists: async () => false,
  mkdir: async () => {},
  rm: async () => {},
  exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
};

describe("pinned Flue framework-tool exclusion", () => {
  it("removes task from the actual model-facing child-task schema while programmatic session.task remains available", async () => {
    expect(FRAMEWORK_TOOL_EXCLUSION_SUPPORTED).toBe(true);
    const providerId = `framework-exclusion-${crypto.randomUUID()}`;
    const provider = registerFauxProvider({ provider: providerId });
    const observedTools: string[][] = [];
    const observeTools = (label: string) => async (context: Context) => {
        observedTools.push(context.tools?.map((tool) => tool.name) ?? []);
        return fauxAssistantMessage(label);
      };
    provider.setResponses([
      observeTools("planner"),
      observeTools("coder"),
      observeTools("verifier"),
      observeTools("publication"),
      observeTools("default"),
    ]);
    const model = provider.getModel();
    registerProvider(providerId, { api: model.api, apiKey: "fixture-only", baseUrl: model.baseUrl });
    const modelSpecifier = `${providerId}/${model.id}`;
    const profiles = ["planner", "coder", "verifier"].map((name) => defineAgentProfile({ name, model: modelSpecifier }));
    const agent = defineAgent(() => ({ model: modelSpecifier, subagents: profiles }));
    const openPullRequest = defineTool({
      name: "open_pull_request",
      description: "fixture publication effect",
      input: v.object({}),
      output: v.object({ opened: v.boolean() }),
      run: async () => ({ opened: true }),
    });
    const context = createFlueContext({
      id: `framework-exclusion-${crypto.randomUUID()}`,
      env: {},
      agentConfig: { resolveModel: () => model },
      createDefaultEnv: async () => createSandboxSessionEnv(sandbox, "/"),
    });
    const harness = await context.initializeRootHarness(agent);
    try {
      const session = await harness.session("coordinator");
      await session.task("plan", { agent: "planner", frameworkTools: { task: false } });
      await session.task("code", { agent: "coder", frameworkTools: { task: false } });
      await session.task("verify", { agent: "verifier", frameworkTools: { task: false } });
      await session.task("publish", { agent: "coder", frameworkTools: { task: false }, tools: [openPullRequest] });
      await session.task("default", { agent: "planner" });
    } finally {
      await harness.close();
    }

    for (const tools of observedTools.slice(0, 4)) expect(tools).not.toContain("task");
    expect(observedTools[3]).toContain("open_pull_request");
    expect(observedTools[4]).toContain("task");
  });
});
