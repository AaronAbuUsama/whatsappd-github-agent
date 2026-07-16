import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { migrateLegacyManagedData } from "../../src/managed/migration.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const home = async (): Promise<string> => {
  const directory = await mkdtemp(join(tmpdir(), "ambient-agent-migration-"));
  roots.push(directory);
  return directory;
};

const environment = (homeDirectory: string) =>
  ({ platform: "linux", homeDirectory, environment: {} }) as const;

const legacyPath = (homeDirectory: string): string => join(homeDirectory, ".local", "share", "ambient-agent");
const newPath = (homeDirectory: string): string => join(homeDirectory, ".ambient-agent");

const populateLegacy = async (homeDirectory: string): Promise<string> => {
  const legacy = legacyPath(homeDirectory);
  await mkdir(join(legacy, "credentials"), { recursive: true, mode: 0o700 });
  await mkdir(join(legacy, "whatsapp", "nested"), { recursive: true, mode: 0o700 });
  await writeFile(join(legacy, "credentials", "github.json"), "{}", { mode: 0o600 });
  await writeFile(join(legacy, "whatsapp", "nested", "creds.json"), '{"registered":true}', { mode: 0o600 });
  await writeFile(join(legacy, "application.sqlite"), "", { mode: 0o600 });
  const database = new DatabaseSync(join(legacy, "application.sqlite"));
  database.exec("CREATE TABLE proof (value TEXT)");
  database.prepare("INSERT INTO proof (value) VALUES (?)").run("survives-migration");
  database.close();
  return legacy;
};

const recordedSources = (applicationDatabase: string): string[] => {
  const database = new DatabaseSync(applicationDatabase, { readOnly: true });
  try {
    return database
      .prepare("SELECT source FROM managed_root_migrations")
      .all()
      .map((row) => String((row as { source: unknown }).source));
  } finally {
    database.close();
  }
};

describe("managed data migration", () => {
  it("does nothing on a clean machine or under a dataDirectory override", async () => {
    const homeDirectory = await home();
    await expect(migrateLegacyManagedData(environment(homeDirectory))).resolves.toEqual({
      migrated: false,
      root: newPath(homeDirectory),
    });
    await populateLegacy(homeDirectory);
    const override = join(homeDirectory, "override");
    await expect(
      migrateLegacyManagedData({ ...environment(homeDirectory), dataDirectory: override }),
    ).resolves.toEqual({ migrated: false, root: override });
    await expect(lstat(legacyPath(homeDirectory))).resolves.toBeDefined();
  });

  it("adopts a legacy installation atomically via rename and records the move", async () => {
    const homeDirectory = await home();
    const legacy = await populateLegacy(homeDirectory);
    const result = await migrateLegacyManagedData(environment(homeDirectory));
    expect(result).toEqual({ migrated: true, root: newPath(homeDirectory), source: legacy });
    await expect(lstat(legacy)).rejects.toMatchObject({ code: "ENOENT" });
    const migrated = newPath(homeDirectory);
    await expect(readFile(join(migrated, "whatsapp", "nested", "creds.json"), "utf8")).resolves.toBe(
      '{"registered":true}',
    );
    expect(recordedSources(join(migrated, "application.sqlite"))).toEqual([legacy]);
    await expect(migrateLegacyManagedData(environment(homeDirectory))).resolves.toEqual({
      migrated: false,
      root: migrated,
    });
  });

  it("fails closed with both paths when both directories exist without a recorded migration", async () => {
    const homeDirectory = await home();
    const legacy = await populateLegacy(homeDirectory);
    await mkdir(newPath(homeDirectory), { mode: 0o700 });
    await expect(migrateLegacyManagedData(environment(homeDirectory))).rejects.toThrow(
      new RegExp(`${newPath(homeDirectory)}.*${legacy}`),
    );
    await expect(lstat(legacy)).resolves.toBeDefined();
    expect(await readdir(newPath(homeDirectory))).toEqual([]);
  });

  it("falls back to a staged fsynced copy on EXDEV, keeping the source as the backup", async () => {
    const homeDirectory = await home();
    const legacy = await populateLegacy(homeDirectory);
    const crossDeviceRename: typeof rename = async (source, target) => {
      if (String(source) === legacy) throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
      await rename(source, target);
    };
    const result = await migrateLegacyManagedData({ ...environment(homeDirectory), rename: crossDeviceRename });
    const migrated = newPath(homeDirectory);
    expect(result).toEqual({ migrated: true, root: migrated, source: legacy });
    await expect(readFile(join(legacy, "credentials", "github.json"), "utf8")).resolves.toBe("{}");
    expect((await lstat(migrated)).mode & 0o777).toBe(0o700);
    expect((await lstat(join(migrated, "credentials"))).mode & 0o777).toBe(0o700);
    expect((await lstat(join(migrated, "credentials", "github.json"))).mode & 0o777).toBe(0o600);
    expect((await lstat(join(migrated, "application.sqlite"))).mode & 0o777).toBe(0o600);
    const database = new DatabaseSync(join(migrated, "application.sqlite"), { readOnly: true });
    expect(database.prepare("SELECT value FROM proof").get()).toEqual({ value: "survives-migration" });
    database.close();
    expect(recordedSources(join(migrated, "application.sqlite"))).toEqual([legacy]);
    // Both directories now exist, but the record marks the legacy copy as the backup.
    await expect(migrateLegacyManagedData(environment(homeDirectory))).resolves.toEqual({
      migrated: false,
      root: migrated,
    });
    expect(await readdir(homeDirectory)).not.toContainEqual(expect.stringContaining(".staging-"));
  });

  it("cleans the staging directory and keeps the source intact when the copy cannot be promoted", async () => {
    const homeDirectory = await home();
    const legacy = await populateLegacy(homeDirectory);
    const failingRename: typeof rename = async (source) => {
      if (String(source) === legacy) throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
      throw new Error("promotion failed");
    };
    await expect(
      migrateLegacyManagedData({ ...environment(homeDirectory), rename: failingRename }),
    ).rejects.toThrow("promotion failed");
    await expect(lstat(newPath(homeDirectory))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(join(legacy, "credentials", "github.json"), "utf8")).resolves.toBe("{}");
    expect(await readdir(homeDirectory)).not.toContainEqual(expect.stringContaining(".staging-"));
  });
});
