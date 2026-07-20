import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { configureLogging, type LogFormat } from "@ambient-agent/engine/logging/logging.ts";
import {
  ensureManagedGitHubWebhookSecret,
  readManagedConfig,
  readManagedGitHubAppCredential,
  readManagedModelApiKey,
} from "@ambient-agent/installation/configuration.ts";
import { SUBSCRIPTION_PROVIDER_ID } from "@ambient-agent/engine/model/pi-subscription.ts";
import {
  installManagedRuntimeDependencies,
  resolveTenantRuntimeOperateBridge,
  runtimeDeploymentIdentityFromEnvironment,
  startDeferredWhatsAppRuntime,
} from "@ambient-agent/installation/runtime-dependencies.ts";
import { e2bSandbox } from "@ambient-agent/installation/e2b-sandbox.ts";
import type { ManagedPaths } from "@ambient-agent/installation/paths.ts";
import type { ChatGptAuthentication } from "@ambient-agent/engine/model/chatgpt-authentication.ts";

export interface RuntimeLoggingOptions {
  readonly debug: boolean;
  readonly format?: LogFormat;
}

export type StartRuntime = (paths: ManagedPaths, logging: RuntimeLoggingOptions) => Promise<void>;
export type ImportRuntime = (specifier: string) => Promise<unknown>;

/**
 * One job's whole sandbox budget (ADR 0021): E2B keeps the micro-VM alive this long, and
 * it bounds any shell command whose caller names no shorter deadline. Comfortably over the
 * Coder's 20-minute per-command ceiling so a full implement→verify loop fits in one VM.
 */
const AGENT_SANDBOX_TIMEOUT_MS = 60 * 60 * 1000;

/**
 * The per-job sandbox both agent shells run in. Keyed off the E2B SDK's own `E2B_API_KEY`:
 * until the operator supplies one there is no isolated sandbox, so the Coder and Reviewer
 * stay unprovisioned rather than falling back to a host-local shell.
 */
export const resolveAgentSandbox = (environment: NodeJS.ProcessEnv = process.env) => {
  if (!environment.E2B_API_KEY?.trim()) return undefined;
  const template = environment.E2B_TEMPLATE?.trim();
  return e2bSandbox({
    timeoutMs: AGENT_SANDBOX_TIMEOUT_MS,
    ...(template ? { template } : {}),
  });
};

const importRuntime: ImportRuntime = async (specifier) => await import(specifier);

const running = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return (cause as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * Refuse a second runtime on one data directory (T2, #253). Flue forbids two replicas on one
 * volume, and a second process would otherwise share the SQLite pair and the WhatsApp session
 * and corrupt both silently. No cleanup handler: `stopRuntimeOnSignal` re-raises the signal, so
 * the file always outlives the process and the stale-pid reclaim below is the normal restart path.
 * ponytail: pid liveness, not flock — Node's stdlib has no flock, a reused pid would hold the
 * directory hostage (delete `runtime.lock`), and two simultaneous reclaims of one stale lock both
 * win. Swap in a real advisory lock if either ever bites.
 */
export const acquireInstanceLock = async (root: string): Promise<void> => {
  const lock = join(root, "runtime.lock");
  try {
    await writeFile(lock, `${process.pid}\n`, { flag: "wx" });
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause;
    const owner = Number((await readFile(lock, "utf8")).trim());
    if (Number.isInteger(owner) && owner > 0 && running(owner)) {
      throw new Error(
        `Another ambient-agent runtime (pid ${owner}) is already using ${root}. Stop it before starting another; two runtimes on one data directory corrupt it.`,
      );
    }
    await writeFile(lock, `${process.pid}\n`);
  }
};

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

/**
 * Read the configured provider's key, or throw. This runs before anything binds, so a runtime
 * with no usable inference exits non-zero at start instead of booting green and going silent
 * on the first message (#250).
 */
const readModelApiKeyOrFail = async (paths: ManagedPaths, provider: string): Promise<string> => {
  let credential: Awaited<ReturnType<typeof readManagedModelApiKey>>;
  try {
    credential = await readManagedModelApiKey(paths.modelApiKeyCredential);
  } catch (cause) {
    throw new Error(
      `model.provider is ${provider} but the managed API key at ${paths.modelApiKeyCredential} is missing or unreadable. Run ambient-agent config --model-provider ${provider} and paste a fresh key.`,
      { cause },
    );
  }
  if (credential.provider !== provider) {
    throw new Error(
      `The managed API key at ${paths.modelApiKeyCredential} was issued for ${credential.provider}, but model.provider is ${provider}. Run ambient-agent config --model-provider ${provider} and paste a key for that provider.`,
    );
  }
  return credential.apiKey;
};

export const startGeneratedRuntime = async (
  paths: ManagedPaths,
  logging: RuntimeLoggingOptions,
  authentication: ChatGptAuthentication,
  importServer: ImportRuntime = importRuntime,
): Promise<void> => {
  await acquireInstanceLock(paths.root);
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
  const modelApiKey =
    configuration.model.provider === SUBSCRIPTION_PROVIDER_ID
      ? undefined
      : await readModelApiKeyOrFail(paths, configuration.model.provider);
  const deployment = runtimeDeploymentIdentityFromEnvironment();
  const bridge = resolveTenantRuntimeOperateBridge();
  const agentSandbox = resolveAgentSandbox();
  installManagedRuntimeDependencies({
    authentication,
    configuration,
    githubCredential: { ...githubCredential, webhookSecret: githubCredential.webhookSecret },
    paths,
    ...(deployment === undefined ? {} : { deployment }),
    ...(bridge === undefined ? {} : { bridge }),
    ...(agentSandbox === undefined ? {} : { agentSandbox }),
    ...(modelApiKey === undefined ? {} : { modelApiKey }),
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
