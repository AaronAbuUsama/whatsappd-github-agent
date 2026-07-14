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
import { ChatGptAuthenticationError, type ChatGptAuthentication } from "./chatgpt-authentication.js";
import type { ModelAuthorization } from "./chatgpt-authentication.js";

export const AMBIENCE_MODEL_ID = "gpt-5.6-luna";
export const AMBIENCE_MODEL_SPECIFIER = `openai-codex/${AMBIENCE_MODEL_ID}`;

const PROVIDER_ID = "openai-codex";
const CODEX_API = "openai-codex-responses";
const AMBIENCE_CODEX_API = "ambience-openai-codex-responses";
const CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const LUNA_MINIMUM_CODEX_VERSION = "0.144.1";
const RESPONSES_LITE_FETCH = Symbol.for("whatsappd.ambience.responses-lite-fetch");

type ApiRegistration = Parameters<typeof flueRegisterApiProvider>[0];
type ApiRegistrar = (provider: ApiRegistration) => void;
type ProviderRegistrar = typeof flueRegisterProvider;

export interface PiSubscriptionConnectorOptions {
  authentication: ChatGptAuthentication;
  codexApi?: ProviderStreams;
  registerApiProvider?: ApiRegistrar;
  registerProvider?: ProviderRegistrar;
}

export interface PiSubscriptionReceipt {
  authentication: "chatgpt-oauth";
  model: typeof AMBIENCE_MODEL_SPECIFIER;
  provider: typeof PROVIDER_ID;
}

export interface ChatGptReadinessReceipt {
  readonly model: typeof AMBIENCE_MODEL_SPECIFIER;
  readonly request: "complete" | "failed";
  readonly reason?: "cancelled" | "timeout" | "credential-rejected" | "request-failed";
}

export interface ChatGptReadinessCheckOptions {
  readonly signal?: AbortSignal;
  readonly request?: (authorization: ModelAuthorization, signal?: AbortSignal) => Promise<void>;
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
  if (!isRecord(body) || body.model !== AMBIENCE_MODEL_ID) return { headers, body };

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

function lunaModel(model: Model<Api>): Model<Api> {
  return {
    ...model,
    api: CODEX_API,
    reasoning: true,
    thinkingLevelMap: { ...model.thinkingLevelMap, minimal: "low", xhigh: "xhigh" },
  };
}

function lunaApi(delegate: ProviderStreams): ApiRegistration {
  return {
    api: AMBIENCE_CODEX_API,
    stream: (model, context, options) =>
      delegate.stream(lunaModel(model), context, { ...options, transport: "sse" }),
    streamSimple: (model, context, options) =>
      delegate.streamSimple(lunaModel(model), context, { ...options, transport: "sse" }),
  };
}

const requestChatGptReadiness = async (authorization: ModelAuthorization, signal?: AbortSignal): Promise<void> => {
  if (!nonEmptyString(authorization.apiKey)) throw new Error("ChatGPT model authorization is not ready.");
  installLunaResponsesLiteFetch();
  const stream = openAICodexResponsesApi().streamSimple(
    lunaModel({
      id: AMBIENCE_MODEL_ID,
      name: AMBIENCE_MODEL_ID,
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
  if (
    cause instanceof ChatGptAuthenticationError &&
    (cause.code === "timeout" || cause.code === "cancelled")
  ) {
    return new ChatGptReadinessError(cause.code, cause.message, { cause });
  }
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
  options: ChatGptReadinessCheckOptions = {},
): Promise<ChatGptReadinessReceipt> => {
  try {
    const authorization = await authentication.authorization(options.signal);
    await (options.request ?? requestChatGptReadiness)(authorization, options.signal);
  } catch (cause) {
    throw readinessFailure(cause, options.signal);
  }
  return { model: AMBIENCE_MODEL_SPECIFIER, request: "complete" };
};

export async function connectPiChatGptSubscription(
  options: PiSubscriptionConnectorOptions,
): Promise<PiSubscriptionReceipt> {
  const { apiKey } = await options.authentication.authorization();
  if (!nonEmptyString(apiKey)) throw new Error("ChatGPT model authorization is not ready; run ambient-agent doctor.");

  if (!options.codexApi) installLunaResponsesLiteFetch();
  const codexApi = options.codexApi ?? openAICodexResponsesApi();
  (options.registerApiProvider ?? flueRegisterApiProvider)(lunaApi(codexApi));
  (options.registerProvider ?? flueRegisterProvider)(PROVIDER_ID, {
    api: AMBIENCE_CODEX_API,
    apiKey,
    baseUrl: CODEX_BASE_URL,
    contextWindow: 272_000,
    maxTokens: 128_000,
  });

  return {
    authentication: "chatgpt-oauth",
    model: AMBIENCE_MODEL_SPECIFIER,
    provider: PROVIDER_ID,
  };
}
