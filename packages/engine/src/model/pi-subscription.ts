import {
  completeSimple,
  openAICodexResponsesApi,
  type Api,
  type Model,
  type ProviderStreams,
} from "@earendil-works/pi-ai/compat";
import {
  registerApiProvider as flueRegisterApiProvider,
  registerProvider as flueRegisterProvider,
} from "@flue/runtime";
import { getBuiltinModels, getBuiltinProviders } from "@earendil-works/pi-ai/providers/all";
import type { KnownProvider } from "@earendil-works/pi-ai";
import type { ChatGptAuthentication } from "./chatgpt-authentication.ts";
import type { ModelAuthorization } from "./chatgpt-authentication.ts";

/**
 * The ChatGPT subscription provider — the one provider that is not an API key. It carries an
 * OAuth credential and a bespoke Responses Lite adaptation, so it keeps its own connector
 * ({@link connectPiChatGptSubscription}). Every other provider ID pi ships is an API key and
 * shares {@link connectPiApiKeyProvider}.
 */
export const SUBSCRIPTION_PROVIDER_ID = "openai-codex";

const PROVIDER_ID = SUBSCRIPTION_PROVIDER_ID;

/** A pi provider ID, e.g. `openai`, `anthropic`, `groq` — the prefix on every model specifier. */
export type ModelProvider = string;

/**
 * pi's built-in provider catalog, 35 entries. Every one is a `createProvider({id, baseUrl,
 * auth: {apiKey}, api})` of identical shape, and every `api` they name (`openai-responses`,
 * `anthropic-messages`, …) is already registered by `registerBuiltInApiProviders()` at import
 * (`pi-ai/dist/compat.js:136`). Binding one is therefore a single `registerProvider(id,
 * {apiKey})` and never a `registerApiProvider`.
 */
export const modelProviders = (): readonly string[] => getBuiltinProviders();

export const isModelProvider = (value: string): boolean => modelProviders().includes(value);

/**
 * The provider's catalog model IDs, so a rejected ID can be answered with the real ones. pi
 * types this by the `KnownProvider` union it derives from its generated catalog; a provider
 * ID out of config is a plain string, and the function already answers with an empty list
 * for an ID the catalog does not carry — which is exactly what the callers ask.
 */
export const catalogModelIds = (provider: ModelProvider): readonly string[] =>
  getBuiltinModels(provider as KnownProvider).map((model) => model.id);

/** Whether the provider's catalog lists this model ID, so a typo is refused before it is written. */
export const isCatalogModel = (provider: ModelProvider, modelId: string): boolean =>
  catalogModelIds(provider).includes(modelId);

export const LUNA_MODEL_ID = "gpt-5.6-luna";
export const AGENT_MODEL_ROLES = ["brain", "speaker", "scribe", "planner", "coder", "verifier"] as const;
export const MODEL_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

export type AgentModelRole = (typeof AGENT_MODEL_ROLES)[number];
export type ModelThinkingLevel = (typeof MODEL_THINKING_LEVELS)[number];

export interface AgentModelProfile {
  readonly id: string;
  readonly thinkingLevel: ModelThinkingLevel;
}

export type AgentModelProfiles = Readonly<Record<AgentModelRole, AgentModelProfile>>;

export const DEFAULT_AGENT_MODEL_PROFILES: AgentModelProfiles = {
  brain: { id: LUNA_MODEL_ID, thinkingLevel: "high" },
  speaker: { id: LUNA_MODEL_ID, thinkingLevel: "low" },
  scribe: { id: LUNA_MODEL_ID, thinkingLevel: "medium" },
  planner: { id: "gpt-5.6-sol", thinkingLevel: "xhigh" },
  coder: { id: "gpt-5.6-sol", thinkingLevel: "high" },
  verifier: { id: "gpt-5.6-sol", thinkingLevel: "xhigh" },
};

let agentModelProfiles = DEFAULT_AGENT_MODEL_PROFILES;
let agentModelProvider: ModelProvider = PROVIDER_ID;

export const modelSpecifier = (provider: ModelProvider, id: string): `${string}/${string}` =>
  `${provider}/${id}`;

export const configureAgentModelProfiles = (profiles: AgentModelProfiles, provider: ModelProvider): void => {
  agentModelProfiles = profiles;
  agentModelProvider = provider;
};

/**
 * The single seam every agent resolves its model through. Every role reads its own
 * profile here, so a per-role model — a cheap Speaker beside a capable Coder — is config,
 * and no agent ever names a provider.
 */
export const resolveAgentModelProfile = (role: AgentModelRole) => {
  const profile = agentModelProfiles[role];
  return { model: modelSpecifier(agentModelProvider, profile.id), thinkingLevel: profile.thinkingLevel };
};

export const configuredModelIds = (profiles: AgentModelProfiles): readonly string[] => [
  ...new Set(AGENT_MODEL_ROLES.map((role) => profiles[role].id)),
];

const CODEX_API = "openai-codex-responses";
const SPEAKER_CODEX_API = "speaker-openai-codex-responses";
const CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const LUNA_MINIMUM_CODEX_VERSION = "0.144.1";
const RESPONSES_LITE_FETCH = Symbol.for("whatsappd.speaker.responses-lite-fetch");
const RATE_LIMIT_RETRY_FETCH = Symbol.for("whatsappd.speaker.rate-limit-retry-fetch");
/** Retries per request before a 429 surfaces. Model prompts fire in bursts, so a few is plenty. */
const RATE_LIMIT_MAX_RETRIES = 5;
/** Cap for a single backoff wait, so a stuck provider fails a job in minutes, not forever. */
const RATE_LIMIT_MAX_DELAY_MS = 30_000;

type ApiRegistration = Parameters<typeof flueRegisterApiProvider>[0];
type ApiRegistrar = (provider: ApiRegistration) => void;
type ProviderRegistrar = typeof flueRegisterProvider;

export interface PiSubscriptionConnectorOptions {
  authentication: ChatGptAuthentication;
  profiles: AgentModelProfiles;
  codexApi?: ProviderStreams;
  registerApiProvider?: ApiRegistrar;
  registerProvider?: ProviderRegistrar;
}

export interface PiSubscriptionReceipt {
  authentication: "chatgpt-oauth";
  model: string;
  models: readonly string[];
  provider: typeof PROVIDER_ID;
}

export interface ChatGptReadinessReceipt {
  readonly model: string;
  readonly models: readonly string[];
  readonly request: "complete" | "failed";
  readonly reason?: "cancelled" | "timeout" | "credential-rejected" | "rate-limited" | "request-failed";
}

export interface ChatGptReadinessCheckOptions {
  readonly profiles: AgentModelProfiles;
  readonly signal?: AbortSignal;
  readonly request?: (authorization: ModelAuthorization, modelId: string, signal?: AbortSignal) => Promise<void>;
}

export type ChatGptReadinessErrorCode = NonNullable<ChatGptReadinessReceipt["reason"]>;

export class ChatGptReadinessError extends Error {
  override readonly name = "ChatGptReadinessError";

  constructor(
    readonly code: ChatGptReadinessErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

const CREDENTIAL_REJECTED = /\b(401|403|unauthori[sz]ed|forbidden|invalid[_ -]?token|revoked)\b/iu;
const RATE_LIMITED = /\b(429|rate.?limit(ed|s)?|too many requests|quota)\b/iu;

/**
 * Classify a failed model request (#246). A 429 previously fell through to `request-failed`,
 * making a rate limit indistinguishable from a network blip, a 500 or a DNS failure — so a
 * live gate that merely hit the rate limit read as a regression. A rate-limited run is
 * INCONCLUSIVE and re-runnable: never PASS, never FAIL.
 *
 * Credential rejection is checked first: a 401 that also happens to mention a quota is still
 * a credential problem, and retrying it is pointless.
 */
export const readinessErrorFor = (message: string, options?: ErrorOptions): ChatGptReadinessError => {
  if (CREDENTIAL_REJECTED.test(message)) {
    return new ChatGptReadinessError(
      "credential-rejected",
      "ChatGPT rejected the managed credential during the live readiness check.",
      options,
    );
  }
  if (RATE_LIMITED.test(message)) {
    return new ChatGptReadinessError(
      "rate-limited",
      "The model provider rate-limited the live readiness request; the result is inconclusive, not a regression. Re-run it.",
      options,
    );
  }
  return new ChatGptReadinessError(
    "request-failed",
    "The ChatGPT live readiness request failed; retry when the service is reachable.",
    options,
  );
};

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Adapt Luna requests to the subscription-only Codex Responses Lite contract. */
export function prepareLunaResponsesLiteRequest(
  headers: Headers,
  body: unknown,
): { headers: Headers; body: unknown } {
  if (!isRecord(body) || body.model !== LUNA_MODEL_ID) return { headers, body };

  const input = Array.isArray(body.input)
    ? body.input.map((item) =>
        isRecord(item) && !("type" in item) && "role" in item
          ? { type: "message", ...item }
          : item,
      )
    : [];
  const tools = Array.isArray(body.tools) ? body.tools : [];
  const prefix: unknown[] = [{ type: "additional_tools", role: "developer", tools }];
  if (nonEmptyString(body.instructions)) {
    prefix.push({
      type: "message",
      role: "developer",
      content: [{ type: "input_text", text: body.instructions }],
    });
  }

  const { instructions: _instructions, tools: _tools, ...rest } = body;
  headers.set("originator", "codex_exec");
  headers.set("version", LUNA_MINIMUM_CODEX_VERSION);
  headers.set("x-openai-internal-codex-responses-lite", "true");

  return {
    headers,
    body: {
      ...rest,
      input: [...prefix, ...input],
      parallel_tool_calls: false,
      reasoning: {
        ...(isRecord(body.reasoning) ? body.reasoning : {}),
        context: "all_turns",
      },
    },
  };
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  return input instanceof Request ? input.url : input.toString();
}

function installLunaResponsesLiteFetch(): void {
  const upstream = globalThis.fetch as typeof fetch & { [RESPONSES_LITE_FETCH]?: true };
  if (upstream[RESPONSES_LITE_FETCH]) return;

  const wrapped: typeof fetch = async (input, init) => {
    if (
      !requestUrl(input).includes("/backend-api/codex/responses") ||
      typeof init?.body !== "string"
    ) {
      return upstream(input, init);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(init.body);
    } catch {
      return upstream(input, init);
    }

    const prepared = prepareLunaResponsesLiteRequest(new Headers(init.headers), parsed);
    return upstream(input, {
      ...init,
      headers: prepared.headers,
      body: JSON.stringify(prepared.body),
    });
  };
  Object.defineProperty(wrapped, RESPONSES_LITE_FETCH, { value: true });
  globalThis.fetch = wrapped;
}

/** Milliseconds to wait from a `Retry-After` header (delta-seconds or HTTP-date), else undefined. */
function retryAfterMs(response: Response): number | undefined {
  const header = response.headers.get("retry-after");
  if (header === null) return undefined;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

const abortableDelay = (ms: number, signal?: AbortSignal | null): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal!.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/**
 * Wrap a `fetch` so a `429` is honored and retried instead of surfaced as a fatal error (#246
 * follow-up). A single transient tokens-per-minute rate limit was aborting an entire Coder run
 * after minutes of real work — OpenAI asks the client to wait a few seconds and retry, so we do:
 * `Retry-After` when present, otherwise capped exponential backoff, bounded by {@link
 * RATE_LIMIT_MAX_RETRIES}. Only requests with a resendable (string/empty) body are retried; a
 * streamed body can be consumed once, so it is passed straight through. The retry is abandoned if
 * the caller's signal aborts, so a cancelled job never hangs on a backoff.
 */
export const rateLimitRetryingFetch = (
  upstream: typeof fetch,
  options: {
    readonly maxRetries?: number;
    readonly maxDelayMs?: number;
    readonly delay?: (ms: number, signal?: AbortSignal | null) => Promise<void>;
  } = {},
): typeof fetch => {
  const maxRetries = options.maxRetries ?? RATE_LIMIT_MAX_RETRIES;
  const maxDelayMs = options.maxDelayMs ?? RATE_LIMIT_MAX_DELAY_MS;
  const delay = options.delay ?? abortableDelay;
  return async (input, init) => {
    const bodyResendable = init?.body === undefined || init?.body === null || typeof init.body === "string";
    const signal = init?.signal ?? (input instanceof Request ? input.signal : null);
    for (let attempt = 0; ; attempt++) {
      const response = await upstream(input, init);
      if (response.status !== 429 || attempt >= maxRetries || !bodyResendable || signal?.aborted) return response;
      const wait = Math.min(retryAfterMs(response) ?? 1000 * 2 ** attempt, maxDelayMs);
      // The 429 body is discarded before the retry so the connection can be reused.
      await response.body?.cancel().catch(() => {});
      try {
        await delay(wait, signal);
      } catch (cause) {
        // Aborted while waiting: propagate the abort so a cancelled job never hangs on a backoff.
        throw cause;
      }
    }
  };
};

/** Install {@link rateLimitRetryingFetch} over the global fetch once, idempotently. */
function installModelRateLimitRetryFetch(): void {
  const upstream = globalThis.fetch as typeof fetch & { [RATE_LIMIT_RETRY_FETCH]?: true };
  if (upstream[RATE_LIMIT_RETRY_FETCH]) return;
  const wrapped = rateLimitRetryingFetch(upstream);
  Object.defineProperty(wrapped, RATE_LIMIT_RETRY_FETCH, { value: true });
  globalThis.fetch = wrapped;
}

function codexSubscriptionModel(model: Model<Api>): Model<Api> {
  const configured = {
    ...model,
    api: CODEX_API,
    reasoning: true,
    thinkingLevelMap: { ...model.thinkingLevelMap, xhigh: "xhigh" },
  };
  return model.id === LUNA_MODEL_ID
    ? { ...configured, thinkingLevelMap: { ...configured.thinkingLevelMap, minimal: "low" } }
    : configured;
}

function codexSubscriptionApi(delegate: ProviderStreams): ApiRegistration {
  return {
    api: SPEAKER_CODEX_API,
    stream: (model, context, options) =>
      delegate.stream(codexSubscriptionModel(model), context, { ...options, transport: "sse" }),
    streamSimple: (model, context, options) =>
      delegate.streamSimple(codexSubscriptionModel(model), context, { ...options, transport: "sse" }),
  };
}

const requestChatGptReadiness = async (
  authorization: ModelAuthorization,
  modelId: string,
  signal?: AbortSignal,
): Promise<void> => {
  if (!nonEmptyString(authorization.apiKey)) throw new Error("ChatGPT model authorization is not ready.");
  installLunaResponsesLiteFetch();
  const stream = openAICodexResponsesApi().streamSimple(
    codexSubscriptionModel({
      id: modelId,
      name: modelId,
      api: CODEX_API,
      provider: PROVIDER_ID,
      baseUrl: CODEX_BASE_URL,
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 272_000,
      maxTokens: 128_000,
    }),
    {
      messages: [{ role: "user", content: "Reply with READY.", timestamp: Date.now() }],
    },
    { apiKey: authorization.apiKey, maxTokens: 16, signal, transport: "sse" },
  );
  const result = await stream.result();
  if (result.stopReason === "aborted") {
    const timeout = signal?.reason instanceof Error && signal.reason.name === "TimeoutError";
    throw new ChatGptReadinessError(
      timeout ? "timeout" : "cancelled",
      timeout ? "The ChatGPT readiness request timed out." : "The ChatGPT readiness request was cancelled.",
    );
  }
  if (result.stopReason === "error") throw readinessErrorFor(result.errorMessage ?? "");
};

const readinessFailure = (cause: unknown, signal?: AbortSignal): ChatGptReadinessError => {
  if (cause instanceof ChatGptReadinessError) return cause;
  if (signal?.aborted) {
    const timeout = signal.reason instanceof Error && signal.reason.name === "TimeoutError";
    return new ChatGptReadinessError(
      timeout ? "timeout" : "cancelled",
      timeout ? "The ChatGPT readiness request timed out." : "The ChatGPT readiness request was cancelled.",
      { cause },
    );
  }
  return readinessErrorFor(cause instanceof Error ? cause.message : String(cause), { cause });
};

export const runChatGptReadinessCheck = async (
  authentication: ChatGptAuthentication,
  options: ChatGptReadinessCheckOptions,
): Promise<ChatGptReadinessReceipt> => {
  const authorization = await authentication.authorization(options.signal);
  const modelIds = configuredModelIds(options.profiles);
  try {
    for (const modelId of modelIds) {
      await (options.request ?? requestChatGptReadiness)(authorization, modelId, options.signal);
    }
  } catch (cause) {
    throw readinessFailure(cause, options.signal);
  }
  return {
    model: modelSpecifier(PROVIDER_ID, options.profiles.speaker.id),
    models: modelIds.map((id) => modelSpecifier(PROVIDER_ID, id)),
    request: "complete",
  };
};

export async function connectPiChatGptSubscription(
  options: PiSubscriptionConnectorOptions,
): Promise<PiSubscriptionReceipt> {
  const { apiKey } = await options.authentication.authorization();
  if (!nonEmptyString(apiKey)) throw new Error("ChatGPT model authorization is not ready; run ambient-agent doctor.");

  if (!options.codexApi) installLunaResponsesLiteFetch();
  // A transient 429 must back off and retry, not abort a running Coder job (#246 follow-up).
  installModelRateLimitRetryFetch();
  const codexApi = options.codexApi ?? openAICodexResponsesApi();
  const modelIds = configuredModelIds(options.profiles);
  (options.registerApiProvider ?? flueRegisterApiProvider)(codexSubscriptionApi(codexApi));
  (options.registerProvider ?? flueRegisterProvider)(PROVIDER_ID, {
    api: SPEAKER_CODEX_API,
    apiKey,
    baseUrl: CODEX_BASE_URL,
    contextWindow: 272_000,
    maxTokens: 128_000,
    models: Object.fromEntries(modelIds.map((id) => [id, {}])),
  });

  return {
    authentication: "chatgpt-oauth",
    model: modelSpecifier(PROVIDER_ID, options.profiles.speaker.id),
    models: modelIds.map((id) => modelSpecifier(PROVIDER_ID, id)),
    provider: PROVIDER_ID,
  };
}

export interface ApiKeyReadinessReceipt {
  readonly model: string;
  readonly request: "complete" | "failed";
  readonly reason?: NonNullable<ChatGptReadinessReceipt["reason"]>;
  /** The reply text. Non-empty is the only evidence that inference happened at all. */
  readonly text: string;
  readonly elapsedMs: number;
}

/**
 * One real request through an API-key provider, for the pre-flight that de-risks a deploy.
 *
 * It deliberately reports the reply *text*: a `complete` request only means the stream ended
 * without an error, and an empty response satisfies that. This makes no claim about any
 * transport — it proves inference, nothing else.
 */
export const runApiKeyReadinessCheck = async (options: {
  readonly provider: ModelProvider;
  readonly apiKey: string;
  readonly modelId: string;
  readonly prompt?: string;
  readonly maxTokens?: number;
  readonly signal?: AbortSignal;
}): Promise<ApiKeyReadinessReceipt> => {
  const model = getBuiltinModels(options.provider as KnownProvider).find(({ id }) => id === options.modelId);
  if (model === undefined) {
    throw new Error(`${options.provider} has no model ${options.modelId} in this build's catalog.`);
  }
  const started = Date.now();
  const specifier = modelSpecifier(options.provider, options.modelId);
  try {
    const result = await completeSimple(
      model,
      { messages: [{ role: "user", content: options.prompt ?? "Reply with READY.", timestamp: started }] },
      { apiKey: options.apiKey, maxTokens: options.maxTokens ?? 16, ...(options.signal ? { signal: options.signal } : {}) },
    );
    if (result.stopReason === "error" || result.stopReason === "aborted") {
      const failure = readinessErrorFor(result.errorMessage ?? String(result.stopReason));
      return { model: specifier, request: "failed", reason: failure.code, text: "", elapsedMs: Date.now() - started };
    }
    const text = result.content
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("")
      .trim();
    return { model: specifier, request: "complete", text, elapsedMs: Date.now() - started };
  } catch (cause) {
    const failure = readinessFailure(cause, options.signal);
    return { model: specifier, request: "failed", reason: failure.code, text: "", elapsedMs: Date.now() - started };
  }
};

export interface PiApiKeyConnectorOptions {
  /** Any pi provider ID other than the subscription one. */
  readonly provider: ModelProvider;
  /** The key read from the managed credential store; never an environment variable. */
  readonly apiKey: string;
  readonly profiles: AgentModelProfiles;
  readonly registerProvider?: ProviderRegistrar;
}

export interface PiApiKeyReceipt {
  readonly authentication: "api-key";
  readonly model: string;
  readonly models: readonly string[];
  readonly provider: ModelProvider;
}

/**
 * Bind any catalog provider with an API key. The registration carries only the key: the api
 * id, endpoint, context window and per-model cost all hydrate from pi's catalog. There is
 * deliberately no `registerApiProvider` and no request rewriting — the Codex Responses Lite
 * adaptation is gated on the Codex URL and model id and never sees these requests.
 */
export async function connectPiApiKeyProvider(options: PiApiKeyConnectorOptions): Promise<PiApiKeyReceipt> {
  if (!nonEmptyString(options.apiKey)) {
    throw new Error(
      `The managed API key for model provider ${options.provider} is empty; run ambient-agent config --model-provider ${options.provider}.`,
    );
  }
  if (!isModelProvider(options.provider)) {
    throw new Error(`${options.provider} is not a model provider this build of pi ships.`);
  }
  // A transient 429 must back off and retry, not abort a running Coder job (#246 follow-up).
  installModelRateLimitRetryFetch();
  const modelIds = configuredModelIds(options.profiles);
  (options.registerProvider ?? flueRegisterProvider)(options.provider, { apiKey: options.apiKey });

  return {
    authentication: "api-key",
    model: modelSpecifier(options.provider, options.profiles.speaker.id),
    models: modelIds.map((id) => modelSpecifier(options.provider, id)),
    provider: options.provider,
  };
}
