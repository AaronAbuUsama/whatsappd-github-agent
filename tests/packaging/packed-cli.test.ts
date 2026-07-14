import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { managedPaths } from "../../src/managed/paths.ts";

const execute = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "ambient-agent-packed-"));
const packDirectory = join(root, "pack");
const installDirectory = join(root, "install");
const homeDirectory = join(root, "home");
const tokenPath = join(root, "github-token.txt");
const oauthPreload = join(process.cwd(), "tests", "fixtures", "packed-oauth-fetch.cjs");
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
  NODE_OPTIONS: [process.env.NODE_OPTIONS, `--require=${oauthPreload}`].filter(Boolean).join(" "),
};
const executeAmbientAgent = (args: string[]) =>
  process.platform === "win32"
    ? execute(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", executable, ...args], { env: environment })
    : execute(executable, args, { env: environment });
const paths = managedPaths({
  platform: process.platform,
  homeDirectory,
  environment,
});

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
  await writeFile(tokenPath, "packed-github-secret\n", { mode: 0o600 });
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

  it("diagnoses a secure managed installation from the packed executable", async () => {
    if (process.platform === "win32") {
      await expect(executeAmbientAgent(["init"])).rejects.toMatchObject({
        code: 1,
        stderr: expect.stringContaining("Non-interactive init requires"),
      });
      return;
    }
    const init = await executeAmbientAgent([
      "init",
      "--chat",
      "120363000@g.us",
      "--repository",
      "owner/repo",
      "--github-token-file",
      tokenPath,
    ]);
    expect(init.stdout).toContain("PACK-TEST");
    expect(init.stdout).toContain("Created secure managed installation");

    const status = await executeAmbientAgent(["status", "--json"]);
    expect(JSON.parse(status.stdout)).toMatchObject({
      state: "configured",
      dataDirectory: paths.root,
    });
    const config = await readFile(paths.config, "utf8");
    expect(config).not.toContain("packed-github-secret");
    expect(config).not.toContain("packed-refresh-secret");
    expect((await stat(paths.root)).mode & 0o777).toBe(0o700);
    expect((await stat(paths.githubCredential)).mode & 0o777).toBe(0o600);
    expect((await stat(paths.chatGptOAuthCredential)).mode & 0o777).toBe(0o600);

    const second = await executeAmbientAgent(["init"]);
    expect(second.stdout).toContain("no files changed");

    await writeFile(paths.config, "invalid json", "utf8");
    await chmod(paths.config, 0o600);
    await expect(executeAmbientAgent(["doctor", "--json"])).rejects.toMatchObject({
      code: 1,
      stdout: expect.stringContaining('"state": "damaged"'),
    });
  });

  it("fails promptly instead of prompting when scripted init values are missing", async () => {
    if (process.platform === "win32") return;
    await expect(
      executeAmbientAgent(["--data-dir", join(root, "non-interactive"), "init"]),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("Non-interactive init requires"),
    });
  });
});
