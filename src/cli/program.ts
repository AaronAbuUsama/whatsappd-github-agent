import { chmod, lstat, mkdir, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Command, CommanderError } from "@commander-js/extra-typings";
import * as prompts from "@clack/prompts";
import packageManifest from "../../package.json" with { type: "json" };

import { configureLogging, upstreamWhatsAppLogger, type LogFormat } from "../logging/logging.js";
import {
  acquireSetupLock,
  inspectManagedData,
  promoteReplacementWhatsAppStore,
  releaseSetupLock,
  type InstallationInspection,
} from "../managed/installation.js";
import { createManagedChatGptAuthentication } from "../managed/chatgpt-authentication.js";
import {
  readManagedConfig,
  readManagedGitHubCredential,
  ensureManagedGitHubWebhookSecret,
  writeManagedConfiguration,
} from "../managed/configuration.js";
import { inspectManagedServices, inspectWhatsAppSession, type ManagedCheck } from "../managed/diagnostics.js";
import { migrateLegacyManagedData, type ManagedDataMigration } from "../managed/migration.js";
import { managedPaths, type ManagedPaths } from "../managed/paths.js";
import {
  probeAmbientRuntimeHealth,
  runtimeInstallationId,
  type AmbientRuntimeHealth,
} from "../managed/runtime-health.js";
import {
  installManagedRuntimeDependencies,
  startDeferredWhatsAppRuntime,
} from "../managed/runtime-dependencies.js";
import {
  createUncertainWorkController,
  inspectUncertainWorkStatus,
  type UncertainActionResult,
  type UncertainDoctorReport,
  type UncertainWorkController,
  type UncertainWorkRef,
  type UncertainWorkStatus,
} from "../managed/uncertain-work.js";
import {
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
import {
  discoverGitHubCredential,
  discoverOriginRepository,
  normalizeGitHubRepository,
  verifyGitHubRepositoryAccess,
} from "../setup/github.js";
import { runFirstRunSetup, type FirstRunPrompts, type FirstRunServices, type SetupReview } from "../setup/first-run.js";
import { createWhatsAppAccount } from "../whatsapp/account.js";
import { createConversationArchive } from "../intake/conversation-archive.js";
import { createManagedChatInbox, inspectWindowDeliveryCounts } from "../intake/managed-chat-inbox.js";
import { createIssueOperationStore } from "../capabilities/issue-management/operation-store.js";
import { createOctokitIssueRepository } from "../host/github-issue-repository.js";

export interface CliOutput {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

export type SetupPrompts = FirstRunPrompts;

export interface CliDependencies {
  readonly output?: CliOutput;
  readonly setupPrompts?: SetupPrompts;
  readonly interactive?: boolean;
  readonly startRuntime?: StartRuntime;
  readonly importRuntime?: ImportRuntime;
  readonly chatGptOAuth?: ChatGptOAuthAdapter;
  readonly firstRunServices?: Partial<FirstRunServices>;
  readonly signal?: AbortSignal;
  readonly readinessTimeoutMillis?: number;
  readonly readinessCheck?: (
    authentication: ChatGptAuthentication,
    signal?: AbortSignal,
  ) => Promise<ChatGptReadinessReceipt>;
  readonly uncertainWorkFor?: (paths: ManagedPaths) => Promise<UncertainWorkController>;
  readonly inspectUncertainWork?: (databasePath: string) => UncertainWorkStatus;
  readonly inspectWindowDeliveries?: (databasePath: string) => WindowDeliveryCounts;
  readonly runtimeHealthFor?: (paths: ManagedPaths) => Promise<AmbientRuntimeHealth>;
  readonly migrateManagedData?: () => Promise<ManagedDataMigration>;
}

export interface RuntimeLoggingOptions {
  readonly debug: boolean;
  readonly format?: LogFormat;
}
export type StartRuntime = (paths: ManagedPaths, logging: RuntimeLoggingOptions) => Promise<void>;
export type ImportRuntime = (specifier: string) => Promise<unknown>;
export interface WindowDeliveryCounts {
  readonly pending: number;
  readonly failed: number;
}

const defaultOutput: CliOutput = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

const importRuntime: ImportRuntime = async (specifier) => await import(specifier);

const parseRuntimePort = (value: string): number => {
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

const startGeneratedRuntime = async (
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
  await ensureManagedGitHubWebhookSecret(paths.githubCredential);
  const configuration = await readManagedConfig(paths.config);
  const githubCredential = await readManagedGitHubCredential(paths.githubCredential);
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

const promptValue = async <Value>(prompt: Promise<Value | symbol>): Promise<Value> => {
  const value = await prompt;
  if (prompts.isCancel(value)) {
    prompts.cancel("Setup cancelled.");
    throw new Error("Setup cancelled.");
  }
  return value;
};

const defaultSetupPrompts: SetupPrompts = {
  selectChat: async (candidates) =>
    await promptValue(
      prompts.autocomplete({
        message: "Search the synchronized WhatsApp chats",
        options: candidates.map((candidate) => ({
          value: candidate.jid,
          label: candidate.name,
          hint: [
            candidate.kind,
            candidate.lastActivityAt === undefined
              ? undefined
              : `active ${new Date(candidate.lastActivityAt).toISOString()}`,
            candidate.jid,
          ]
            .filter(Boolean)
            .join(" · "),
        })),
        maxItems: 10,
      }),
    ),
  repository: (discovered) =>
    requiredPrompt("Repository", () =>
      prompts.text({
        message: "Default GitHub repository",
        placeholder: "owner/repository",
        ...(discovered === undefined ? {} : { initialValue: discovered }),
      }),
    ),
  githubCredential: async (discovered) => {
    if (discovered !== undefined) {
      const reuse = await promptValue(
        prompts.confirm({
          message: `Use the GitHub credential from ${discovered.source}?`,
          initialValue: true,
        }),
      );
      if (reuse) return discovered;
    }
    const token = await requiredPrompt("GitHub token", () =>
      prompts.password({
        message: "Fine-grained GitHub personal access token",
        mask: "*",
      }),
    );
    return { token, source: "secure prompt" };
  },
  review: async (review: SetupReview) => {
    prompts.note(
      [
        `Data directory: ${review.dataDirectory}`,
        `ChatGPT: ${review.chatGptCredentialSource}`,
        `WhatsApp: ${review.whatsappCredentialSource}`,
        `Managed chat: ${review.chat.name} (${review.chat.kind}, ${review.chat.jid})`,
        `GitHub repository: ${review.repository}`,
        `GitHub credential: ${review.githubCredentialSource}`,
      ].join("\n"),
      "Review Ambient Agent setup",
    );
    return await promptValue(prompts.confirm({ message: "Create this managed installation?", initialValue: true }));
  },
  validationError: (_field, message) => prompts.log.error(message),
};

/** Component roll-up of the internal five-state detail (#91): refreshable is machine-repairable, so ready. */
const chatGptComponentState = (authentication: ChatGptAuthenticationStatus): "ready" | "reauthentication-required" =>
  authentication.state === "ready" || authentication.state === "expired-refreshable"
    ? "ready"
    : "reauthentication-required";

const renderInspection = (
  inspection: InstallationInspection,
  authentication: ChatGptAuthenticationStatus,
  checks: readonly ManagedCheck[],
  observedRuntime: AmbientRuntimeHealth | undefined,
  liveCheck: ChatGptReadinessReceipt | undefined,
  uncertainWork: UncertainWorkStatus | undefined,
  windowDeliveries: WindowDeliveryCounts | undefined,
  uncertainDoctor: UncertainDoctorReport | undefined,
  uncertainAction: UncertainActionResult | undefined,
  json: boolean,
): string => {
  if (json)
    return `${JSON.stringify(
      {
        ...inspection,
        checks,
        observedRuntime,
        ...(inspection.state === "ready" ? { chatgpt: chatGptComponentState(authentication) } : {}),
        modelAuthentication: authentication,
        liveCheck,
        uncertainWork,
        windowDeliveries,
        uncertainDoctor,
        uncertainAction,
      },
      null,
      2,
    )}\n`;
  const lines = [`Ambient Agent: ${inspection.state}`, `Data directory: ${inspection.dataDirectory}`];
  for (const item of inspection.diagnostics) {
    lines.push(`[${item.code}] ${item.message}`, `  Path: ${item.path}`, `  Fix: ${item.remediation}`);
  }
  for (const check of checks) {
    lines.push(`${check.name}: ${check.state} (${check.code})`, `  ${check.message}`);
    if (check.remediation !== undefined) lines.push(`  Fix: ${check.remediation}`);
  }
  if (inspection.state === "ready") lines.push(`chatgpt: ${chatGptComponentState(authentication)}`);
  lines.push(`ChatGPT authentication: ${authentication.state}`);
  if (authentication.state === "missing") {
    lines.push(
      inspection.state === "absent"
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
      inspection.state === "incomplete" || inspection.state === "corrupt"
        ? "  Fix: Run ambient-agent doctor and repair the managed installation."
        : "  Fix: Run ambient-agent auth to authenticate again.",
    );
  if (observedRuntime !== undefined) {
    lines.push(`Runtime: ${observedRuntime.state} (whatsapp ${observedRuntime.whatsapp.phase})`);
  }
  if (liveCheck !== undefined) {
    lines.push(
      `ChatGPT live readiness: ${liveCheck.request}${liveCheck.reason === undefined ? "" : ` (${liveCheck.reason})`}`,
    );
  }
  if (uncertainWork !== undefined) {
    lines.push(`Uncertain work: ${uncertainWork.health} (${uncertainWork.externalMutations} external mutations)`);
    if (uncertainWork.total > 0) {
      lines.push("  Fix: Run ambient-agent doctor, then choose --retry, --accept-observed, or --abandon explicitly.");
    }
  }
  if (windowDeliveries !== undefined) {
    lines.push(`backlog: ${windowDeliveries.pending} pending, ${windowDeliveries.failed} failed`);
  }
  if (uncertainDoctor !== undefined) {
    for (const item of uncertainDoctor.diagnoses) {
      lines.push(`  [${item.outcome}] ${item.ref}: ${item.evidence}`);
    }
    if (uncertainDoctor.deferred > 0) {
      lines.push(`  ${uncertainDoctor.deferred} additional Uncertain items were deferred to the next doctor run.`);
    }
  }
  if (uncertainAction !== undefined) {
    lines.push(
      `Uncertain action: ${uncertainAction.ref} -> ${uncertainAction.outcome}${
        uncertainAction.replacementRef === undefined ? "" : ` (${uncertainAction.replacementRef})`
      }`,
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
  const serviceOverrides = dependencies.firstRunServices ?? {};
  const firstRunServices: FirstRunServices = {
    chatGptFor: serviceOverrides.chatGptFor ?? authenticationFor,
    whatsappFor:
      serviceOverrides.whatsappFor ??
      ((paths, archive) =>
        createWhatsAppAccount({
          storeDirectory: paths.whatsapp,
          archive,
          logger: upstreamWhatsAppLogger(),
        })),
    discoverRepository: serviceOverrides.discoverRepository ?? (() => discoverOriginRepository()),
    discoverCredential: serviceOverrides.discoverCredential ?? (() => discoverGitHubCredential()),
    verifyGitHub:
      serviceOverrides.verifyGitHub ??
      ((token, repository, signal) => verifyGitHubRepositoryAccess({ token, repository, signal })),
  };
  const startRuntime =
    dependencies.startRuntime ??
    ((paths: ManagedPaths, logging: RuntimeLoggingOptions) =>
      startGeneratedRuntime(paths, logging, authenticationFor(paths), dependencies.importRuntime));
  const uncertainWorkFor =
    dependencies.uncertainWorkFor ??
    (async (paths: ManagedPaths): Promise<UncertainWorkController> => {
      const token = (await readManagedGitHubCredential(paths.githubCredential)).token;
      const archive = createConversationArchive(paths.applicationDatabase);
      try {
        // Opening the inbox performs the one-way Window-ledger migration (ADR 0014).
        createManagedChatInbox(archive, { allowed: () => false });
      } finally {
        archive.close();
      }
      return createUncertainWorkController({
        operations: createIssueOperationStore(paths.applicationDatabase),
        repository: createOctokitIssueRepository(token),
      });
    });
  const inspectUncertainWork = dependencies.inspectUncertainWork ?? inspectUncertainWorkStatus;
  const inspectWindowDeliveries = dependencies.inspectWindowDeliveries ?? inspectWindowDeliveryCounts;
  const runtimeHealthFor =
    dependencies.runtimeHealthFor ??
    (async (paths) => {
      const configuration = await readManagedConfig(paths.config);
      const credential = await readManagedGitHubCredential(paths.githubCredential);
      if (credential.webhookSecret === undefined) return { state: "stopped", whatsapp: { phase: "stopped" } };
      return await probeAmbientRuntimeHealth({
        port: configuration.runtime.port,
        installationId: runtimeInstallationId(credential.webhookSecret),
        timeoutMillis: 750,
      });
    });
  const operationSignal = (timeoutMillis: number): AbortSignal => {
    const timeout = AbortSignal.timeout(timeoutMillis);
    return dependencies.signal === undefined ? timeout : AbortSignal.any([dependencies.signal, timeout]);
  };
  const authenticationSignal = (): AbortSignal => operationSignal(20 * 60 * 1_000);
  const readinessSignal = (): AbortSignal => operationSignal(dependencies.readinessTimeoutMillis ?? 60_000);
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
  const whatsappCallbacks = {
    onPairing: (pairing: { readonly qr?: string; readonly code?: string }) => {
      if (pairing.qr !== undefined) {
        const renderer = createRequire(import.meta.url)("qrcode-terminal") as {
          generate(value: string, options: { readonly small: boolean }, callback: (rendered: string) => void): void;
        };
        renderer.generate(pairing.qr, { small: true }, (rendered) => output.stdout(`${rendered}\n`));
      } else if (pairing.code !== undefined) {
        output.stdout(`Enter WhatsApp pairing code ${pairing.code}.\n`);
      }
    },
  };
  let exitCode = 0;
  const program = new Command()
    .name("ambient-agent")
    .description("Install and operate the Ambient Agent managed runtime")
    .version(packageManifest.version)
    .option("--data-dir <path>", "override the managed data directory")
    .configureOutput({ writeOut: output.stdout, writeErr: output.stderr })
    .exitOverride();
  const reportInspection = async (
    json: boolean,
    refresh: boolean = false,
    live: boolean = false,
    observeRuntime: boolean = false,
    uncertainty?:
      | { readonly mode: "status" }
      | {
          readonly mode: "doctor";
          readonly retry?: UncertainWorkRef;
          readonly abandon?: UncertainWorkRef;
          readonly acceptObserved?: UncertainWorkRef;
        },
  ): Promise<{
    readonly installation: InstallationInspection;
    readonly authentication: ChatGptAuthenticationStatus;
    readonly checks: readonly ManagedCheck[];
    readonly observedRuntime?: AmbientRuntimeHealth;
    readonly liveCheck?: ChatGptReadinessReceipt;
    readonly uncertainWork?: UncertainWorkStatus;
    readonly windowDeliveries?: WindowDeliveryCounts;
    readonly uncertainDoctor?: UncertainDoctorReport;
    readonly uncertainAction?: UncertainActionResult;
  }> => {
    const paths = managedPaths({ dataDirectory: program.opts().dataDir });
    const inspection = await inspectManagedData({ dataDirectory: paths.root });
    const ready = inspection.state === "ready";
    const checks = ready ? [...(await inspectManagedServices(paths))] : [];
    const githubCredentialReady = checks.some(
      ({ name, state }) => name === "github-credential" && state === "ready",
    );
    const managedGitHubCredential =
      ready && githubCredentialReady ? await readManagedGitHubCredential(paths.githubCredential) : undefined;
    if (managedGitHubCredential !== undefined && managedGitHubCredential.webhookSecret === undefined) {
      checks.push({
        name: "github-webhook-secret",
        state: "warning",
        code: "github.webhook-secret-migration-pending",
        message: "The valid predecessor GitHub credential needs the app-owned webhook-secret migration.",
        remediation: "Run ambient-agent start once; startup performs the supported atomic migration before listening.",
      });
    }
    if (live && managedGitHubCredential !== undefined) {
      const config = await readManagedConfig(paths.config);
      try {
        await firstRunServices.verifyGitHub(
          managedGitHubCredential.token,
          config.github.defaultRepository,
          readinessSignal(),
        );
        checks.push({
          name: "github-access",
          state: "ready",
          code: "github.ready",
          message: `GitHub authenticated and can access ${config.github.defaultRepository}.`,
        });
      } catch {
        checks.push({
          name: "github-access",
          state: "failed",
          code: "github.access-failed",
          message: `GitHub authentication or repository access failed for ${config.github.defaultRepository}.`,
          remediation: "Run ambient-agent config with a valid scoped GitHub token, then run doctor --live again.",
        });
      }
    }
    const authentication = ready ? authenticationFor(paths) : undefined;
    // The default probe derives its correlation ID from the GitHub credential's webhook
    // secret; when that is unreadable the runtime is honestly unobservable, not stopped.
    const observedRuntime =
      observeRuntime && ready ? await runtimeHealthFor(paths).catch(() => undefined) : undefined;
    if (observedRuntime?.whatsapp.phase === "online") {
      // "online" comes only from live observation; static store evidence caps at "paired".
      const online = checks.findIndex(({ name }) => name === "whatsapp-session");
      if (online !== -1) {
        checks[online] = {
          name: "whatsapp-session",
          state: "online",
          code: "whatsapp.online",
          message: "The running Ambient Agent runtime observes the WhatsApp session online.",
        };
      }
    }
    let authenticationStatus: ChatGptAuthenticationStatus =
      inspection.state === "absent"
        ? { state: "missing" }
        : !ready
          ? {
              state: "unusable",
              message: `ChatGPT authentication was not inspected because the managed installation is ${inspection.state}.`,
            }
          : await authentication!.inspect();
    if (refresh && authenticationStatus.state === "expired-refreshable") {
      try {
        await authentication!.authorization(readinessSignal());
      } catch {
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
    let uncertainWork: UncertainWorkStatus | undefined;
    let windowDeliveries: WindowDeliveryCounts | undefined;
    let uncertainDoctor: UncertainDoctorReport | undefined;
    let uncertainAction: UncertainActionResult | undefined;
    const applicationDatabaseReady = checks.some(
      ({ name, state }) => name === "application-database" && state === "ready",
    );
    if (ready && applicationDatabaseReady && uncertainty !== undefined) {
      if (uncertainty.mode === "status") {
        uncertainWork = inspectUncertainWork(paths.applicationDatabase);
        windowDeliveries = inspectWindowDeliveries(paths.applicationDatabase);
      } else {
        if (!githubCredentialReady) {
          throw new Error(
            "Uncertain-work actions need a usable GitHub credential. Run ambient-agent config --github-token-file <path> with a valid scoped GitHub token.",
          );
        }
        const controller = await uncertainWorkFor(paths);
        try {
          if (uncertainty.retry !== undefined) uncertainAction = await controller.retry(uncertainty.retry);
          else if (uncertainty.abandon !== undefined) uncertainAction = controller.abandon(uncertainty.abandon);
          else if (uncertainty.acceptObserved !== undefined) {
            uncertainAction = await controller.acceptObserved(uncertainty.acceptObserved);
          } else uncertainDoctor = await controller.diagnose();
          uncertainWork = controller.status();
        } finally {
          controller.close();
        }
      }
    }
    output.stdout(
      renderInspection(
        inspection,
        authenticationStatus,
        checks,
        observedRuntime,
        liveCheck,
        uncertainWork,
        windowDeliveries,
        uncertainDoctor,
        uncertainAction,
        json,
      ),
    );
    return {
      installation: inspection,
      authentication: authenticationStatus,
      checks,
      observedRuntime,
      liveCheck,
      uncertainWork,
      windowDeliveries,
      uncertainDoctor,
      uncertainAction,
    };
  };

  program
    .command("init")
    .description("create a secure managed installation")
    .option("--chat <jid>", "managed WhatsApp chat JID")
    .option("--repository <owner/name>", "default GitHub repository")
    .option("--github-token-file <path>", "read the GitHub token from a file")
    .option("--whatsapp-store <path>", "copy a stopped local WhatsApp store into setup")
    .option("--authorize", "allow explicit headless ChatGPT device authorization")
    .action(async (options) => {
      const global = program.opts();
      const current = await inspectManagedData({ dataDirectory: global.dataDir });
      output.stdout(`Data directory: ${current.dataDirectory}\n`);
      if (current.state === "ready") {
        output.stdout(`Managed installation already configured at ${current.dataDirectory}; no files changed.\n`);
        return;
      }
      if (current.state !== "absent") {
        throw new Error(
          `Refusing to replace ${current.state} managed data at ${current.dataDirectory}; run ambient-agent doctor.`,
        );
      }
      const scriptedCredential =
        options.githubTokenFile === undefined
          ? undefined
          : { token: await readGitHubToken(options.githubTokenFile), source: "token file" };
      const result = await runFirstRunSetup({
        dataDirectory: global.dataDir,
        interactive,
        allowFreshChatGptAuthentication: options.authorize ?? false,
        ...(options.whatsappStore === undefined ? {} : { whatsappStoreSource: resolve(options.whatsappStore) }),
        services: firstRunServices,
        prompts: setupPrompts,
        scripted: {
          ...(options.chat === undefined ? {} : { chat: options.chat }),
          ...(options.repository === undefined ? {} : { repository: options.repository }),
          ...(scriptedCredential === undefined ? {} : { githubCredential: scriptedCredential }),
        },
        chatGptCallbacks: deviceCodeCallbacks,
        whatsappCallbacks,
        signal: authenticationSignal(),
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
      if (inspection.state === "absent") {
        throw new Error("Ambient Agent is not configured; run ambient-agent init first.");
      }
      if (inspection.state !== "ready") {
        throw new Error(
          `Refusing to authenticate against ${inspection.state} managed data at ${paths.root}; run ambient-agent doctor.`,
        );
      }
      // Fail before the device flow when the credential path can never persist a login.
      try {
        if (!(await lstat(paths.chatGptOAuthCredential)).isFile()) {
          throw new Error(
            `The managed ChatGPT credential path at ${paths.chatGptOAuthCredential} is not a regular file; run ambient-agent doctor.`,
          );
        }
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      }
      await authenticationFor(paths).authenticate(deviceCodeCallbacks, authenticationSignal());
      const verified = await inspectManagedData({ dataDirectory: paths.root });
      if (verified.state !== "ready") {
        throw new Error(`ChatGPT authentication was saved, but managed data verification failed at ${paths.root}.`);
      }
      output.stdout(`ChatGPT authentication updated at ${paths.chatGptOAuthCredential}.\n`);
    });

  program
    .command("config")
    .description("review and change validated managed configuration")
    .option("--chat <jid>", "managed WhatsApp chat JID")
    .option("--repository <owner/name>", "default GitHub repository")
    .option("--port <port>", "foreground runtime HTTP port")
    .option("--github-token-file <path>", "replace the GitHub token from a private file")
    .action(async (options) => {
      const paths = managedPaths({ dataDirectory: program.opts().dataDir });
      const inspection = await inspectManagedData({ dataDirectory: paths.root });
      if (inspection.state !== "ready") {
        throw new Error(
          inspection.state === "absent"
            ? "Ambient Agent is not configured; run ambient-agent init first."
            : `Refusing to reconfigure ${inspection.state} managed data at ${paths.root}; run ambient-agent doctor.`,
        );
      }
      const currentConfig = await readManagedConfig(paths.config);
      const currentCredential = await readManagedGitHubCredential(paths.githubCredential);
      let selected = {
        jid: options.chat ?? currentConfig.managedChats[0]!,
        name: options.chat ?? currentConfig.managedChats[0]!,
        kind: (options.chat ?? currentConfig.managedChats[0]!).endsWith("@g.us")
          ? ("group" as const)
          : ("direct" as const),
      };

      if (interactive || options.chat !== undefined) {
        const archive = createConversationArchive(paths.applicationDatabase);
        const account = firstRunServices.whatsappFor(paths, archive);
        try {
          let pairingRequired = false;
          await account.authenticate(
            {
              ...whatsappCallbacks,
              onPairing: (progress) => {
                pairingRequired = true;
                whatsappCallbacks.onPairing?.(progress);
              },
            },
            authenticationSignal(),
          );
          if (!interactive && pairingRequired) {
            throw new Error("Non-interactive config requires an existing valid managed WhatsApp session.");
          }
          const candidates = await account.synchronizedChats(authenticationSignal());
          const jid = interactive ? await setupPrompts.selectChat(candidates) : options.chat!;
          const candidate = candidates.find((item) => item.jid === jid);
          if (candidate === undefined) {
            throw new Error("The selected WhatsApp chat was not found in the authenticated account sync result.");
          }
          selected = { jid: candidate.jid, name: candidate.name, kind: candidate.kind };
        } finally {
          try {
            await account.stop();
          } finally {
            archive.close();
          }
        }
      }

      const repository = normalizeGitHubRepository(
        interactive
          ? await setupPrompts.repository(options.repository ?? currentConfig.github.defaultRepository)
          : (options.repository ?? currentConfig.github.defaultRepository),
      );
      const credentialFromFile =
        options.githubTokenFile === undefined
          ? undefined
          : { token: await readGitHubToken(options.githubTokenFile), source: "token file" };
      const credential = interactive
        ? await setupPrompts.githubCredential(
            credentialFromFile ?? { token: currentCredential.token, source: "existing managed credential" },
          )
        : (credentialFromFile ?? { token: currentCredential.token, source: "existing managed credential" });
      const verifiedRepository = await firstRunServices.verifyGitHub(
        credential.token,
        repository,
        authenticationSignal(),
      );
      const review: SetupReview = {
        dataDirectory: paths.root,
        chat: selected,
        repository: verifiedRepository,
        chatGptCredentialSource: "existing managed credential",
        whatsappCredentialSource: "existing managed session",
        githubCredentialSource: credential.source,
      };
      if (interactive && !(await setupPrompts.review(review))) {
        throw new Error("Configuration cancelled; managed configuration was not changed.");
      }
      const managedChats = [
        selected.jid,
        ...currentConfig.managedChats.filter((chat) => chat.toLowerCase() !== selected.jid.toLowerCase()),
      ];
      const allowedRepositories = [...currentConfig.github.allowedRepositories, verifiedRepository].filter(
        (repository, index, all) =>
          all.findIndex((candidate) => candidate.toLowerCase() === repository.toLowerCase()) === index,
      );
      const runtimePort = options.port === undefined ? currentConfig.runtime.port : parseRuntimePort(options.port);
      await writeManagedConfiguration(
        paths.config,
        paths.githubCredential,
        {
          ...currentConfig,
          managedChats,
          runtime: { port: runtimePort },
          github: {
            ...currentConfig.github,
            defaultRepository: verifiedRepository,
            allowedRepositories,
          },
        },
        {
          schemaVersion: 1,
          kind: "personal-token",
          token: credential.token,
          ...(currentCredential.webhookSecret === undefined ? {} : { webhookSecret: currentCredential.webhookSecret }),
        },
      );
      output.stdout(`Updated validated managed configuration at ${paths.config}.\n`);
    });

  program
    .command("repair")
    .description("guided component repair that preserves the rest of the managed installation")
    .argument("[component]", "component to repair (whatsapp)", "whatsapp")
    .action(async (component) => {
      if (component !== "whatsapp") {
        throw new Error(`Unknown repair component "${component}"; only whatsapp re-pairing is supported.`);
      }
      const paths = managedPaths({ dataDirectory: program.opts().dataDir });
      const inspection = await inspectManagedData({ dataDirectory: paths.root });
      if (inspection.state !== "ready") {
        throw new Error(
          inspection.state === "absent"
            ? "Ambient Agent is not configured; run ambient-agent init first."
            : `Refusing to repair components of ${inspection.state} managed data at ${paths.root}; run ambient-agent doctor.`,
        );
      }
      if ((await inspectWhatsAppSession(paths)).state !== "re-pair-required") {
        throw new Error(
          "The managed WhatsApp store is already paired; nothing to repair. To pair a different account, unlink this device from the phone first (Linked devices), then run the repair again.",
        );
      }
      if (!interactive) {
        throw new Error(
          "WhatsApp re-pairing requires a human to scan a QR code; run ambient-agent repair whatsapp in an interactive terminal.",
        );
      }
      const configuration = await readManagedConfig(paths.config);
      // An unprobeable runtime (no webhook secret to correlate) is undefined and does not
      // block; any observed state other than an explicit "stopped" fails closed, because
      // even a failed runtime process still holds the store directory open.
      const observed = await runtimeHealthFor(paths).catch(() => undefined);
      if (observed !== undefined && observed.state !== "stopped") {
        throw new Error(
          `Stop the running ambient-agent start process before re-pairing WhatsApp (observed runtime state: ${observed.state}).`,
        );
      }
      const lock = await acquireSetupLock(paths.root);
      const stagingPaths = managedPaths({ dataDirectory: lock.stagingRoot });
      try {
        await mkdir(lock.stagingRoot, { mode: 0o700 });
        await chmod(lock.stagingRoot, 0o700);
        await mkdir(stagingPaths.whatsapp, { mode: 0o700 });
        await chmod(stagingPaths.whatsapp, 0o700);
        // The staging archive absorbs the pairing sync and is discarded; the application
        // database, credentials, configuration, and unresolved work are never touched.
        const archive = createConversationArchive(stagingPaths.applicationDatabase);
        const account = firstRunServices.whatsappFor(stagingPaths, archive);
        try {
          const identity = await account.authenticate(whatsappCallbacks, authenticationSignal());
          const candidates = await account.synchronizedChats(authenticationSignal());
          const managedChat = configuration.managedChats[0]!;
          if (!candidates.some((candidate) => candidate.jid.toLowerCase() === managedChat.toLowerCase())) {
            throw new Error(
              `The newly paired WhatsApp account (${identity.jid}) does not see the configured managed chat ${managedChat}; nothing was replaced.`,
            );
          }
          output.stdout(`Paired WhatsApp as ${identity.jid}; the configured managed chat is visible.\n`);
        } finally {
          try {
            await account.stop();
          } finally {
            archive.close();
          }
        }
        await promoteReplacementWhatsAppStore(paths, stagingPaths.whatsapp);
        output.stdout(
          `Replaced the managed WhatsApp store at ${paths.whatsapp}; configuration, credentials, and history are unchanged.\n`,
        );
      } finally {
        try {
          await rm(lock.stagingRoot, { recursive: true, force: true });
        } finally {
          await releaseSetupLock(lock);
        }
      }
    });

  program
    .command("start")
    .description("start the generated Flue server in the foreground")
    .option("--debug", "verbose diagnostic logging, including raw upstream WhatsApp records")
    .option("--log-format <format>", "log output format: pretty or json (default: pretty on a TTY, json otherwise)")
    .action(async (options) => {
      const format = options.logFormat;
      if (format !== undefined && format !== "pretty" && format !== "json") {
        throw new Error("The --log-format option must be pretty or json.");
      }
      const paths = managedPaths({ dataDirectory: program.opts().dataDir });
      const inspection = await inspectManagedData({ dataDirectory: paths.root });
      if (inspection.state !== "ready") {
        throw new Error(
          inspection.state === "absent"
            ? "Ambient Agent is not configured; run ambient-agent init first."
            : `Refusing to start ${inspection.state} managed data at ${paths.root}; run ambient-agent doctor.`,
        );
      }
      const blockingCheck = (await inspectManagedServices(paths)).find(
        ({ state }) => state !== "ready" && state !== "paired",
      );
      if (blockingCheck !== undefined) {
        throw new Error(
          blockingCheck.name === "whatsapp-session"
            ? `WhatsApp requires re-pairing (${blockingCheck.code}). Run ambient-agent repair whatsapp; the rest of the managed installation is preserved.`
            : `Refusing to start managed data at ${paths.root}: ${blockingCheck.code}. Run ambient-agent doctor.`,
        );
      }
      await startRuntime(paths, { debug: options.debug ?? false, ...(format === undefined ? {} : { format }) });
    });

  program
    .command("status")
    .description("report whether the managed installation is ready")
    .option("--json", "emit machine-readable JSON")
    .action(async (options) => {
      const report = await reportInspection(options.json ?? false, false, false, true, { mode: "status" });
      if (report.installation.state === "absent") exitCode = 2;
      else if (
        report.installation.state !== "ready" ||
        report.authentication.state !== "ready" ||
        report.checks.some(({ state }) => state !== "ready" && state !== "paired" && state !== "online") ||
        report.observedRuntime?.state === "failed" ||
        report.uncertainWork?.health === "degraded"
      )
        exitCode = 3;
    });

  program
    .command("doctor")
    .description("diagnose managed configuration, permissions, and credential references")
    .option("--json", "emit machine-readable JSON")
    .option("--refresh", "verify and safely rotate an expired ChatGPT credential")
    .option("--live", "make gated real GitHub and model readiness requests")
    .option("--retry <ref>", "explicitly retry mutation:<operationId> under a fresh Operation Identity")
    .option("--abandon <ref>", "explicitly abandon mutation:<operationId> while preserving its audit")
    .option("--accept-observed <ref>", "accept observed desired state for an external mutation")
    .action(async (options) => {
      const actions = [options.retry, options.abandon, options.acceptObserved].filter(
        (value): value is string => value !== undefined,
      );
      if (actions.length > 1) throw new Error("Choose only one of --retry, --abandon, or --accept-observed.");
      const report = await reportInspection(
        options.json ?? false,
        Boolean(options.refresh || options.live),
        options.live ?? false,
        false,
        {
          mode: "doctor",
          ...(options.retry === undefined ? {} : { retry: options.retry as UncertainWorkRef }),
          ...(options.abandon === undefined ? {} : { abandon: options.abandon as UncertainWorkRef }),
          ...(options.acceptObserved === undefined
            ? {}
            : { acceptObserved: options.acceptObserved as UncertainWorkRef }),
        },
      );
      if (
        report.installation.state !== "ready" ||
        report.authentication.state !== "ready" ||
        report.checks.some(({ state }) => state !== "ready" && state !== "paired" && state !== "online") ||
        report.liveCheck?.request === "failed" ||
        report.uncertainWork?.health === "degraded" ||
        report.uncertainAction?.outcome === "failed"
      ) {
        exitCode = 1;
      }
    });

  try {
    let args = [...argv];
    const informational = args.some((arg) => arg === "--help" || arg === "-h" || arg === "--version" || arg === "-V");
    const overridden = args.some((arg) => arg === "--data-dir" || arg.startsWith("--data-dir="));
    if (!informational && !overridden) {
      // ADR 0015: adopt a pre-existing platform-native installation before any
      // component opens a database or credential file. --data-dir skips it.
      const migration = await (dependencies.migrateManagedData ?? migrateLegacyManagedData)();
      if (migration.migrated) {
        // stderr keeps stdout clean for machine consumers of `status --json`.
        output.stderr(`Moved managed data from ${migration.source} to ${migration.root}.\n`);
      }
    }
    const bare = bareDataDirectory(args);
    if (bare !== undefined) {
      const inspection = await inspectManagedData({ dataDirectory: bare.dataDirectory });
      if (inspection.state === "absent") args.push("init");
      else if (
        inspection.state === "ready" &&
        interactive &&
        (await inspectWhatsAppSession(managedPaths({ dataDirectory: bare.dataDirectory }))).state ===
          "re-pair-required"
      ) {
        args.push("repair", "whatsapp");
      } else args.push("status");
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
