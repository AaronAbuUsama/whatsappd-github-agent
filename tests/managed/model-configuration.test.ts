import { describe, expect, it } from "vite-plus/test";

import { resolveModelSelection } from "../../apps/cli/src/model-configuration.ts";
import { DEFAULT_AGENT_MODEL_PROFILES } from "../../packages/engine/src/model/pi-subscription.ts";

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
