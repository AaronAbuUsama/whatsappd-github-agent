import { describe, expect, it } from "vite-plus/test";
import * as v from "valibot";

import {
  ChatGptOAuthCredentialSchema,
  GitHubAppCredentialSchema,
  ManagedConfigSchema,
  createManagedConfig,
  modelApiKeyCredentialFrom,
} from "../../packages/installation/src/schema.ts";

const EXPECTED_DEFAULT_PROFILES = {
  brain: { id: "gpt-5.6-luna", thinkingLevel: "high" },
  speaker: { id: "gpt-5.6-luna", thinkingLevel: "low" },
  scribe: { id: "gpt-5.6-luna", thinkingLevel: "medium" },
  planner: { id: "gpt-5.6-sol", thinkingLevel: "xhigh" },
  coder: { id: "gpt-5.6-sol", thinkingLevel: "high" },
  verifier: { id: "gpt-5.6-sol", thinkingLevel: "xhigh" },
} as const;

const APP_CREDENTIAL = {
  schemaVersion: 1,
  kind: "github-app",
  appId: "12345",
  installationId: "67890",
  privateKey: "-----BEGIN RSA PRIVATE KEY-----\nfake\n-----END RSA PRIVATE KEY-----\n",
} as const;

describe("managed schemas", () => {
  it("accepts supported managed-chat JIDs and normalizes surrounding whitespace", () => {
    const config = createManagedConfig([" 120363000@g.us ", "15550000000@s.whatsapp.net"], " owner/repo ");
    const parsed = v.parse(ManagedConfigSchema, config);
    expect(parsed.managedChats).toEqual(["120363000@g.us", "15550000000@s.whatsapp.net"]);
    expect(parsed.github.defaultRepository).toBe("owner/repo");
    expect(parsed.runtime).toEqual({ port: 3000, sandbox: { kind: "local" }, tracing: { enabled: false } });
    expect(parsed.model.profiles).toEqual(EXPECTED_DEFAULT_PROFILES);
  });

  it("rejects blank or malformed managed-chat identifiers", () => {
    for (const chat of ["   ", "not-a-jid", "someone@example.com"]) {
      expect(v.safeParse(ManagedConfigSchema, createManagedConfig([chat], "owner/repo")).success).toBe(false);
    }
  });

  it("requires the default repository in the case-insensitive allowlist", () => {
    const config = createManagedConfig(["120363000@g.us"], "owner/repo");
    expect(
      v.safeParse(ManagedConfigSchema, {
        ...config,
        github: { ...config.github, allowedRepositories: ["other/repository"] },
      }).success,
    ).toBe(false);
    expect(
      v.safeParse(ManagedConfigSchema, {
        ...config,
        github: { ...config.github, defaultRepository: "OWNER/REPO" },
      }).success,
    ).toBe(true);
  });

  it("rejects a retired personal-token file and requires numeric App identifiers", () => {
    // A lingering PAT file fails the App schema and surfaces as reauthentication-required.
    expect(
      v.safeParse(GitHubAppCredentialSchema, { schemaVersion: 1, kind: "personal-token", token: "ghp_x" }).success,
    ).toBe(false);
    expect(v.safeParse(GitHubAppCredentialSchema, { ...APP_CREDENTIAL, appId: "not-numeric" }).success).toBe(false);
    expect(v.safeParse(GitHubAppCredentialSchema, { ...APP_CREDENTIAL, privateKey: "   " }).success).toBe(false);
    expect(v.safeParse(ChatGptOAuthCredentialSchema, { type: "oauth", access: "   ", refresh: "r", expires: 1 }).success).toBe(
      false,
    );
    const parsed = v.parse(GitHubAppCredentialSchema, { ...APP_CREDENTIAL, appId: " 12345 " });
    expect(parsed).toMatchObject({ kind: "github-app", appId: "12345", installationId: "67890" });
  });

  it("uses the application-owned ChatGPT credential reference", () => {
    expect(createManagedConfig(["120363000@g.us"], "owner/repo").model).toMatchObject({
      provider: "openai-codex",
      credential: "chatgpt-oauth",
    });
  });

  it("defaults role model profiles for existing installations and validates overrides", () => {
    const config = createManagedConfig(["120363000@g.us"], "owner/repo");
    const { profiles: _profiles, ...legacyModel } = config.model;
    const legacy = v.parse(ManagedConfigSchema, { ...config, model: legacyModel });
    expect(legacy.model.profiles).toEqual(EXPECTED_DEFAULT_PROFILES);

    const { brain: _brain, ...preBrainProfiles } = config.model.profiles;
    const preBrain = v.parse(ManagedConfigSchema, {
      ...config,
      model: { ...config.model, profiles: preBrainProfiles },
    });
    expect(preBrain.model.profiles.brain).toEqual(EXPECTED_DEFAULT_PROFILES.brain);

    expect(
      v.parse(ManagedConfigSchema, {
        ...config,
        model: {
          ...config.model,
          profiles: {
            ...config.model.profiles,
            coder: { id: "gpt-5.6-terra", thinkingLevel: "medium" },
          },
        },
      }).model.profiles.coder,
    ).toEqual({ id: "gpt-5.6-terra", thinkingLevel: "medium" });

    expect(
      v.safeParse(ManagedConfigSchema, {
        ...config,
        model: {
          ...config.model,
          profiles: {
            ...config.model.profiles,
            verifier: { id: " ", thinkingLevel: "extreme" },
          },
        },
      }).success,
    ).toBe(false);
    expect(
      v.safeParse(ManagedConfigSchema, {
        ...config,
        model: {
          ...config.model,
          profiles: {
            ...config.model.profiles,
            verifier: { id: "gpt-5.6-sol", thinkingLevel: "max" },
          },
        },
      }).success,
    ).toBe(false);
    expect(
      v.safeParse(ManagedConfigSchema, {
        ...config,
        model: {
          ...config.model,
          profiles: {
            ...config.model.profiles,
            planner: { id: "anthropic/claude", thinkingLevel: "high" },
          },
        },
      }).success,
    ).toBe(false);
  });

  it("defaults older managed configuration to the discoverable runtime port and validates explicit ports", () => {
    const { runtime: _runtime, ...older } = createManagedConfig(["120363000@g.us"], "owner/repo");
    expect(v.parse(ManagedConfigSchema, older).runtime).toEqual({
      port: 3000,
      sandbox: { kind: "local" },
      tracing: { enabled: false },
    });
    expect(v.safeParse(ManagedConfigSchema, { ...older, runtime: { port: 65_535 } }).success).toBe(true);
    expect(v.safeParse(ManagedConfigSchema, { ...older, runtime: { port: 65_536 } }).success).toBe(false);
    // The agent sandbox is operator environment, not managed config (ADR 0021): a config
    // still naming the retired Docker reviewer sandbox is rejected rather than ignored.
    expect(v.safeParse(ManagedConfigSchema, {
      ...older,
      runtime: { port: 3000, reviewerSandbox: { kind: "docker", image: "node:22-bookworm" } },
    }).success).toBe(false);
  });

  it("defaults the agent sandbox to local and validates an explicit selector (#251)", () => {
    const config = createManagedConfig(["120363000@g.us"], "owner/repo");
    // Default local, and a config predating the selector (runtime with only a port) still parses to local.
    expect(v.parse(ManagedConfigSchema, config).runtime.sandbox).toEqual({ kind: "local" });
    expect(v.parse(ManagedConfigSchema, { ...config, runtime: { port: 3737 } }).runtime.sandbox).toEqual({ kind: "local" });
    // e2b with a template round-trips.
    expect(
      v.parse(ManagedConfigSchema, { ...config, runtime: { port: 3000, sandbox: { kind: "e2b", template: "flue-node" } } })
        .runtime.sandbox,
    ).toEqual({ kind: "e2b", template: "flue-node" });
    // An unknown kind, an unknown sandbox field, and a blank template are all refused rather than written.
    expect(v.safeParse(ManagedConfigSchema, { ...config, runtime: { port: 3000, sandbox: { kind: "docker" } } }).success).toBe(false);
    expect(
      v.safeParse(ManagedConfigSchema, { ...config, runtime: { port: 3000, sandbox: { kind: "local", image: "x" } } }).success,
    ).toBe(false);
    expect(
      v.safeParse(ManagedConfigSchema, { ...config, runtime: { port: 3000, sandbox: { kind: "e2b", template: "  " } } }).success,
    ).toBe(false);
  });

  it("defaults tracing off and round-trips an explicit tracing block (#252)", () => {
    const config = createManagedConfig(["120363000@g.us"], "owner/repo");
    // Default off, and a config predating tracing (runtime with only a port) still parses to off.
    expect(v.parse(ManagedConfigSchema, config).runtime.tracing).toEqual({ enabled: false });
    expect(v.parse(ManagedConfigSchema, { ...config, runtime: { port: 3737 } }).runtime.tracing).toEqual({
      enabled: false,
    });
    // Enabled with a named project round-trips identically.
    const tracing = { enabled: true, project: { name: "ambient-agent", id: "abc123" } };
    expect(
      v.parse(ManagedConfigSchema, { ...config, runtime: { port: 3000, tracing } }).runtime.tracing,
    ).toEqual(tracing);
    // Bad values are refused rather than written: non-boolean enabled, unknown field, blank project name.
    expect(
      v.safeParse(ManagedConfigSchema, { ...config, runtime: { port: 3000, tracing: { enabled: "yes" } } }).success,
    ).toBe(false);
    expect(
      v.safeParse(ManagedConfigSchema, { ...config, runtime: { port: 3000, tracing: { enabled: true, sink: "x" } } })
        .success,
    ).toBe(false);
    expect(
      v.safeParse(ManagedConfigSchema, {
        ...config,
        runtime: { port: 3000, tracing: { enabled: true, project: { name: "  " } } },
      }).success,
    ).toBe(false);
  });

  it("parses an existing config unchanged and defaults its provider to the subscription one", () => {
    // No migration and no schemaVersion bump: `provider` is optional with the historical
    // default, so a config written before #250 still parses.
    const { model, ...rest } = createManagedConfig(["120363000@g.us"], "owner/repo");
    const { provider: _provider, ...modelWithoutProvider } = model;
    const parsed = v.parse(ManagedConfigSchema, { ...rest, model: modelWithoutProvider });
    expect(parsed.model.provider).toBe("openai-codex");
    expect(parsed.model.credential).toBe("chatgpt-oauth");
  });

  it("accepts any provider pi ships paired with the api-key credential, and refuses a mismatch", () => {
    const config = createManagedConfig(["120363000@g.us"], "owner/repo");
    const withModel = (model: Record<string, unknown>) => v.safeParse(ManagedConfigSchema, { ...config, model });
    const profiles = {
      ...EXPECTED_DEFAULT_PROFILES,
      speaker: { id: "gpt-5.4-nano", thinkingLevel: "low" },
    };

    // Any of pi's 35 provider IDs, not a hand-kept allowlist.
    for (const provider of ["openai", "anthropic", "groq", "deepseek", "openrouter"]) {
      expect(withModel({ provider, credential: "api-key", profiles }).success).toBe(true);
    }
    // A provider paired with the wrong credential file is refused at parse time, which is
    // what `writeManagedConfiguration` re-validates through before it touches disk.
    expect(withModel({ provider: "openai", credential: "chatgpt-oauth", profiles }).success).toBe(false);
    expect(withModel({ provider: "openai-codex", credential: "api-key", profiles }).success).toBe(false);
    // A provider ID no build ships is refused rather than deferred to first inference.
    expect(withModel({ provider: "opeani", credential: "api-key", profiles }).success).toBe(false);
  });

  it("binds the api-key credential file to the provider it was pasted for", () => {
    expect(modelApiKeyCredentialFrom("openai", " sk-test-key ")).toEqual({
      schemaVersion: 1,
      kind: "api-key",
      provider: "openai",
      apiKey: "sk-test-key",
    });
    expect(() => modelApiKeyCredentialFrom("openai", "   ")).toThrow();
    expect(() => modelApiKeyCredentialFrom("not-a-provider", "sk-test-key")).toThrow();
  });

  it("accepts only a managed group as the dedicated smoke canary", () => {
    const config = createManagedConfig(["120363000@g.us", "15550000000@s.whatsapp.net"], "owner/repo");
    expect(
      v.safeParse(ManagedConfigSchema, { ...config, smoke: { canaryChat: "120363000@g.us" } }).success,
    ).toBe(true);
    expect(
      v.safeParse(ManagedConfigSchema, { ...config, smoke: { canaryChat: "15550000000@s.whatsapp.net" } }).success,
    ).toBe(false);
    expect(
      v.safeParse(ManagedConfigSchema, { ...config, smoke: { canaryChat: "120363999@g.us" } }).success,
    ).toBe(false);
  });
});
