import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseEnv } from "node:util";
import * as v from "valibot";

import type { ManagedPaths } from "./paths.js";
import { GitHubCredentialSchema, ManagedConfigSchema } from "./schema.js";

type RuntimeEnvironment = Record<string, string | undefined>;

const isMissingFile = (cause: unknown): boolean =>
  typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT";

const readJson = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, "utf8"));

const readOptionalDotEnv = async (root: string): Promise<RuntimeEnvironment> => {
  try {
    return parseEnv(await readFile(join(root, ".env"), "utf8"));
  } catch (cause) {
    if (isMissingFile(cause)) return {};
    throw cause;
  }
};

const applyDefaults = (environment: RuntimeEnvironment, defaults: Readonly<RuntimeEnvironment>): void => {
  for (const [key, value] of Object.entries(defaults)) {
    if (environment[key] === undefined && value !== undefined) environment[key] = value;
  }
};

export const loadManagedRuntimeEnvironment = async (
  paths: ManagedPaths,
  environment: RuntimeEnvironment = process.env,
): Promise<void> => {
  applyDefaults(environment, await readOptionalDotEnv(paths.root));

  const config = v.parse(ManagedConfigSchema, await readJson(paths.config));
  const github = v.parse(GitHubCredentialSchema, await readJson(paths.githubCredential));
  const primaryChat = config.managedChats[0]!;

  applyDefaults(environment, {
    AMBIENCE_PI_AUTH_PATH: paths.piAuthCredential,
    AMBIENCE_WHATSAPP: "1",
    GITHUB_ALLOWED_REPOS: config.github.allowedRepositories.join(","),
    GITHUB_INGRESS_DB_PATH: paths.applicationDatabase,
    GITHUB_REPO: config.github.defaultRepository,
    GITHUB_TOKEN: github.token,
    WHATSAPP_GROUP_ID: primaryChat,
    WHATSAPP_GROUP_IDS: config.managedChats.join(","),
    WHATSAPP_HISTORY_DB: paths.applicationDatabase,
    WHATSAPP_STORE_DIR: paths.whatsapp,
  });
};
