import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { configureLogging, type LogFormat } from "@ambient-agent/engine/logging/logging.ts";
import { ensureManagedGitHubWebhookSecret, readManagedConfig, readManagedGitHubAppCredential } from "@ambient-agent/installation/configuration.ts";
import { installManagedRuntimeDependencies, startDeferredWhatsAppRuntime } from "@ambient-agent/installation/runtime-dependencies.ts";
import type { ManagedPaths } from "@ambient-agent/installation/paths.ts";
import type { ChatGptAuthentication } from "@ambient-agent/engine/model/chatgpt-authentication.ts";

export interface RuntimeLoggingOptions {
  readonly debug: boolean;
  readonly format?: LogFormat;
}

export type StartRuntime = (paths: ManagedPaths, logging: RuntimeLoggingOptions) => Promise<void>;
export type ImportRuntime = (specifier: string) => Promise<unknown>;

const importRuntime: ImportRuntime = async (specifier) => await import(specifier);

export const parseRuntimePort = (value: string): number => {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("The runtime port must be an integer from 1 through 65535.");
  }
  return port;
};

const portOccupied = (cause: unknown): boolean =>
  cause instanceof AggregateError
    ? cause.errors.some(portOccupied)
    : (cause as NodeJS.ErrnoException | null)?.code === "EADDRINUSE";

export const startGeneratedRuntime = async (
  paths: ManagedPaths,
  logging: RuntimeLoggingOptions,
  authentication: ChatGptAuthentication,
  importServer: ImportRuntime = importRuntime,
): Promise<void> => {
  await configureLogging({
    logsDirectory: paths.logs,
    level: logging.debug ? "debug" : "info",
    ...(logging.format === undefined ? {} : { format: logging.format }),
  });
  await ensureManagedGitHubWebhookSecret(paths.githubAppCredentials.planner);
  const configuration = await readManagedConfig(paths.config);
  const githubCredential = await readManagedGitHubAppCredential(paths.githubAppCredentials.planner);
  if (githubCredential.webhookSecret === undefined) {
    throw new Error("The app-owned GitHub webhook credential migration did not complete.");
  }
  installManagedRuntimeDependencies({
    authentication,
    configuration,
    githubCredential: { ...githubCredential, webhookSecret: githubCredential.webhookSecret },
    paths,
  });
  process.chdir(paths.root);
  const serverEntry = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "..", "server.mjs"));
  const previousPort = process.env.PORT;
  process.env.PORT = String(configuration.runtime.port);
  try {
    // The generated server top-level-awaits its HTTP bind, so this import resolves
    // only once the configured port is actually listening and rejects (after the
    // server stopped everything it started) when the port is occupied.
    await importServer(serverEntry.href);
  } catch (cause) {
    if (portOccupied(cause)) {
      throw new Error(
        `Port ${configuration.runtime.port} is already in use; free it or run ambient-agent config --port <port> to choose another port.`,
        { cause },
      );
    }
    throw cause;
  } finally {
    if (previousPort === undefined) delete process.env.PORT;
    else process.env.PORT = previousPort;
  }
  // ponytail: if a mismatched dist ships a server without the deferred starter, this
  // throw leaves the bound HTTP server running; stopping it needs the generated server
  // to export its lifecycle — add that seam if bundle mismatch ever becomes reachable.
  startDeferredWhatsAppRuntime();
};
