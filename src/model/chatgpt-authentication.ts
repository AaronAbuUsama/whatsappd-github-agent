import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { CredentialStore, ModelAuth, OAuthCredential } from "@earendil-works/pi-ai";
import {
  loginOpenAICodexDeviceCode,
  openaiCodexOAuthProvider,
  type OAuthDeviceCodeInfo,
} from "@earendil-works/pi-ai/oauth";

export const CHATGPT_PROVIDER_ID = "openai-codex";

export type ChatGptAuthenticationErrorCode =
  | "cancelled"
  | "device-code-expired"
  | "timeout"
  | "provider-rejected"
  | "malformed-response"
  | "persistence-failed"
  | "missing"
  | "malformed"
  | "refresh-failed";

export class ChatGptAuthenticationError extends Error {
  override readonly name = "ChatGptAuthenticationError";

  constructor(
    readonly code: ChatGptAuthenticationErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export interface DeviceCodeCallbacks {
  readonly onDeviceCode: (info: OAuthDeviceCodeInfo) => void;
  readonly onProgress?: (progress: { readonly phase: "waiting" | "complete" }) => void;
}

export type ChatGptAuthenticationStatus =
  | { readonly state: "missing" }
  | { readonly state: "malformed"; readonly message: string }
  | { readonly state: "expired-refreshable" }
  | { readonly state: "unusable"; readonly message: string }
  | { readonly state: "ready" };

export type ModelAuthorization = ModelAuth;

export interface ChatGptAuthentication {
  authenticate(callbacks: DeviceCodeCallbacks, signal?: AbortSignal): Promise<void>;
  inspect(): Promise<ChatGptAuthenticationStatus>;
  authorization(signal?: AbortSignal): Promise<ModelAuthorization>;
}

export interface ChatGptOAuthAdapter {
  login(callbacks: DeviceCodeCallbacks, signal?: AbortSignal): Promise<OAuthCredential>;
  refresh(credential: OAuthCredential, signal?: AbortSignal): Promise<OAuthCredential>;
  authorization(credential: OAuthCredential, signal?: AbortSignal): Promise<ModelAuthorization>;
}

export interface CreateChatGptAuthenticationOptions {
  readonly store: CredentialStore;
  readonly oauth?: ChatGptOAuthAdapter;
  readonly now?: () => number;
}

export interface ManagedChatGptCredentialStoreOptions {
  readonly path: string;
  readonly managedRoot?: string;
  readonly legacyPath?: string;
  readonly onLegacyMigration?: () => Promise<void>;
  readonly beforeCommit?: (temporaryPath: string, targetPath: string) => Promise<void>;
  readonly beforeStaleLockClaim?: (lockPath: string) => Promise<void>;
}

export interface ChatGptCredentialStore extends CredentialStore {
  read(providerId: string, signal?: AbortSignal): Promise<OAuthCredential | undefined>;
  modify(
    providerId: string,
    change: (credential: OAuthCredential | undefined) => Promise<OAuthCredential | undefined>,
    signal?: AbortSignal,
  ): Promise<OAuthCredential | undefined>;
  replace(providerId: string, credential: OAuthCredential, signal?: AbortSignal): Promise<void>;
  delete(providerId: string, signal?: AbortSignal): Promise<void>;
}

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
const MAX_CREDENTIAL_BYTES = 1024 * 1024;
const LOCK_WAIT_MILLIS = 20;
const LOCK_TIMEOUT_MILLIS = 20 * 60 * 1_000;
const STALE_LOCK_MILLIS = 30_000;
const LOCK_OWNER_FILE = "owner.json";
const LOCK_RECLAIM_FILE = "reclaiming.json";
const LOCK_RELEASE_FILE = "releasing.json";

interface CredentialLockOwner {
  readonly pid: number;
  readonly createdAt: string;
  readonly token: string;
}

const errorCode = (cause: unknown): string | undefined =>
  typeof cause === "object" && cause !== null && "code" in cause ? String(cause.code) : undefined;

const abortError = (signal: AbortSignal): unknown =>
  signal.reason ?? new DOMException("The operation was aborted.", "AbortError");

const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) throw abortError(signal);
};

const abortable = async <T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> => {
  throwIfAborted(signal);
  if (signal === undefined) return await operation;
  return await new Promise<T>((resolveOperation, rejectOperation) => {
    const onAbort = () => rejectOperation(abortError(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    void operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolveOperation(value);
      },
      (cause: unknown) => {
        signal.removeEventListener("abort", onAbort);
        rejectOperation(cause);
      },
    );
  });
};

const delay = async (millis: number, signal?: AbortSignal): Promise<void> =>
  await abortable(new Promise((resolve) => setTimeout(resolve, millis)), signal);

const pathExists = async (path: string | undefined): Promise<boolean> => {
  if (path === undefined) return false;
  try {
    await lstat(path);
    return true;
  } catch (cause) {
    if (errorCode(cause) === "ENOENT") return false;
    throw cause;
  }
};

const assertManagedCredentialDirectory = async (path: string, managedRoot: string): Promise<void> => {
  if (resolve(path) !== resolve(join(managedRoot, "credentials"))) {
    throw new Error("The managed ChatGPT credential path escapes the managed data root.");
  }
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  for (const [directoryPath, message] of [
    [managedRoot, "The managed data root is not a private directory."],
    [path, "The managed ChatGPT credential directory is not a private directory."],
  ] as const) {
    let directory;
    try {
      directory = await open(directoryPath, constants.O_RDONLY | noFollow);
      if (!(await directory.stat()).isDirectory()) throw new Error(message);
    } finally {
      await directory?.close();
    }
  }
};

const ensurePrivateDirectory = async (path: string, managedRoot?: string): Promise<void> => {
  if (managedRoot === undefined) {
    await mkdir(path, { recursive: true, mode: DIRECTORY_MODE });
  } else {
    try {
      await assertManagedCredentialDirectory(path, managedRoot);
    } catch (cause) {
      if (errorCode(cause) === "ENOENT") {
        throw new Error("The managed ChatGPT credential directory is missing.", { cause });
      }
      throw cause;
    }
  }
  const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
  let directory;
  try {
    directory = await open(path, constants.O_RDONLY | noFollow);
    if (!(await directory.stat()).isDirectory()) {
      throw new Error("The managed ChatGPT credential directory is not a private directory.");
    }
    await directory.chmod(DIRECTORY_MODE);
  } catch (cause) {
    throw cause;
  } finally {
    await directory?.close();
  }
};

const assertReplaceableCredentialPath = async (path: string): Promise<void> => {
  try {
    if (!(await lstat(path)).isFile()) {
      throw new Error("The managed ChatGPT credential path is not a regular file.");
    }
  } catch (cause) {
    if (errorCode(cause) !== "ENOENT") throw cause;
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

const readPrivateJson = async (path: string): Promise<unknown | undefined> => {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const stat = await lstat(path);
    if (!stat.isFile()) throw new Error("The managed ChatGPT credential path is not a regular file.");
    if ((stat.mode & 0o777) !== FILE_MODE) {
      throw new Error("The managed ChatGPT credential file must have mode 0600.");
    }
    const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
    handle = await open(path, constants.O_RDONLY | noFollow);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size > MAX_CREDENTIAL_BYTES) {
      throw new Error("The managed ChatGPT credential file is not a supported private JSON file.");
    }
    const bytes = Buffer.allocUnsafe(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== opened.size) throw new Error("The managed ChatGPT credential changed while it was read.");
    return JSON.parse(bytes.toString("utf8"));
  } catch (cause) {
    if (errorCode(cause) === "ENOENT") return undefined;
    throw cause;
  } finally {
    await handle?.close();
  }
};

const atomicWriteCredential = async (
  path: string,
  credential: OAuthCredential,
  beforeCommit?: ManagedChatGptCredentialStoreOptions["beforeCommit"],
  managedRoot?: string,
): Promise<void> => {
  const directory = dirname(path);
  await ensurePrivateDirectory(directory, managedRoot);
  await assertReplaceableCredentialPath(path);
  const temporary = `${path}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", FILE_MODE);
    await handle.writeFile(`${JSON.stringify(credential, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await beforeCommit?.(temporary, path);
    await rename(temporary, path);
    await chmod(path, FILE_MODE);
    const noFollow = "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
    const directoryHandle = await open(directory, constants.O_RDONLY | noFollow);
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

const parseCredentialLockOwner = (value: unknown): CredentialLockOwner | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const owner = value as Record<string, unknown>;
  return typeof owner.pid === "number" && typeof owner.createdAt === "string" && typeof owner.token === "string"
    ? { pid: owner.pid, createdAt: owner.createdAt, token: owner.token }
    : undefined;
};

const readCredentialLockOwner = async (lockPath: string): Promise<CredentialLockOwner | undefined> =>
  parseCredentialLockOwner(await readPrivateJson(join(lockPath, LOCK_OWNER_FILE)));

const removeOwnedMarker = async (markerPath: string, token: string): Promise<void> => {
  try {
    const marker = await readPrivateJson(markerPath);
    if (typeof marker === "object" && marker !== null && (marker as Record<string, unknown>).token === token) {
      await rm(markerPath, { force: true });
    }
  } catch (cause) {
    if (errorCode(cause) !== "ENOENT") throw cause;
  }
};

const releaseCredentialLock = async (lockPath: string, token: string): Promise<void> => {
  let candidate;
  try {
    candidate = await lstat(lockPath);
  } catch (cause) {
    if (errorCode(cause) === "ENOENT") return;
    throw cause;
  }
  const owner = await readCredentialLockOwner(lockPath);
  if (owner?.token !== token) return;
  const releasePath = join(lockPath, LOCK_RELEASE_FILE);
  let release;
  try {
    release = await open(releasePath, "wx", FILE_MODE);
    await release.writeFile(JSON.stringify({ pid: process.pid, token }), "utf8");
    await release.sync();
  } catch (cause) {
    if (["ENOENT", "EEXIST", "EINVAL"].includes(errorCode(cause) ?? "")) return;
    throw cause;
  } finally {
    await release?.close();
  }
  try {
    const claimed = await lstat(lockPath);
    if (claimed.dev !== candidate.dev || claimed.ino !== candidate.ino) return;
    if ((await readCredentialLockOwner(lockPath))?.token !== token) return;
    await rm(lockPath, { recursive: true, force: true });
  } finally {
    await removeOwnedMarker(releasePath, token);
  }
};

const acquireCredentialLock = async (
  path: string,
  signal?: AbortSignal,
  options: Pick<ManagedChatGptCredentialStoreOptions, "managedRoot" | "beforeStaleLockClaim"> = {},
): Promise<() => Promise<void>> => {
  const lockPath = `${path}.lock`;
  const started = Date.now();
  const token = randomUUID();
  await ensurePrivateDirectory(dirname(path), options.managedRoot);
  while (true) {
    throwIfAborted(signal);
    try {
      await mkdir(lockPath, { mode: DIRECTORY_MODE });
      await chmod(lockPath, DIRECTORY_MODE);
      const owner = await open(join(lockPath, LOCK_OWNER_FILE), "wx", FILE_MODE);
      try {
        await owner.writeFile(
          JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), token }),
          "utf8",
        );
        await owner.sync();
      } catch (cause) {
        await rm(lockPath, { recursive: true, force: true });
        throw cause;
      } finally {
        await owner.close();
      }
      await chmod(join(lockPath, LOCK_OWNER_FILE), FILE_MODE);
      return async () => await releaseCredentialLock(lockPath, token);
    } catch (cause) {
      if (errorCode(cause) !== "EEXIST") throw cause;
      try {
        const lock = await lstat(lockPath);
        if (!lock.isDirectory()) throw new Error("The managed ChatGPT credential lock is not a directory.");
        let owner: CredentialLockOwner | undefined;
        try {
          owner = await readCredentialLockOwner(lockPath);
        } catch {
          owner = undefined;
        }
        const stale = owner !== undefined ? !processIsAlive(owner.pid) : Date.now() - lock.mtimeMs > STALE_LOCK_MILLIS;
        if (stale) {
          const candidate = await lstat(lockPath);
          await options.beforeStaleLockClaim?.(lockPath);
          const reclaimPath = join(lockPath, LOCK_RECLAIM_FILE);
          let ownedReclaimPath = reclaimPath;
          let reclaim;
          try {
            reclaim = await open(reclaimPath, "wx", FILE_MODE);
            await reclaim.writeFile(JSON.stringify({ pid: process.pid, token }), "utf8");
            await reclaim.sync();
          } catch (claimCause) {
            if (["ENOENT", "EEXIST", "EINVAL"].includes(errorCode(claimCause) ?? "")) continue;
            throw claimCause;
          } finally {
            await reclaim?.close();
          }
          try {
            const claimed = await lstat(lockPath);
            if (claimed.dev !== candidate.dev || claimed.ino !== candidate.ino) continue;
            const claimedOwner = await readCredentialLockOwner(lockPath).catch(() => undefined);
            const claimedIsStale =
              claimedOwner !== undefined
                ? !processIsAlive(claimedOwner.pid)
                : Date.now() - candidate.mtimeMs > STALE_LOCK_MILLIS;
            if (!claimedIsStale) continue;
            const quarantinePath = `${lockPath}.stale-${token}`;
            try {
              await rename(lockPath, quarantinePath);
            } catch (renameCause) {
              if (errorCode(renameCause) === "ENOENT") continue;
              throw renameCause;
            }
            ownedReclaimPath = join(quarantinePath, LOCK_RECLAIM_FILE);
            const moved = await lstat(quarantinePath);
            if (moved.dev !== candidate.dev || moved.ino !== candidate.ino) {
              throw new Error("The managed ChatGPT credential lock changed ownership during stale recovery.");
            }
            await rm(quarantinePath, { recursive: true, force: true });
          } finally {
            await removeOwnedMarker(ownedReclaimPath, token);
          }
          continue;
        }
      } catch (inspectionCause) {
        if (errorCode(inspectionCause) !== "ENOENT") throw inspectionCause;
        continue;
      }
      if (Date.now() - started >= LOCK_TIMEOUT_MILLIS) {
        throw new Error("Timed out waiting for the managed ChatGPT credential lock.");
      }
      await delay(LOCK_WAIT_MILLIS, signal);
    }
  }
};

const assertProvider = (providerId: string): void => {
  if (providerId !== CHATGPT_PROVIDER_ID) {
    throw new Error("The managed ChatGPT credential store accepts only openai-codex.");
  }
};

export const createManagedChatGptCredentialStore = (
  options: ManagedChatGptCredentialStoreOptions,
): ChatGptCredentialStore => {
  const readUnlocked = async (): Promise<OAuthCredential | undefined> => {
    const current = await readPrivateJson(options.path);
    if (current !== undefined) {
      return validateChatGptOAuthCredential(current);
    }
    if (options.legacyPath === undefined) return undefined;
    const legacy = await readPrivateJson(options.legacyPath);
    if (legacy === undefined) return undefined;
    if (typeof legacy !== "object" || legacy === null) {
      throw new Error("The provisional managed ChatGPT credential is malformed.");
    }
    const migrated = validateChatGptOAuthCredential((legacy as Record<string, unknown>)[CHATGPT_PROVIDER_ID]);
    return migrated;
  };

  const finishLegacyMigration = async (): Promise<void> => {
    await options.onLegacyMigration?.();
    if (options.legacyPath !== undefined && (await pathExists(options.legacyPath))) {
      await assertReplaceableCredentialPath(options.legacyPath);
      await rm(options.legacyPath, { force: true });
    }
  };

  const locked = async <T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
    const release = await acquireCredentialLock(options.path, signal, options);
    try {
      throwIfAborted(signal);
      return await task();
    } finally {
      await release();
    }
  };

  return {
    async read(providerId, signal) {
      assertProvider(providerId);
      throwIfAborted(signal);
      if (options.managedRoot !== undefined) {
        await assertManagedCredentialDirectory(dirname(options.path), options.managedRoot);
      }
      return await readUnlocked();
    },
    async modify(providerId, change, signal) {
      assertProvider(providerId);
      return await locked(async () => {
        const current = await readUnlocked();
        const next = await change(current);
        if (next === undefined) return current;
        if (next.type !== "oauth") throw new Error("Only a ChatGPT OAuth credential may be stored.");
        const credential = validateChatGptOAuthCredential(next);
        throwIfAborted(signal);
        await atomicWriteCredential(options.path, credential, options.beforeCommit, options.managedRoot);
        await finishLegacyMigration();
        return credential;
      }, signal);
    },
    async replace(providerId, next, signal) {
      assertProvider(providerId);
      const credential = validateChatGptOAuthCredential(next);
      await locked(async () => {
        if (options.legacyPath !== undefined && (await pathExists(options.legacyPath))) {
          await assertReplaceableCredentialPath(options.legacyPath);
        }
        throwIfAborted(signal);
        await atomicWriteCredential(options.path, credential, options.beforeCommit, options.managedRoot);
        await finishLegacyMigration();
      }, signal);
    },
    async delete(providerId, signal) {
      assertProvider(providerId);
      await locked(async () => {
        await rm(options.path, { force: true });
      }, signal);
    },
  };
};

const nonBlank = (value: unknown): value is string => typeof value === "string" && value.trim().length > 0;

const loginFailure = (cause: unknown, signal?: AbortSignal): ChatGptAuthenticationError => {
  const providerMessage = cause instanceof Error ? cause.message : String(cause);
  const abortReason = signal?.aborted ? signal.reason : undefined;
  if (
    abortReason instanceof Error &&
    (abortReason.name === "TimeoutError" || /timeout|timed out/i.test(abortReason.message))
  ) {
    return new ChatGptAuthenticationError("timeout", "ChatGPT authentication timed out; try again.", { cause });
  }
  if (signal?.aborted || /cancel/i.test(providerMessage)) {
    return new ChatGptAuthenticationError("cancelled", "ChatGPT device-code authentication was cancelled.", {
      cause,
    });
  }
  if (/device flow timed out/i.test(providerMessage)) {
    return new ChatGptAuthenticationError(
      "device-code-expired",
      "The ChatGPT device code expired; start login again.",
      {
        cause,
      },
    );
  }
  if (/timeout|timed out/i.test(providerMessage)) {
    return new ChatGptAuthenticationError("timeout", "ChatGPT authentication timed out; try again.", { cause });
  }
  if (/invalid|malformed/i.test(providerMessage)) {
    return new ChatGptAuthenticationError(
      "malformed-response",
      "ChatGPT returned a malformed authentication response; try again.",
      { cause },
    );
  }
  return new ChatGptAuthenticationError(
    "provider-rejected",
    "ChatGPT rejected the device-code authentication request; try again.",
    { cause },
  );
};

export const validateChatGptOAuthCredential = (value: unknown): OAuthCredential => {
  if (
    typeof value !== "object" ||
    value === null ||
    (value as Record<string, unknown>).type !== "oauth" ||
    !nonBlank((value as Record<string, unknown>).access) ||
    !nonBlank((value as Record<string, unknown>).refresh) ||
    typeof (value as Record<string, unknown>).expires !== "number" ||
    !Number.isFinite((value as Record<string, unknown>).expires)
  ) {
    throw new Error("The managed ChatGPT OAuth credential is malformed.");
  }
  return value as OAuthCredential;
};

export const piChatGptOAuthAdapter = (): ChatGptOAuthAdapter => ({
  login: async (callbacks, signal) => {
    const credential = await loginOpenAICodexDeviceCode({
      signal,
      onDeviceCode: (info) => {
        callbacks.onDeviceCode(info);
        callbacks.onProgress?.({ phase: "waiting" });
      },
    });
    return { type: "oauth", ...credential };
  },
  refresh: async (credential) =>
    validateChatGptOAuthCredential({
      type: "oauth",
      ...(await openaiCodexOAuthProvider.refreshToken(credential)),
    }),
  authorization: async (credential) => ({ apiKey: openaiCodexOAuthProvider.getApiKey(credential) }),
});

export const createChatGptAuthentication = (options: CreateChatGptAuthenticationOptions): ChatGptAuthentication => {
  const oauth = options.oauth ?? piChatGptOAuthAdapter();
  const now = options.now ?? Date.now;
  let unusableMessage: string | undefined;
  const store = options.store as ChatGptCredentialStore;

  return {
    async authenticate(callbacks, signal) {
      let credential: OAuthCredential;
      try {
        credential = validateChatGptOAuthCredential(await oauth.login(callbacks, signal));
      } catch (cause) {
        if (cause instanceof ChatGptAuthenticationError) throw cause;
        throw loginFailure(cause, signal);
      }
      try {
        if ("replace" in options.store && typeof options.store.replace === "function") {
          await store.replace(CHATGPT_PROVIDER_ID, credential, signal);
        } else {
          throwIfAborted(signal);
          await options.store.modify(CHATGPT_PROVIDER_ID, async () => credential);
        }
      } catch (cause) {
        if (signal?.aborted) throw loginFailure(cause, signal);
        throw new ChatGptAuthenticationError(
          "persistence-failed",
          "ChatGPT login succeeded, but the managed credential could not be saved; login is not ready.",
          { cause },
        );
      }
      unusableMessage = undefined;
      callbacks.onProgress?.({ phase: "complete" });
    },

    async inspect() {
      if (unusableMessage !== undefined) return { state: "unusable", message: unusableMessage };
      let stored;
      try {
        stored = await options.store.read(CHATGPT_PROVIDER_ID);
      } catch {
        return { state: "malformed", message: "The managed ChatGPT OAuth credential could not be read." };
      }
      if (stored === undefined) return { state: "missing" };
      let credential;
      try {
        credential = validateChatGptOAuthCredential(stored);
      } catch (cause) {
        return { state: "malformed", message: cause instanceof Error ? cause.message : String(cause) };
      }
      return credential.expires <= now() ? { state: "expired-refreshable" } : { state: "ready" };
    },

    async authorization(signal) {
      try {
        throwIfAborted(signal);
        let current;
        try {
          current = await store.read(CHATGPT_PROVIDER_ID, signal);
        } catch (cause) {
          throw new ChatGptAuthenticationError(
            "persistence-failed",
            "The managed ChatGPT credential could not be read; run ambient-agent doctor.",
            { cause },
          );
        }
        if (current === undefined) {
          throw new ChatGptAuthenticationError("missing", "ChatGPT authentication is missing; run ambient-agent auth.");
        }
        let credential: OAuthCredential;
        try {
          credential = validateChatGptOAuthCredential(current);
        } catch (cause) {
          throw new ChatGptAuthenticationError(
            "malformed",
            "The managed ChatGPT OAuth credential is malformed; run ambient-agent auth.",
            { cause },
          );
        }
        if (credential.expires <= now()) {
          let refreshFailed = false;
          let refreshed;
          try {
            refreshed = await store.modify(CHATGPT_PROVIDER_ID, async (latest) => {
              if (latest === undefined) return undefined;
              const validated = validateChatGptOAuthCredential(latest);
              if (validated.expires > now()) return undefined;
              try {
                return validateChatGptOAuthCredential(await abortable(oauth.refresh(validated, signal), signal));
              } catch (cause) {
                refreshFailed = true;
                throw cause;
              }
            }, signal);
          } catch (cause) {
            if (signal?.aborted) throw loginFailure(cause, signal);
            throw new ChatGptAuthenticationError(
              refreshFailed ? "refresh-failed" : "persistence-failed",
              refreshFailed
                ? "ChatGPT rejected the credential refresh; run ambient-agent auth to authenticate again."
                : "ChatGPT refreshed the credential, but the rotation could not be saved; authorization is not ready.",
              { cause },
            );
          }
          if (refreshed === undefined) {
            throw new ChatGptAuthenticationError(
              "missing",
              "ChatGPT authentication was removed during refresh; run ambient-agent auth.",
            );
          }
          credential = validateChatGptOAuthCredential(refreshed);
        }
        let authorization: ModelAuthorization;
        try {
          authorization = await abortable(oauth.authorization(credential, signal), signal);
        } catch (cause) {
          if (signal?.aborted) throw loginFailure(cause, signal);
          throw new ChatGptAuthenticationError(
            "provider-rejected",
            "ChatGPT could not derive model authorization from the managed credential.",
            { cause },
          );
        }
        if (!nonBlank(authorization.apiKey)) {
          throw new ChatGptAuthenticationError(
            "malformed",
            "ChatGPT authorization did not contain a usable token; run ambient-agent auth.",
          );
        }
        unusableMessage = undefined;
        return authorization;
      } catch (cause) {
        if (
          cause instanceof ChatGptAuthenticationError &&
          (cause.code === "cancelled" || cause.code === "timeout")
        ) {
          throw cause;
        }
        unusableMessage = cause instanceof Error ? cause.message : String(cause);
        throw cause;
      }
    },
  };
};
