import type { ProviderStreams } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  AMBIENCE_MODEL_ID,
  AMBIENCE_MODEL_SPECIFIER,
  ChatGptReadinessError,
  connectPiChatGptSubscription,
  prepareLunaResponsesLiteRequest,
  runChatGptReadinessCheck,
} from "../../src/model/pi-subscription.js";
import {
  createChatGptAuthentication,
  createManagedChatGptCredentialStore,
  type ChatGptAuthentication,
} from "../../src/model/chatgpt-authentication.js";
import { managedPaths } from "../../src/managed/paths.js";

const authentication = (apiKey = "header.payload.signature"): ChatGptAuthentication => ({
  authenticate: vi.fn(async () => undefined),
  inspect: vi.fn(async () => ({ state: "ready" as const })),
  authorization: vi.fn(async () => ({ apiKey })),
});

describe("connectPiChatGptSubscription", () => {
  it("loads model authorization only from the injected Ambient Agent authentication service", async () => {
    const registerProvider = vi.fn();
    const codexApi: ProviderStreams = {
      stream: vi.fn(() => ({}) as ReturnType<ProviderStreams["stream"]>),
      streamSimple: vi.fn(() => ({}) as ReturnType<ProviderStreams["streamSimple"]>),
    };

    await connectPiChatGptSubscription({
      authentication: authentication("managed-access-token"),
      codexApi,
      registerApiProvider: vi.fn(),
      registerProvider,
    });

    expect(registerProvider).toHaveBeenCalledWith(
      "openai-codex",
      expect.objectContaining({ apiKey: "managed-access-token" }),
    );
  });

  it("ignores OPENAI_API_KEY and registers only the managed ChatGPT OAuth token", async () => {
    const previous = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "must-not-be-used";
    const registerProvider = vi.fn();
    const codexApi: ProviderStreams = {
      stream: vi.fn(() => ({}) as ReturnType<ProviderStreams["stream"]>),
      streamSimple: vi.fn(() => ({}) as ReturnType<ProviderStreams["streamSimple"]>),
    };

    try {
      await connectPiChatGptSubscription({
        authentication: authentication(),
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

  it("requires usable authorization from the injected service", async () => {
    const missing = authentication();
    vi.mocked(missing.authorization).mockRejectedValue(new Error("ChatGPT authentication is missing"));

    await expect(connectPiChatGptSubscription({ authentication: missing })).rejects.toThrow(
      /ChatGPT authentication is missing/i,
    );
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
      authentication: authentication(),
      codexApi,
      registerApiProvider,
      registerProvider,
    });

    expect(receipt).toEqual({
      authentication: "chatgpt-oauth",
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

  it("runs readiness through the same production authorization interface", async () => {
    const managedAuthentication = authentication("managed-readiness-token");
    const request = vi.fn(async () => undefined);

    await expect(runChatGptReadinessCheck(managedAuthentication, { request })).resolves.toEqual({
      model: AMBIENCE_MODEL_SPECIFIER,
      request: "complete",
    });
    expect(managedAuthentication.authorization).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith({ apiKey: "managed-readiness-token" }, undefined);
  });

  it("types transport and credential failures without exposing provider details", async () => {
    const transportFailure = runChatGptReadinessCheck(authentication(), {
      request: async () => {
        throw new Error("network response with must-not-be-printed");
      },
    });
    await expect(transportFailure).rejects.toMatchObject({
      name: "ChatGptReadinessError",
      code: "request-failed",
    });
    await expect(transportFailure).rejects.not.toThrow("must-not-be-printed");

    await expect(
      runChatGptReadinessCheck(authentication(), {
        request: async () => {
          throw new ChatGptReadinessError("credential-rejected", "ChatGPT rejected the managed credential.");
        },
      }),
    ).rejects.toMatchObject({ code: "credential-rejected" });
  });

  it.runIf(process.env.AMBIENT_AGENT_LIVE_CHATGPT === "1")(
    "makes one gated real model request with the managed credential",
    async () => {
      const dataDirectory = process.env.AMBIENT_AGENT_LIVE_DATA_DIR?.trim();
      if (!dataDirectory) throw new Error("AMBIENT_AGENT_LIVE_DATA_DIR is required for the live ChatGPT check.");
      const paths = managedPaths({ dataDirectory });
      const managedAuthentication = createChatGptAuthentication({
        store: createManagedChatGptCredentialStore({
          path: paths.chatGptOAuthCredential,
          legacyPath: paths.legacyPiAuthCredential,
        }),
      });

      await expect(
        runChatGptReadinessCheck(managedAuthentication, { signal: AbortSignal.timeout(60_000) }),
      ).resolves.toMatchObject({ request: "complete" });
    },
    70_000,
  );
});
