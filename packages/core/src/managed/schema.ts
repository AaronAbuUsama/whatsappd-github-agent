import * as v from "valibot";

import { GITHUB_REPOSITORY_PATTERN } from "../github/repository.js";

const GITHUB_CREDENTIAL_REFERENCE = "github";
const CHATGPT_OAUTH_CREDENTIAL_REFERENCE = "chatgpt-oauth";
const LEGACY_PI_AUTH_CREDENTIAL_REFERENCE = "pi-auth";

const NonBlankString = v.pipe(v.string(), v.trim(), v.nonEmpty());
const Repository = v.pipe(
  NonBlankString,
  v.regex(GITHUB_REPOSITORY_PATTERN, "Expected a GitHub repository in owner/name form"),
);
const ManagedChat = v.pipe(
  NonBlankString,
  v.regex(/^[^@\s]+@(g\.us|s\.whatsapp\.net)$/, "Expected a WhatsApp group or direct-chat JID"),
);
const RuntimePort = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(65_535));
const CanaryGroup = v.pipe(ManagedChat, v.regex(/@g\.us$/, "Expected a WhatsApp group JID"));

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
    }),
    runtime: v.optional(v.strictObject({ port: RuntimePort }), { port: 3000 }),
    smoke: v.optional(v.strictObject({ canaryChat: CanaryGroup })),
    github: v.strictObject({
      kind: v.literal("personal-token"),
      credential: v.literal(GITHUB_CREDENTIAL_REFERENCE),
      defaultRepository: Repository,
      allowedRepositories: v.pipe(v.array(Repository), v.nonEmpty()),
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
    (config) =>
      config.smoke === undefined ||
      config.managedChats.some((chat) => chat.toLowerCase() === config.smoke!.canaryChat.toLowerCase()),
    "The smoke canary group must be included in managedChats",
  ),
);

export type ManagedConfig = v.InferOutput<typeof ManagedConfigSchema>;

export const GitHubCredentialSchema = v.strictObject({
  schemaVersion: v.literal(1),
  kind: v.literal("personal-token"),
  token: NonBlankString,
  webhookSecret: v.optional(NonBlankString),
});

export type GitHubCredential = v.InferOutput<typeof GitHubCredentialSchema>;

export const ChatGptOAuthCredentialSchema = v.looseObject({
  type: v.literal("oauth"),
  access: NonBlankString,
  refresh: NonBlankString,
  expires: v.number(),
});

export const createManagedConfig = (managedChats: readonly string[], defaultRepository: string): ManagedConfig => ({
  schemaVersion: 1,
  managedChats: [...managedChats],
  model: { provider: "openai-codex", credential: CHATGPT_OAUTH_CREDENTIAL_REFERENCE },
  runtime: { port: 3000 },
  github: {
    kind: "personal-token",
    credential: GITHUB_CREDENTIAL_REFERENCE,
    defaultRepository,
    allowedRepositories: [defaultRepository],
  },
});
