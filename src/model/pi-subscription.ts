import { AuthStorage } from "@earendil-works/pi-coding-agent";
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

export const AMBIENCE_MODEL_ID = "gpt-5.6-luna";
export const AMBIENCE_MODEL_SPECIFIER = `openai-codex/${AMBIENCE_MODEL_ID}`;

const PROVIDER_ID = "openai-codex";
const CODEX_API = "openai-codex-responses";
const AMBIENCE_CODEX_API = "ambience-openai-codex-responses";
const CODEX_BASE_URL = "https://chatgpt.com/backend-api";
const LUNA_MINIMUM_CODEX_VERSION = "0.144.1";
const RESPONSES_LITE_FETCH = Symbol.for("whatsappd.ambience.responses-lite-fetch");

type AuthReader = Pick<AuthStorage, "get" | "getApiKey">;
type ApiRegistration = Parameters<typeof flueRegisterApiProvider>[0];
type ApiRegistrar = (provider: ApiRegistration) => void;
type ProviderRegistrar = typeof flueRegisterProvider;

export interface PiSubscriptionConnectorOptions {
  authStorage?: AuthReader;
  codexApi?: ProviderStreams;
  registerApiProvider?: ApiRegistrar;
  registerProvider?: ProviderRegistrar;
}

export interface PiSubscriptionReceipt {
  authentication: "pi-oauth";
  model: typeof AMBIENCE_MODEL_SPECIFIER;
  provider: typeof PROVIDER_ID;
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

export async function connectPiChatGptSubscription(
  options: PiSubscriptionConnectorOptions = {},
): Promise<PiSubscriptionReceipt> {
  const authStorage =
    options.authStorage ?? AuthStorage.create(process.env.AMBIENCE_PI_AUTH_PATH?.trim() || undefined);
  const credential = authStorage.get(PROVIDER_ID);
  if (!credential || credential.type !== "oauth") {
    throw new Error(
      "Ambience requires a Pi OAuth credential for openai-codex; run `pi /login` and select ChatGPT.",
    );
  }

  const apiKey = await authStorage.getApiKey(PROVIDER_ID, { includeFallback: false });
  if (!apiKey) {
    throw new Error(
      "Pi could not load or refresh the openai-codex OAuth credential; run `pi /login` and try again.",
    );
  }

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
    authentication: "pi-oauth",
    model: AMBIENCE_MODEL_SPECIFIER,
    provider: PROVIDER_ID,
  };
}
