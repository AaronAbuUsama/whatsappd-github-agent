import {
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
export const AGENT_MODEL_ROLES = ["speaker", "scribe", "planner", "coder", "verifier"] as const;
export const MODEL_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;

export type AgentModelRole = (typeof AGENT_MODEL_ROLES)[number];
export type ModelThinkingLevel = (typeof MODEL_THINKING_LEVELS)[number];

export interface AgentModelProfile {
  readonly id: string;
  readonly thinkingLevel: ModelThinkingLevel;
}

export type AgentModelProfiles = Readonly<Record<AgentModelRole, AgentModelProfile>>;

export const DEFAULT_AGENT_MODEL_PROFILES: AgentModelProfiles = {
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
 * The single seam every agent resolves its model through. All five roles read their own
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
  readonly reason?: "cancelled" | "timeout" | "credential-rejected" | "request-failed";
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
  if (result.stopReason === "error") {
    const rejected = /\b(401|403|unauthori[sz]ed|forbidden|invalid[_ -]?token|revoked)\b/iu.test(
      result.errorMessage ?? "",
    );
    throw new ChatGptReadinessError(
      rejected ? "credential-rejected" : "request-failed",
      rejected
        ? "ChatGPT rejected the managed credential during the live readiness check."
        : "The ChatGPT live readiness request failed; retry when the service is reachable.",
    );
  }
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
  return new ChatGptReadinessError(
    "request-failed",
    "The ChatGPT live readiness request failed; retry when the service is reachable.",
    { cause },
  );
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
  const modelIds = configuredModelIds(options.profiles);
  (options.registerProvider ?? flueRegisterProvider)(options.provider, { apiKey: options.apiKey });

  return {
    authentication: "api-key",
    model: modelSpecifier(options.provider, options.profiles.speaker.id),
    models: modelIds.map((id) => modelSpecifier(options.provider, id)),
    provider: options.provider,
  };
}
