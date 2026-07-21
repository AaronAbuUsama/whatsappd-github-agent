import {
  AGENT_MODEL_ROLES,
  catalogModelIds,
  isCatalogModel,
  isModelProvider,
  modelProviders,
  MODEL_THINKING_LEVELS,
  SUBSCRIPTION_PROVIDER_ID,
  type AgentModelProfiles,
  type AgentModelRole,
  type ModelThinkingLevel,
} from "@ambient-agent/engine/model/pi-subscription.ts";
import { MODEL_API_KEY_CREDENTIAL_REFERENCE } from "@ambient-agent/installation/schema.ts";

/** The `--model-<role>` flags, one per agent role. Commander camel-cases them on the way in. */
export const MODEL_ROLE_OPTIONS = AGENT_MODEL_ROLES.map((role) => `--model-${role}`);

export interface ModelSelectionOptions {
  /** `--model-provider <id>`; absent leaves the configured provider alone. */
  readonly provider?: string;
  /** `--model <id>`; the model every role uses unless a role flag overrides it. */
  readonly model?: string;
  /** `--model-<role> <id>` overrides, keyed by role. */
  readonly roleModels?: Partial<Record<AgentModelRole, string>>;
}

/** Read the `--model*` flags off a Commander options object, which camel-cases them. */
export const modelSelectionFrom = (options: Record<string, unknown>): ModelSelectionOptions => ({
  ...(options.modelProvider === undefined ? {} : { provider: String(options.modelProvider) }),
  ...(options.model === undefined ? {} : { model: String(options.model) }),
  roleModels: Object.fromEntries(
    AGENT_MODEL_ROLES.flatMap((role) => {
      const value = options[`model${role[0]!.toUpperCase()}${role.slice(1)}`];
      return value === undefined ? [] : [[role, String(value)]];
    }),
  ),
});

export interface ResolvedModelSelection {
  readonly provider: string;
  readonly credential: string;
  readonly profiles: AgentModelProfiles;
  /** True when the resolved provider needs an API key pasted and written. */
  readonly needsApiKey: boolean;
}

const CHATGPT_OAUTH_CREDENTIAL_REFERENCE = "chatgpt-oauth";

const listed = (values: readonly string[]): string => values.join(", ");

/**
 * Fold the model flags over the current config.
 *
 * Model IDs do not carry across providers, so switching provider requires naming the models
 * — there is no packaged per-provider default table to drift. Thinking levels *do* carry:
 * they are a role property, not a model property, and pi maps an unsupported level down.
 */
export const resolveModelSelection = (
  current: { readonly provider: string; readonly credential: string; readonly profiles: AgentModelProfiles },
  options: ModelSelectionOptions,
): ResolvedModelSelection => {
  const provider = options.provider ?? current.provider;
  if (!isModelProvider(provider)) {
    throw new Error(
      `${provider} is not a model provider this build ships. Choose one of: ${listed(modelProviders())}.`,
    );
  }
  const roleModels = options.roleModels ?? {};
  const switching = provider !== current.provider;
  const missing = AGENT_MODEL_ROLES.filter((role) => roleModels[role] === undefined);
  if (switching && options.model === undefined && missing.length > 0) {
    throw new Error(
      `Switching to ${provider} needs a model: model IDs do not carry across providers. Pass --model <id>, or a --model-<role> for each of ${listed(missing)}.`,
    );
  }

  const profiles = Object.fromEntries(
    AGENT_MODEL_ROLES.map((role) => {
      const id = roleModels[role] ?? (switching ? options.model! : (options.model ?? current.profiles[role].id));
      return [role, { id, thinkingLevel: current.profiles[role].thinkingLevel }];
    }),
  ) as unknown as AgentModelProfiles;

  // Catalog validation applies to API-key providers only. The subscription provider's models
  // (`gpt-5.6-luna`, `gpt-5.6-sol`) are subscription-only and deliberately absent from pi's
  // catalog, so checking them there would reject a working install.
  if (provider !== SUBSCRIPTION_PROVIDER_ID) {
    for (const role of AGENT_MODEL_ROLES) {
      const id = profiles[role].id;
      if (!isCatalogModel(provider, id)) {
        throw new Error(
          `${provider} has no model ${id} (role ${role}). Choose one of: ${listed(catalogModelIds(provider))}.`,
        );
      }
    }
  }

  const apiKeyProvider = provider !== SUBSCRIPTION_PROVIDER_ID;
  return {
    provider,
    // Untouched when the provider is untouched, so a legacy `pi-auth` reference is left for
    // its own migration to walk forward rather than being rewritten here.
    credential: switching
      ? (apiKeyProvider ? MODEL_API_KEY_CREDENTIAL_REFERENCE : CHATGPT_OAUTH_CREDENTIAL_REFERENCE)
      : current.credential,
    profiles,
    // Naming an API-key provider always re-pastes the key, the same idiom as --github-app.
    needsApiKey: apiKeyProvider && options.provider !== undefined,
  };
};

/** Stamp one reasoning level onto every role, keeping each role's model. */
export const withUniformThinkingLevel = (
  profiles: AgentModelProfiles,
  thinkingLevel: ModelThinkingLevel,
): AgentModelProfiles =>
  Object.fromEntries(
    AGENT_MODEL_ROLES.map((role) => [role, { ...profiles[role], thinkingLevel }]),
  ) as unknown as AgentModelProfiles;

/**
 * The three interactive first-run prompts, structurally a subset of the CLI's prompt object.
 * All optional: a scripted or test harness that omits them keeps the historical subscription
 * default with no prompt.
 */
export interface InteractiveModelPrompts {
  readonly modelAuthMode?: () => Promise<"subscription" | "api-key">;
  readonly selectModel?: (provider: string, modelIds: readonly string[]) => Promise<string>;
  readonly selectThinkingLevel?: (levels: readonly string[]) => Promise<string>;
}

/**
 * pi's OpenAI API-key provider. The interactive first-run API-key path targets it and offers its
 * full catalog. ponytail: OpenAI-only interactive path (the ticket's scope); every other provider
 * still routes through `--model-provider <id>`, whose flow is unchanged.
 */
const INTERACTIVE_API_KEY_PROVIDER = "openai";

/**
 * Fold the interactive first-run model choice (auth mode → model → reasoning level) into a
 * {@link ModelSelectionOptions} the flag resolver already understands, plus the single reasoning
 * level to stamp on every role. Returns `base` unchanged — no prompt fired — when the prompts are
 * unavailable or the operator keeps the subscription. The API-key branch names the provider and a
 * catalog model, so {@link resolveModelSelection} validates and builds the per-role profiles.
 */
export const promptInteractiveModelSelection = async (
  base: ModelSelectionOptions,
  prompts: InteractiveModelPrompts,
): Promise<{ readonly selection: ModelSelectionOptions; readonly thinkingLevel?: ModelThinkingLevel }> => {
  if (
    prompts.modelAuthMode === undefined ||
    prompts.selectModel === undefined ||
    prompts.selectThinkingLevel === undefined
  ) {
    return { selection: base };
  }
  if ((await prompts.modelAuthMode()) !== "api-key") return { selection: base };
  const provider = INTERACTIVE_API_KEY_PROVIDER;
  const model = await prompts.selectModel(provider, catalogModelIds(provider));
  const level = await prompts.selectThinkingLevel(MODEL_THINKING_LEVELS);
  // The select can only surface a catalog level, so this guards a misbehaving prompt, not a human.
  if (!(MODEL_THINKING_LEVELS as readonly string[]).includes(level)) {
    throw new Error(`${level} is not a reasoning level this build supports.`);
  }
  return { selection: { ...base, provider, model }, thinkingLevel: level as ModelThinkingLevel };
};
