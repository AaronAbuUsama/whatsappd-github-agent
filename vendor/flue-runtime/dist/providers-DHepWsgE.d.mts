import { t as CLOUDFLARE_AI_BINDING_API } from "./cloudflare-model-vD6fKgyg.mjs";
import { Api, Model, registerApiProvider } from "@earendil-works/pi-ai/compat";

//#region src/cloudflare/gateway.d.ts
/**
 * Cloudflare AI Gateway options forwarded as the third argument to
 * `env.AI.run(...)`. Mirrors the shape documented at
 * https://developers.cloudflare.com/ai-gateway/integrations/worker-binding-methods/.
 *
 * Carried on a `CloudflareAIBindingRegistration` from
 * `@flue/runtime/cloudflare`; the binding provider attaches it to every
 * `env.AI.run(...)` call routed through that registration.
 */
interface CloudflareGatewayOptions {
  /**
   * The AI Gateway id (slug) to route requests through. Required when
   * gateway options are specified.
   */
  id: string;
  /** Bypass the gateway cache for this request. */
  skipCache?: boolean;
  /** Override the cache TTL (seconds) for this request. */
  cacheTtl?: number;
  /** Override the cache key used for this request. */
  cacheKey?: string;
  /**
   * Arbitrary metadata associated with the request. Surfaced on the
   * Gateway log entry.
   */
  metadata?: Record<string, number | string | boolean | null | bigint>;
  /** Force collecting (or not collecting) request logs on the Gateway. */
  collectLog?: boolean;
  /** Correlate this request with a custom event id on the Gateway log. */
  eventId?: string;
  /** Per-request timeout enforced by the Gateway, in milliseconds. */
  requestTimeoutMs?: number;
}
//#endregion
//#region src/runtime/providers.d.ts
/**
 * Minimal Workers AI binding shape. Kept structural so `@flue/runtime` stays
 * importable on Node.
 */
interface CloudflareAIBinding {
  run(modelId: string, inputs: Record<string, unknown>, options?: Record<string, unknown>): Promise<Response | Record<string, unknown>>;
}
/**
 * Provider declarations keyed by provider ID. HTTP providers carry endpoint
 * settings; Workers AI binding providers carry the captured binding object.
 */
type ProviderRegistration = HttpProviderRegistration | CloudflareAIBindingRegistration;
interface ProviderTelemetryRegistration {
  providerName?: string;
  serverAddress?: string;
  serverPort?: number;
}
/** Register an HTTP-backed provider ID with {@link registerProvider}. */
interface HttpProviderRegistration {
  /**
   * Wire protocol used for requests. Required for provider IDs the catalog
   * doesn't know; defaults to the catalog protocol for catalog provider IDs.
   */
  api?: Api;
  /**
   * Endpoint root, e.g. `'https://api.anthropic.com/v1'`. Required for
   * provider IDs the catalog doesn't know; defaults to the catalog endpoint
   * for catalog provider IDs.
   */
  baseUrl?: string;
  /**
   * Optional API key. Propagated to pi-ai via the harness's per-call
   * `getApiKey(providerId)` callback. Falls back to whatever pi-ai's normal
   * env-var lookup produces if unset.
   */
  apiKey?: string;
  /**
   * Headers sent on every outgoing request. Merged per key over the catalog
   * model's headers when the provider ID hydrates from the catalog; this
   * registration's values win on conflict.
   */
  headers?: Record<string, string>;
  /**
   * Default `contextWindow` (in tokens) for every model resolved through
   * this registration. Overridden per-model via {@link models}. Unset falls
   * back to the catalog value for catalog models, then to `0`, which the
   * runtime treats as "unknown".
   */
  contextWindow?: number;
  /**
   * Default `maxTokens` for every model resolved through this registration.
   * Overridden per-model via {@link models}. Unset falls back to the catalog
   * value for catalog models, then to `0`.
   */
  maxTokens?: number;
  /** Per-model overrides for {@link contextWindow} and {@link maxTokens}, keyed by model ID. */
  models?: Record<string, {
    contextWindow?: number;
    maxTokens?: number;
  }>;
  /**
   * Sends `store: true` for OpenAI Responses API providers. Only enable when
   * you need OpenAI-hosted item persistence and accept its retention policy.
   */
  storeResponses?: boolean;
  telemetry?: ProviderTelemetryRegistration;
}
/** Register a Workers AI binding-backed provider ID with {@link registerProvider}. */
interface CloudflareAIBindingRegistration {
  api: typeof CLOUDFLARE_AI_BINDING_API;
  /** The captured `env.AI` reference. Read at registration time. */
  binding: CloudflareAIBinding;
  /**
   * AI Gateway options forwarded to every `env.AI.run(...)` call routed
   * through this registration.
   *
   * - Omitted: routes through Cloudflare's default AI Gateway, which the
   *   binding spins up on demand for the account.
   * - Options object: replaces the default. Specify `id` plus any other
   *   knobs (cache, metadata, logging).
   * - `false`: opts out — no gateway is passed to `ai.run`.
   *
   * See https://developers.cloudflare.com/ai-gateway/integrations/worker-binding-methods/.
   */
  gateway?: CloudflareGatewayOptions | false;
  telemetry?: ProviderTelemetryRegistration;
}
/**
 * Register a model provider keyed by the provider ID used in model specifiers.
 *
 * When the provider ID is a catalog provider, models resolve from the catalog
 * — preserving metadata such as cost, context window, and wire protocol —
 * with this call's options layered on top. That makes transport overrides
 * one call:
 *
 * ```ts
 * registerProvider('anthropic', {
 *   baseUrl: 'https://gateway.example.com/anthropic',
 *   apiKey: process.env.GATEWAY_KEY,
 * });
 * ```
 *
 * Provider IDs the catalog doesn't know are registered from scratch and must
 * supply `api` and `baseUrl`.
 *
 * Each call REPLACES the provider ID's previous registration; calls do not
 * accumulate. The effective settings are always the catalog defaults (when
 * the ID is known) plus the latest call's options. On Cloudflare, registering
 * the `cloudflare` provider ID in `app.ts` takes precedence over the
 * generated Workers AI binding default.
 */
declare function registerProvider(providerId: string, registration: ProviderRegistration): void;
declare function resetProviderRuntime(): void;
/** Whether a provider ID has already been registered. */
declare function hasRegisteredProvider(providerId: string): boolean;
/**
 * Register a brand-new pi-ai wire-protocol handler. Use this before
 * wire-protocol handler for an `api` slug pi-ai doesn't ship. Then call
 * {@link registerProvider} to associate a provider ID with that api.
 *
 * ```ts
 * registerApiProvider({ api: 'my-novel-api', stream, streamSimple });
 * registerProvider('thing', { api: 'my-novel-api', baseUrl: '...', apiKey: '...' });
 * ```
 *
 * pi-ai's registry is also module-scoped and last-write-wins. Calling
 * `registerApiProvider` repeatedly with the same `api` string overwrites,
 * so generated code can register on every isolate boot without dedupe
 * bookkeeping.
 */
declare function registerApiProvider$1(provider: Parameters<typeof registerApiProvider>[0]): void;
//#endregion
export { hasRegisteredProvider as a, resetProviderRuntime as c, ProviderRegistration as i, CloudflareGatewayOptions as l, CloudflareAIBindingRegistration as n, registerApiProvider$1 as o, HttpProviderRegistration as r, registerProvider as s, CloudflareAIBinding as t };