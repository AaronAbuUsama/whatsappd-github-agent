import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import * as v from "valibot";

import { managedPaths, type ManagedPathEnvironment, type ManagedPaths } from "./paths.js";
import {
  createManagedConfig,
  ChatGptOAuthCredentialSchema,
  GitHubCredentialSchema,
  ManagedConfigSchema,
  PiAuthSchema,
  type GitHubCredential,
  type ManagedConfig,
} from "./schema.js";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_MANAGED_JSON_BYTES = 1024 * 1024;
const CONFIG_ISSUE_PATHS = new Set([
  "<root>",
  "schemaVersion",
  "managedChats",
  "managedChats.[]",
  "model",
  "model.provider",
  "model.credential",
  "github",
  "github.kind",
  "github.credential",
  "github.defaultRepository",
  "github.allowedRepositories",
  "github.allowedRepositories.[]",
]);
const GITHUB_CREDENTIAL_ISSUE_PATHS = new Set(["<root>", "schemaVersion", "kind", "token"]);
const CHATGPT_OAUTH_ISSUE_PATHS = new Set(["<root>", "type", "access", "refresh", "expires"]);
const LEGACY_PI_AUTH_ISSUE_PATHS = new Set([
  "<root>",
  "openai-codex",
  "openai-codex.type",
  "openai-codex.access",
  "openai-codex.refresh",
  "openai-codex.expires",
]);

export type InstallationState = "unconfigured" | "configured" | "damaged";

export interface InstallationDiagnostic {
  readonly code: string;
  readonly path: string;
  readonly message: string;
  readonly remediation: string;
}

export interface InstallationInspection {
  readonly state: InstallationState;
  readonly dataDirectory: string;
  readonly diagnostics: readonly InstallationDiagnostic[];
}

export interface InstallManagedDataInput extends ManagedPathEnvironment {
  readonly managedChats: readonly string[];
  readonly defaultRepository: string;
  readonly githubToken: string;
  readonly authenticateChatGpt: (paths: ManagedPaths) => Promise<void>;
}

export interface InstallManagedDataResult {
  readonly created: boolean;
  readonly inspection: InstallationInspection;
}

const diagnostic = (code: string, path: string, message: string, remediation: string): InstallationDiagnostic => ({
  code,
  path,
  message,
  remediation,
});

const errorCode = (cause: unknown): string | undefined =>
  typeof cause === "object" && cause !== null && "code" in cause ? String(cause.code) : undefined;

const exists = async (path: string): Promise<boolean> => {
  try {
    await lstat(path);
    return true;
  } catch (cause) {
    if (errorCode(cause) === "ENOENT") return false;
    throw cause;
  }
};

const modeOf = (mode: number): number => mode & 0o777;

const boundedReadError = (code: string, message: string): Error & { readonly code: string } =>
  Object.assign(new Error(message), { code });

const readBoundedUtf8 = async (handle: Awaited<ReturnType<typeof open>>): Promise<string> => {
  const before = await handle.stat();
  if (before.size > MAX_MANAGED_JSON_BYTES) {
    throw boundedReadError("EMANAGEDJSONTOOLARGE", "Managed JSON exceeds the 1 MiB diagnostic limit.");
  }

  const bytes = Buffer.allocUnsafe(MAX_MANAGED_JSON_BYTES + 1);
  let offset = 0;
  while (offset < bytes.length) {
    const result = await handle.read(bytes, offset, bytes.length - offset, null);
    if (result.bytesRead === 0) break;
    offset += result.bytesRead;
  }
  if (offset > MAX_MANAGED_JSON_BYTES) {
    throw boundedReadError("EMANAGEDJSONTOOLARGE", "Managed JSON exceeds the 1 MiB diagnostic limit.");
  }

  const after = await handle.stat();
  if (after.size !== before.size || after.size !== offset || after.mtimeMs !== before.mtimeMs) {
    throw boundedReadError("EMANAGEDJSONCHANGED", "Managed JSON changed while it was being diagnosed.");
  }
  return bytes.subarray(0, offset).toString("utf8");
};

const inspectDirectory = async (
  path: string,
  label: string,
  enforcePermissions: boolean,
): Promise<readonly InstallationDiagnostic[]> => {
  try {
    const stat = await lstat(path);
    if (!stat.isDirectory()) {
      return [
        diagnostic(
          "path.not-directory",
          path,
          `${label} is not a directory.`,
          `Move it aside and run ambient-agent init again.`,
        ),
      ];
    }
    if (enforcePermissions && modeOf(stat.mode) !== DIRECTORY_MODE) {
      return [
        diagnostic(
          "permissions.directory",
          path,
          `${label} must have mode 0700.`,
          "Restrict this directory to owner-only access (mode 0700), then run ambient-agent doctor.",
        ),
      ];
    }
    return [];
  } catch (cause) {
    if (errorCode(cause) !== "ENOENT") {
      return [
        diagnostic(
          "filesystem.unreadable",
          path,
          `${label} could not be inspected (${errorCode(cause) ?? "unknown error"}).`,
          `Check ownership and filesystem health, then run ambient-agent doctor.`,
        ),
      ];
    }
    return [
      diagnostic(
        "path.missing-directory",
        path,
        `${label} is missing.`,
        `Restore it or move the managed data directory aside and run ambient-agent init.`,
      ),
    ];
  }
};

const inspectFile = async (
  path: string,
  label: string,
  enforcePermissions: boolean,
): Promise<readonly InstallationDiagnostic[]> => {
  try {
    const stat = await lstat(path);
    if (!stat.isFile()) {
      return [
        diagnostic(
          "path.not-file",
          path,
          `${label} is not a regular file.`,
          `Replace it with a regular file and run ambient-agent doctor.`,
        ),
      ];
    }
    if (enforcePermissions && modeOf(stat.mode) !== FILE_MODE) {
      return [
        diagnostic(
          "permissions.file",
          path,
          `${label} must have mode 0600.`,
          "Restrict this file to owner read/write access (mode 0600), then run ambient-agent doctor.",
        ),
      ];
    }
    return [];
  } catch (cause) {
    if (errorCode(cause) !== "ENOENT") {
      return [
        diagnostic(
          "filesystem.unreadable",
          path,
          `${label} could not be inspected (${errorCode(cause) ?? "unknown error"}).`,
          `Check ownership and filesystem health, then run ambient-agent doctor.`,
        ),
      ];
    }
    return [
      diagnostic(
        "path.missing-file",
        path,
        `${label} is missing.`,
        `Restore it or move the managed data directory aside and run ambient-agent init.`,
      ),
    ];
  }
};

interface JsonInspection {
  readonly diagnostics: readonly InstallationDiagnostic[];
  readonly value?: unknown;
}

const issuePaths = (issues: readonly v.BaseIssue<unknown>[], allowedPaths: ReadonlySet<string>): string => {
  const paths = issues.map((issue) => {
    const path =
      issue.path?.map((item) => (typeof item.key === "number" ? "[]" : String(item.key))).join(".") || "<root>";
    return allowedPaths.has(path) ? path : "<unknown field>";
  });
  return [...new Set(paths)].join(", ");
};

const inspectJson = async <TSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>>(
  path: string,
  label: string,
  schema: TSchema,
  allowedIssuePaths: ReadonlySet<string>,
): Promise<JsonInspection> => {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let parsed: unknown;
  try {
    const before = await lstat(path);
    if (!before.isFile()) return { diagnostics: [] };
    const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
    const nonBlocking = "O_NONBLOCK" in constants ? constants.O_NONBLOCK : 0;
    handle = await open(path, constants.O_RDONLY | noFollow | nonBlocking);
    if (!(await handle.stat()).isFile()) return { diagnostics: [] };
    parsed = JSON.parse(await readBoundedUtf8(handle));
  } catch (cause) {
    if (errorCode(cause) === "ENOENT") return { diagnostics: [] };
    const code = errorCode(cause);
    if (code === "EMANAGEDJSONTOOLARGE") {
      return {
        diagnostics: [
          diagnostic(
            "file.too-large",
            path,
            `${label} exceeds the 1 MiB diagnostic limit.`,
            "Replace it with the expected small private JSON file, then run ambient-agent doctor.",
          ),
        ],
      };
    }
    if (code === "EMANAGEDJSONCHANGED") {
      return {
        diagnostics: [
          diagnostic(
            "file.changed-during-read",
            path,
            `${label} changed while it was being diagnosed.`,
            "Stop the process changing this file, then run ambient-agent doctor again.",
          ),
        ],
      };
    }
    if (cause instanceof SyntaxError) {
      return {
        diagnostics: [
          diagnostic(
            "json.invalid",
            path,
            `${label} is not valid JSON.`,
            "Repair or replace this file, then run ambient-agent doctor.",
          ),
        ],
      };
    }
    return {
      diagnostics: [
        diagnostic(
          "filesystem.unreadable",
          path,
          `${label} could not be read safely (${code ?? "unknown error"}).`,
          `Replace it with a private regular file, then run ambient-agent doctor.`,
        ),
      ],
    };
  } finally {
    await handle?.close();
  }
  const result = v.safeParse(schema, parsed);
  return result.success
    ? { diagnostics: [], value: parsed }
    : {
        diagnostics: [
          diagnostic(
            "schema.invalid",
            path,
            `${label} has invalid fields: ${issuePaths(result.issues, allowedIssuePaths)}.`,
            "Repair the named fields in this file, then run ambient-agent doctor.",
          ),
        ],
        value: parsed,
      };
};

const inspectConfigReferences = (path: string, value: unknown): readonly InstallationDiagnostic[] => {
  if (typeof value !== "object" || value === null) return [];
  const config = value as Record<string, unknown>;
  const model =
    typeof config.model === "object" && config.model !== null ? (config.model as Record<string, unknown>) : undefined;
  const github =
    typeof config.github === "object" && config.github !== null
      ? (config.github as Record<string, unknown>)
      : undefined;
  const issues: InstallationDiagnostic[] = [];
  if (model?.credential !== "chatgpt-oauth" && model?.credential !== "pi-auth") {
    issues.push(
      diagnostic(
        "credential.reference",
        path,
        "The model credential reference must be chatgpt-oauth.",
        "Set model.credential to chatgpt-oauth and run ambient-agent doctor.",
      ),
    );
  }
  if (github?.credential !== "github") {
    issues.push(
      diagnostic(
        "credential.reference",
        path,
        "The GitHub credential reference must be github.",
        "Set github.credential to github and run ambient-agent doctor.",
      ),
    );
  }
  return issues;
};

const setupLockPath = (root: string): string => join(dirname(root), `.${basename(root)}.setup.lock`);

const inspectSetupLock = async (root: string): Promise<readonly InstallationDiagnostic[]> => {
  const lockPath = setupLockPath(root);
  try {
    if (!(await exists(lockPath))) return [];
  } catch (cause) {
    return [
      diagnostic(
        "filesystem.unreadable",
        lockPath,
        `Setup lock could not be inspected (${errorCode(cause) ?? "unknown error"}).`,
        "Check ownership and filesystem health, then run ambient-agent doctor.",
      ),
    ];
  }
  return [
    diagnostic(
      "setup.locked",
      lockPath,
      "Another setup is in progress or an earlier setup was interrupted.",
      "Wait for setup to finish. If it is not running, remove this lock and run ambient-agent init again.",
    ),
  ];
};

interface AcquiredSetupLock {
  readonly path: string;
  readonly stagingRoot: string;
}

const setupStagingPath = (root: string, token: string): string =>
  join(dirname(root), `.${basename(root)}.setup-${token}`);

const acquireSetupLock = async (root: string): Promise<AcquiredSetupLock> => {
  const lockPath = setupLockPath(root);
  const token = randomUUID();
  const stagingRoot = setupStagingPath(root, token);
  try {
    await mkdir(lockPath, { mode: DIRECTORY_MODE });
    await chmod(lockPath, DIRECTORY_MODE);
    return { path: lockPath, stagingRoot };
  } catch (cause) {
    if (errorCode(cause) === "EEXIST") {
      throw new Error(`Setup is already in progress for ${root}; wait for it to finish or clear the lock after confirming it stopped.`);
    }
    throw cause;
  }
};

const releaseSetupLock = async (lock: AcquiredSetupLock): Promise<void> => {
  await rm(lock.path, { recursive: true, force: true });
};

export const inspectManagedData = async (
  options: ManagedPathEnvironment = {},
  inspectionOptions: { readonly ignoreSetupLock?: boolean } = {},
): Promise<InstallationInspection> => {
  const paths = managedPaths(options);
  const platform = options.platform ?? process.platform;
  const lockDiagnostics = inspectionOptions.ignoreSetupLock ? [] : await inspectSetupLock(paths.root);
  let rootExists: boolean;
  try {
    rootExists = await exists(paths.root);
  } catch (cause) {
    return {
      state: "damaged",
      dataDirectory: paths.root,
      diagnostics: [
        diagnostic(
          "filesystem.unreadable",
          paths.root,
          `Managed data path could not be inspected (${errorCode(cause) ?? "unknown error"}).`,
          "Check ownership and filesystem health, then run ambient-agent doctor.",
        ),
        ...lockDiagnostics,
      ],
    };
  }
  if (platform === "win32") {
    return {
      state: rootExists ? "damaged" : "unconfigured",
      dataDirectory: paths.root,
      diagnostics: [
        diagnostic(
          "platform.unsupported",
          paths.root,
          "Secure managed credential ACLs are not implemented on Windows.",
          "Use Ambient Agent on macOS or Linux; Windows setup fails closed.",
        ),
        ...lockDiagnostics,
      ],
    };
  }
  if (!rootExists) {
    return {
      state: "unconfigured",
      dataDirectory: paths.root,
      diagnostics: [
        diagnostic("installation.missing", paths.root, "Ambient Agent is not configured.", "Run ambient-agent init."),
        ...lockDiagnostics,
      ],
    };
  }

  const rootDiagnostics = await inspectDirectory(paths.root, "Managed data directory", true);
  if (rootDiagnostics.length > 0) {
    return {
      state: "damaged",
      dataDirectory: paths.root,
      diagnostics: [...lockDiagnostics, ...rootDiagnostics],
    };
  }

  const diagnostics = [...lockDiagnostics];
  const credentialDirectoryDiagnostics = await inspectDirectory(paths.credentials, "Credential directory", true);
  diagnostics.push(
    ...credentialDirectoryDiagnostics,
    ...(await inspectDirectory(paths.whatsapp, "WhatsApp data directory", true)),
    ...(await inspectDirectory(paths.logs, "Log directory", true)),
  );

  const configFileDiagnostics = await inspectFile(paths.config, "Configuration file", true);
  diagnostics.push(
    ...configFileDiagnostics,
    ...(await inspectFile(paths.applicationDatabase, "Application database", true)),
    ...(await inspectFile(paths.flueDatabase, "Flue database", true)),
  );
  if (configFileDiagnostics.length === 0) {
    const config = await inspectJson(paths.config, "Configuration file", ManagedConfigSchema, CONFIG_ISSUE_PATHS);
    diagnostics.push(...config.diagnostics);
    if (config.value !== undefined) diagnostics.push(...inspectConfigReferences(paths.config, config.value));
  }

  if (credentialDirectoryDiagnostics.length === 0) {
    const githubFileDiagnostics = await inspectFile(paths.githubCredential, "GitHub credential file", true);
    const useLegacyCredential =
      !(await exists(paths.chatGptOAuthCredential)) && (await exists(paths.legacyPiAuthCredential));
    const chatGptCredentialPath = useLegacyCredential ? paths.legacyPiAuthCredential : paths.chatGptOAuthCredential;
    const chatGptFileDiagnostics = await inspectFile(
      chatGptCredentialPath,
      useLegacyCredential ? "Provisional managed ChatGPT credential file" : "ChatGPT OAuth credential file",
      true,
    );
    diagnostics.push(...githubFileDiagnostics, ...chatGptFileDiagnostics);
    if (githubFileDiagnostics.length === 0) {
      diagnostics.push(
        ...(
          await inspectJson(
            paths.githubCredential,
            "GitHub credential file",
            GitHubCredentialSchema,
            GITHUB_CREDENTIAL_ISSUE_PATHS,
          )
        ).diagnostics,
      );
    }
    if (chatGptFileDiagnostics.length === 0) {
      diagnostics.push(
        ...(
          await inspectJson(
            chatGptCredentialPath,
            useLegacyCredential ? "Provisional managed ChatGPT credential file" : "ChatGPT OAuth credential file",
            useLegacyCredential ? PiAuthSchema : ChatGptOAuthCredentialSchema,
            useLegacyCredential ? LEGACY_PI_AUTH_ISSUE_PATHS : CHATGPT_OAUTH_ISSUE_PATHS,
          )
        ).diagnostics,
      );
    }
  }

  return {
    state: diagnostics.length === 0 ? "configured" : "damaged",
    dataDirectory: paths.root,
    diagnostics,
  };
};

const writeSecureFile = async (path: string, contents: string): Promise<void> => {
  const handle = await open(path, "wx", FILE_MODE);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(path, FILE_MODE);
};

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

const createSkeleton = async (
  paths: ManagedPaths,
  config: ManagedConfig,
  github: GitHubCredential,
): Promise<void> => {
  await mkdir(paths.root, { mode: DIRECTORY_MODE });
  await chmod(paths.root, DIRECTORY_MODE);
  await mkdir(paths.credentials, { mode: DIRECTORY_MODE });
  await mkdir(paths.whatsapp, { mode: DIRECTORY_MODE });
  await mkdir(paths.logs, { mode: DIRECTORY_MODE });
  await Promise.all([
    chmod(paths.credentials, DIRECTORY_MODE),
    chmod(paths.whatsapp, DIRECTORY_MODE),
    chmod(paths.logs, DIRECTORY_MODE),
  ]);
  await writeSecureFile(paths.config, json(config));
  await writeSecureFile(paths.githubCredential, json(github));
  await writeSecureFile(paths.applicationDatabase, "");
  await writeSecureFile(paths.flueDatabase, "");
};

export const installManagedData = async (input: InstallManagedDataInput): Promise<InstallManagedDataResult> => {
  const targetPaths = managedPaths(input);
  if ((input.platform ?? process.platform) === "win32") {
    throw new Error("Secure managed credential ACLs are not implemented on Windows; setup fails closed.");
  }
  const before = await inspectManagedData(input);
  if (before.state === "configured") return { created: false, inspection: before };
  if (before.state === "damaged") {
    throw new Error(`Refusing to replace damaged managed data at ${targetPaths.root}; run ambient-agent doctor.`);
  }

  const configResult = v.safeParse(
    ManagedConfigSchema,
    createManagedConfig(input.managedChats, input.defaultRepository),
  );
  if (!configResult.success) throw new Error("Setup values do not form a valid Ambient Agent configuration.");
  const githubResult = v.safeParse(GitHubCredentialSchema, {
    schemaVersion: 1,
    kind: "personal-token",
    token: input.githubToken,
  });
  if (!githubResult.success) throw new Error("The GitHub token must not be empty.");
  await mkdir(dirname(targetPaths.root), { recursive: true, mode: DIRECTORY_MODE });
  const lock = await acquireSetupLock(targetPaths.root);

  const stagingRoot = lock.stagingRoot;
  try {
    const current = await inspectManagedData(input, { ignoreSetupLock: true });
    if (current.state === "configured") return { created: false, inspection: current };
    if (current.state === "damaged") {
      throw new Error(`Refusing to replace existing managed data at ${targetPaths.root}.`);
    }
    const stagingPaths = managedPaths({ dataDirectory: stagingRoot });
    await createSkeleton(stagingPaths, configResult.output, githubResult.output);
    await input.authenticateChatGpt(stagingPaths);
    const stagingInspection = await inspectManagedData({ dataDirectory: stagingRoot });
    if (stagingInspection.state !== "configured") {
      throw new Error("Managed staging verification failed; setup did not commit any files.");
    }
    await rename(stagingRoot, targetPaths.root);
  } finally {
    try {
      await rm(stagingRoot, { recursive: true, force: true });
    } finally {
      await releaseSetupLock(lock);
    }
  }

  const inspection = await inspectManagedData(input);
  if (inspection.state !== "configured") {
    throw new Error(`Managed data verification failed at ${targetPaths.root}; run ambient-agent doctor.`);
  }
  return { created: true, inspection };
};
