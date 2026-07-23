import * as v from "valibot";

import { GITHUB_REPOSITORY_PATTERN } from "@ambient-agent/engine/github/repository.ts";
import {
  DEFAULT_AGENT_MODEL_PROFILES,
  isModelProvider,
  MODEL_THINKING_LEVELS,
  SUBSCRIPTION_PROVIDER_ID,
  type AgentModelProfiles,
} from "@ambient-agent/engine/model/pi-subscription.ts";

const GITHUB_CREDENTIAL_REFERENCE = "github";
const CHATGPT_OAUTH_CREDENTIAL_REFERENCE = "chatgpt-oauth";
const LEGACY_PI_AUTH_CREDENTIAL_REFERENCE = "pi-auth";
/** The one credential reference every API-key provider shares: `credentials/model-api-key.json`. */
export const MODEL_API_KEY_CREDENTIAL_REFERENCE = "api-key";

/**
 * Which credential references a provider's config may name (#250). The subscription provider
 * carries OAuth; every other provider ID is an API key, so the table is a rule, not a list —
 * adding a provider is config, not code.
 */
export const modelCredentialReferences = (provider: string): readonly string[] =>
  provider === SUBSCRIPTION_PROVIDER_ID
    ? [CHATGPT_OAUTH_CREDENTIAL_REFERENCE, LEGACY_PI_AUTH_CREDENTIAL_REFERENCE]
    : [MODEL_API_KEY_CREDENTIAL_REFERENCE];

/** One GitHub App per Specialist identity (#135). The Planner file is also the Speaker's identity. */
export const GITHUB_APP_REFERENCES = ["coder", "reviewer", "planner"] as const;
export type GitHubAppReference = (typeof GITHUB_APP_REFERENCES)[number];

const NonBlankString = v.pipe(v.string(), v.trim(), v.nonEmpty());
const NumericId = v.pipe(NonBlankString, v.regex(/^\d+$/, "Expected a numeric GitHub identifier"));
const Repository = v.pipe(
  NonBlankString,
  v.regex(GITHUB_REPOSITORY_PATTERN, "Expected a GitHub repository in owner/name form"),
);
const ManagedChat = v.pipe(
  NonBlankString,
  v.regex(/^[^@\s]+@(g\.us|s\.whatsapp\.net)$/, "Expected a WhatsApp group or direct-chat JID"),
);
const RuntimePort = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(65_535));
/**
 * The per-job agent sandbox both Specialist shells run in (#251). `local` runs the model's
 * shell on the host as the runtime uid (single-operator use, D-1); `e2b` runs it in a
 * disposable micro-VM. Default `local`, so flipping to `e2b` once an E2B key is configured is
 * a one-line change rather than a swap of a hardcoded binding. `template` is the E2B blueprint
 * to boot (absent uses the account default); it is migrated off `E2B_TEMPLATE` in #252.
 */
const RuntimeSandbox = v.strictObject({
  kind: v.picklist(["local", "e2b"]),
  template: v.optional(NonBlankString),
});
export type RuntimeSandbox = v.InferOutput<typeof RuntimeSandbox>;
/**
 * Braintrust production tracing (#252), migrated off `BRAINTRUST_TRACING`/`_PROJECT_NAME`/`_ID`.
 * `enabled` is the explicit opt-in the old env toggle carried; the API key is a secret referenced
 * by name (`credentials/braintrust.json`), never config, so it is not here. Default `enabled: false`,
 * so tracing stays off unless a deployment turns it on — every existing config parses unchanged.
 */
const RuntimeTracing = v.strictObject({
  enabled: v.boolean(),
  project: v.optional(
    v.strictObject({
      name: v.optional(NonBlankString),
      id: v.optional(NonBlankString),
    }),
  ),
});
export type RuntimeTracing = v.InferOutput<typeof RuntimeTracing>;
const CanaryGroup = v.pipe(ManagedChat, v.regex(/@g\.us$/, "Expected a WhatsApp group JID"));
const ModelId = v.pipe(
  NonBlankString,
  v.regex(/^[^/\s]+$/, "Expected an OpenAI model ID without a provider prefix"),
);
/**
 * Validated against pi's live provider catalog rather than a hand-kept list: a build that
 * ships a new provider accepts it with no schema change, and a typo is refused here.
 */
const ModelProviderId = v.pipe(
  NonBlankString,
  v.check(isModelProvider, "Expected a model provider ID this build of pi ships"),
);
const AgentModelProfileSchema = v.strictObject({
  id: ModelId,
  thinkingLevel: v.picklist(MODEL_THINKING_LEVELS),
});
const AgentModelProfilesSchema = v.strictObject({
  // Existing installations predate the Brain role; parsing stamps its default profile.
  brain: v.optional(AgentModelProfileSchema, DEFAULT_AGENT_MODEL_PROFILES.brain),
  speaker: AgentModelProfileSchema,
  scribe: AgentModelProfileSchema,
  planner: AgentModelProfileSchema,
  coder: AgentModelProfileSchema,
  verifier: AgentModelProfileSchema,
});

export const ManagedConfigSchema = v.pipe(
  v.strictObject({
    schemaVersion: v.literal(1),
    managedChats: v.pipe(v.array(ManagedChat), v.nonEmpty()),
    model: v.strictObject({
      // Optional with the historical default, so every existing config parses unchanged.
      provider: v.optional(ModelProviderId, SUBSCRIPTION_PROVIDER_ID),
      credential: v.union([
        v.literal(CHATGPT_OAUTH_CREDENTIAL_REFERENCE),
        v.literal(LEGACY_PI_AUTH_CREDENTIAL_REFERENCE),
        v.literal(MODEL_API_KEY_CREDENTIAL_REFERENCE),
      ]),
      profiles: v.optional(AgentModelProfilesSchema, DEFAULT_AGENT_MODEL_PROFILES),
    }),
    runtime: v.optional(v.strictObject({
      port: RuntimePort,
      // Optional with the local default (#251), so every existing `runtime` block parses unchanged.
      sandbox: v.optional(RuntimeSandbox, { kind: "local" }),
      // Optional with tracing off (#252), so every existing `runtime` block parses unchanged.
      tracing: v.optional(RuntimeTracing, { enabled: false }),
    }), { port: 3000, sandbox: { kind: "local" }, tracing: { enabled: false } }),
    smoke: v.optional(v.strictObject({ canaryChat: CanaryGroup })),
    github: v.strictObject({
      kind: v.literal("github-app"),
      credential: v.literal(GITHUB_CREDENTIAL_REFERENCE),
      defaultRepository: Repository,
      allowedRepositories: v.pipe(v.array(Repository), v.nonEmpty()),
      reviewRepositories: v.optional(v.array(Repository), []),
      // Which repository the Brain files a managed chat's issues into (#317). Optional and empty by
      // default, so every existing config parses and unmapped chats fall back to `defaultRepository`.
      surfaceRepositories: v.optional(
        v.array(v.strictObject({ chat: ManagedChat, repository: Repository })),
        [],
      ),
    }),
  }),
  // The mismatch gate. `writeManagedConfiguration` re-parses through this schema before it
  // touches disk, so a provider paired with the wrong credential file is refused at
  // config-write time and rolled back — never discovered at first inference.
  v.check(
    (config) => modelCredentialReferences(config.model.provider).includes(config.model.credential),
    "The model credential reference must match the configured model provider",
  ),
  v.check(
    (config) =>
      config.github.allowedRepositories.some(
        (repository) => repository.toLowerCase() === config.github.defaultRepository.toLowerCase(),
      ),
    "The default GitHub repository must be included in allowedRepositories",
  ),
  v.check(
    (config) => config.github.reviewRepositories.every((repository) =>
      config.github.allowedRepositories.some((allowed) => allowed.toLowerCase() === repository.toLowerCase()),
    ),
    "Every review repository must be included in allowedRepositories",
  ),
  v.check(
    (config) => config.github.surfaceRepositories.every(({ repository }) =>
      config.github.allowedRepositories.some((allowed) => allowed.toLowerCase() === repository.toLowerCase()),
    ),
    "Every surface repository must be included in allowedRepositories",
  ),
  v.check(
    (config) => config.github.surfaceRepositories.every(({ chat }) =>
      config.managedChats.some((managed) => managed.toLowerCase() === chat.toLowerCase()),
    ),
    "Every surface repository chat must be included in managedChats",
  ),
  v.check(
    (config) =>
      config.smoke === undefined ||
      config.managedChats.some((chat) => chat.toLowerCase() === config.smoke!.canaryChat.toLowerCase()),
    "The smoke canary group must be included in managedChats",
  ),
);

export type ManagedConfig = v.InferOutput<typeof ManagedConfigSchema>;

/**
 * One file per GitHub App, `credentials/github-{coder,reviewer,planner}.json`. The
 * `personal-token` kind is retired outright (#135): a lingering PAT file fails this
 * schema and surfaces as the existing `reauthentication-required` component state.
 * `appId`/`installationId` are pasted as numeric strings; the PEM is an escaped
 * JSON string. Only the Planner file carries the runtime `webhookSecret`.
 */
export const GitHubAppCredentialSchema = v.strictObject({
  schemaVersion: v.literal(1),
  kind: v.literal("github-app"),
  appId: NumericId,
  installationId: NumericId,
  privateKey: NonBlankString,
  webhookSecret: v.optional(NonBlankString),
});

export type GitHubAppCredential = v.InferOutput<typeof GitHubAppCredentialSchema>;

/** A pasted App triple, before it is written to disk as a {@link GitHubAppCredential}. */
export interface GitHubAppTriple {
  readonly appId: string;
  readonly installationId: string;
  readonly privateKey: string;
}

export type GitHubAppTriples = Readonly<Record<GitHubAppReference, GitHubAppTriple>>;

export const ChatGptOAuthCredentialSchema = v.looseObject({
  type: v.literal("oauth"),
  access: NonBlankString,
  refresh: NonBlankString,
  expires: v.number(),
});

/**
 * `credentials/model-api-key.json`, mode 0600 — one file, whatever the provider. Config
 * references it by name (`model.credential: "api-key"`) and never by value. The file names
 * the provider it was issued for, so a config that points at a different provider than the
 * key was pasted for is caught at start rather than at first inference.
 */
export const ModelApiKeyCredentialSchema = v.strictObject({
  schemaVersion: v.literal(1),
  kind: v.literal("api-key"),
  provider: ModelProviderId,
  apiKey: NonBlankString,
});

export type ModelApiKeyCredential = v.InferOutput<typeof ModelApiKeyCredentialSchema>;

/**
 * `credentials/e2b.json`, mode 0600 (#252) — the E2B API key migrated off `E2B_API_KEY`. Config
 * references it by the `runtime.sandbox.kind: "e2b"` selection, never by value; the sandbox
 * selector reads this file rather than the ambient environment.
 */
export const E2BCredentialSchema = v.strictObject({
  schemaVersion: v.literal(1),
  kind: v.literal("e2b"),
  apiKey: NonBlankString,
});

export type E2BCredential = v.InferOutput<typeof E2BCredentialSchema>;

export const e2bCredentialFrom = (apiKey: string): E2BCredential =>
  v.parse(E2BCredentialSchema, { schemaVersion: 1, kind: "e2b", apiKey });

/**
 * `credentials/braintrust.json`, mode 0600 (#252) — the Braintrust API key migrated off
 * `BRAINTRUST_API_KEY`. Config turns tracing on (`runtime.tracing.enabled`) and names the project;
 * the key lives here, referenced by name, never echoed or logged.
 */
export const BraintrustCredentialSchema = v.strictObject({
  schemaVersion: v.literal(1),
  kind: v.literal("braintrust"),
  apiKey: NonBlankString,
});

export type BraintrustCredential = v.InferOutput<typeof BraintrustCredentialSchema>;

export const braintrustCredentialFrom = (apiKey: string): BraintrustCredential =>
  v.parse(BraintrustCredentialSchema, { schemaVersion: 1, kind: "braintrust", apiKey });

export const modelApiKeyCredentialFrom = (provider: string, apiKey: string): ModelApiKeyCredential =>
  v.parse(ModelApiKeyCredentialSchema, { schemaVersion: 1, kind: "api-key", provider, apiKey });

/** The model half of a config, chosen at first run. Defaults to the subscription provider. */
export interface ManagedModelChoice {
  readonly provider: string;
  readonly profiles: AgentModelProfiles;
}

export const subscriptionModelChoice: ManagedModelChoice = {
  provider: SUBSCRIPTION_PROVIDER_ID,
  profiles: DEFAULT_AGENT_MODEL_PROFILES,
};

export const createManagedConfig = (
  managedChats: readonly string[],
  defaultRepository: string,
  model: ManagedModelChoice = subscriptionModelChoice,
): ManagedConfig => ({
  schemaVersion: 1,
  managedChats: [...managedChats],
  model: {
    provider: model.provider,
    // Decision 5: API key or subscription, neither required. The reference follows the
    // provider so first-run setup cannot mint a config its own credential does not match.
    credential:
      model.provider === SUBSCRIPTION_PROVIDER_ID
        ? CHATGPT_OAUTH_CREDENTIAL_REFERENCE
        : MODEL_API_KEY_CREDENTIAL_REFERENCE,
    profiles: model.profiles,
  },
  runtime: { port: 3000, sandbox: { kind: "local" }, tracing: { enabled: false } },
  github: {
    kind: "github-app",
    credential: GITHUB_CREDENTIAL_REFERENCE,
    defaultRepository,
    allowedRepositories: [defaultRepository],
    // Safe packaged default: automatic review stays off until a deployment binds an
    // isolated Reviewer sandbox and explicitly opts repositories in.
    reviewRepositories: [],
    // No per-surface routing by default; unmapped chats file into defaultRepository (#317).
    surfaceRepositories: [],
  },
});
