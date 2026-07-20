import { githubAppClient } from "@ambient-agent/installation/github-app-client.ts";
import { createOctokitIssueRepository } from "@ambient-agent/installation/github-issue-repository.ts";
import { createConversationArchive } from "@ambient-agent/engine/intake/conversation-archive.ts";
import { createManagedChatInbox, inspectWindowDeliveryCounts } from "@ambient-agent/engine/intake/managed-chat-inbox.ts";
import { createIssueOperationStore } from "@ambient-agent/engine/github/operation-store.ts";
import { createManagedChatGptAuthentication } from "@ambient-agent/installation/chatgpt-authentication.ts";
import { readManagedConfig, readManagedGitHubAppCredential } from "@ambient-agent/installation/configuration.ts";
import { inspectManagedServices } from "@ambient-agent/installation/diagnostics.ts";
import { inspectManagedData } from "@ambient-agent/installation/installation.ts";
import { managedPaths, type ManagedPaths } from "@ambient-agent/installation/paths.ts";
import { probeAmbientRuntimeHealth, runtimeInstallationId, type AmbientRuntimeHealth } from "@ambient-agent/installation/runtime-health.ts";
import {
  createUncertainWorkController,
  inspectUncertainWorkStatus,
  type UncertainWorkController,
  type UncertainWorkRef,
  type UncertainWorkStatus,
} from "@ambient-agent/installation/uncertain-work.ts";
import type { ChatGptAuthentication, ChatGptAuthenticationStatus } from "@ambient-agent/engine/model/chatgpt-authentication.ts";
import {
  ChatGptReadinessError,
  configuredModelIds,
  modelSpecifier,
  runChatGptReadinessCheck,
  type ChatGptReadinessReceipt,
} from "@ambient-agent/engine/model/pi-subscription.ts";
import { verifyGitHubAppRepositoryAccess } from "./setup/github.ts";
import type { CliDependencies, CliOutput } from "./program.ts";
import { renderInspection, type InspectionReport, type WindowDeliveryCounts } from "./rendering.ts";

type InspectionUncertainty =
  | { readonly mode: "status" }
  | {
      readonly mode: "doctor";
      readonly retry?: UncertainWorkRef;
      readonly abandon?: UncertainWorkRef;
      readonly acceptObserved?: UncertainWorkRef;
    };

interface InspectionReporterOptions {
  readonly dataDirectory: () => string | undefined;
  readonly output: CliOutput;
  readonly dependencies: CliDependencies;
  readonly authenticationFor?: (paths: ManagedPaths) => ChatGptAuthentication;
  readonly operationSignal: (timeoutMillis: number) => AbortSignal;
}

export const createInspectionReporter = ({
  dataDirectory,
  output,
  dependencies,
  authenticationFor: authenticationOverride,
  operationSignal,
}: InspectionReporterOptions) => {
  const authenticationFor =
    authenticationOverride ??
    ((paths: ManagedPaths) =>
      createManagedChatGptAuthentication(paths, dependencies.chatGptOAuth, dependencies.environment ?? process.env));
  const inspectUncertainWork = dependencies.inspectUncertainWork ?? inspectUncertainWorkStatus;
  const inspectWindowDeliveries = dependencies.inspectWindowDeliveries ?? inspectWindowDeliveryCounts;
  const readinessSignal = (): AbortSignal => operationSignal(dependencies.readinessTimeoutMillis ?? 60_000);
  const verifyGitHub =
    dependencies.firstRunServices?.verifyGitHub ??
    ((credential, repository, signal) => verifyGitHubAppRepositoryAccess({ credential, repository, signal }));
  const runtimeHealthFor =
    dependencies.runtimeHealthFor ??
    (async (paths: ManagedPaths) => {
      const configuration = await readManagedConfig(paths.config);
      const credential = await readManagedGitHubAppCredential(paths.githubAppCredentials.planner);
      if (credential.webhookSecret === undefined) return { state: "stopped", whatsapp: { phase: "stopped" } } as const;
      return await probeAmbientRuntimeHealth({
        port: configuration.runtime.port,
        installationId: runtimeInstallationId(credential.webhookSecret),
        timeoutMillis: 750,
      });
    });
  const uncertainWorkFor =
    dependencies.uncertainWorkFor ??
    (async (paths: ManagedPaths): Promise<UncertainWorkController> => {
      const credential = await readManagedGitHubAppCredential(paths.githubAppCredentials.planner);
      const archive = createConversationArchive(paths.applicationDatabase);
      try {
        // Opening the inbox performs the one-way Window-ledger migration (ADR 0014).
        createManagedChatInbox(archive, { allowed: () => false });
      } finally {
        archive.close();
      }
      return createUncertainWorkController({
        operations: createIssueOperationStore(paths.applicationDatabase),
        repository: createOctokitIssueRepository(githubAppClient(credential)),
      });
    });

  return async (
    json: boolean,
    refresh: boolean = false,
    live: boolean = false,
    observeRuntime: boolean = false,
    uncertainty?: InspectionUncertainty,
    emit: boolean = true,
  ): Promise<InspectionReport> => {
    const paths = managedPaths({ dataDirectory: dataDirectory() });
    const inspection = await inspectManagedData({ dataDirectory: paths.root });
    const ready = inspection.state === "ready";
    const configuration = ready ? await readManagedConfig(paths.config) : undefined;
    const checks = ready ? [...(await inspectManagedServices(paths, dependencies.environment ?? process.env))] : [];
    const githubCredentialReady = checks.some(
      ({ name, state }) => name === "github-credential" && state === "ready",
    );
    const managedGitHubCredential =
      ready && githubCredentialReady
        ? await readManagedGitHubAppCredential(paths.githubAppCredentials.planner)
        : undefined;
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
      try {
        await verifyGitHub(managedGitHubCredential, configuration!.github.defaultRepository, readinessSignal());
        checks.push({
          name: "github-access",
          state: "ready",
          code: "github.ready",
          message: `GitHub authenticated and can access ${configuration!.github.defaultRepository}.`,
        });
      } catch {
        checks.push({
          name: "github-access",
          state: "failed",
          code: "github.access-failed",
          message: `GitHub authentication or repository access failed for ${configuration!.github.defaultRepository}.`,
          remediation: "Run ambient-agent config --github-app <coder|reviewer|planner> with a fresh App triple, then run doctor --live again.",
        });
      }
    }
    const authentication = ready ? authenticationFor(paths) : undefined;
    // The default probe derives its correlation ID from the GitHub credential's webhook
    // secret; when that is unreadable the runtime is honestly unobservable, not stopped.
    const observedRuntime: AmbientRuntimeHealth | undefined =
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
          dependencies.readinessCheck ??
          ((service, signal) =>
            runChatGptReadinessCheck(service, {
              profiles: configuration!.model.profiles,
              signal,
            }))
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
        const { profiles, provider } = configuration!.model;
        liveCheck = {
          model: modelSpecifier(provider, profiles.speaker.id),
          models: configuredModelIds(profiles).map((id) => modelSpecifier(provider, id)),
          request: "failed",
          reason: failure.code,
        };
        if (failure.code === "credential-rejected") {
          authenticationStatus = { state: "unusable", message: failure.message };
        }
      }
    }
    let uncertainWork: UncertainWorkStatus | undefined;
    let windowDeliveries: WindowDeliveryCounts | undefined;
    let uncertainDoctor: InspectionReport["uncertainDoctor"];
    let uncertainAction: InspectionReport["uncertainAction"];
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
            "Uncertain-work actions need a usable GitHub credential. Run ambient-agent config --github-app <coder|reviewer|planner> and paste a fresh App triple.",
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
    const report: InspectionReport = {
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
    if (emit) output.stdout(renderInspection(report, json));
    return report;
  };
};
