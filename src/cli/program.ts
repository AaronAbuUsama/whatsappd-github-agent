import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Command, CommanderError } from "@commander-js/extra-typings";
import * as prompts from "@clack/prompts";

import { inspectManagedData, installManagedData, type InstallationInspection } from "../managed/installation.js";
import { managedPaths, type ManagedPaths } from "../managed/paths.js";

export interface CliOutput {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

export interface SetupPrompts {
  readonly managedChat: () => Promise<string>;
  readonly repository: () => Promise<string>;
  readonly githubToken: () => Promise<string>;
  readonly piAuthPath: () => Promise<string>;
}

export interface CliDependencies {
  readonly output?: CliOutput;
  readonly setupPrompts?: SetupPrompts;
  readonly interactive?: boolean;
  readonly startRuntime?: StartRuntime;
}

export type StartRuntime = (paths: ManagedPaths) => Promise<void>;

const defaultOutput: CliOutput = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

const startGeneratedRuntime: StartRuntime = async (paths) => {
  process.chdir(paths.root);
  const serverEntry = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "..", "server.mjs"));
  await import(serverEntry.href);
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
  piAuthPath: () =>
    requiredPrompt("Pi auth path", () =>
      prompts.text({
        message: "Path to an existing Pi auth.json with openai-codex OAuth",
        placeholder: "~/.pi/agent/auth.json",
      }),
    ),
};

const renderInspection = (inspection: InstallationInspection, json: boolean): string => {
  if (json) return `${JSON.stringify(inspection, null, 2)}\n`;
  const lines = [`Ambient Agent: ${inspection.state}`, `Data directory: ${inspection.dataDirectory}`];
  for (const item of inspection.diagnostics) {
    lines.push(`[${item.code}] ${item.message}`, `  Path: ${item.path}`, `  Fix: ${item.remediation}`);
  }
  return `${lines.join("\n")}\n`;
};

const readPiAuth = async (path: string): Promise<unknown> => {
  const expandedPath = path === "~" ? homedir() : path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
  try {
    return JSON.parse(await readFile(expandedPath, "utf8"));
  } catch {
    throw new Error(`Could not read valid JSON from the Pi auth file at ${expandedPath}.`);
  }
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
  const startRuntime = dependencies.startRuntime ?? startGeneratedRuntime;
  const interactive =
    dependencies.interactive ??
    (dependencies.setupPrompts !== undefined || (process.stdin.isTTY === true && process.stdout.isTTY === true));
  let exitCode = 0;
  const program = new Command()
    .name("ambient-agent")
    .description("Install and operate the Ambient Agent managed runtime")
    .version("0.1.0")
    .option("--data-dir <path>", "override the managed data directory")
    .configureOutput({ writeOut: output.stdout, writeErr: output.stderr })
    .exitOverride();
  const reportInspection = async (json: boolean): Promise<InstallationInspection> => {
    const inspection = await inspectManagedData({ dataDirectory: program.opts().dataDir });
    output.stdout(renderInspection(inspection, json));
    return inspection;
  };

  program
    .command("init")
    .description("create a secure managed installation")
    .option("--chat <jid>", "managed WhatsApp chat JID")
    .option("--repository <owner/name>", "default GitHub repository")
    .option("--github-token-file <path>", "read the GitHub token from a file")
    .option("--pi-auth-file <path>", "copy credentials from a Pi auth.json file")
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
          options.piAuthFile === undefined ? "--pi-auth-file" : undefined,
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
      const piAuthPath = options.piAuthFile ?? (await setupPrompts.piAuthPath());
      const result = await installManagedData({
        dataDirectory: global.dataDir,
        managedChats: [managedChat],
        defaultRepository: repository,
        githubToken,
        piAuth: await readPiAuth(piAuthPath),
      });
      output.stdout(
        result.created
          ? `Created secure managed installation at ${result.inspection.dataDirectory}.\n`
          : `Managed installation already configured at ${result.inspection.dataDirectory}; no files changed.\n`,
      );
    });

  program
    .command("start")
    .description("start the generated Flue server in the foreground")
    .action(async () => {
      await startRuntime(managedPaths({ dataDirectory: program.opts().dataDir }));
    });

  program
    .command("status")
    .description("report whether the managed installation is ready")
    .option("--json", "emit machine-readable JSON")
    .action(async (options) => {
      const inspection = await reportInspection(options.json ?? false);
      if (inspection.state === "unconfigured") exitCode = 2;
      if (inspection.state === "damaged") exitCode = 3;
    });

  program
    .command("doctor")
    .description("diagnose managed configuration, permissions, and credential references")
    .option("--json", "emit machine-readable JSON")
    .action(async (options) => {
      const inspection = await reportInspection(options.json ?? false);
      if (inspection.state !== "configured") exitCode = 1;
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
