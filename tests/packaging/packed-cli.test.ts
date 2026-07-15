import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

const execute = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "ambient-agent-packed-"));
const packDirectory = join(root, "pack");
const installDirectory = join(root, "install");
const homeDirectory = join(root, "home");
const tarball = join(packDirectory, "ambient-agent-0.1.0.tgz");
const executable = join(
  installDirectory,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "ambient-agent.cmd" : "ambient-agent",
);
const environment = {
  ...process.env,
  HOME: homeDirectory,
  USERPROFILE: homeDirectory,
  XDG_DATA_HOME: join(homeDirectory, ".local", "share"),
  LOCALAPPDATA: join(homeDirectory, "AppData", "Local"),
  PATH: `${join(installDirectory, "node_modules", ".bin")}${delimiter}${process.env.PATH ?? ""}`,
  NODE_OPTIONS: process.env.NODE_OPTIONS,
};
const executeAmbientAgent = (args: string[]) =>
  process.platform === "win32"
    ? execute(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", executable, ...args], { env: environment })
    : execute(executable, args, { env: environment });
beforeAll(async () => {
  await Promise.all([
    mkdir(packDirectory, { recursive: true }),
    mkdir(installDirectory, { recursive: true }),
    mkdir(homeDirectory, { recursive: true }),
  ]);
  await execute("pnpm", ["pack", "--pack-destination", packDirectory], {
    cwd: process.cwd(),
    env: environment,
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  await execute("pnpm", ["add", "--dir", installDirectory, "--ignore-scripts", tarball], {
    cwd: process.cwd(),
    env: environment,
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
  });
}, 240_000);

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("packed ambient-agent executable", () => {
  it("is a normal executable Node npm bin produced by Vite+", async () => {
    const installedEntry = join(installDirectory, "node_modules", "ambient-agent", "dist", "cli", "main.js");
    expect((await readFile(installedEntry, "utf8")).startsWith("#!/usr/bin/env node\n")).toBe(true);
    if (process.platform !== "win32") expect((await stat(installedEntry)).mode & 0o111).not.toBe(0);
  });

  it("fails closed at the exact missing managed-auth prerequisite without promoting a partial install", async () => {
    await expect(executeAmbientAgent(["--data-dir", join(root, "non-interactive"), "init"])).rejects.toMatchObject({
      code: 1,
      stderr:
        process.platform === "win32"
          ? expect.stringContaining("ACLs are not implemented on Windows")
          : expect.stringContaining("existing valid managed ChatGPT credential"),
    });
    if (process.platform === "win32") return;
    await expect(
      executeAmbientAgent(["--data-dir", join(root, "non-interactive"), "status", "--json"]),
    ).rejects.toMatchObject({
      code: 2,
      stdout: expect.stringContaining('"state": "unconfigured"'),
    });
  });
});
