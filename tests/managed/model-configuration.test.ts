import { describe, expect, it } from "vite-plus/test";
import * as v from "valibot";

import {
  promptInteractiveModelSelection,
  resolveModelSelection,
  withUniformThinkingLevel,
} from "../../apps/cli/src/model-configuration.ts";
import {
  AGENT_MODEL_ROLES,
  DEFAULT_AGENT_MODEL_PROFILES,
} from "../../packages/engine/src/model/pi-subscription.ts";
import { createManagedConfig, ManagedConfigSchema } from "../../packages/installation/src/schema.ts";

const CURRENT = {
  provider: "openai-codex",
  credential: "chatgpt-oauth",
  profiles: DEFAULT_AGENT_MODEL_PROFILES,
} as const;

describe("resolveModelSelection", () => {
  it("leaves the configured provider and profiles alone when no model flag is passed", () => {
    const resolved = resolveModelSelection(CURRENT, {});
    expect(resolved).toEqual({
      provider: "openai-codex",
      credential: "chatgpt-oauth",
      profiles: DEFAULT_AGENT_MODEL_PROFILES,
      needsApiKey: false,
    });
  });

  it("switches to an api-key provider, repoints the credential, and asks for a key", () => {
    const resolved = resolveModelSelection(CURRENT, { provider: "openai", model: "gpt-5.4-nano" });
    expect(resolved.provider).toBe("openai");
    expect(resolved.credential).toBe("api-key");
    expect(resolved.needsApiKey).toBe(true);
    expect(resolved.profiles.speaker).toEqual({ id: "gpt-5.4-nano", thinkingLevel: "low" });
    // Thinking level is a role property, not a model property, so it carries across the switch.
    expect(resolved.profiles.planner.thinkingLevel).toBe("xhigh");
  });

  it("gives each role its own model so a cheap Speaker can sit beside a capable Coder", () => {
    const resolved = resolveModelSelection(CURRENT, {
      provider: "openai",
      model: "gpt-5.4-nano",
      roleModels: { coder: "gpt-5.4", verifier: "gpt-5.4" },
    });
    expect(resolved.profiles.speaker.id).toBe("gpt-5.4-nano");
    expect(resolved.profiles.scribe.id).toBe("gpt-5.4-nano");
    expect(resolved.profiles.coder.id).toBe("gpt-5.4");
    expect(resolved.profiles.verifier.id).toBe("gpt-5.4");
  });

  it("refuses a provider switch that names no model, because model IDs do not carry across providers", () => {
    expect(() => resolveModelSelection(CURRENT, { provider: "openai" })).toThrow(/--model/u);
    // …unless every role is named individually.
    expect(
      resolveModelSelection(CURRENT, {
        provider: "openai",
        roleModels: {
          brain: "gpt-5.4",
          speaker: "gpt-5.4-nano",
          scribe: "gpt-5.4-nano",
          planner: "gpt-5.4",
          coder: "gpt-5.4",
          verifier: "gpt-5.4",
        },
      }).profiles.speaker.id,
    ).toBe("gpt-5.4-nano");
  });

  it("refuses an unknown provider and a model the provider's catalog does not list", () => {
    expect(() => resolveModelSelection(CURRENT, { provider: "opeani", model: "gpt-5.4-nano" })).toThrow(
      /not a model provider/u,
    );
    expect(() => resolveModelSelection(CURRENT, { provider: "openai", model: "gpt-5.6-luna" })).toThrow(
      /has no model gpt-5\.6-luna/u,
    );
    // Anthropic model IDs are refused for OpenAI and vice versa, at config-write time.
    expect(() => resolveModelSelection(CURRENT, { provider: "openai", model: "claude-sonnet-4-6" })).toThrow();
  });

  it("does not catalog-check the subscription provider, whose models are subscription-only", () => {
    // `gpt-5.6-luna` and `gpt-5.6-sol` are deliberately absent from pi's public catalog.
    expect(resolveModelSelection(CURRENT, { model: "gpt-5.6-luna" }).profiles.coder.id).toBe("gpt-5.6-luna");
  });

  it("retunes models on the current api-key provider without re-pasting the key", () => {
    const current = { provider: "openai", credential: "api-key", profiles: DEFAULT_AGENT_MODEL_PROFILES } as const;
    const resolved = resolveModelSelection(current, {
      model: "gpt-5.4-nano",
      roleModels: { coder: "gpt-5.4" },
    });
    expect(resolved.needsApiKey).toBe(false);
    expect(resolved.credential).toBe("api-key");
    expect(resolved.profiles.coder.id).toBe("gpt-5.4");
  });
});

describe("withUniformThinkingLevel", () => {
  it("stamps one level onto every role while keeping each role's model", () => {
    const stamped = withUniformThinkingLevel(DEFAULT_AGENT_MODEL_PROFILES, "minimal");
    for (const role of AGENT_MODEL_ROLES) {
      expect(stamped[role].thinkingLevel).toBe("minimal");
      expect(stamped[role].id).toBe(DEFAULT_AGENT_MODEL_PROFILES[role].id);
    }
  });
});

describe("promptInteractiveModelSelection", () => {
  it("keeps the base selection when the prompts are unavailable — no prompt fires", async () => {
    const base = { roleModels: {} };
    const { selection, thinkingLevel } = await promptInteractiveModelSelection(base, {});
    expect(selection).toBe(base);
    expect(thinkingLevel).toBeUndefined();
  });

  it("keeps the base selection and asks nothing more when the operator keeps the subscription", async () => {
    let modelAsked = false;
    let levelAsked = false;
    const { selection, thinkingLevel } = await promptInteractiveModelSelection(
      { roleModels: {} },
      {
        modelAuthMode: async () => "subscription",
        selectModel: async () => {
          modelAsked = true;
          return "gpt-5.4";
        },
        selectThinkingLevel: async () => {
          levelAsked = true;
          return "high";
        },
      },
    );
    expect(selection).toEqual({ roleModels: {} });
    expect(thinkingLevel).toBeUndefined();
    expect(modelAsked).toBe(false);
    expect(levelAsked).toBe(false);
  });

  it("folds the API-key choice into an OpenAI selection over the real catalog", async () => {
    let offered: readonly string[] = [];
    const { selection, thinkingLevel } = await promptInteractiveModelSelection(
      { roleModels: {} },
      {
        modelAuthMode: async () => "api-key",
        selectModel: async (provider, modelIds) => {
          expect(provider).toBe("openai");
          offered = modelIds;
          return "gpt-5.4-mini";
        },
        selectThinkingLevel: async () => "high",
      },
    );
    // The select is handed OpenAI's full catalog, not a hand-kept subset.
    expect(offered).toContain("gpt-5.4-mini");
    expect(offered).toContain("gpt-4o");
    expect(offered.length).toBeGreaterThan(20);
    expect(selection).toEqual({ roleModels: {}, provider: "openai", model: "gpt-5.4-mini" });
    expect(thinkingLevel).toBe("high");
  });

  it("refuses a level the build does not ship, guarding a misbehaving prompt", async () => {
    await expect(
      promptInteractiveModelSelection(
        { roleModels: {} },
        {
          modelAuthMode: async () => "api-key",
          selectModel: async () => "gpt-5.4-mini",
          selectThinkingLevel: async () => "extreme",
        },
      ),
    ).rejects.toThrow(/not a reasoning level/u);
  });

  it("round-trips the interactive API-key choice through the config schema, write then read identical", async () => {
    const { selection, thinkingLevel } = await promptInteractiveModelSelection(
      { roleModels: {} },
      {
        modelAuthMode: async () => "api-key",
        selectModel: async () => "gpt-5.4-mini",
        selectThinkingLevel: async () => "high",
      },
    );
    const resolved = resolveModelSelection(
      { provider: "openai-codex", credential: "chatgpt-oauth", profiles: DEFAULT_AGENT_MODEL_PROFILES },
      selection,
    );
    const profiles = withUniformThinkingLevel(resolved.profiles, thinkingLevel!);
    const config = createManagedConfig(["120363000@g.us"], "owner/repo", { provider: resolved.provider, profiles });
    const written = v.parse(ManagedConfigSchema, config);
    // Write → read is identical, and every role carries the chosen model and reasoning level.
    expect(v.parse(ManagedConfigSchema, written)).toEqual(written);
    expect(written.model).toMatchObject({ provider: "openai", credential: "api-key" });
    for (const role of AGENT_MODEL_ROLES) {
      expect(written.model.profiles[role]).toEqual({ id: "gpt-5.4-mini", thinkingLevel: "high" });
    }
  });

  it("rejects a bad model id and a bad reasoning level at the schema, before any write", () => {
    const good = createManagedConfig(["120363000@g.us"], "owner/repo", {
      provider: "openai",
      profiles: withUniformThinkingLevel(
        resolveModelSelection(
          { provider: "openai-codex", credential: "chatgpt-oauth", profiles: DEFAULT_AGENT_MODEL_PROFILES },
          { provider: "openai", model: "gpt-5.4-mini", roleModels: {} },
        ).profiles,
        "high",
      ),
    });
    // A provider-prefixed (slashed) model id and an off-catalog reasoning level are both refused.
    expect(
      v.safeParse(ManagedConfigSchema, {
        ...good,
        model: { ...good.model, profiles: { ...good.model.profiles, coder: { id: "openai/gpt-5.4", thinkingLevel: "high" } } },
      }).success,
    ).toBe(false);
    expect(
      v.safeParse(ManagedConfigSchema, {
        ...good,
        model: { ...good.model, profiles: { ...good.model.profiles, coder: { id: "gpt-5.4-mini", thinkingLevel: "extreme" } } },
      }).success,
    ).toBe(false);
  });
});
