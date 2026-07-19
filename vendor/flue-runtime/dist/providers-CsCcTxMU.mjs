import { b as ProviderRegistrationError } from "./errors-DUgRtE8e.mjs";
import { getModel, getModels, registerApiProvider, resetApiProviders } from "@earendil-works/pi-ai/compat";
//#region src/cloudflare-model.ts
/** Pi-ai `Api` slug for the binding-backed Workers AI provider. */
const CLOUDFLARE_AI_BINDING_API = "cloudflare-ai-binding";
//#endregion
//#region src/runtime/providers.ts
/** Runtime provider registries consumed by `resolveModel` and Session. */
/**
* pi-ai's open-ended `Api` type prevents direct discriminator narrowing.
*/
function isCloudflareBindingRegistration(def) {
	return def.api === CLOUDFLARE_AI_BINDING_API;
}
/**
* Provider registry populated at module init by `app.ts` and generated
* server entries.
*/
const providersById = /* @__PURE__ */ new Map();
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
function registerProvider(providerId, registration) {
	if (!isCloudflareBindingRegistration(registration) && (registration.api === void 0 || registration.baseUrl === void 0) && getModels(providerId).length === 0) throw new ProviderRegistrationError({ providerId });
	providersById.set(providerId, registration);
}
function resetProviderRuntime() {
	providersById.clear();
	resetApiProviders();
}
/** Whether a provider ID has already been registered. */
function hasRegisteredProvider(providerId) {
	return providersById.has(providerId);
}
/** Look up an API key registered for a provider ID. */
function getProviderTelemetry(providerId) {
	const telemetry = providersById.get(providerId)?.telemetry;
	return {
		...telemetry,
		providerName: telemetry?.providerName ?? normalizeProviderName(providerId)
	};
}
function normalizeProviderName(providerId) {
	return {
		"amazon-bedrock": "aws.bedrock",
		anthropic: "anthropic",
		"azure-openai-responses": "azure.ai.openai",
		deepseek: "deepseek",
		google: "gcp.gemini",
		"google-vertex": "gcp.vertex_ai",
		groq: "groq",
		mistral: "mistral_ai",
		moonshotai: "moonshot_ai",
		"moonshotai-cn": "moonshot_ai",
		openai: "openai",
		xai: "x_ai"
	}[providerId] ?? providerId;
}
function getRegisteredApiKey(providerId) {
	const registration = providersById.get(providerId);
	if (!registration || isCloudflareBindingRegistration(registration)) return void 0;
	return registration.apiKey;
}
/** Whether a registered provider opted into OpenAI-hosted response storage. */
function getRegisteredStoreResponses(providerId) {
	const registration = providersById.get(providerId);
	if (!registration || isCloudflareBindingRegistration(registration)) return false;
	return registration.storeResponses === true;
}
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
function registerApiProvider$1(provider) {
	registerApiProvider(provider, "flue-runtime");
}
/** Attach a Workers AI binding (and optional gateway options) to a Model literal. */
function attachModelBinding(model, binding, gateway) {
	return {
		...model,
		binding,
		gateway
	};
}
/**
* Read a Workers AI binding off a resolved Model, or `undefined` if no
* usable binding is attached.
*/
function getModelBinding(model) {
	const candidate = model.binding;
	if (!candidate || typeof candidate.run !== "function") return;
	return candidate;
}
/**
* Read AI Gateway options off a resolved Model, or `undefined` if none are
* attached.
*/
function getModelGateway(model) {
	const candidate = model.gateway;
	if (!candidate || typeof candidate.id !== "string") return;
	return candidate;
}
/** Resolve `'provider-id/model-id'` against the provider registry. */
function resolveRegisteredModel(providerId, modelId) {
	const registration = providersById.get(providerId);
	if (!registration) return void 0;
	return buildModelFromRegistration(providerId, registration, modelId);
}
/**
* Construct a pi-ai Model from a registered provider template. Binding
* registrations hydrate metadata from pi-ai's `cloudflare-workers-ai`
* catalog; HTTP registrations hydrate from the provider ID's own catalog
* entry when one exists, with the registration's options layered on top and
* any still-unset metadata defaulting to zero.
*/
function buildModelFromRegistration(providerId, registration, modelId) {
	if (isCloudflareBindingRegistration(registration)) {
		const catalog = getModel("cloudflare-workers-ai", modelId);
		const base = catalog ? {
			...catalog,
			api: CLOUDFLARE_AI_BINDING_API,
			provider: providerId,
			baseUrl: ""
		} : zeroMetadataModel(providerId, modelId, CLOUDFLARE_AI_BINDING_API, "");
		const gateway = registration.gateway === false ? void 0 : registration.gateway ?? { id: "default" };
		return attachModelBinding(base, registration.binding, gateway);
	}
	const catalog = getModel(providerId, modelId);
	const providerDefaults = catalog ?? getModels(providerId)[0];
	const api = registration.api ?? providerDefaults?.api;
	const baseUrl = registration.baseUrl ?? providerDefaults?.baseUrl;
	if (api === void 0 || baseUrl === void 0) throw new ProviderRegistrationError({ providerId });
	const base = catalog ?? zeroMetadataModel(providerId, modelId, api, baseUrl);
	const headers = base.headers || registration.headers ? {
		...base.headers,
		...registration.headers
	} : void 0;
	return {
		...base,
		api,
		provider: providerId,
		baseUrl,
		headers,
		contextWindow: registration.models?.[modelId]?.contextWindow ?? registration.contextWindow ?? base.contextWindow,
		maxTokens: registration.models?.[modelId]?.maxTokens ?? registration.maxTokens ?? base.maxTokens
	};
}
/** Zero-metadata Model literal for ids no catalog knows. */
function zeroMetadataModel(providerId, modelId, api, baseUrl) {
	return {
		id: modelId,
		name: modelId,
		api,
		provider: providerId,
		baseUrl,
		reasoning: false,
		input: ["text"],
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0
		},
		contextWindow: 0,
		maxTokens: 0
	};
}
//#endregion
export { getRegisteredStoreResponses as a, registerProvider as c, CLOUDFLARE_AI_BINDING_API as d, getRegisteredApiKey as i, resetProviderRuntime as l, getModelGateway as n, hasRegisteredProvider as o, getProviderTelemetry as r, registerApiProvider$1 as s, getModelBinding as t, resolveRegisteredModel as u };
