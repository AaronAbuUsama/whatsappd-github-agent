import { execFile, spawn } from "node:child_process";
import { copyFile, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
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
const runtimeFixtureSource = fileURLToPath(new URL("../fixtures/packed-runtime.mjs", import.meta.url));
const runtimeFixture = join(root, "packed-runtime.mjs");
const fixtureEnvironment = {
  ...environment,
  GH_TOKEN: "packed-github-secret",
  NODE_OPTIONS: [environment.NODE_OPTIONS, `--import=${runtimeFixture}`].filter(Boolean).join(" "),
};
const executeAmbientAgent = (args: string[], env: NodeJS.ProcessEnv = environment) =>
  process.platform === "win32"
    ? execute(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", executable, ...args], {
        cwd: homeDirectory,
        env,
      })
    : execute(executable, args, { cwd: homeDirectory, env });

const availablePort = async (): Promise<number> =>
  await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") return reject(new Error("Could not allocate a test port."));
      server.close((cause) => (cause === undefined ? resolve(address.port) : reject(cause)));
    });
  });
beforeAll(async () => {
  await Promise.all([
    mkdir(packDirectory, { recursive: true }),
    mkdir(installDirectory, { recursive: true }),
    mkdir(homeDirectory, { recursive: true }),
    copyFile(runtimeFixtureSource, runtimeFixture),
  ]);
  await execute("npm", ["pack", "--pack-destination", packDirectory], {
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
    const installedManifest = JSON.parse(
      await readFile(join(installDirectory, "node_modules", "ambient-agent", "package.json"), "utf8"),
    ) as { readonly bin?: unknown };
    expect(installedManifest.bin).toEqual({ "ambient-agent": "dist/cli/main.js" });
    const installedEntry = join(installDirectory, "node_modules", "ambient-agent", "dist", "cli", "main.js");
    expect((await readFile(installedEntry, "utf8")).startsWith("#!/usr/bin/env node\n")).toBe(true);
    if (process.platform !== "win32") expect((await stat(installedEntry)).mode & 0o111).not.toBe(0);
    await expect(executeAmbientAgent(["--help"])).resolves.toMatchObject({
      stdout: expect.stringContaining("Install and operate the Ambient Agent managed runtime"),
    });
  });

  it("resolves the installed production runtime dependencies without test hooks or a checkout", async () => {
    const script = [
      'import("whatsappd")',
      'import("@octokit/rest")',
      'import("@flue/runtime/node")',
      'import("@flue/github")',
      'import("@earendil-works/pi-ai/compat")',
    ].join(",");
    const packageDirectory = join(installDirectory, "node_modules", "ambient-agent");
    const probe = join(packageDirectory, "dependency-smoke.mjs");
    await writeFile(probe, `await Promise.all([${script}]);\n`);
    await execute(process.execPath, [probe], {
      cwd: homeDirectory,
      env: environment,
    });
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

  it("completes clean setup and reaches the production server from the installed tarball", async () => {
    if (process.platform === "win32") return;
    const dataDirectory = join(root, "clean-journey");
    const initialized = await executeAmbientAgent(
      ["--data-dir", dataDirectory, "init", "--authorize", "--chat", "120363000@g.us", "--repository", "owner/repo"],
      fixtureEnvironment,
    );
    expect(initialized.stdout).toContain("Created secure managed installation");
    expect(initialized.stdout).toContain("PACK-TEST");
    expect(initialized.stdout).not.toContain("packed-github-secret");

    const status = await executeAmbientAgent(["--data-dir", dataDirectory, "status", "--json"], fixtureEnvironment);
    expect(JSON.parse(status.stdout)).toMatchObject({
      state: "configured",
      runtimeState: "stopped",
      modelAuthentication: { state: "ready" },
      checks: [
        { name: "application-database", state: "ready" },
        { name: "flue-database", state: "ready" },
        { name: "whatsapp-session", state: "ready" },
      ],
    });

    const port = await availablePort();
    await executeAmbientAgent(["--data-dir", dataDirectory, "config", "--port", String(port)], fixtureEnvironment);
    const child = spawn(executable, ["--data-dir", dataDirectory, "start"], {
      cwd: homeDirectory,
      env: { ...fixtureEnvironment, PORT: "65535" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += String(chunk)));
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
      child.once("exit", (code, signal) => resolve({ code, signal })),
    );

    let health: unknown;
    try {
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        if (child.exitCode !== null)
          throw new Error(`Packed runtime exited early (${child.exitCode}).\n${stdout}\n${stderr}`);
        try {
          const response = await fetch(`http://127.0.0.1:${port}/health`);
          if (response.ok) {
            health = await response.json();
            if ((health as { readonly runtime?: { readonly state?: unknown } }).runtime?.state === "healthy") {
              break;
            }
          }
        } catch {
          // The foreground server has not bound its socket yet.
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(health).toMatchObject({
        ok: true,
        authentication: "chatgpt-oauth",
        runtime: { state: "healthy", whatsapp: { phase: "online" } },
      });
      expect(JSON.stringify(health)).not.toMatch(/chatTarget|botIds|private failure|packed-bot/);
      const liveStatus = await executeAmbientAgent(
        ["--data-dir", dataDirectory, "status", "--json"],
        fixtureEnvironment,
      );
      expect(JSON.parse(liveStatus.stdout)).toMatchObject({
        runtimeState: "healthy",
        observedRuntime: { state: "healthy", whatsapp: { phase: "online" } },
      });
      expect(stdout).toContain("Ambience WhatsApp online");
      expect(stderr).not.toContain("packed-github-secret");
    } finally {
      child.kill("SIGTERM");
      await exit;
    }
  }, 60_000);
});
