import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { startGeneratedRuntime } from "../../apps/cli/src/lifecycle.ts";
import { installManagedData } from "../../packages/test-support/src/managed-installation.ts";
import { managedPaths } from "../../packages/installation/src/paths.ts";
import { atomicWriteManagedConfig, readManagedConfig } from "../../packages/installation/src/configuration.ts";
import type { ChatGptAuthentication } from "../../packages/engine/src/model/chatgpt-authentication.ts";

const roots: string[] = [];
afterEach(async () => await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

const authentication: ChatGptAuthentication = {
  authenticate: vi.fn(async () => undefined),
  inspect: vi.fn(async () => ({ state: "ready" as const })),
  authorization: vi.fn(async () => ({ apiKey: "header.payload.signature" })),
};

/** A ready installation whose config names an API-key provider. */
const installedOnApiKeyProvider = async (provider = "openai") => {
  const home = await mkdtemp(join(tmpdir(), "ambient-model-provider-"));
  roots.push(home);
  const dataDirectory = join(home, "managed");
  await installManagedData({
    dataDirectory,
    managedChats: ["120363000@g.us"],
    defaultRepository: "owner/repo",
    authenticateChatGpt: async (paths) =>
      await writeFile(
        paths.chatGptOAuthCredential,
        JSON.stringify({ type: "oauth", access: "a", refresh: "r", expires: Date.now() + 3_600_000 }),
        { mode: 0o600 },
      ),
  });
  const paths = managedPaths({ dataDirectory });
  const config = await readManagedConfig(paths.config);
  await atomicWriteManagedConfig(paths.config, {
    ...config,
    model: {
      provider,
      credential: "api-key",
      profiles: {
        speaker: { id: "gpt-5.4-nano", thinkingLevel: "low" },
        scribe: { id: "gpt-5.4-nano", thinkingLevel: "low" },
        planner: { id: "gpt-5.4-nano", thinkingLevel: "low" },
        coder: { id: "gpt-5.4-nano", thinkingLevel: "low" },
        verifier: { id: "gpt-5.4-nano", thinkingLevel: "low" },
      },
    },
  });
  return paths;
};

describe("starting on an api-key model provider", () => {
  it("fails before anything binds when the credential file is absent", async () => {
    // Negative assertion for #250: no inference must mean no boot. A runtime that starts,
    // binds its port and settles green with no usable model is the failure this refuses.
    const paths = await installedOnApiKeyProvider();
    const importServer = vi.fn(async () => undefined);

    await expect(
      startGeneratedRuntime(paths, { debug: false }, authentication, importServer),
    ).rejects.toThrow(/missing or unreadable/u);
    expect(importServer).not.toHaveBeenCalled();
  });

  it("fails when the stored key was pasted for a different provider than the config names", async () => {
    const paths = await installedOnApiKeyProvider("openai");
    await atomicWriteManagedConfig(paths.modelApiKeyCredential, {
      schemaVersion: 1,
      kind: "api-key",
      provider: "anthropic",
      apiKey: "sk-ant-not-an-openai-key",
    });
    const importServer = vi.fn(async () => undefined);

    await expect(
      startGeneratedRuntime(paths, { debug: false }, authentication, importServer),
    ).rejects.toThrow(/was issued for anthropic/u);
    expect(importServer).not.toHaveBeenCalled();
  });

  it("keeps the key out of the config file, referenced only by name", async () => {
    const paths = await installedOnApiKeyProvider();
    await atomicWriteManagedConfig(paths.modelApiKeyCredential, {
      schemaVersion: 1,
      kind: "api-key",
      provider: "openai",
      apiKey: "sk-secret-value",
    });

    const config = await readFile(paths.config, "utf8");
    expect(config).not.toContain("sk-secret-value");
    expect(JSON.parse(config).model.credential).toBe("api-key");
  });
});
