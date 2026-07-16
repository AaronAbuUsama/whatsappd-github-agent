import { chmod, copyFile, lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  managedPaths,
  resolveLegacyManagedDataDirectory,
  resolveManagedDataDirectory,
  type ManagedPathEnvironment,
} from "./paths.js";

export interface ManagedDataMigration {
  readonly migrated: boolean;
  readonly root: string;
  readonly source?: string;
}

export interface MigrateManagedDataOptions extends ManagedPathEnvironment {
  /** Test seam so the cross-filesystem (EXDEV) copy fallback is exercisable. */
  readonly rename?: typeof rename;
}

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
 * One-time adoption of a pre-ADR-0015 installation into ~/.ambient-agent.
 * Atomic: same-filesystem rename, or staged copy + rename on EXDEV (the source
 * then remains intact as the backup). Fails closed when both directories exist
 * without a recorded migration, and never runs under a dataDirectory override.
 */
export const migrateLegacyManagedData = async (
  options: MigrateManagedDataOptions = {},
): Promise<ManagedDataMigration> => {
  const root = resolveManagedDataDirectory(options);
  if (options.dataDirectory !== undefined) return { migrated: false, root };
  const legacy = resolveLegacyManagedDataDirectory(options);
  if (legacy === undefined || legacy === root || !(await exists(legacy))) return { migrated: false, root };
  const paths = managedPaths(options);
  if (await exists(root)) {
    if (migrationRecorded(paths.applicationDatabase, legacy)) return { migrated: false, root };
    throw new Error(
      `Managed data exists at both ${root} and the former default ${legacy}. ` +
        `Remove or rename whichever directory is not the real installation, then run ambient-agent again.`,
    );
  }
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
};
