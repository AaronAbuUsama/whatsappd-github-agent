import * as v from "valibot";

import { GITHUB_REPOSITORY_PATTERN } from "@ambient-agent/engine/github/repository.ts";
import {
  DEFAULT_AGENT_MODEL_PROFILES,
  MODEL_THINKING_LEVELS,
} from "@ambient-agent/engine/model/pi-subscription.ts";

const GITHUB_CREDENTIAL_REFERENCE = "github";
const CHATGPT_OAUTH_CREDENTIAL_REFERENCE = "chatgpt-oauth";
const LEGACY_PI_AUTH_CREDENTIAL_REFERENCE = "pi-auth";

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
const ContainerImage = v.pipe(NonBlankString, v.regex(/^[^\s]+$/u, "Expected one Docker image reference"));
const CanaryGroup = v.pipe(ManagedChat, v.regex(/@g\.us$/, "Expected a WhatsApp group JID"));
const ModelId = v.pipe(
  NonBlankString,
  v.regex(/^[^/\s]+$/, "Expected an OpenAI model ID without a provider prefix"),
);
const AgentModelProfileSchema = v.strictObject({
  id: ModelId,
  thinkingLevel: v.picklist(MODEL_THINKING_LEVELS),
});
const AgentModelProfilesSchema = v.strictObject({
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
      provider: v.literal("openai-codex"),
      credential: v.union([
        v.literal(CHATGPT_OAUTH_CREDENTIAL_REFERENCE),
        v.literal(LEGACY_PI_AUTH_CREDENTIAL_REFERENCE),
      ]),
      profiles: v.optional(AgentModelProfilesSchema, DEFAULT_AGENT_MODEL_PROFILES),
    }),
    runtime: v.optional(v.strictObject({
      port: RuntimePort,
      reviewerSandbox: v.optional(v.strictObject({ kind: v.literal("docker"), image: ContainerImage })),
    }), { port: 3000 }),
    smoke: v.optional(v.strictObject({ canaryChat: CanaryGroup })),
    github: v.strictObject({
      kind: v.literal("github-app"),
      credential: v.literal(GITHUB_CREDENTIAL_REFERENCE),
      defaultRepository: Repository,
      allowedRepositories: v.pipe(v.array(Repository), v.nonEmpty()),
      reviewRepositories: v.optional(v.array(Repository), []),
    }),
  }),
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

export const createManagedConfig = (managedChats: readonly string[], defaultRepository: string): ManagedConfig => ({
  schemaVersion: 1,
  managedChats: [...managedChats],
  model: {
    provider: "openai-codex",
    credential: CHATGPT_OAUTH_CREDENTIAL_REFERENCE,
    profiles: DEFAULT_AGENT_MODEL_PROFILES,
  },
  runtime: { port: 3000 },
  github: {
    kind: "github-app",
    credential: GITHUB_CREDENTIAL_REFERENCE,
    defaultRepository,
    allowedRepositories: [defaultRepository],
    // Safe packaged default: automatic review stays off until a deployment binds an
    // isolated Reviewer sandbox and explicitly opts repositories in.
    reviewRepositories: [],
  },
});
