import { chmod, lstat, mkdir, readFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { Command, CommanderError } from "@commander-js/extra-typings";
import packageManifest from "../../../package.json" with { type: "json" };

import { upstreamWhatsAppLogger } from "@ambient-agent/engine/logging/logging.ts";
import {
  acquireSetupLock,
  githubAppCredentialFrom,
  inspectManagedData,
  promoteReplacementWhatsAppStore,
  releaseSetupLock,
} from "@ambient-agent/installation/installation.ts";
import { createManagedChatGptAuthentication } from "@ambient-agent/installation/chatgpt-authentication.ts";
import {
  atomicWriteManagedConfig,
  readManagedConfig,
  readManagedGitHubAppCredential,
  writeManagedConfiguration,
} from "@ambient-agent/installation/configuration.ts";
import { inspectManagedServices, inspectWhatsAppSession } from "@ambient-agent/installation/diagnostics.ts";
import {
  migrateLegacyManagedData,
  migrateManagedGitHubCredential,
  type ManagedDataMigration,
} from "@ambient-agent/installation/migration.ts";
import {
  GITHUB_APP_REFERENCES,
  type GitHubAppReference,
  type GitHubAppTriple,
  type GitHubAppTriples,
} from "@ambient-agent/installation/schema.ts";
import { managedPaths, type ManagedPaths } from "@ambient-agent/installation/paths.ts";
import {
  probeAmbientRuntimeHealth,
  runtimeInstallationId,
  type AmbientRuntimeHealth,
} from "@ambient-agent/installation/runtime-health.ts";
import {
  type UncertainWorkController,
  type UncertainWorkRef,
  type UncertainWorkStatus,
} from "@ambient-agent/installation/uncertain-work.ts";
import {
  type ChatGptOAuthAdapter,
  type ChatGptAuthentication,
} from "@ambient-agent/engine/model/chatgpt-authentication.ts";
import type { ChatGptReadinessReceipt } from "@ambient-agent/engine/model/pi-subscription.ts";
import {
  discoverOriginRepository,
  normalizeGitHubRepository,
  verifyGitHubAppRepositoryAccess,
} from "./setup/github.ts";
import { runFirstRunSetup, type FirstRunServices, type SetupReview } from "./setup/first-run.ts";
import { createWhatsAppAccount } from "@ambient-agent/installation/whatsapp-account.ts";
import { createConversationArchive, migrateConversationArchiveSchema } from "@ambient-agent/engine/intake/conversation-archive.ts";
import { createDeviceCodeCallbacks, createWhatsAppCallbacks, defaultSetupPrompts, type SetupPrompts } from "./prompts.ts";
import {
  parseRuntimePort,
  startGeneratedRuntime,
  type ImportRuntime,
  type RuntimeLoggingOptions,
  type StartRuntime,
} from "./lifecycle.ts";
import { createInspectionReporter } from "./inspection.ts";
import type { WindowDeliveryCounts } from "./rendering.ts";
import {
  renderSmokeStations,
  requestRuntimeSmokeCanary,
  smokeStations,
  type SmokeCanary,
} from "./smoke.ts";

export interface CliOutput {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

export type { SetupPrompts } from "./prompts.ts";

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
  readonly smokeCanaryFor?: SmokeCanary;
  readonly smokeTimeoutMillis?: number;
  readonly createNonce?: () => string;
}

export type { ImportRuntime, StartRuntime } from "./lifecycle.ts";
export type { WindowDeliveryCounts } from "./rendering.ts";

const defaultOutput: CliOutput = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};


/** Read three App triples from a private JSON file for headless (non-interactive) setup. */
const readGitHubAppTriplesFile = async (path: string): Promise<GitHubAppTriples> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new Error(`Could not read GitHub App triples from ${path}; expected a JSON object.`);
  }
  const triples = {} as Record<GitHubAppReference, GitHubAppTriple>;
  for (const reference of GITHUB_APP_REFERENCES) {
    const entry = (parsed as Record<string, unknown> | null)?.[reference] as Partial<GitHubAppTriple> | undefined;
    const appId = entry?.appId?.trim();
    const installationId = entry?.installationId?.trim();
    const privateKey = entry?.privateKey?.trim();
    if (!appId || !installationId || !privateKey) {
      throw new Error(`The ${reference} App triple in ${path} needs a non-empty appId, installationId, and privateKey.`);
    }
    triples[reference] = { appId, installationId, privateKey };
  }
  return triples;
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
    verifyGitHub:
      serviceOverrides.verifyGitHub ??
      ((credential, repository, signal) => verifyGitHubAppRepositoryAccess({ credential, repository, signal })),
  };
  const startRuntime =
    dependencies.startRuntime ??
    ((paths: ManagedPaths, logging: RuntimeLoggingOptions) =>
      startGeneratedRuntime(paths, logging, authenticationFor(paths), dependencies.importRuntime));
  const runtimeHealthFor =
    dependencies.runtimeHealthFor ??
    (async (paths) => {
      const configuration = await readManagedConfig(paths.config);
      const credential = await readManagedGitHubAppCredential(paths.githubAppCredentials.planner);
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
  const deviceCodeCallbacks = createDeviceCodeCallbacks(output);
  const whatsappCallbacks = createWhatsAppCallbacks(output);
  let exitCode = 0;
  const program = new Command()
    .name("ambient-agent")
    .description("Install and operate the Ambient Agent managed runtime")
    .version(packageManifest.version)
    .option("--data-dir <path>", "override the managed data directory")
    .configureOutput({ writeOut: output.stdout, writeErr: output.stderr })
    .exitOverride();
  const reportInspection = createInspectionReporter({
    dataDirectory: () => program.opts().dataDir,
    output,
    dependencies,
    authenticationFor,
    operationSignal,
  });
  const readyManagedPaths = async (verb: string): Promise<ManagedPaths> => {
    const paths = managedPaths({ dataDirectory: program.opts().dataDir });
    const inspection = await inspectManagedData({ dataDirectory: paths.root });
    if (inspection.state !== "ready") {
      throw new Error(
        inspection.state === "absent"
          ? "Ambient Agent is not configured; run ambient-agent init first."
          : `Refusing to ${verb} ${inspection.state} managed data at ${paths.root}; run ambient-agent doctor.`,
      );
    }
    return paths;
  };

  program
    .command("init")
    .description("create a secure managed installation")
    .option("--chat <jid>", "managed WhatsApp chat JID")
    .option("--repository <owner/name>", "default GitHub repository")
    .option("--github-apps-file <path>", "read the three GitHub App triples from a private JSON file")
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
      const scriptedApps =
        options.githubAppsFile === undefined ? undefined : await readGitHubAppTriplesFile(options.githubAppsFile);
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
          ...(scriptedApps === undefined ? {} : { githubApps: scriptedApps }),
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
      const paths = await readyManagedPaths("authenticate against");
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
    .option("--canary-chat <jid>", "dedicated managed WhatsApp group for live smoke canaries")
    .option("--repository <owner/name>", "default GitHub repository")
    .option("--port <port>", "foreground runtime HTTP port")
    .option("--github-app <reference>", "rotate one GitHub App (coder|reviewer|planner) by pasting a fresh triple")
    .action(async (options) => {
      const paths = await readyManagedPaths("reconfigure");
      const currentConfig = await readManagedConfig(paths.config);
      const rotateReference = options.githubApp as GitHubAppReference | undefined;
      if (rotateReference !== undefined && !GITHUB_APP_REFERENCES.includes(rotateReference)) {
        throw new Error("The --github-app reference must be one of coder, reviewer, or planner.");
      }
      // One-time token->App cutover: a lingering personal-token file is walked to three Apps.
      const credentialMigration = await migrateManagedGitHubCredential({
        paths,
        collectTriples: () => setupPrompts.githubApps(currentConfig.github.defaultRepository),
      });
      if (credentialMigration.migrated) {
        output.stdout("Provisioned three GitHub Apps and retired the personal-token credential.\n");
      }
      const currentCredential = await readManagedGitHubAppCredential(paths.githubAppCredentials.planner);
      let selected = {
        jid: options.chat ?? currentConfig.managedChats[0]!,
        name: options.chat ?? currentConfig.managedChats[0]!,
        kind: (options.chat ?? currentConfig.managedChats[0]!).endsWith("@g.us")
          ? ("group" as const)
          : ("direct" as const),
      };
      const knownCanary =
        options.canaryChat === undefined
          ? undefined
          : currentConfig.managedChats.find(
              (chat) => chat.toLowerCase() === options.canaryChat!.toLowerCase() && chat.endsWith("@g.us"),
            );
      let canaryChat = knownCanary ?? options.canaryChat ?? currentConfig.smoke?.canaryChat;

      if (interactive || options.chat !== undefined || (options.canaryChat !== undefined && knownCanary === undefined)) {
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
          if (interactive || options.chat !== undefined) {
            const jid = interactive ? await setupPrompts.selectChat(candidates) : options.chat!;
            const candidate = candidates.find((item) => item.jid.toLowerCase() === jid.toLowerCase());
            if (candidate === undefined) {
              throw new Error("The selected WhatsApp chat was not found in the authenticated account sync result.");
            }
            selected = { jid: candidate.jid, name: candidate.name, kind: candidate.kind };
          }
          if (options.canaryChat !== undefined) {
            const candidate = candidates.find(
              (item) => item.jid.toLowerCase() === options.canaryChat!.toLowerCase(),
            );
            if (candidate === undefined || candidate.kind !== "group") {
              throw new Error("The smoke canary chat must be a synchronized WhatsApp group.");
            }
            canaryChat = candidate.jid;
          }
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
      // Rotation re-pastes one App's triple; the Planner file also keeps the runtime webhook secret.
      let rotatedPlanner: typeof currentCredential | undefined;
      if (rotateReference !== undefined) {
        if (!interactive) throw new Error("Rotating a GitHub App requires the interactive guided paste.");
        const triple = await setupPrompts.githubApp(rotateReference, repository);
        const rotated = {
          ...githubAppCredentialFrom(rotateReference, { [rotateReference]: triple } as GitHubAppTriples),
          ...(rotateReference === "planner" && currentCredential.webhookSecret !== undefined
            ? { webhookSecret: currentCredential.webhookSecret }
            : {}),
        };
        if (rotateReference === "planner") rotatedPlanner = rotated;
        else await atomicWriteManagedConfig(paths.githubAppCredentials[rotateReference], rotated);
      }
      // The runtime's own identity is the Planner App, so it proves access to the repository.
      const plannerCredential = rotatedPlanner ?? currentCredential;
      const verifiedRepository = await firstRunServices.verifyGitHub(
        plannerCredential,
        repository,
        authenticationSignal(),
      );
      const review: SetupReview = {
        dataDirectory: paths.root,
        chat: selected,
        repository: verifiedRepository,
        chatGptCredentialSource: "existing managed credential",
        whatsappCredentialSource: "existing managed session",
        githubCredentialSource:
          rotateReference === undefined ? "existing managed credential" : `rotated ${rotateReference} App`,
      };
      if (interactive && !(await setupPrompts.review(review))) {
        throw new Error("Configuration cancelled; managed configuration was not changed.");
      }
      const managedChats = [
        selected.jid,
        ...(canaryChat === undefined || canaryChat.toLowerCase() === selected.jid.toLowerCase() ? [] : [canaryChat]),
        ...currentConfig.managedChats.filter(
          (chat) =>
            chat.toLowerCase() !== selected.jid.toLowerCase() &&
            (canaryChat === undefined || chat.toLowerCase() !== canaryChat.toLowerCase()),
        ),
      ];
      const allowedRepositories = [...currentConfig.github.allowedRepositories, verifiedRepository].filter(
        (repository, index, all) =>
          all.findIndex((candidate) => candidate.toLowerCase() === repository.toLowerCase()) === index,
      );
      const runtimePort = options.port === undefined ? currentConfig.runtime.port : parseRuntimePort(options.port);
      await writeManagedConfiguration(
        paths.config,
        paths.githubAppCredentials.planner,
        {
          ...currentConfig,
          managedChats,
          ...(canaryChat === undefined ? {} : { smoke: { canaryChat } }),
          runtime: { port: runtimePort },
          github: {
            ...currentConfig.github,
            defaultRepository: verifiedRepository,
            allowedRepositories,
          },
        },
        plannerCredential,
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
      const paths = await readyManagedPaths("repair components of");
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
      const paths = await readyManagedPaths("start");
      // Application schema migrations must run before diagnostics compare the
      // on-disk version with the current owned schema.
      migrateConversationArchiveSchema(paths.applicationDatabase);
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
    .command("smoke")
    .description("run the live installation, provider, runtime, backlog, GitHub, and canary battery")
    .option("--timeout <milliseconds>", "live canary timeout", "30000")
    .action(async (options) => {
      const timeoutMillis = Number(options.timeout);
      if (!Number.isInteger(timeoutMillis) || timeoutMillis < 1 || timeoutMillis > 300_000) {
        throw new Error("The smoke timeout must be an integer from 1 through 300000 milliseconds.");
      }
      const paths = managedPaths({ dataDirectory: program.opts().dataDir });
      const report = await reportInspection(false, true, true, true, { mode: "status" }, false);
      const nonce = (dependencies.createNonce ?? (() => randomUUID().replaceAll("-", "").slice(0, 12)))();
      const stations = await smokeStations(
        report,
        paths,
        nonce,
        dependencies.smokeTimeoutMillis ?? timeoutMillis,
        dependencies.smokeCanaryFor ?? requestRuntimeSmokeCanary,
      );
      output.stdout(renderSmokeStations(stations));
      if (stations.some(({ passed }) => !passed)) exitCode = 1;
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
