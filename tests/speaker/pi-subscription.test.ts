import type { ProviderStreams } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  DEFAULT_AGENT_MODEL_PROFILES,
  ChatGptReadinessError,
  configureAgentModelProfiles,
  connectPiApiKeyProvider,
  connectPiChatGptSubscription,
  modelSpecifier,
  SUBSCRIPTION_PROVIDER_ID,
  prepareLunaResponsesLiteRequest,
  rateLimitRetryingFetch,
  resolveAgentModelProfile,
  readinessErrorFor,
  runApiKeyReadinessCheck,
  runChatGptReadinessCheck,
} from "../../packages/engine/src/model/pi-subscription.ts";
import {
  createChatGptAuthentication,
  createManagedChatGptCredentialStore,
  type ChatGptAuthentication,
} from "../../packages/engine/src/model/chatgpt-authentication.ts";
import { managedPaths } from "../../packages/installation/src/paths.ts";

const authentication = (apiKey = "header.payload.signature"): ChatGptAuthentication => ({
  authenticate: vi.fn(async () => undefined),
  inspect: vi.fn(async () => ({ state: "ready" as const })),
  authorization: vi.fn(async () => ({ apiKey })),
});

const SPEAKER_MODEL_ID = DEFAULT_AGENT_MODEL_PROFILES.speaker.id;
const SPEAKER_MODEL_SPECIFIER = modelSpecifier(SUBSCRIPTION_PROVIDER_ID, SPEAKER_MODEL_ID);

afterEach(() => configureAgentModelProfiles(DEFAULT_AGENT_MODEL_PROFILES, SUBSCRIPTION_PROVIDER_ID));

describe("connectPiChatGptSubscription", () => {
  it("loads model authorization only from the injected Ambient Agent authentication service", async () => {
    const registerProvider = vi.fn();
    const codexApi: ProviderStreams = {
      stream: vi.fn(() => ({}) as ReturnType<ProviderStreams["stream"]>),
      streamSimple: vi.fn(() => ({}) as ReturnType<ProviderStreams["streamSimple"]>),
    };

    await connectPiChatGptSubscription({
      authentication: authentication("managed-access-token"),
      profiles: DEFAULT_AGENT_MODEL_PROFILES,
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
        profiles: DEFAULT_AGENT_MODEL_PROFILES,
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

    await expect(
      connectPiChatGptSubscription({ authentication: missing, profiles: DEFAULT_AGENT_MODEL_PROFILES }),
    ).rejects.toThrow(
      /ChatGPT authentication is missing/i,
    );
  });

  it("registers every distinct configured model through Pi with reasoning enabled and a safe receipt", async () => {
    const registerApiProvider = vi.fn();
    const registerProvider = vi.fn();
    const streamResult = {} as ReturnType<ProviderStreams["streamSimple"]>;
    const codexApi: ProviderStreams = {
      stream: vi.fn(() => streamResult),
      streamSimple: vi.fn(() => streamResult),
    };

    const profiles = {
      ...DEFAULT_AGENT_MODEL_PROFILES,
      coder: { id: "gpt-5.6-terra", thinkingLevel: "high" },
    } as const;
    const receipt = await connectPiChatGptSubscription({
      authentication: authentication(),
      profiles,
      codexApi,
      registerApiProvider,
      registerProvider,
    });

    expect(receipt).toEqual({
      authentication: "chatgpt-oauth",
      model: SPEAKER_MODEL_SPECIFIER,
      models: [
        "openai-codex/gpt-5.6-luna",
        "openai-codex/gpt-5.6-sol",
        "openai-codex/gpt-5.6-terra",
      ],
      provider: "openai-codex",
    });
    expect(receipt).not.toHaveProperty("apiKey");

    const registration = registerApiProvider.mock.calls[0]?.[0];
    expect(registration?.api).toBe("speaker-openai-codex-responses");

    registration.streamSimple(
      {
        id: SPEAKER_MODEL_ID,
        name: SPEAKER_MODEL_ID,
        api: "speaker-openai-codex-responses",
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
        id: SPEAKER_MODEL_ID,
        provider: "openai-codex",
        reasoning: true,
        thinkingLevelMap: { minimal: "low", xhigh: "xhigh" },
      }),
      { messages: [] },
      expect.objectContaining({ reasoning: "low" }),
    );
    expect(registerProvider).toHaveBeenCalledWith(
      "openai-codex",
      expect.objectContaining({
        api: "speaker-openai-codex-responses",
        apiKey: "header.payload.signature",
        baseUrl: "https://chatgpt.com/backend-api",
        models: {
          "gpt-5.6-luna": {},
          "gpt-5.6-sol": {},
          "gpt-5.6-terra": {},
        },
      }),
    );

    registration.streamSimple(
      {
        id: "gpt-5.6-sol",
        name: "gpt-5.6-sol",
        api: "speaker-openai-codex-responses",
        provider: "openai-codex",
        baseUrl: "https://chatgpt.com/backend-api",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 0,
        maxTokens: 0,
      },
      { messages: [] },
      { reasoning: "xhigh" },
    );
    expect(codexApi.streamSimple).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ thinkingLevelMap: { xhigh: "xhigh" } }),
      { messages: [] },
      expect.objectContaining({ reasoning: "xhigh" }),
    );
  });

  it("adapts Luna to the Codex Responses Lite wire contract", () => {
    const prepared = prepareLunaResponsesLiteRequest(
      new Headers({ authorization: "Bearer subscription-token", originator: "pi" }),
      {
        model: SPEAKER_MODEL_ID,
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
      model: SPEAKER_MODEL_ID,
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

    await expect(
      runChatGptReadinessCheck(managedAuthentication, {
        profiles: DEFAULT_AGENT_MODEL_PROFILES,
        request,
      }),
    ).resolves.toEqual({
      model: SPEAKER_MODEL_SPECIFIER,
      models: ["openai-codex/gpt-5.6-luna", "openai-codex/gpt-5.6-sol"],
      request: "complete",
    });
    expect(managedAuthentication.authorization).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenNthCalledWith(
      1,
      { apiKey: "managed-readiness-token" },
      "gpt-5.6-luna",
      undefined,
    );
    expect(request).toHaveBeenNthCalledWith(
      2,
      { apiKey: "managed-readiness-token" },
      "gpt-5.6-sol",
      undefined,
    );
  });

  it("resolves every agent role from configured model and thinking profiles", () => {
    configureAgentModelProfiles({
      ...DEFAULT_AGENT_MODEL_PROFILES,
      speaker: { id: "gpt-5.6-terra", thinkingLevel: "medium" },
      verifier: { id: "gpt-5.6-luna", thinkingLevel: "off" },
    }, SUBSCRIPTION_PROVIDER_ID);

    expect(resolveAgentModelProfile("speaker")).toEqual({
      model: "openai-codex/gpt-5.6-terra",
      thinkingLevel: "medium",
    });
    expect(resolveAgentModelProfile("scribe")).toEqual({
      model: "openai-codex/gpt-5.6-luna",
      thinkingLevel: "medium",
    });
    expect(resolveAgentModelProfile("planner")).toEqual({
      model: "openai-codex/gpt-5.6-sol",
      thinkingLevel: "xhigh",
    });
    expect(resolveAgentModelProfile("coder")).toEqual({
      model: "openai-codex/gpt-5.6-sol",
      thinkingLevel: "high",
    });
    expect(resolveAgentModelProfile("verifier")).toEqual({
      model: "openai-codex/gpt-5.6-luna",
      thinkingLevel: "off",
    });
  });

  it("types transport and credential failures without exposing provider details", async () => {
    const transportFailure = runChatGptReadinessCheck(authentication(), {
      profiles: DEFAULT_AGENT_MODEL_PROFILES,
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
        profiles: DEFAULT_AGENT_MODEL_PROFILES,
        request: async () => {
          throw new ChatGptReadinessError("credential-rejected", "ChatGPT rejected the managed credential.");
        },
      }),
    ).rejects.toMatchObject({ code: "credential-rejected" });
  });

  it("classifies a rate limit apart from a genuine failure, so a gate can report inconclusive", async () => {
    // #246: a 429 used to fall through to request-failed, indistinguishable from a network
    // blip. Every live gate from T2 onward needs that difference to avoid reading a rate
    // limit as a regression.
    const failing = async (message: string) =>
      await runChatGptReadinessCheck(authentication(), {
        profiles: DEFAULT_AGENT_MODEL_PROFILES,
        request: async () => {
          throw new Error(message);
        },
      })
        .then(() => {
          throw new Error("The readiness check resolved when it was expected to fail.");
        })
        .catch((cause: unknown) => cause as { code: string; message: string });

    for (const message of [
      "429 Too Many Requests",
      "Rate limit reached for gpt-5.4-mini",
      "You exceeded your current quota",
      "too many requests, please slow down",
    ]) {
      expect(await failing(message)).toMatchObject({ code: "rate-limited" });
    }
    // A rate-limited result is re-runnable, so it must say so rather than read as a defect.
    expect((await failing("429 Too Many Requests")).message).toMatch(/inconclusive/iu);

    // Genuine failures keep their existing classification — the negative that can fail.
    for (const message of [
      "fetch failed: ECONNREFUSED",
      "getaddrinfo ENOTFOUND api.openai.com",
      "500 Internal Server Error",
      "socket hang up",
    ]) {
      expect(await failing(message)).toMatchObject({ code: "request-failed" });
    }
    // A rejected credential still wins over a quota mention: retrying it is pointless.
    expect(await failing("401 Unauthorized — quota check failed")).toMatchObject({
      code: "credential-rejected",
    });
  });

  it("classifies the stream-error path the same way as the thrown path", () => {
    // The provider reports most failures through the stream's stopReason rather than by
    // throwing. Both branches call this one classifier, so asserting it directly covers the
    // stopReason path without a real stream.
    expect(readinessErrorFor("429 Too Many Requests").code).toBe("rate-limited");
    expect(readinessErrorFor("403 Forbidden").code).toBe("credential-rejected");
    expect(readinessErrorFor("fetch failed").code).toBe("request-failed");
    // No provider detail leaks into the operator-facing message.
    expect(readinessErrorFor("429 for org-secret-name").message).not.toContain("org-secret-name");
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
        runChatGptReadinessCheck(managedAuthentication, {
          profiles: DEFAULT_AGENT_MODEL_PROFILES,
          signal: AbortSignal.timeout(60_000),
        }),
      ).resolves.toMatchObject({ request: "complete" });
    },
    70_000,
  );
});

describe("connectPiApiKeyProvider", () => {
  it("binds any catalog provider with the key alone, and never registers an api", async () => {
    // Every api pi's catalog names is already built in (`compat.js:136` calls
    // registerBuiltInApiProviders at import), so an api-key provider is one registerProvider
    // call. Supporting all 35 is this, not a per-provider branch.
    for (const provider of ["openai", "anthropic", "groq", "deepseek", "openrouter"]) {
      const registerProvider = vi.fn();
      const receipt = await connectPiApiKeyProvider({
        provider,
        apiKey: "managed-api-key",
        profiles: DEFAULT_AGENT_MODEL_PROFILES,
        registerProvider,
      });

      expect(registerProvider).toHaveBeenCalledTimes(1);
      expect(registerProvider).toHaveBeenCalledWith(provider, { apiKey: "managed-api-key" });
      expect(receipt).toMatchObject({ authentication: "api-key", provider });
    }
  });

  it("refuses an empty key and a provider no build ships rather than failing at first inference", async () => {
    const registerProvider = vi.fn();
    await expect(
      connectPiApiKeyProvider({
        provider: "openai",
        apiKey: "   ",
        profiles: DEFAULT_AGENT_MODEL_PROFILES,
        registerProvider,
      }),
    ).rejects.toThrow(/API key/iu);
    await expect(
      connectPiApiKeyProvider({
        provider: "opeani",
        apiKey: "managed-api-key",
        profiles: DEFAULT_AGENT_MODEL_PROFILES,
        registerProvider,
      }),
    ).rejects.toThrow(/not a model provider/iu);
    expect(registerProvider).not.toHaveBeenCalled();
  });

  it("prefixes each role's own model with the configured provider", () => {
    // Funds are limited: a cheap Speaker beside a capable Coder is config, and every agent
    // reads it through this one seam.
    configureAgentModelProfiles(
      {
        ...DEFAULT_AGENT_MODEL_PROFILES,
        speaker: { id: "gpt-5.4-nano", thinkingLevel: "low" },
        coder: { id: "gpt-5.4", thinkingLevel: "high" },
      },
      "openai",
    );

    expect(resolveAgentModelProfile("speaker")).toEqual({ model: "openai/gpt-5.4-nano", thinkingLevel: "low" });
    expect(resolveAgentModelProfile("coder")).toEqual({ model: "openai/gpt-5.4", thinkingLevel: "high" });
  });

  it.runIf(process.env.AMBIENT_AGENT_LIVE_MODEL === "1")(
    "pre-flight: makes one real API-key model request and gets non-empty text back",
    async () => {
      // NOT A GATE. One real model call through the production API-key binding, claiming
      // nothing about any transport. It de-risks the T2 deploy by flushing out provider bugs
      // before we debug them through an install.
      //
      //   AMBIENT_AGENT_LIVE_MODEL=1 OPENAI_API_KEY=sk-... pnpm vitest run tests/speaker/pi-subscription.test.ts
      const apiKey = process.env.OPENAI_API_KEY?.trim();
      if (!apiKey) throw new Error("OPENAI_API_KEY is required for the live API-key pre-flight.");
      const provider = process.env.AMBIENT_AGENT_LIVE_PROVIDER?.trim() || "openai";
      const modelId = process.env.AMBIENT_AGENT_LIVE_MODEL_ID?.trim() || "gpt-5.4-mini";

      // The production binding, not a bespoke one: the same call apps/runtime makes at boot.
      const registerProvider = vi.fn();
      const receipt = await connectPiApiKeyProvider({
        provider,
        apiKey,
        profiles: { ...DEFAULT_AGENT_MODEL_PROFILES, speaker: { id: modelId, thinkingLevel: "low" } },
        registerProvider,
      });
      expect(registerProvider).toHaveBeenCalledWith(provider, { apiKey });
      expect(receipt.model).toBe(`${provider}/${modelId}`);

      const live = await runApiKeyReadinessCheck({
        provider,
        apiKey,
        modelId,
        prompt: "Reply with the single word READY.",
        maxTokens: 16,
        signal: AbortSignal.timeout(60_000),
      });

      // A rate limit is inconclusive, not a regression (#246) — say so instead of failing.
      if (live.reason === "rate-limited") {
        throw new Error(
          `INCONCLUSIVE: ${provider} rate-limited the pre-flight. This is not a regression; re-run it.`,
        );
      }
      expect(live.request).toBe("complete");
      // The assertion that matters. `complete` alone means only that the stream ended without
      // an error, and an empty response satisfies it.
      expect(live.text.length).toBeGreaterThan(0);
      console.log(
        `pre-flight: model=${live.model} chars=${live.text.length} elapsedMs=${live.elapsedMs}`,
      );
    },
    70_000,
  );
});

describe("rateLimitRetryingFetch (#246 follow-up)", () => {
  const res = (status: number, headers: Record<string, string> = {}) =>
    new Response(status === 429 ? "rate limited" : "ok", { status, headers });

  it("retries a 429 and returns the first non-429 response", async () => {
    const statuses = [429, 429, 200];
    const calls: unknown[] = [];
    const upstream = (async (input: unknown) => {
      calls.push(input);
      return res(statuses.shift()!);
    }) as unknown as typeof fetch;
    const waits: number[] = [];
    const fetching = rateLimitRetryingFetch(upstream, { delay: async (ms) => { waits.push(ms); } });

    const out = await fetching("https://api.example/v1", { body: "{}" });
    expect(out.status).toBe(200);
    expect(calls).toHaveLength(3); // initial + 2 retries
    expect(waits).toEqual([1000, 2000]); // capped exponential backoff, no Retry-After header
  });

  it("honors a Retry-After header over the backoff", async () => {
    const statuses = [429, 200];
    const upstream = (async () => res(statuses.shift()!, statuses.length === 1 ? { "retry-after": "7" } : {})) as unknown as typeof fetch;
    const waits: number[] = [];
    const out = await rateLimitRetryingFetch(upstream, { delay: async (ms) => { waits.push(ms); } })("u", { body: "{}" });
    expect(out.status).toBe(200);
    expect(waits).toEqual([7000]);
  });

  it("gives up after maxRetries and surfaces the final 429 for the caller to classify", async () => {
    let calls = 0;
    const upstream = (async () => { calls++; return res(429); }) as unknown as typeof fetch;
    const out = await rateLimitRetryingFetch(upstream, { maxRetries: 3, delay: async () => {} })("u", { body: "{}" });
    expect(out.status).toBe(429);
    expect(calls).toBe(4); // initial + 3 retries, then the 429 is returned
  });

  it("does not retry a non-resendable (streamed) body, so a consumed stream is never re-sent", async () => {
    let calls = 0;
    const upstream = (async () => { calls++; return res(429); }) as unknown as typeof fetch;
    const out = await rateLimitRetryingFetch(upstream, { delay: async () => {} })("u", { body: new ReadableStream() });
    expect(out.status).toBe(429);
    expect(calls).toBe(1); // passed straight through, never retried
  });

  it("caps a single backoff wait at maxDelayMs", async () => {
    const statuses = [429, 429, 429, 200];
    const upstream = (async () => res(statuses.shift()!)) as unknown as typeof fetch;
    const waits: number[] = [];
    await rateLimitRetryingFetch(upstream, { maxDelayMs: 3000, delay: async (ms) => { waits.push(ms); } })("u", { body: "{}" });
    expect(waits).toEqual([1000, 2000, 3000]); // 4000 would be next, capped to 3000
  });
});
