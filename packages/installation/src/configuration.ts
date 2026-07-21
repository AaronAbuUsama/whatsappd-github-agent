import { constants } from "node:fs";
import { randomBytes, randomUUID } from "node:crypto";
import { chmod, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import * as v from "valibot";

import { SUBSCRIPTION_PROVIDER_ID } from "@ambient-agent/engine/model/pi-subscription.ts";
import {
  BraintrustCredentialSchema,
  E2BCredentialSchema,
  GitHubAppCredentialSchema,
  ManagedConfigSchema,
  ModelApiKeyCredentialSchema,
  type BraintrustCredential,
  type E2BCredential,
  type GitHubAppCredential,
  type ManagedConfig,
  type ModelApiKeyCredential,
} from "./schema.ts";

const FILE_MODE = 0o600;
const MAX_CONFIG_BYTES = 1024 * 1024;

const readPrivateJson = async <TSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>>(
  path: string,
  schema: TSchema,
): Promise<v.InferOutput<TSchema>> => {
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  const handle = await open(path, constants.O_RDONLY | noFollow);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_CONFIG_BYTES) {
      throw new Error("The managed configuration is not a supported private JSON file.");
    }
    const source = await handle.readFile("utf8");
    const result = v.safeParse(schema, JSON.parse(source));
    if (!result.success) throw new Error("The managed private JSON file is malformed.");
    return result.output;
  } finally {
    await handle.close();
  }
};

export const readManagedConfig = async (path: string): Promise<ManagedConfig> =>
  await readPrivateJson(path, ManagedConfigSchema);

export const readManagedGitHubAppCredential = async (path: string): Promise<GitHubAppCredential> =>
  await readPrivateJson(path, GitHubAppCredentialSchema);

/**
 * Read a Specialist's (Coder/Reviewer) GitHub App credential, or throw a clear, actionable error
 * (#247, #251). A missing or mispasted App credential must fail the runtime loudly at start rather
 * than silently mounting a dead capability — the configured-but-inert failure the one-box plan bans
 * for the Speaker, and which used to boot green with a dead Coder.
 */
export const readProvisionedGitHubAppCredential = async (
  path: string,
  role: "coder" | "reviewer",
): Promise<GitHubAppCredential> => {
  try {
    return await readManagedGitHubAppCredential(path);
  } catch (cause) {
    throw new Error(
      `The ${role} GitHub App credential at ${path} is missing or malformed; the ${role} cannot start. Run ambient-agent config --github-app ${role} and paste a fresh triple.`,
      { cause },
    );
  }
};

/**
 * The model API key. A missing or damaged file throws: the runtime must fail loudly at start
 * rather than boot green with no inference (#250).
 */
export const readManagedModelApiKey = async (path: string): Promise<ModelApiKeyCredential> =>
  await readPrivateJson(path, ModelApiKeyCredentialSchema);

/**
 * The E2B API key from `credentials/e2b.json` (#252). A missing or damaged file throws: an `e2b`
 * sandbox with no key must fail the runtime loudly at start rather than boot with a dead Coder.
 */
export const readManagedE2BApiKey = async (path: string): Promise<E2BCredential> =>
  await readPrivateJson(path, E2BCredentialSchema);

/**
 * The Braintrust API key from `credentials/braintrust.json` (#252). A missing or damaged file
 * throws: tracing that is configured on but has no key must fail loudly rather than boot silent.
 */
export const readManagedBraintrustApiKey = async (path: string): Promise<BraintrustCredential> =>
  await readPrivateJson(path, BraintrustCredentialSchema);

export const atomicWriteManagedConfig = async (path: string, value: unknown): Promise<void> => {
  const directory = dirname(path);
  const temporary = `${path}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", FILE_MODE);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    await chmod(path, FILE_MODE);
    const directoryHandle = await open(directory, constants.O_RDONLY);
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } finally {
    await handle?.close();
    await rm(temporary, { force: true });
  }
};

/** Each referenced file is replaced atomically; both old files remain usable if validation fails. */
export const writeManagedConfiguration = async (
  configPath: string,
  githubCredentialPath: string,
  config: unknown,
  githubCredential: unknown,
  write: (path: string, value: unknown) => Promise<void> = atomicWriteManagedConfig,
): Promise<void> => {
  const validatedConfig = v.parse(ManagedConfigSchema, config);
  const validatedCredential = v.parse(GitHubAppCredentialSchema, githubCredential);
  const previousConfig = await readManagedConfig(configPath);
  const previousCredential = await readManagedGitHubAppCredential(githubCredentialPath);
  try {
    await write(githubCredentialPath, validatedCredential);
    await write(configPath, validatedConfig);
  } catch (cause) {
    const rollback = await Promise.allSettled([
      write(configPath, previousConfig),
      write(githubCredentialPath, previousCredential),
    ]);
    const rollbackCauses = rollback.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
    if (rollbackCauses.length > 0) {
      throw new AggregateError(
        [cause, ...rollbackCauses],
        "Managed configuration commit failed and the previous installation could not be fully restored.",
      );
    }
    throw cause;
  }
};

/** One-time app-owned migration. Atomic replacement leaves the previous credential usable on failure. */
export const ensureManagedGitHubWebhookSecret = async (
  path: string,
  write: (path: string, value: unknown) => Promise<void> = atomicWriteManagedConfig,
): Promise<void> => {
  const credential = await readManagedGitHubAppCredential(path);
  if (credential.webhookSecret !== undefined) return;
  await write(path, {
    ...credential,
    webhookSecret: randomBytes(32).toString("base64url"),
  });
};

export const migrateManagedChatGptCredentialReference = async (path: string): Promise<void> => {
  let config: Awaited<ReturnType<typeof readManagedConfig>>;
  try {
    config = await readManagedConfig(path);
  } catch (cause) {
    if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT") return;
    throw cause;
  }
  // Only the legacy `pi-auth` reference is walked forward. An API-key install owns a
  // different credential file, and rewriting it to a ChatGPT one would break the pairing
  // check it is about to be re-validated against.
  if (config.model.provider !== SUBSCRIPTION_PROVIDER_ID || config.model.credential === "chatgpt-oauth") return;
  await atomicWriteManagedConfig(path, {
    ...config,
    model: { ...config.model, credential: "chatgpt-oauth" },
  });
};
