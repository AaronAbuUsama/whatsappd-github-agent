import {
  AGENT_MODEL_ROLES,
  catalogModelIds,
  isCatalogModel,
  isModelProvider,
  modelProviders,
  SUBSCRIPTION_PROVIDER_ID,
  type AgentModelProfiles,
  type AgentModelRole,
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
