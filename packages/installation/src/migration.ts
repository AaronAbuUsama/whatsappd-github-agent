import { chmod, copyFile, lstat, mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import * as v from "valibot";

import { atomicWriteManagedConfig, readManagedConfig } from "./configuration.ts";
import { acquireSetupLock, githubAppCredentialFrom, releaseSetupLock } from "./installation.ts";
import { GITHUB_APP_REFERENCES, GitHubAppCredentialSchema, type GitHubAppTriples } from "./schema.ts";
import { type ManagedPaths } from "./paths.ts";
import {
  managedPaths,
  resolveLegacyManagedDataDirectory,
  resolveManagedDataDirectory,
  type ManagedPathEnvironment,
} from "./paths.ts";
import { probeAmbientRuntimeHealth, runtimeInstallationId } from "./runtime-health.ts";
import { errorCode } from "@ambient-agent/engine/shared/errors.ts";
import { pathExists as exists } from "./files.ts";

export interface ManagedDataMigration {
  readonly migrated: boolean;
  readonly root: string;
  readonly source?: string;
}

export interface MigrateManagedDataOptions extends ManagedPathEnvironment {
  /** Test seam so the cross-filesystem (EXDEV) copy fallback is exercisable. */
  readonly rename?: typeof rename;
  /** Test seam for the legacy-runtime liveness probe. */
  readonly probeRuntimeHealth?: typeof probeAmbientRuntimeHealth;
}

/** Copy a managed tree preserving 0700/0600 modes; fsync every file so the staged copy is durable. */
const copySecureTree = async (source: string, target: string): Promise<void> => {
  const sourceStat = await lstat(source);
  await mkdir(target, { mode: sourceStat.mode & 0o777 });
  await chmod(target, sourceStat.mode & 0o777);
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.isDirectory()) {
      await copySecureTree(from, to);
    } else if (entry.isFile()) {
      await copyFile(from, to);
      await chmod(to, (await lstat(from)).mode & 0o777);
      const handle = await open(to, "r+");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    } else {
      throw new Error(`Cannot migrate ${from}: only regular files and directories are supported.`);
    }
  }
};

const recordMigration = async (applicationDatabase: string, source: string): Promise<void> => {
  if (!(await exists(applicationDatabase))) {
    const handle = await open(applicationDatabase, "wx", 0o600);
    await handle.close();
  }
  const database = new DatabaseSync(applicationDatabase);
  try {
    database.exec(
      "CREATE TABLE IF NOT EXISTS managed_root_migrations (source TEXT NOT NULL, migrated_at TEXT NOT NULL)",
    );
    database
      .prepare("INSERT INTO managed_root_migrations (source, migrated_at) VALUES (?, ?)")
      .run(source, new Date().toISOString());
  } finally {
    database.close();
  }
};

/** True when the application database records that `source` was already adopted (its copy is the backup). */
const migrationRecorded = (applicationDatabase: string, source: string): boolean => {
  try {
    const database = new DatabaseSync(applicationDatabase, { readOnly: true });
    try {
      return (
        database.prepare("SELECT 1 AS recorded FROM managed_root_migrations WHERE source = ?").get(source) !==
        undefined
      );
    } finally {
      database.close();
    }
  } catch {
    return false;
  }
};

/**
 * Fail closed when the legacy runtime verifiably answers its health endpoint:
 * renaming the directory under a live process would leave it writing into the
 * moved tree through open file descriptors. An unreadable legacy config or a
 * port holder that is not verifiably ours cannot block the migration.
 */
/**
 * The webhook secret is the runtime's health-probe correlation. This platform-path migration
 * (ADR 0015) can be moving a pre-App install (secret in the retired `github.json`) or a
 * provisioned one (secret in the Planner App file), so read it leniently from whichever file
 * carries it rather than through the strict App schema.
 */
const readLegacyWebhookSecret = async (paths: ManagedPaths): Promise<string | undefined> => {
  for (const path of [paths.githubAppCredentials.planner, paths.legacyGithubCredential]) {
    try {
      const parsed = JSON.parse(await readFile(path, "utf8")) as { webhookSecret?: unknown };
      if (typeof parsed.webhookSecret === "string" && parsed.webhookSecret.length > 0) return parsed.webhookSecret;
    } catch {
      // Try the next candidate file.
    }
  }
  return undefined;
};

const assertLegacyRuntimeStopped = async (
  legacy: string,
  probe: typeof probeAmbientRuntimeHealth,
): Promise<void> => {
  let state: string;
  try {
    const legacyPaths = managedPaths({ dataDirectory: legacy });
    const config = await readManagedConfig(legacyPaths.config);
    const webhookSecret = await readLegacyWebhookSecret(legacyPaths);
    if (webhookSecret === undefined) return;
    const health = await probe({
      port: config.runtime.port,
      installationId: runtimeInstallationId(webhookSecret),
      timeoutMillis: 750,
    });
    state = health.state;
  } catch {
    return;
  }
  // "stopped" is nothing listening; "failed" is a port holder that did not
  // prove it is our runtime. Every other state came from a verified health
  // response, so the legacy installation is live.
  if (state !== "stopped" && state !== "failed") {
    throw new Error(
      `The Ambient Agent runtime is still running against ${legacy} (${state}). ` +
        `Stop it, then run ambient-agent again to migrate the managed data.`,
    );
  }
};

const removeStaleStaging = async (root: string): Promise<void> => {
  const prefix = `${basename(root)}.staging-`;
  for (const entry of await readdir(dirname(root))) {
    if (entry.startsWith(prefix)) await rm(join(dirname(root), entry), { recursive: true, force: true });
  }
};

/**
 * One-time adoption of a pre-ADR-0015 installation into ~/.ambient-agent.
 * Atomic: same-filesystem rename, or staged copy + rename on EXDEV (the source
 * then remains intact as the backup). Fails closed when both directories exist
 * without a recorded migration or when the legacy runtime is still live, and
 * never runs under a dataDirectory override. Concurrent invocations serialize
 * on the managed setup lock.
 */
export const migrateLegacyManagedData = async (
  options: MigrateManagedDataOptions = {},
): Promise<ManagedDataMigration> => {
  const root = resolveManagedDataDirectory(options);
  if (options.dataDirectory !== undefined) return { migrated: false, root };
  const legacy = resolveLegacyManagedDataDirectory(options);
  if (legacy === undefined || legacy === root) return { migrated: false, root };
  const paths = managedPaths(options);
  // Returns the settled outcome, or undefined when a migration is still needed.
  const settled = async (): Promise<ManagedDataMigration | undefined> => {
    if (!(await exists(legacy))) return { migrated: false, root };
    if (!(await exists(root))) return undefined;
    if (migrationRecorded(paths.applicationDatabase, legacy)) return { migrated: false, root };
    throw new Error(
      `Managed data exists at both ${root} and the former default ${legacy}. ` +
        `Remove or rename whichever directory is not the real installation, then run ambient-agent again.`,
    );
  };
  const early = await settled();
  if (early !== undefined) return early;
  const lock = await acquireSetupLock(root);
  try {
    const raced = await settled();
    if (raced !== undefined) return raced;
    await assertLegacyRuntimeStopped(legacy, options.probeRuntimeHealth ?? probeAmbientRuntimeHealth);
    await removeStaleStaging(root);
    const move = options.rename ?? rename;
    try {
      await move(legacy, root);
      await recordMigration(paths.applicationDatabase, legacy);
    } catch (cause) {
      if (errorCode(cause) !== "EXDEV") throw cause;
      const staging = `${root}.staging-${process.pid}`;
      try {
        await copySecureTree(legacy, staging);
        // Record before promoting so a post-promote crash never leaves both
        // directories present without the record that marks the source a backup.
        await recordMigration(join(staging, "application.sqlite"), legacy);
        await move(staging, root);
      } catch (copyCause) {
        await rm(staging, { recursive: true, force: true });
        throw copyCause;
      }
    }
    return { migrated: true, root, source: legacy };
  } finally {
    await releaseSetupLock(lock);
  }
};

/**
 * One-time token→App cutover (#153): a retired single-PAT `github.json` is present, so walk
 * the operator through provisioning the three GitHub Apps, then retire the PAT file. Detection
 * is presence of the legacy file — a fresh App install never writes it. `collectTriples` is the
 * guided-paste seam (the CLI prints the per-App checklist and prompts; tests supply fixtures).
 * Fail-closed: the three triples are validated before any file is written, and the PAT file is
 * removed only after all three App files land, so a bad paste leaves the old install intact.
 */
export const migrateManagedGitHubCredential = async (input: {
  readonly paths: ManagedPaths;
  readonly collectTriples: () => Promise<GitHubAppTriples>;
  readonly write?: (path: string, value: unknown) => Promise<void>;
}): Promise<{ readonly migrated: boolean }> => {
  if (!(await exists(input.paths.legacyGithubCredential))) return { migrated: false };
  const write = input.write ?? atomicWriteManagedConfig;
  const triples = await input.collectTriples();
  const credentials = GITHUB_APP_REFERENCES.map((reference) => {
    const result = v.safeParse(GitHubAppCredentialSchema, githubAppCredentialFrom(reference, triples));
    if (!result.success) {
      throw new Error(
        `The ${reference} GitHub App credential is incomplete; provide a numeric App ID, Installation ID, and private key.`,
      );
    }
    return { reference, credential: result.output } as const;
  });
  for (const { reference, credential } of credentials) {
    await write(input.paths.githubAppCredentials[reference], credential);
  }
  await rm(input.paths.legacyGithubCredential, { force: true });
  return { migrated: true };
};
