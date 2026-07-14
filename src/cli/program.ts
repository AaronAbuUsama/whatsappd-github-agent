import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Command, CommanderError } from "@commander-js/extra-typings";
import * as prompts from "@clack/prompts";

import { inspectManagedData, installManagedData, type InstallationInspection } from "../managed/installation.js";
import { createManagedChatGptAuthentication } from "../managed/chatgpt-authentication.js";
import { managedPaths, type ManagedPaths } from "../managed/paths.js";
import { loadManagedRuntimeEnvironment } from "../managed/runtime-environment.js";
import { installManagedRuntimeDependencies } from "../managed/runtime-dependencies.js";
import {
  ChatGptAuthenticationError,
  type ChatGptOAuthAdapter,
  type ChatGptAuthentication,
  type ChatGptAuthenticationStatus,
  type DeviceCodeCallbacks,
} from "../model/chatgpt-authentication.js";
import {
  AMBIENCE_MODEL_SPECIFIER,
  ChatGptReadinessError,
  runChatGptReadinessCheck,
  type ChatGptReadinessReceipt,
} from "../model/pi-subscription.js";

export interface CliOutput {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

export interface SetupPrompts {
  readonly managedChat: () => Promise<string>;
  readonly repository: () => Promise<string>;
  readonly githubToken: () => Promise<string>;
}

export interface CliDependencies {
  readonly output?: CliOutput;
  readonly setupPrompts?: SetupPrompts;
  readonly interactive?: boolean;
  readonly startRuntime?: StartRuntime;
  readonly importRuntime?: ImportRuntime;
  readonly chatGptOAuth?: ChatGptOAuthAdapter;
  readonly signal?: AbortSignal;
  readonly readinessTimeoutMillis?: number;
  readonly readinessCheck?: (
    authentication: ChatGptAuthentication,
    signal?: AbortSignal,
  ) => Promise<ChatGptReadinessReceipt>;
}

export type StartRuntime = (paths: ManagedPaths) => Promise<void>;
export type ImportRuntime = (specifier: string) => Promise<unknown>;

const defaultOutput: CliOutput = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

const importRuntime: ImportRuntime = async (specifier) => await import(specifier);

const startGeneratedRuntime = async (
  paths: ManagedPaths,
  authentication: ChatGptAuthentication,
  importServer: ImportRuntime = importRuntime,
): Promise<void> => {
  installManagedRuntimeDependencies({ authentication });
  await loadManagedRuntimeEnvironment(paths);
  process.chdir(paths.root);
  const serverEntry = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "..", "server.mjs"));
  await importServer(serverEntry.href);
};

const requiredPrompt = async (label: string, prompt: () => Promise<string | symbol>): Promise<string> => {
  const value = await prompt();
  if (prompts.isCancel(value)) {
    prompts.cancel("Setup cancelled.");
    throw new Error("Setup cancelled.");
  }
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} is required.`);
  return trimmed;
};

const defaultSetupPrompts: SetupPrompts = {
  managedChat: () =>
    requiredPrompt("Managed chat", () =>
      prompts.text({
        message: "WhatsApp chat JID to manage",
        placeholder: "120363000000000000@g.us",
      }),
    ),
  repository: () =>
    requiredPrompt("Repository", () =>
      prompts.text({
        message: "Default GitHub repository",
        placeholder: "owner/repository",
      }),
    ),
  githubToken: () =>
    requiredPrompt("GitHub token", () =>
      prompts.password({
        message: "Fine-grained GitHub personal access token",
        mask: "*",
      }),
    ),
};

const renderInspection = (
  inspection: InstallationInspection,
  authentication: ChatGptAuthenticationStatus,
  liveCheck: ChatGptReadinessReceipt | undefined,
  json: boolean,
): string => {
  if (json) return `${JSON.stringify({ ...inspection, modelAuthentication: authentication, liveCheck }, null, 2)}\n`;
  const lines = [`Ambient Agent: ${inspection.state}`, `Data directory: ${inspection.dataDirectory}`];
  for (const item of inspection.diagnostics) {
    lines.push(`[${item.code}] ${item.message}`, `  Path: ${item.path}`, `  Fix: ${item.remediation}`);
  }
  lines.push(`ChatGPT authentication: ${authentication.state}`);
  if (authentication.state === "missing") {
    lines.push(
      inspection.state === "unconfigured"
        ? "  Fix: Run ambient-agent init."
        : "  Fix: Run ambient-agent auth to authenticate again.",
    );
  }
  if (authentication.state === "malformed")
    lines.push(`  ${authentication.message}`, "  Fix: Run ambient-agent auth to authenticate again.");
  if (authentication.state === "expired-refreshable") {
    lines.push("  Fix: Run ambient-agent doctor --refresh to rotate the managed credential.");
  }
  if (authentication.state === "unusable")
    lines.push(
      `  ${authentication.message}`,
      inspection.state === "damaged"
        ? "  Fix: Run ambient-agent doctor and repair the managed installation."
        : "  Fix: Run ambient-agent auth to authenticate again.",
    );
  if (liveCheck !== undefined) {
    lines.push(
      `ChatGPT live readiness: ${liveCheck.request}${liveCheck.reason === undefined ? "" : ` (${liveCheck.reason})`}`,
    );
  }
  return `${lines.join("\n")}\n`;
};

const readGitHubToken = async (path: string): Promise<string> => {
  try {
    const token = (await readFile(path, "utf8")).trim();
    if (!token) throw new Error("empty");
    return token;
  } catch {
    throw new Error(`Could not read a non-empty GitHub token from ${path}.`);
  }
};

const bareDataDirectory = (args: readonly string[]): { readonly dataDirectory?: string } | undefined => {
  if (args.some((arg) => arg === "--help" || arg === "-h" || arg === "--version" || arg === "-V")) return undefined;
  let dataDirectory: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--data-dir") {
      const value = args[index + 1];
      if (value === undefined) return undefined;
      dataDirectory = value;
      index += 1;
      continue;
    }
    if (arg.startsWith("--data-dir=")) {
      dataDirectory = arg.slice("--data-dir=".length);
      continue;
    }
    return undefined;
  }
  return dataDirectory === undefined ? {} : { dataDirectory };
};

export const runCli = async (argv: readonly string[], dependencies: CliDependencies = {}): Promise<number> => {
  const output = dependencies.output ?? defaultOutput;
  const setupPrompts = dependencies.setupPrompts ?? defaultSetupPrompts;
  const interactive =
    dependencies.interactive ??
    (dependencies.setupPrompts !== undefined || (process.stdin.isTTY === true && process.stdout.isTTY === true));
  const authenticationFor = (paths: ManagedPaths) =>
    createManagedChatGptAuthentication(paths, dependencies.chatGptOAuth);
  const startRuntime =
    dependencies.startRuntime ??
    ((paths: ManagedPaths) => startGeneratedRuntime(paths, authenticationFor(paths), dependencies.importRuntime));
  const operationSignal = (timeoutMillis: number): AbortSignal => {
    const timeout = AbortSignal.timeout(timeoutMillis);
    return dependencies.signal === undefined ? timeout : AbortSignal.any([dependencies.signal, timeout]);
  };
  const authenticationSignal = (): AbortSignal => operationSignal(20 * 60 * 1_000);
  const readinessSignal = (): AbortSignal => operationSignal(dependencies.readinessTimeoutMillis ?? 60_000);
  const credentialDamageOnly = (inspection: InstallationInspection, paths: ManagedPaths): boolean => {
    if (inspection.state !== "damaged" || inspection.diagnostics.length === 0) return false;
    const credentialPaths = new Set([paths.chatGptOAuthCredential, paths.legacyPiAuthCredential]);
    const repairableCodes = new Set([
      "path.missing-file",
      "permissions.file",
      "json.invalid",
      "schema.invalid",
      "file.too-large",
      "file.changed-during-read",
    ]);
    return inspection.diagnostics.every(
      (item) => credentialPaths.has(item.path) && repairableCodes.has(item.code),
    );
  };
  const deviceCodeCallbacks: DeviceCodeCallbacks = {
    onDeviceCode: (info) => {
      output.stdout(`Open ${info.verificationUri} and enter code ${info.userCode}.\n`);
      if (info.expiresInSeconds !== undefined) {
        output.stdout(`The device code expires in ${info.expiresInSeconds} seconds.\n`);
      }
    },
    onProgress: ({ phase }) => {
      output.stdout(
        phase === "waiting" ? "Waiting for ChatGPT authorization...\n" : "ChatGPT authorization complete.\n",
      );
    },
  };
  let exitCode = 0;
  const program = new Command()
    .name("ambient-agent")
    .description("Install and operate the Ambient Agent managed runtime")
    .version("0.1.0")
    .option("--data-dir <path>", "override the managed data directory")
    .configureOutput({ writeOut: output.stdout, writeErr: output.stderr })
    .exitOverride();
  const reportInspection = async (
    json: boolean,
    refresh: boolean = false,
    live: boolean = false,
  ): Promise<{
    readonly installation: InstallationInspection;
    readonly authentication: ChatGptAuthenticationStatus;
    readonly liveCheck?: ChatGptReadinessReceipt;
  }> => {
    const paths = managedPaths({ dataDirectory: program.opts().dataDir });
    const inspection = await inspectManagedData({ dataDirectory: paths.root });
    const authenticationSafe = inspection.state === "configured" || credentialDamageOnly(inspection, paths);
    const authentication = authenticationSafe ? authenticationFor(paths) : undefined;
    let authenticationStatus: ChatGptAuthenticationStatus =
      inspection.state === "unconfigured"
        ? { state: "missing" }
        : !authenticationSafe
          ? {
              state: "unusable",
              message: "ChatGPT authentication was not inspected because the managed installation is damaged.",
            }
          : await authentication!.inspect();
    if (refresh && authenticationStatus.state === "expired-refreshable") {
      try {
        await authentication!.authorization(readinessSignal());
      } catch (cause) {
        if (
          cause instanceof ChatGptAuthenticationError &&
          (cause.code === "timeout" || cause.code === "cancelled")
        ) {
          throw cause;
        }
        // inspect() reports the sanitized unusable state from the same service instance.
      }
      authenticationStatus = await authentication!.inspect();
    }
    let liveCheck: ChatGptReadinessReceipt | undefined;
    if (live && authenticationStatus.state === "ready") {
      try {
        liveCheck = await (
          dependencies.readinessCheck ?? ((service, signal) => runChatGptReadinessCheck(service, { signal }))
        )(authentication!, readinessSignal());
      } catch (cause) {
        const failure =
          cause instanceof ChatGptReadinessError
            ? cause
            : new ChatGptReadinessError(
                "request-failed",
                "The ChatGPT live readiness request failed; retry when the service is reachable.",
                { cause },
              );
        liveCheck = { model: AMBIENCE_MODEL_SPECIFIER, request: "failed", reason: failure.code };
        if (failure.code === "credential-rejected") {
          authenticationStatus = { state: "unusable", message: failure.message };
        }
      }
    }
    output.stdout(renderInspection(inspection, authenticationStatus, liveCheck, json));
    return { installation: inspection, authentication: authenticationStatus, liveCheck };
  };

  program
    .command("init")
    .description("create a secure managed installation")
    .option("--chat <jid>", "managed WhatsApp chat JID")
    .option("--repository <owner/name>", "default GitHub repository")
    .option("--github-token-file <path>", "read the GitHub token from a file")
    .action(async (options) => {
      const global = program.opts();
      const current = await inspectManagedData({ dataDirectory: global.dataDir });
      if (current.state === "configured") {
        output.stdout(`Managed installation already configured at ${current.dataDirectory}; no files changed.\n`);
        return;
      }
      if (current.state === "damaged") {
        throw new Error(
          `Refusing to replace damaged managed data at ${current.dataDirectory}; run ambient-agent doctor.`,
        );
      }
      if (!interactive) {
        const missing = [
          options.chat === undefined ? "--chat" : undefined,
          options.repository === undefined ? "--repository" : undefined,
          options.githubTokenFile === undefined ? "--github-token-file" : undefined,
        ].filter((flag): flag is string => flag !== undefined);
        if (missing.length > 0) {
          throw new Error(`Non-interactive init requires ${missing.join(", ")}.`);
        }
      }
      const managedChat = options.chat ?? (await setupPrompts.managedChat());
      const repository = options.repository ?? (await setupPrompts.repository());
      const githubToken = options.githubTokenFile
        ? await readGitHubToken(options.githubTokenFile)
        : await setupPrompts.githubToken();
      const result = await installManagedData({
        dataDirectory: global.dataDir,
        managedChats: [managedChat],
        defaultRepository: repository,
        githubToken,
        authenticateChatGpt: async (paths) =>
          await authenticationFor(paths).authenticate(deviceCodeCallbacks, authenticationSignal()),
      });
      output.stdout(
        result.created
          ? `Created secure managed installation at ${result.inspection.dataDirectory}.\n`
          : `Managed installation already configured at ${result.inspection.dataDirectory}; no files changed.\n`,
      );
    });

  program
    .command("auth")
    .description("authenticate ChatGPT for an existing managed installation")
    .action(async () => {
      const paths = managedPaths({ dataDirectory: program.opts().dataDir });
      const inspection = await inspectManagedData({ dataDirectory: paths.root });
      if (inspection.state === "unconfigured") {
        throw new Error("Ambient Agent is not configured; run ambient-agent init first.");
      }
      const credentialOnlyDamage = credentialDamageOnly(inspection, paths);
      if (inspection.state === "damaged" && !credentialOnlyDamage) {
        throw new Error(
          `Refusing to authenticate against damaged managed data at ${paths.root}; run ambient-agent doctor.`,
        );
      }
      await authenticationFor(paths).authenticate(deviceCodeCallbacks, authenticationSignal());
      const verified = await inspectManagedData({ dataDirectory: paths.root });
      if (verified.state !== "configured") {
        throw new Error(`ChatGPT authentication was saved, but managed data verification failed at ${paths.root}.`);
      }
      output.stdout(`ChatGPT authentication updated at ${paths.chatGptOAuthCredential}.\n`);
    });

  program
    .command("start")
    .description("start the generated Flue server in the foreground")
    .action(async () => {
      const paths = managedPaths({ dataDirectory: program.opts().dataDir });
      const inspection = await inspectManagedData({ dataDirectory: paths.root });
      if (inspection.state !== "configured") {
        throw new Error(
          inspection.state === "unconfigured"
            ? "Ambient Agent is not configured; run ambient-agent init first."
            : `Refusing to start damaged managed data at ${paths.root}; run ambient-agent doctor.`,
        );
      }
      await startRuntime(paths);
    });

  program
    .command("status")
    .description("report whether the managed installation is ready")
    .option("--json", "emit machine-readable JSON")
    .action(async (options) => {
      const report = await reportInspection(options.json ?? false);
      if (report.installation.state === "unconfigured") exitCode = 2;
      else if (report.installation.state === "damaged" || report.authentication.state !== "ready") exitCode = 3;
    });

  program
    .command("doctor")
    .description("diagnose managed configuration, permissions, and credential references")
    .option("--json", "emit machine-readable JSON")
    .option("--refresh", "verify and safely rotate an expired ChatGPT credential")
    .option("--live", "make one gated real model readiness request")
    .action(async (options) => {
      const report = await reportInspection(
        options.json ?? false,
        Boolean(options.refresh || options.live),
        options.live ?? false,
      );
      if (
        report.installation.state !== "configured" ||
        report.authentication.state !== "ready" ||
        report.liveCheck?.request === "failed"
      ) {
        exitCode = 1;
      }
    });

  try {
    let args = [...argv];
    const bare = bareDataDirectory(args);
    if (bare !== undefined) {
      const inspection = await inspectManagedData({ dataDirectory: bare.dataDirectory });
      args.push(inspection.state === "unconfigured" ? "init" : "status");
    }
    await program.parseAsync(["node", "ambient-agent", ...args]);
    return exitCode;
  } catch (cause) {
    if (cause instanceof CommanderError) {
      return cause.exitCode;
    }
    const message = cause instanceof Error ? cause.message : String(cause);
    output.stderr(`ambient-agent: ${message}\n`);
    return 1;
  }
};
