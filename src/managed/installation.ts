import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, rename, rm, rmdir } from "node:fs/promises";
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
const SETUP_LOCK_OWNER = "owner.json";
const SETUP_LOCK_MAX_AGE_MILLIS = 10 * 60 * 1000;
const SETUP_LOCK_HEARTBEAT_MILLIS = 30 * 1000;
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
  readonly setupLockHeartbeatMillis?: number;
  readonly setupLockHeartbeatBeforeWrite?: () => Promise<void>;
  readonly setupLockHeartbeatAfterWrite?: () => Promise<void>;
  readonly beforeStaleSetupLockQuarantine?: (lockPath: string) => Promise<void>;
  readonly afterStaleSetupLockQuarantine?: (quarantinePath: string, lockPath: string) => Promise<void>;
  readonly afterSetupLockDirectoryCreate?: (lockPath: string) => Promise<void>;
  readonly beforeSetupLockReleaseClaim?: (lockPath: string) => Promise<void>;
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

interface SetupLockOwner {
  readonly pid: number;
  readonly createdAt: string;
  readonly heartbeatAt?: string;
  readonly token: string;
  readonly stagingRoot?: string;
}

const readSetupLockOwner = async (lockPath: string): Promise<SetupLockOwner | undefined> => {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    if (!(await lstat(lockPath)).isDirectory()) return undefined;
    const ownerPath = join(lockPath, SETUP_LOCK_OWNER);
    if (!(await lstat(ownerPath)).isFile()) return undefined;
    const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
    const nonBlocking = "O_NONBLOCK" in constants ? constants.O_NONBLOCK : 0;
    handle = await open(ownerPath, constants.O_RDONLY | noFollow | nonBlocking);
    if (!(await handle.stat()).isFile()) return undefined;
    const value = JSON.parse(await readBoundedUtf8(handle)) as Record<string, unknown>;
    return typeof value.pid === "number" &&
      typeof value.createdAt === "string" &&
      typeof value.token === "string"
      ? {
          pid: value.pid,
          createdAt: value.createdAt,
          ...(typeof value.heartbeatAt === "string" ? { heartbeatAt: value.heartbeatAt } : {}),
          token: value.token,
          ...(typeof value.stagingRoot === "string" ? { stagingRoot: value.stagingRoot } : {}),
        }
      : undefined;
  } catch (cause) {
    if (["EMANAGEDJSONTOOLARGE", "EMANAGEDJSONCHANGED"].includes(errorCode(cause) ?? "")) throw cause;
    return undefined;
  } finally {
    await handle?.close();
  }
};

const processIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return errorCode(cause) !== "ESRCH";
  }
};

const setupLockIsStale = (owner: SetupLockOwner): boolean => {
  const lastHeartbeat = Date.parse(owner.heartbeatAt ?? owner.createdAt);
  const tooOld = Number.isFinite(lastHeartbeat) && Date.now() - lastHeartbeat > SETUP_LOCK_MAX_AGE_MILLIS;
  return tooOld || !processIsAlive(owner.pid);
};

const inspectSetupLock = async (
  root: string,
  ignoredOwnerToken?: string,
): Promise<readonly InstallationDiagnostic[]> => {
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
  let owner: SetupLockOwner | undefined;
  try {
    owner = await readSetupLockOwner(lockPath);
  } catch (cause) {
    return [
      diagnostic(
        "setup.lock-unreadable",
        join(lockPath, SETUP_LOCK_OWNER),
        `Setup lock ownership could not be read safely (${errorCode(cause) ?? "unknown error"}).`,
        "Inspect and remove this lock if no setup is running, then run ambient-agent init again.",
      ),
    ];
  }
  if (ignoredOwnerToken !== undefined && owner?.token === ignoredOwnerToken) return [];
  if (owner && setupLockIsStale(owner)) {
    return [
      diagnostic(
        "setup.stale-lock",
        lockPath,
        `Setup lock from process ${owner.pid} is stale.`,
        "If no setup is running, remove this stale lock and run ambient-agent init again.",
      ),
    ];
  }
  return [
    diagnostic(
      "setup.locked",
      lockPath,
      owner ? `Setup is owned by running process ${owner.pid}.` : "Setup lock ownership is unreadable.",
      owner
        ? "Wait for setup to finish, then run ambient-agent doctor."
        : "Inspect and remove this lock if no setup is running.",
    ),
  ];
};

interface AcquiredSetupLock {
  readonly path: string;
  readonly token: string;
  readonly stagingRoot: string;
}

const setupStagingPath = (root: string, token: string): string =>
  join(dirname(root), `.${basename(root)}.setup-${token}`);

const isSetupToken = (token: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(token);

const assertOwnedStagingDirectory = async (path: string): Promise<void> => {
  const stat = await lstat(path);
  if (!stat.isDirectory() || modeOf(stat.mode) !== DIRECTORY_MODE) {
    throw new Error(`Refusing to remove unsafe stale setup staging path ${path}.`);
  }
  if (process.getuid && stat.uid !== process.getuid()) {
    throw new Error(`Refusing to remove stale setup staging path ${path} owned by another user.`);
  }
};

const ownedStagingDirectoryExists = async (path: string): Promise<boolean> => {
  try {
    await assertOwnedStagingDirectory(path);
    return true;
  } catch (cause) {
    if (errorCode(cause) === "ENOENT") return false;
    throw cause;
  }
};

const renameIfPresent = async (source: string, destination: string): Promise<boolean> => {
  try {
    await rename(source, destination);
    return true;
  } catch (cause) {
    if (errorCode(cause) === "ENOENT") return false;
    throw cause;
  }
};

const removeOwnedStagingDirectory = async (path: string): Promise<void> => {
  if (!(await ownedStagingDirectoryExists(path))) return;
  await rm(path, { recursive: true, force: true });
};

const reconcileStaleStaging = async (root: string, owner: SetupLockOwner): Promise<void> => {
  if (owner.stagingRoot === undefined) return;
  if (!isSetupToken(owner.token)) {
    throw new Error(`Refusing invalid stale setup token recorded for ${root}.`);
  }
  const expected = setupStagingPath(root, owner.token);
  if (owner.stagingRoot !== expected) {
    throw new Error(`Refusing untrusted stale setup staging path recorded for ${root}.`);
  }
  const recoveryPath = `${expected}.recovering`;
  await removeOwnedStagingDirectory(recoveryPath);
  if (!(await ownedStagingDirectoryExists(expected))) return;

  await renameIfPresent(expected, recoveryPath);
  await removeOwnedStagingDirectory(recoveryPath);
};

const quarantineLock = async (lockPath: string, reason: string): Promise<string | undefined> => {
  const quarantinePath = `${lockPath}.${reason}-${randomUUID()}`;
  try {
    await rename(lockPath, quarantinePath);
    return quarantinePath;
  } catch (cause) {
    if (errorCode(cause) === "ENOENT") return undefined;
    throw cause;
  }
};

const sameDirectoryGeneration = async (
  path: string,
  candidate: Awaited<ReturnType<typeof lstat>>,
): Promise<boolean> => {
  try {
    const current = await lstat(path);
    return current.dev === candidate.dev && current.ino === candidate.ino;
  } catch (cause) {
    if (errorCode(cause) === "ENOENT") return false;
    throw cause;
  }
};

const restoreSetupLock = async (quarantinePath: string, lockPath: string): Promise<boolean> => {
  let claim: Awaited<ReturnType<typeof lstat>>;
  try {
    await mkdir(lockPath, { mode: DIRECTORY_MODE });
    claim = await lstat(lockPath);
    await chmod(lockPath, DIRECTORY_MODE);
  } catch (cause) {
    if (errorCode(cause) === "EEXIST") return false;
    throw cause;
  }

  let ownerPublished = false;
  try {
    await rename(join(quarantinePath, SETUP_LOCK_OWNER), join(lockPath, SETUP_LOCK_OWNER));
    ownerPublished = true;
    await rm(quarantinePath, { recursive: true, force: true });
    return true;
  } catch (cause) {
    if (!ownerPublished && (await sameDirectoryGeneration(lockPath, claim))) {
      await rm(join(lockPath, SETUP_LOCK_OWNER), { force: true });
      try {
        await rmdir(lockPath);
      } catch (cleanupCause) {
        if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(errorCode(cleanupCause) ?? "")) throw cleanupCause;
      }
    }
    throw cause;
  }
};

const recoverQuarantinedSetupLocks = async (root: string, lockPath: string): Promise<void> => {
  const parent = dirname(lockPath);
  const prefix = `${basename(lockPath)}.stale-`;
  const entries = await readdir(parent, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
    const quarantinePath = join(parent, entry.name);
    const owner = await readSetupLockOwner(quarantinePath).catch(() => undefined);
    if (owner === undefined) continue;
    if (setupLockIsStale(owner)) {
      await reconcileStaleStaging(root, owner);
      await rm(quarantinePath, { recursive: true, force: true });
      continue;
    }
    await restoreSetupLock(quarantinePath, lockPath);
  }
};

const acquireSetupLock = async (
  root: string,
  hooks: Pick<
    InstallManagedDataInput,
    "beforeStaleSetupLockQuarantine" | "afterStaleSetupLockQuarantine" | "afterSetupLockDirectoryCreate"
  > = {},
): Promise<AcquiredSetupLock> => {
  const lockPath = setupLockPath(root);
  const token = randomUUID();
  const stagingRoot = setupStagingPath(root, token);
  const create = async () => {
    let created: Awaited<ReturnType<typeof lstat>> | undefined;
    try {
      await mkdir(lockPath, { mode: DIRECTORY_MODE });
      created = await lstat(lockPath);
      await chmod(lockPath, DIRECTORY_MODE);
      await hooks.afterSetupLockDirectoryCreate?.(lockPath);
      await writeSecureFile(
        join(lockPath, SETUP_LOCK_OWNER),
        json({
          pid: process.pid,
          createdAt: new Date().toISOString(),
          heartbeatAt: new Date().toISOString(),
          token,
          stagingRoot,
        }),
      );
    } catch (cause) {
      if (created && (await sameDirectoryGeneration(lockPath, created))) {
        const owner = await readSetupLockOwner(lockPath).catch(() => undefined);
        if (owner === undefined || owner.token === token) {
          await rm(join(lockPath, SETUP_LOCK_OWNER), { force: true });
          try {
            await rmdir(lockPath);
          } catch (cleanupCause) {
            if (!["ENOENT", "ENOTEMPTY", "EEXIST"].includes(errorCode(cleanupCause) ?? "")) throw cleanupCause;
          }
        }
      }
      throw cause;
    }
  };
  await recoverQuarantinedSetupLocks(root, lockPath);
  try {
    await create();
    return { path: lockPath, token, stagingRoot };
  } catch (cause) {
    if (errorCode(cause) !== "EEXIST") throw cause;
  }

  const owner = await readSetupLockOwner(lockPath);
  if (owner && setupLockIsStale(owner)) {
    await hooks.beforeStaleSetupLockQuarantine?.(lockPath);
    const quarantinePath = await quarantineLock(lockPath, "stale");
    if (quarantinePath) {
      await hooks.afterStaleSetupLockQuarantine?.(quarantinePath, lockPath);
      const movedOwner = await readSetupLockOwner(quarantinePath);
      if (movedOwner?.token !== owner.token || !setupLockIsStale(movedOwner)) {
        await restoreSetupLock(quarantinePath, lockPath);
        throw new Error(`Setup lock ownership changed while recovering ${lockPath}; retry after inspection.`);
      }
      await reconcileStaleStaging(root, movedOwner);
      await rm(quarantinePath, { recursive: true, force: true });
    }
    try {
      await create();
      return { path: lockPath, token, stagingRoot };
    } catch (cause) {
      if (errorCode(cause) !== "EEXIST") throw cause;
    }
  }
  throw new Error(
    owner
      ? `Another setup is already running for ${root} (process ${owner.pid}).`
      : `Setup lock ${lockPath} is unreadable; inspect it before retrying.`,
  );
};

const releaseSetupLock = async (
  lock: AcquiredSetupLock,
  beforeClaim?: (lockPath: string) => Promise<void>,
): Promise<void> => {
  let candidate;
  try {
    candidate = await lstat(lock.path);
  } catch (cause) {
    if (errorCode(cause) === "ENOENT") return;
    throw cause;
  }
  const owner = await readSetupLockOwner(lock.path);
  if (owner?.token !== lock.token) return;
  await beforeClaim?.(lock.path);
  const releasePath = join(lock.path, `releasing-${lock.token}.json`);
  let release;
  try {
    release = await open(releasePath, "wx", FILE_MODE);
    await release.writeFile(json({ pid: process.pid, token: lock.token }), "utf8");
    await release.sync();
  } catch (cause) {
    if (["ENOENT", "EEXIST", "EINVAL"].includes(errorCode(cause) ?? "")) return;
    throw cause;
  } finally {
    await release?.close();
  }
  try {
    const claimed = await lstat(lock.path);
    if (claimed.dev !== candidate.dev || claimed.ino !== candidate.ino) return;
    if ((await readSetupLockOwner(lock.path))?.token !== lock.token) return;
    await rm(lock.path, { recursive: true, force: true });
  } finally {
    await rm(releasePath, { force: true });
  }
};

interface SetupLockHeartbeat {
  readonly stop: () => Promise<void>;
}

const startSetupLockHeartbeat = (
  lock: AcquiredSetupLock,
  intervalMillis: number = SETUP_LOCK_HEARTBEAT_MILLIS,
  beforeWrite?: () => Promise<void>,
  afterWrite?: () => Promise<void>,
): SetupLockHeartbeat => {
  let failure: unknown;
  let update = Promise.resolve();
  let stopped = false;
  const timer = setInterval(() => {
    update = update
      .then(async () => {
        const owner = await readSetupLockOwner(lock.path);
        if (owner?.token !== lock.token) throw new Error("Setup lock ownership changed during authentication.");
        await beforeWrite?.();
        const temporary = join(lock.path, `${SETUP_LOCK_OWNER}.${randomUUID()}.tmp`);
        await writeSecureFile(temporary, json({ ...owner, heartbeatAt: new Date().toISOString() }));
        await rename(temporary, join(lock.path, SETUP_LOCK_OWNER));
        await afterWrite?.();
      })
      .catch((cause: unknown) => {
        failure ??= cause;
      });
  }, intervalMillis);
  return {
    async stop() {
      if (!stopped) {
        stopped = true;
        clearInterval(timer);
      }
      await update;
      if (failure !== undefined) {
        throw new Error("Could not maintain the setup lock during authentication.", { cause: failure });
      }
    },
  };
};

interface InspectionOptions {
  readonly ignoredSetupLockToken?: string;
}

export const inspectManagedData = async (
  options: ManagedPathEnvironment = {},
  inspectionOptions: InspectionOptions = {},
): Promise<InstallationInspection> => {
  const paths = managedPaths(options);
  const platform = options.platform ?? process.platform;
  const lockDiagnostics = await inspectSetupLock(paths.root, inspectionOptions.ignoredSetupLockToken);
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
  const staleLockOnly =
    before.state === "damaged" &&
    before.diagnostics.length > 0 &&
    before.diagnostics.every((item) => item.code === "setup.stale-lock");
  if (before.state === "damaged" && !staleLockOnly) {
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
  const lock = await acquireSetupLock(targetPaths.root, input);
  const heartbeat = startSetupLockHeartbeat(
    lock,
    input.setupLockHeartbeatMillis,
    input.setupLockHeartbeatBeforeWrite,
    input.setupLockHeartbeatAfterWrite,
  );

  const stagingRoot = lock.stagingRoot;
  try {
    const current = await inspectManagedData(input, { ignoredSetupLockToken: lock.token });
    if (current.state === "configured") return { created: false, inspection: current };
    if (current.state === "damaged") {
      throw new Error(`Refusing to replace existing managed data at ${targetPaths.root}.`);
    }
    const stagingPaths = managedPaths({ dataDirectory: stagingRoot });
    await createSkeleton(stagingPaths, configResult.output, githubResult.output);
    await input.authenticateChatGpt(stagingPaths);
    await heartbeat.stop();
    const stagingInspection = await inspectManagedData({ dataDirectory: stagingRoot });
    if (stagingInspection.state !== "configured") {
      throw new Error("Managed staging verification failed; setup did not commit any files.");
    }
    await rename(stagingRoot, targetPaths.root);
  } finally {
    try {
      await heartbeat.stop();
    } finally {
      try {
        await rm(stagingRoot, { recursive: true, force: true });
      } finally {
        await releaseSetupLock(lock, input.beforeSetupLockReleaseClaim);
      }
    }
  }

  const inspection = await inspectManagedData(input);
  if (inspection.state !== "configured") {
    throw new Error(`Managed data verification failed at ${targetPaths.root}; run ambient-agent doctor.`);
  }
  return { created: true, inspection };
};
