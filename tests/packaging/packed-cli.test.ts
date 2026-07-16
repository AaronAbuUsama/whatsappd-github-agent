import { execFile, spawn } from "node:child_process";
import { copyFile, cp, mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { sqlite } from "@flue/runtime/node";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import { createIssueOperationStore } from "../../src/capabilities/issue-management/operation-store.ts";
import { createConversationArchive } from "../../src/intake/conversation-archive.ts";
import { conversationArrival } from "../../src/intake/conversation-event.ts";
import { createManagedChatInbox } from "../../src/intake/managed-chat-inbox.ts";
import { inspectManagedData } from "../../src/managed/installation.ts";
import { managedPaths } from "../../src/managed/paths.ts";
import type { InboundMessage } from "whatsappd";

const execute = promisify(execFile);
const root = await mkdtemp(join(tmpdir(), "ambient-agent-packed-"));
const packDirectory = join(root, "pack");
const installDirectory = join(root, "install");
const homeDirectory = join(root, "home");
let tarball: string;
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

// Binds the wildcard address, like the generated server does, so a reported port is
// genuinely free for the runtime and not merely free on loopback.
const availablePort = async (): Promise<number> =>
  await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, () => {
      const address = server.address();
      if (address === null || typeof address === "string") return reject(new Error("Could not allocate a test port."));
      server.close((cause) => (cause === undefined ? resolve(address.port) : reject(cause)));
    });
  });

const startPackedRuntime = async (
  dataDirectory: string,
  port: number,
  env: NodeJS.ProcessEnv = fixtureEnvironment,
  cwd = homeDirectory,
) => {
  const child = spawn(executable, ["--data-dir", dataDirectory, "start"], {
    cwd,
    env: { ...env, PORT: "65535" },
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
          if ((health as { readonly runtime?: { readonly state?: unknown } }).runtime?.state === "healthy") break;
        }
      } catch {
        // The foreground server has not bound its configured socket yet.
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(health).toMatchObject({ runtime: { state: "healthy", whatsapp: { phase: "online" } } });
  } catch (cause) {
    child.kill("SIGTERM");
    await exit;
    throw cause;
  }
  return {
    origin: `http://127.0.0.1:${port}`,
    health,
    stdout: () => stdout,
    stderr: () => stderr,
    stop: async () => {
      if (child.exitCode === null) child.kill("SIGTERM");
      await exit;
    },
  };
};

const waitForCanonicalAgentText = async (databasePath: string, chatId: string, expected: string): Promise<string> => {
  const adapter = sqlite(databasePath);
  try {
    const { conversationStreamStore } = await adapter.connect();
    const deadline = Date.now() + 15_000;
    let observed = "";
    while (Date.now() < deadline) {
      const page = await conversationStreamStore.read(`agents/ambience/${chatId}`, { offset: "-1", limit: 1_000 });
      observed = page.batches.flatMap(({ records }) => records.map((record) => JSON.stringify(record))).join("\n");
      if (observed.includes(expected)) return observed;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Canonical Ambience history did not contain ${expected}. Observed:\n${observed}`);
  } finally {
    await adapter.close?.();
  }
};
beforeAll(async () => {
  await Promise.all([
    mkdir(packDirectory, { recursive: true }),
    mkdir(installDirectory, { recursive: true }),
    mkdir(homeDirectory, { recursive: true }),
    copyFile(runtimeFixtureSource, runtimeFixture),
  ]);
  const packed = await execute("npm", ["pack", "--pack-destination", packDirectory], {
    cwd: process.cwd(),
    env: environment,
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
  });
  const packedFilename = packed.stdout.trim().split(/\r?\n/).at(-1);
  if (!packedFilename?.endsWith(".tgz")) throw new Error("npm pack did not report the generated tarball filename.");
  tarball = join(packDirectory, packedFilename);
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
    ) as { readonly bin?: unknown; readonly version: string };
    expect(installedManifest.bin).toEqual({ "ambient-agent": "dist/cli/main.js" });
    const installedEntry = join(installDirectory, "node_modules", "ambient-agent", "dist", "cli", "main.js");
    expect((await readFile(installedEntry, "utf8")).startsWith("#!/usr/bin/env node\n")).toBe(true);
    if (process.platform !== "win32") expect((await stat(installedEntry)).mode & 0o111).not.toBe(0);
    await expect(executeAmbientAgent(["--help"])).resolves.toMatchObject({
      stdout: expect.stringContaining("Install and operate the Ambient Agent managed runtime"),
    });
    await expect(executeAmbientAgent(["--version"])).resolves.toMatchObject({
      stdout: `${installedManifest.version}\n`,
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
    const runtime = await startPackedRuntime(dataDirectory, port);
    try {
      expect(runtime.health).toMatchObject({
        ok: true,
        authentication: "chatgpt-oauth",
        runtime: { state: "healthy", whatsapp: { phase: "online" } },
      });
      expect(JSON.stringify(runtime.health)).not.toMatch(/chatTarget|botIds|private failure|packed-/);
      const liveStatus = await executeAmbientAgent(
        ["--data-dir", dataDirectory, "status", "--json"],
        fixtureEnvironment,
      );
      expect(JSON.parse(liveStatus.stdout)).toMatchObject({
        runtimeState: "healthy",
        observedRuntime: { state: "healthy", whatsapp: { phase: "online" } },
      });
      // Runtime diagnostics live on stderr (ADR 0016); stdout stays free for command responses.
      expect(runtime.stderr()).toContain("Ambience WhatsApp online");
      expect(runtime.stderr()).not.toContain("packed-github-secret");
    } finally {
      await runtime.stop();
    }
  }, 60_000);

  it("adopts a legacy platform-native installation into ~/.ambient-agent on first run", async () => {
    if (process.platform === "win32") return;
    const migrationHome = join(root, "migration-home");
    const legacyData =
      process.platform === "darwin"
        ? join(migrationHome, "Library", "Application Support", "ambient-agent")
        : join(migrationHome, ".local", "share", "ambient-agent");
    const adoptedData = join(migrationHome, ".ambient-agent");
    const migrationEnvironment = {
      ...fixtureEnvironment,
      HOME: migrationHome,
      USERPROFILE: migrationHome,
      XDG_DATA_HOME: join(migrationHome, ".local", "share"),
    };
    await mkdir(migrationHome, { recursive: true });
    await executeAmbientAgent(
      ["--data-dir", legacyData, "init", "--authorize", "--chat", "120363000@g.us", "--repository", "owner/repo"],
      migrationEnvironment,
    );

    const migrated = await executeAmbientAgent(["status", "--json"], migrationEnvironment);
    expect(migrated.stderr).toContain(`Moved managed data from ${legacyData} to ${adoptedData}.`);
    expect(JSON.parse(migrated.stdout)).toMatchObject({
      state: "configured",
      dataDirectory: adoptedData,
      modelAuthentication: { state: "ready" },
    });
    await expect(stat(legacyData)).rejects.toMatchObject({ code: "ENOENT" });
    const adoptedPaths = managedPaths({ dataDirectory: adoptedData });
    expect((await stat(adoptedData)).mode & 0o777).toBe(0o700);
    expect((await stat(adoptedPaths.githubCredential)).mode & 0o777).toBe(0o600);
    const record = new DatabaseSync(adoptedPaths.applicationDatabase, { readOnly: true });
    expect(record.prepare("SELECT source FROM managed_root_migrations").all()).toEqual([{ source: legacyData }]);
    record.close();

    const settled = await executeAmbientAgent(["status", "--json"], migrationEnvironment);
    expect(settled.stderr).not.toContain("Moved managed data");
    expect(JSON.parse(settled.stdout)).toMatchObject({ state: "configured", dataDirectory: adoptedData });

    const conflictedHome = join(root, "conflicted-home");
    const conflictedLegacy =
      process.platform === "darwin"
        ? join(conflictedHome, "Library", "Application Support", "ambient-agent")
        : join(conflictedHome, ".local", "share", "ambient-agent");
    await mkdir(conflictedLegacy, { recursive: true, mode: 0o700 });
    await mkdir(join(conflictedHome, ".ambient-agent"), { recursive: true, mode: 0o700 });
    await expect(
      executeAmbientAgent(["status"], {
        ...migrationEnvironment,
        HOME: conflictedHome,
        USERPROFILE: conflictedHome,
        XDG_DATA_HOME: join(conflictedHome, ".local", "share"),
      }),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining(conflictedLegacy),
    });
    await expect(stat(conflictedLegacy)).resolves.toBeDefined();
  }, 60_000);

  // #87 regression. This proves, against the packed runtime on the real startup path: an
  // occupied configured port makes `ambient-agent start` exit nonzero with one actionable
  // message naming the port and the `config --port` remediation; the WhatsApp runtime never
  // transitions online (the fixture would deliver PACKED_WHATSAPP_INPUT and create an
  // admission if it did); the process does not linger, and once the blocking listener is
  // released nothing is left bound to the port. Still requiring a live WhatsApp/VPS check:
  // that a real Baileys socket (not the fixture) is likewise never opened before the bind,
  // and operator-shaped port collisions with other real services on the VPS.
  it("exits nonzero and starts nothing when the configured port is already occupied", async () => {
    if (process.platform === "win32") return;
    const dataDirectory = join(root, "occupied-port");
    await executeAmbientAgent(
      ["--data-dir", dataDirectory, "init", "--authorize", "--chat", "120363000@g.us", "--repository", "owner/repo"],
      fixtureEnvironment,
    );
    const port = await availablePort();
    await executeAmbientAgent(["--data-dir", dataDirectory, "config", "--port", String(port)], fixtureEnvironment);

    // Bind the wildcard address, exactly like the generated server does, so the
    // collision reproduces on every platform.
    const blocker = createServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once("error", reject);
      blocker.listen(port, resolve);
    });
    try {
      const failure = (await executeAmbientAgent(["--data-dir", dataDirectory, "start"], {
        ...fixtureEnvironment,
        PACKED_WHATSAPP_INPUT: "OCCUPIED_PORT_87",
        PACKED_WHATSAPP_MESSAGE_ID: "occupied-port-87",
      }).then(
        () => {
          throw new Error("ambient-agent start succeeded although the configured port was occupied.");
        },
        (cause) => cause,
      )) as { code: number; stdout: string; stderr: string };
      expect(failure.code).toBe(1);
      expect(failure.stderr).toContain(`Port ${port} is already in use`);
      expect(failure.stderr).toContain("ambient-agent config --port");
      expect(failure.stdout + failure.stderr).not.toContain("Ambience WhatsApp online");
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
    }

    // The port is provably free again: binding it succeeds, so the failed start left no listener.
    const probe = createServer();
    await new Promise<void>((resolve, reject) => {
      probe.once("error", reject);
      probe.listen(port, resolve);
    });
    await new Promise((resolve) => probe.close(resolve));

    const paths = managedPaths({ dataDirectory });
    const archive = createConversationArchive(paths.applicationDatabase);
    const inbox = createManagedChatInbox(archive, { allowed: () => true });
    try {
      expect(archive.readThread("120363000@g.us")).toEqual([]);
      expect(inbox.unwindowed()).toEqual([]);
      for (const status of ["pending", "done", "failed"] as const) {
        expect(inbox.admissions(status)).toEqual([]);
      }
    } finally {
      archive.close();
    }
  }, 60_000);

  it("replaces a stopped installation in a fresh home without losing owned state or canonical chat continuity", async () => {
    if (process.platform === "win32") return;
    const chatId = "120363000@g.us";
    const sourceHome = join(root, "backup-source-home");
    const sourceData = join(sourceHome, "managed");
    const backupRoot = join(root, "operator-backup");
    const backupSnapshot = join(backupRoot, "managed");
    const restoredHome = join(root, "backup-restored-home");
    const restoredData = join(restoredHome, "managed");
    const incompatibleData = join(restoredHome, "incompatible-managed");
    const restoredEnvironment = {
      ...fixtureEnvironment,
      HOME: restoredHome,
      USERPROFILE: restoredHome,
      XDG_DATA_HOME: join(restoredHome, ".local", "share"),
      LOCALAPPDATA: join(restoredHome, "AppData", "Local"),
    };
    await Promise.all([
      mkdir(sourceHome, { recursive: true }),
      mkdir(backupRoot, { recursive: true }),
      mkdir(restoredHome, { recursive: true }),
    ]);
    await writeFile(join(sourceHome, "unrelated-machine-state"), "must not be copied");

    await executeAmbientAgent(
      ["--data-dir", sourceData, "init", "--authorize", "--chat", chatId, "--repository", "owner/repo"],
      fixtureEnvironment,
    );
    const sourcePaths = managedPaths({ dataDirectory: sourceData });
    const sourceWhatsAppCredential = await readFile(join(sourcePaths.whatsapp, "creds.json"), "utf8");
    const sourceIdentity = (
      JSON.parse(sourceWhatsAppCredential) as {
        readonly identity: { readonly jid: string; readonly lid: string };
      }
    ).identity;
    const sourcePort = await availablePort();
    await executeAmbientAgent(["--data-dir", sourceData, "config", "--port", String(sourcePort)], fixtureEnvironment);
    const sourceRuntime = await startPackedRuntime(sourceData, sourcePort, {
      ...fixtureEnvironment,
      PACKED_WHATSAPP_INPUT: "BEFORE_BACKUP_58",
      PACKED_WHATSAPP_MESSAGE_ID: "before-backup-58",
    });
    try {
      expect(sourceRuntime.stderr()).toContain(sourceIdentity.jid);
      await waitForCanonicalAgentText(sourcePaths.flueDatabase, chatId, "BEFORE_BACKUP_58");
    } finally {
      await sourceRuntime.stop();
    }

    const sourceArchive = createConversationArchive(sourcePaths.applicationDatabase);
    const sourceInbox = createManagedChatInbox(sourceArchive, {
      allowed: () => true,
      createId: () => "backup-terminal-window",
      now: () => 58_000,
    });
    const arrival = (id: string, text: string, timestamp: number): InboundMessage =>
      ({
        id,
        chatId,
        from: "15550000058@s.whatsapp.net",
        pushName: "Backup proof",
        fromMe: false,
        timestamp,
        live: true,
        isGroup: true,
        kind: "text",
        text,
      }) as InboundMessage;
    sourceInbox.recorder.append(conversationArrival(arrival("backup-terminal", "terminal archive fact", 58_001)));
    const terminalWindow = sourceInbox.createWindow({
      chatId,
      messages: sourceInbox.unwindowed(),
      reason: "debounce",
    });
    sourceInbox.markDone(terminalWindow.id, {
      dispatchId: "backup-terminal-dispatch",
      acceptedAt: "2026-07-15T08:58:00.000Z",
    });
    sourceInbox.recorder.append(conversationArrival(arrival("backup-pending", "pending archive fact", 58_002)));
    sourceArchive.close();

    const sourceOperations = createIssueOperationStore(sourcePaths.applicationDatabase);
    sourceOperations.begin({
      operationId: "backup-operation-identity",
      kind: "update-issue",
      repository: "owner/repo",
      issueNumber: 58,
      target: { title: "Portable managed installation" },
      startedAt: "2026-07-15T08:58:01.000Z",
    });
    sourceOperations.complete("backup-operation-identity", 58, "2026-07-15T08:58:02.000Z");
    sourceOperations.close();

    await cp(sourceData, backupSnapshot, { recursive: true, preserveTimestamps: true });
    await cp(backupSnapshot, restoredData, { recursive: true, preserveTimestamps: true });
    await cp(backupSnapshot, incompatibleData, { recursive: true, preserveTimestamps: true });
    await expect(stat(join(backupRoot, "unrelated-machine-state"))).rejects.toMatchObject({ code: "ENOENT" });

    const incompatibleDatabase = new DatabaseSync(
      managedPaths({ dataDirectory: incompatibleData }).applicationDatabase,
    );
    incompatibleDatabase.exec("PRAGMA user_version = 2");
    incompatibleDatabase.close();
    await expect(
      executeAmbientAgent(["--data-dir", incompatibleData, "doctor", "--json"], restoredEnvironment),
    ).rejects.toMatchObject({
      code: 1,
      stdout: expect.stringContaining('"code": "database.schema-incompatible"'),
    });
    await expect(
      executeAmbientAgent(["--data-dir", incompatibleData, "start"], restoredEnvironment),
    ).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("database.schema-incompatible"),
    });

    const restoredPaths = managedPaths({ dataDirectory: restoredData });
    expect(await inspectManagedData({ dataDirectory: restoredData })).toMatchObject({ state: "configured" });
    expect((await stat(restoredData)).mode & 0o777).toBe(0o700);
    for (const privateFile of [
      restoredPaths.config,
      restoredPaths.githubCredential,
      restoredPaths.chatGptOAuthCredential,
      restoredPaths.applicationDatabase,
      restoredPaths.flueDatabase,
    ]) {
      expect((await stat(privateFile)).mode & 0o777).toBe(0o600);
    }
    await expect(readFile(join(restoredPaths.whatsapp, "creds.json"), "utf8")).resolves.toBe(sourceWhatsAppCredential);

    const restoredStatus = await executeAmbientAgent(
      ["--data-dir", restoredData, "status", "--json"],
      restoredEnvironment,
    );
    expect(JSON.parse(restoredStatus.stdout)).toMatchObject({ state: "configured", runtimeState: "stopped" });
    const restoredDoctor = await executeAmbientAgent(
      ["--data-dir", restoredData, "doctor", "--json"],
      restoredEnvironment,
    );
    expect(JSON.parse(restoredDoctor.stdout)).toMatchObject({ state: "configured", runtimeState: "configured" });

    const restoredSnapshot = new DatabaseSync(restoredPaths.applicationDatabase, { readOnly: true });
    expect(
      restoredSnapshot
        .prepare("SELECT text FROM conversation_messages WHERE chat_id = ? ORDER BY timestamp_ms, message_id")
        .all(chatId),
    ).toEqual([{ text: "terminal archive fact" }, { text: "pending archive fact" }, { text: "BEFORE_BACKUP_58" }]);
    expect(
      restoredSnapshot
        .prepare(`
          SELECT e.provider_message_id
            FROM managed_chat_inbox i
            JOIN conversation_events e ON e.event_id = i.event_id
           WHERE i.window_id IS NULL
           ORDER BY i.inbox_sequence
        `)
        .all(),
    ).toEqual([{ provider_message_id: "backup-pending" }]);
    expect(
      restoredSnapshot
        .prepare(`
          SELECT status, window_id, dispatch_id, accepted_at
            FROM managed_chat_admissions
           WHERE window_id = 'backup-terminal-window'
        `)
        .get(),
    ).toEqual({
      status: "done",
      window_id: "backup-terminal-window",
      dispatch_id: "backup-terminal-dispatch",
      accepted_at: "2026-07-15T08:58:00.000Z",
    });
    expect(
      restoredSnapshot
        .prepare(`
          SELECT status, issue_number, target_json
            FROM github_issue_operations
           WHERE operation_id = 'backup-operation-identity'
        `)
        .get(),
    ).toEqual({
      status: "completed",
      issue_number: 58,
      target_json: JSON.stringify({ title: "Portable managed installation" }),
    });
    restoredSnapshot.close();

    const restoredPort = sourcePort;
    const restoredRuntime = await startPackedRuntime(
      restoredData,
      restoredPort,
      {
        ...restoredEnvironment,
        PACKED_WHATSAPP_INPUT: "AFTER_RESTORE_58",
        PACKED_WHATSAPP_MESSAGE_ID: "after-restore-58",
      },
      restoredHome,
    );
    try {
      expect(restoredRuntime.stderr()).toContain(sourceIdentity.jid);
      const restoredHistory = await waitForCanonicalAgentText(restoredPaths.flueDatabase, chatId, "AFTER_RESTORE_58");
      expect(restoredHistory).toContain("BEFORE_BACKUP_58");
      expect(restoredHistory).toContain("AFTER_RESTORE_58");
    } finally {
      await restoredRuntime.stop();
    }

    const restoredArchive = createConversationArchive(restoredPaths.applicationDatabase);
    const restoredInbox = createManagedChatInbox(restoredArchive, { allowed: () => true });
    expect(restoredArchive.readThread(chatId).map(({ text }) => text)).toEqual([
      "terminal archive fact",
      "pending archive fact",
      "BEFORE_BACKUP_58",
      "AFTER_RESTORE_58",
    ]);
    expect(restoredInbox.unwindowed()).toEqual([]);
    expect(restoredInbox.admissions("done")).toHaveLength(3);
    expect(restoredInbox.admissions("done")).toContainEqual({
      status: "done",
      windowId: "backup-terminal-window",
      dispatchId: "backup-terminal-dispatch",
      acceptedAt: "2026-07-15T08:58:00.000Z",
    });
    restoredArchive.close();
    const restoredOperations = createIssueOperationStore(restoredPaths.applicationDatabase);
    expect(restoredOperations.get("backup-operation-identity")).toMatchObject({
      status: "completed",
      issueNumber: 58,
      target: { title: "Portable managed installation" },
    });
    restoredOperations.close();
  }, 90_000);
});
