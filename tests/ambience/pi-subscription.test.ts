import { AuthStorage } from "@earendil-works/pi-coding-agent";
import type { ProviderStreams } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";

import {
  AMBIENCE_MODEL_ID,
  AMBIENCE_MODEL_SPECIFIER,
  connectPiChatGptSubscription,
  prepareLunaResponsesLiteRequest,
} from "../../src/model/pi-subscription.js";

const oauthStorage = () =>
  AuthStorage.inMemory({
    "openai-codex": {
      type: "oauth",
      access: "header.payload.signature",
      refresh: "fixture-refresh-token",
      expires: Date.now() + 60_000,
    },
  });

describe("connectPiChatGptSubscription", () => {
  it("ignores OPENAI_API_KEY and registers only the Pi OAuth token", async () => {
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "must-not-be-used";
    const registerProvider = vi.fn();
    const codexApi: ProviderStreams = {
      stream: vi.fn(() => ({} as ReturnType<ProviderStreams["stream"]>)),
      streamSimple: vi.fn(() => ({} as ReturnType<ProviderStreams["streamSimple"]>)),
    };

    try {
      await connectPiChatGptSubscription({
        authStorage: oauthStorage(),
        codexApi,
        registerApiProvider: vi.fn(),
        registerProvider,
      });
    } finally {
      if (previous === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = previous;
    }

    expect(registerProvider).toHaveBeenCalledWith(
      "openai-codex",
      expect.objectContaining({ apiKey: "header.payload.signature" }),
    );
    expect(registerProvider).not.toHaveBeenCalledWith(
      "openai-codex",
      expect.objectContaining({ apiKey: "must-not-be-used" }),
    );
  });

  it("requires a Pi OAuth credential for openai-codex", async () => {
    const apiKeyStorage = AuthStorage.inMemory({
      "openai-codex": { type: "api_key", key: "must-not-be-used" },
    });

    await expect(
      connectPiChatGptSubscription({ authStorage: apiKeyStorage }),
    ).rejects.toThrow(/Pi OAuth credential.*openai-codex/i);
    await expect(
      connectPiChatGptSubscription({ authStorage: AuthStorage.inMemory() }),
    ).rejects.toThrow(/Pi OAuth credential.*openai-codex/i);
  });

  it("registers Luna through Pi with reasoning enabled and a safe receipt", async () => {
    const registerApiProvider = vi.fn();
    const registerProvider = vi.fn();
    const streamResult = {} as ReturnType<ProviderStreams["streamSimple"]>;
    const codexApi: ProviderStreams = {
      stream: vi.fn(() => streamResult),
      streamSimple: vi.fn(() => streamResult),
    };

    const receipt = await connectPiChatGptSubscription({
      authStorage: oauthStorage(),
      codexApi,
      registerApiProvider,
      registerProvider,
    });

    expect(receipt).toEqual({
      authentication: "pi-oauth",
      model: AMBIENCE_MODEL_SPECIFIER,
      provider: "openai-codex",
    });
    expect(receipt).not.toHaveProperty("apiKey");

    const registration = registerApiProvider.mock.calls[0]?.[0];
    expect(registration?.api).toBe("ambience-openai-codex-responses");

    registration.streamSimple(
      {
        id: AMBIENCE_MODEL_ID,
        name: AMBIENCE_MODEL_ID,
        api: "ambience-openai-codex-responses",
        provider: "openai-codex",
        baseUrl: "https://chatgpt.com/backend-api",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 0,
        maxTokens: 0,
      },
      { messages: [] },
      { reasoning: "low" },
    );

    expect(codexApi.streamSimple).toHaveBeenCalledWith(
      expect.objectContaining({
        api: "openai-codex-responses",
        id: AMBIENCE_MODEL_ID,
        provider: "openai-codex",
        reasoning: true,
      }),
      { messages: [] },
      expect.objectContaining({ reasoning: "low" }),
    );
    expect(registerProvider).toHaveBeenCalledWith(
      "openai-codex",
      expect.objectContaining({
        api: "ambience-openai-codex-responses",
        apiKey: "header.payload.signature",
        baseUrl: "https://chatgpt.com/backend-api",
      }),
    );
  });

  it("adapts Luna to the Codex Responses Lite wire contract", () => {
    const prepared = prepareLunaResponsesLiteRequest(
      new Headers({ authorization: "Bearer subscription-token", originator: "pi" }),
      {
        model: AMBIENCE_MODEL_ID,
        instructions: "Keep ordinary prose private.",
        input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }],
        tools: [],
        reasoning: { effort: "low" },
        stream: true,
      },
    );

    expect(prepared.headers.get("authorization")).toBe("Bearer subscription-token");
    expect(prepared.headers.get("originator")).toBe("codex_exec");
    expect(prepared.headers.get("version")).toBe("0.144.1");
    expect(prepared.headers.get("x-openai-internal-codex-responses-lite")).toBe("true");
    expect(prepared.body).toMatchObject({
      model: AMBIENCE_MODEL_ID,
      input: [
        { type: "additional_tools", role: "developer", tools: [] },
        {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: "Keep ordinary prose private." }],
        },
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "hello" }],
        },
      ],
      parallel_tool_calls: false,
      reasoning: { effort: "low", context: "all_turns" },
      stream: true,
    });
    expect(prepared.body).not.toHaveProperty("instructions");
    expect(prepared.body).not.toHaveProperty("tools");
  });
});
