import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import * as v from "valibot";

import { APPLICATION_DATABASE_ID, APPLICATION_DATABASE_SCHEMA_VERSION } from "@ambient-agent/engine/intake/database-versions.ts";
import { SUBSCRIPTION_PROVIDER_ID } from "@ambient-agent/engine/model/pi-subscription.ts";
import { managedPaths, type ManagedPathEnvironment, type ManagedPaths } from "./paths.ts";
import {
  createManagedConfig,
  GITHUB_APP_REFERENCES,
  GitHubAppCredentialSchema,
  ManagedConfigSchema,
  MODEL_API_KEY_CREDENTIAL_REFERENCE,
  modelApiKeyCredentialFrom,
  modelCredentialReferences,
  type GitHubAppCredential,
  type GitHubAppReference,
  type GitHubAppTriples,
  type ManagedConfig,
  type ManagedModelChoice,
} from "./schema.ts";
import { errorCode } from "@ambient-agent/engine/shared/errors.ts";
import { pathExists as exists } from "./files.ts";

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
  "model.profiles",
  "model.profiles.speaker",
  "model.profiles.speaker.id",
  "model.profiles.speaker.thinkingLevel",
  "model.profiles.scribe",
  "model.profiles.scribe.id",
  "model.profiles.scribe.thinkingLevel",
  "model.profiles.planner",
  "model.profiles.planner.id",
  "model.profiles.planner.thinkingLevel",
  "model.profiles.coder",
  "model.profiles.coder.id",
  "model.profiles.coder.thinkingLevel",
  "model.profiles.verifier",
  "model.profiles.verifier.id",
  "model.profiles.verifier.thinkingLevel",
  "runtime",
  "runtime.port",
  "runtime.sandbox",
  "runtime.sandbox.kind",
  "runtime.sandbox.template",
  "runtime.tracing",
  "runtime.tracing.enabled",
  "runtime.tracing.project",
  "runtime.tracing.project.name",
  "runtime.tracing.project.id",
  "github",
  "github.kind",
  "github.credential",
  "github.defaultRepository",
  "github.allowedRepositories",
  "github.allowedRepositories.[]",
]);
const GITHUB_CREDENTIAL_ISSUE_PATHS = new Set([
  "<root>",
  "schemaVersion",
  "kind",
  "appId",
  "installationId",
  "privateKey",
  "webhookSecret",
]);
/** Only the Planner file carries the runtime webhook secret; it is also the Speaker's identity. */
const RUNTIME_WEBHOOK_APP: GitHubAppReference = "planner";

export type InstallationState = "absent" | "incomplete" | "corrupt" | "ready";

/** True integrity failures (#91 ratified vocabulary); everything else diagnosable is merely incomplete. */
const CORRUPT_CODES = new Set([
  "path.not-directory",
  "path.not-file",
  "filesystem.unreadable",
  "json.invalid",
  "schema.invalid",
  "credential.reference",
  "file.too-large",
  "file.changed-during-read",
]);

const classifyInstallation = (diagnostics: readonly InstallationDiagnostic[]): InstallationState =>
  diagnostics.length === 0
    ? "ready"
    : diagnostics.some(({ code }) => CORRUPT_CODES.has(code))
      ? "corrupt"
      : "incomplete";

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

export interface PreparedManagedData {
  readonly managedChats: readonly string[];
  readonly defaultRepository: string;
  /** One pasted triple per GitHub App identity (#135); guided-paste setup collects all three. */
  readonly githubApps: GitHubAppTriples;
  /**
   * The model provider chosen at first run, and the API key when it is not the subscription
   * provider. Absent means the subscription provider with packaged profiles (decision 5:
   * API key or subscription, neither required).
   */
  readonly model?: ManagedModelChoice & { readonly apiKey?: string };
}

export interface InstallPreparedManagedDataInput extends ManagedPathEnvironment {
  readonly prepare: (paths: ManagedPaths) => Promise<PreparedManagedData>;
  /** Tenant-backed model credentials are verified through their store, not a staged local secret file. */
  readonly modelCredentialStorage?: "managed-file" | "tenant-database";
  readonly signal?: AbortSignal;
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
  const provider = typeof model?.provider === "string" ? model.provider : SUBSCRIPTION_PROVIDER_ID;
  const allowed = modelCredentialReferences(provider);
  if (typeof model?.credential !== "string" || !allowed.includes(model.credential)) {
    issues.push(
      diagnostic(
        "credential.reference",
        path,
        `The model credential reference for provider ${provider} must be ${allowed.join(" or ")}.`,
        `Run ambient-agent config --model-provider ${provider}, then ambient-agent doctor.`,
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

export interface AcquiredSetupLock {
  readonly path: string;
  readonly stagingRoot: string;
}

const setupStagingPath = (root: string, token: string): string =>
  join(dirname(root), `.${basename(root)}.setup-${token}`);

export const acquireSetupLock = async (root: string): Promise<AcquiredSetupLock> => {
  const lockPath = setupLockPath(root);
  const token = randomUUID();
  const stagingRoot = setupStagingPath(root, token);
  try {
    await mkdir(lockPath, { mode: DIRECTORY_MODE });
    await chmod(lockPath, DIRECTORY_MODE);
    return { path: lockPath, stagingRoot };
  } catch (cause) {
    if (errorCode(cause) === "EEXIST") {
      throw new Error(
        `Setup is already in progress for ${root}; wait for it to finish or clear the lock after confirming it stopped.`,
      );
    }
    throw cause;
  }
};

export const releaseSetupLock = async (lock: AcquiredSetupLock): Promise<void> => {
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
      state: "corrupt",
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
      // Windows fails closed on unenforceable ACLs; that is mis-permissioning, not corruption.
      state: rootExists ? "incomplete" : "absent",
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
      state: "absent",
      dataDirectory: paths.root,
      diagnostics: [
        diagnostic("installation.missing", paths.root, "Ambient Agent is not configured.", "Run ambient-agent init."),
        ...lockDiagnostics,
      ],
    };
  }

  const rootDiagnostics = await inspectDirectory(paths.root, "Managed data directory", true);
  if (rootDiagnostics.length > 0) {
    const diagnostics = [...lockDiagnostics, ...rootDiagnostics];
    return {
      state: classifyInstallation(diagnostics),
      dataDirectory: paths.root,
      diagnostics,
    };
  }

  // Component-owned paths (the whatsapp/ store and the credential files inside credentials/)
  // never appear here: they classify into component states, not the installation verdict.
  const diagnostics = [...lockDiagnostics];
  diagnostics.push(
    ...(await inspectDirectory(paths.credentials, "Credential directory", true)),
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

  return {
    state: classifyInstallation(diagnostics),
    dataDirectory: paths.root,
    diagnostics,
  };
};

export type CredentialComponentState = "ready" | "reauthentication-required";

export interface GitHubCredentialComponent {
  readonly state: CredentialComponentState;
  readonly diagnostics: readonly InstallationDiagnostic[];
}

/**
 * Static GitHub App credential-file inspection. Each of the three App files is inspected
 * independently (per-file component model); a lingering `personal-token` file fails the
 * App schema here and surfaces as `reauthentication-required`. File damage is a component
 * state, never an installation verdict.
 */
export const inspectGitHubCredentialComponent = async (paths: ManagedPaths): Promise<GitHubCredentialComponent> => {
  const diagnostics: InstallationDiagnostic[] = [];
  for (const reference of GITHUB_APP_REFERENCES) {
    const path = paths.githubAppCredentials[reference];
    const label = `GitHub ${reference} App credential file`;
    const fileDiagnostics = await inspectFile(path, label, true);
    diagnostics.push(...fileDiagnostics);
    if (fileDiagnostics.length === 0) {
      diagnostics.push(
        ...(await inspectJson(path, label, GitHubAppCredentialSchema, GITHUB_CREDENTIAL_ISSUE_PATHS)).diagnostics,
      );
    }
  }
  return { state: diagnostics.length === 0 ? "ready" : "reauthentication-required", diagnostics };
};

/** Atomically adopt a validated replacement WhatsApp store; everything else in the installation is untouched. */
export const promoteReplacementWhatsAppStore = async (paths: ManagedPaths, replacement: string): Promise<void> => {
  await rm(paths.whatsapp, { recursive: true, force: true });
  await rename(replacement, paths.whatsapp);
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

const createPrivateStaging = async (paths: ManagedPaths): Promise<void> => {
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
  await writeSecureFile(paths.applicationDatabase, "");
  await writeSecureFile(paths.flueDatabase, "");
  const applicationDatabase = new DatabaseSync(paths.applicationDatabase);
  try {
    applicationDatabase.exec(`
      PRAGMA application_id = ${APPLICATION_DATABASE_ID};
      PRAGMA user_version = ${APPLICATION_DATABASE_SCHEMA_VERSION};
    `);
  } finally {
    applicationDatabase.close();
  }
};

/**
 * Hosted tenant volumes are created by Docker (0755 directories, 0644 files), never by
 * `ambient-agent init`, so a fresh volume would fail the readiness inspection forever.
 * Bring the volume to the private layout `inspectManagedData` requires. Idempotent, and
 * it never creates config.json or credential files — the provisioner mounts those, and
 * their absence must keep surfacing as the real error.
 */
export const prepareHostedManagedLayout = async (paths: ManagedPaths): Promise<void> => {
  for (const directory of [paths.root, paths.credentials, paths.whatsapp, paths.logs]) {
    await mkdir(directory, { recursive: true, mode: DIRECTORY_MODE });
    await chmod(directory, DIRECTORY_MODE);
  }
  for (const database of [paths.applicationDatabase, paths.flueDatabase]) {
    if (!(await exists(database))) await writeSecureFile(database, "");
    await chmod(database, FILE_MODE);
  }
  const applicationDatabase = new DatabaseSync(paths.applicationDatabase);
  try {
    const stamped = applicationDatabase.prepare("PRAGMA application_id").get() as { application_id: number };
    if (stamped.application_id === 0) {
      applicationDatabase.exec(`
        PRAGMA application_id = ${APPLICATION_DATABASE_ID};
        PRAGMA user_version = ${APPLICATION_DATABASE_SCHEMA_VERSION};
      `);
    }
  } finally {
    applicationDatabase.close();
  }
  for (const mounted of [paths.config, ...Object.values(paths.githubAppCredentials)]) {
    if (await exists(mounted)) await chmod(mounted, FILE_MODE);
  }
};

/** Turn a pasted triple into a credential file; only the Planner file carries the webhook secret. */
export const githubAppCredentialFrom = (
  reference: GitHubAppReference,
  triples: GitHubAppTriples,
): GitHubAppCredential => ({
  schemaVersion: 1,
  kind: "github-app",
  appId: triples[reference].appId,
  installationId: triples[reference].installationId,
  privateKey: triples[reference].privateKey,
  ...(reference === RUNTIME_WEBHOOK_APP ? { webhookSecret: randomBytes(32).toString("base64url") } : {}),
});

const writePreparedConfiguration = async (
  paths: ManagedPaths,
  config: ManagedConfig,
  githubApps: Readonly<Record<GitHubAppReference, GitHubAppCredential>>,
): Promise<void> => {
  await writeSecureFile(paths.config, json(config));
  for (const reference of GITHUB_APP_REFERENCES) {
    await writeSecureFile(paths.githubAppCredentials[reference], json(githubApps[reference]));
  }
};

export const installPreparedManagedData = async (
  input: InstallPreparedManagedDataInput,
): Promise<InstallManagedDataResult> => {
  const targetPaths = managedPaths(input);
  if ((input.platform ?? process.platform) === "win32") {
    throw new Error("Secure managed credential ACLs are not implemented on Windows; setup fails closed.");
  }
  const before = await inspectManagedData(input);
  if (before.state === "ready") return { created: false, inspection: before };
  if (before.state !== "absent") {
    throw new Error(
      `Refusing to replace ${before.state} managed data at ${targetPaths.root}; run ambient-agent doctor.`,
    );
  }

  await mkdir(dirname(targetPaths.root), { recursive: true, mode: DIRECTORY_MODE });
  const lock = await acquireSetupLock(targetPaths.root);

  const stagingRoot = lock.stagingRoot;
  try {
    const current = await inspectManagedData(input, { ignoreSetupLock: true });
    if (current.state === "ready") return { created: false, inspection: current };
    if (current.state !== "absent") {
      throw new Error(`Refusing to replace existing managed data at ${targetPaths.root}.`);
    }
    const stagingPaths = managedPaths({ dataDirectory: stagingRoot });
    await createPrivateStaging(stagingPaths);
    const prepared = await input.prepare(stagingPaths);
    const configResult = v.safeParse(
      ManagedConfigSchema,
      createManagedConfig(prepared.managedChats, prepared.defaultRepository, prepared.model),
    );
    if (!configResult.success) throw new Error("Setup values do not form a valid Ambient Agent configuration.");
    const githubApps = {} as Record<GitHubAppReference, GitHubAppCredential>;
    for (const reference of GITHUB_APP_REFERENCES) {
      const result = v.safeParse(GitHubAppCredentialSchema, githubAppCredentialFrom(reference, prepared.githubApps));
      if (!result.success) {
        throw new Error(`The ${reference} GitHub App credential is incomplete; provide a numeric App ID, Installation ID, and private key.`);
      }
      githubApps[reference] = result.output;
    }
    // An API-key install stages its own credential file here; the subscription install stages
    // none, because the device flow already wrote one.
    if (prepared.model?.apiKey !== undefined) {
      await writeSecureFile(
        stagingPaths.modelApiKeyCredential,
        json(modelApiKeyCredentialFrom(prepared.model.provider, prepared.model.apiKey)),
      );
    }
    await writePreparedConfiguration(stagingPaths, configResult.output, githubApps);
    const stagingInspection = await inspectManagedData({ dataDirectory: stagingRoot });
    // Decision 5: model auth is an API key OR a subscription, and neither is required. The
    // staged credential must be the one the config references — checking for a ChatGPT file
    // unconditionally is what made an API-key-only install impossible to create.
    const modelCredentialStaged =
      configResult.output.model.credential === MODEL_API_KEY_CREDENTIAL_REFERENCE
        ? await exists(stagingPaths.modelApiKeyCredential)
        : (await exists(stagingPaths.chatGptOAuthCredential)) ||
          (await exists(stagingPaths.legacyPiAuthCredential));
    // Credential files are component-owned and never fail an existing installation,
    // but first-run setup must still stage a complete tree before promotion.
    const modelCredentialReady = input.modelCredentialStorage === "tenant-database" || modelCredentialStaged;
    if (stagingInspection.state !== "ready" || !modelCredentialReady) {
      throw new Error("Managed staging verification failed; setup did not commit any files.");
    }
    if (input.signal?.aborted) {
      throw new Error("Setup was cancelled or timed out before promotion; no files changed.");
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
  if (inspection.state !== "ready") {
    throw new Error(`Managed data verification failed at ${targetPaths.root}; run ambient-agent doctor.`);
  }
  return { created: true, inspection };
};
