import type { Hono } from "hono";

import "@ambient-agent/engine/braintrust.ts";
import { composeSpeaker } from "@ambient-agent/agents/speaker/compose.ts";
import { dispatchSpeaker } from "@ambient-agent/agents/speaker/dispatch.ts";
import { createIssueManagementPolicy } from "@ambient-agent/agents/capabilities/issue-management/runtime.ts";
import { createIssueOperationStore } from "@ambient-agent/engine/github/operation-store.ts";
import { createGraphStore } from "@ambient-agent/engine/graph/store.ts";
import { createRunLedger } from "@ambient-agent/agents/capabilities/delegation/ledger.ts";
import { sweepUnsettledLaunches } from "@ambient-agent/agents/capabilities/delegation/bridge.ts";
import { configureCoderRuntime } from "@ambient-agent/agents/capabilities/coder/runtime.ts";
import type { CoderGitHub } from "@ambient-agent/agents/capabilities/coder/workflow.ts";
import { githubAppClient } from "@ambient-agent/installation/github-app-client.ts";
import { readManagedGitHubAppCredential } from "@ambient-agent/installation/configuration.ts";
import { createOctokitIssueRepository } from "@ambient-agent/installation/github-issue-repository.ts";
import { local } from "@flue/runtime/node";
import {
  getWhatsAppRuntimeStatus,
  startWhatsAppRuntime,
  type WhatsAppRuntimeControl,
} from "./host/whatsapp-runtime.ts";
import { installSmokeRoute } from "./host/smoke-route.ts";
import {
  deferWhatsAppRuntimeStart,
  getManagedRuntimeDependencies,
  type ManagedRuntimeDependencies,
} from "@ambient-agent/installation/runtime-dependencies.ts";
import { ambientRuntimeHealth, runtimeInstallationId } from "@ambient-agent/installation/runtime-health.ts";
import { connectPiChatGptSubscription } from "@ambient-agent/engine/model/pi-subscription.ts";

/**
 * Bind the Coder's deployment runtime (§8 template rule 1: config-bound, never per-job).
 * The coder GitHub App does not exist on every install yet; a missing credential file is
 * expected, so we skip configuration rather than fail the whole runtime's boot.
 */
const configureCoderRuntimeIfProvisioned = async (paths: ManagedRuntimeDependencies["paths"]): Promise<void> => {
  let credential: Awaited<ReturnType<typeof readManagedGitHubAppCredential>>;
  try {
    credential = await readManagedGitHubAppCredential(paths.githubAppCredentials.coder);
  } catch {
    console.warn("[coder] no coder App credential; start_coder_job is mounted but unprovisioned");
    return;
  }
  configureCoderRuntime({
    github: githubAppClient(credential) as unknown as CoderGitHub,
    sandbox: local(),
    workspacesRoot: paths.workspaces,
    maxAttempts: 3,
  });
};

export const createAmbientAgentApp = async ({
  authentication,
  configuration,
  githubCredential,
  paths,
}: ManagedRuntimeDependencies): Promise<Hono> => {
  const subscription = await connectPiChatGptSubscription({ authentication });
  const issueOperations = createIssueOperationStore(paths.applicationDatabase);
  const installationId = runtimeInstallationId(githubCredential.webhookSecret);
  // The Coder Specialist (#158) runs under its own App identity in a config-bound full
  // sandbox — `local()` on the single-owner VPS (host-trusted), a remote container in
  // SaaS. The coder App may not be provisioned yet; if its credential is absent, the
  // start_coder_job tool stays mounted but a launch fails loudly rather than blocking boot.
  await configureCoderRuntimeIfProvisioned(paths);
  let whatsappControl: WhatsAppRuntimeControl | undefined;
  // A SpeakerInput is a SpeakerInput, so the funnel delivers a specialist result to both
  // Speaker and Scribe. Held out here so the boot sweep can reuse it after the port is wired.
  const delegation = {
    ledger: createRunLedger(paths.applicationDatabase),
    dispatch: (request: Parameters<typeof dispatchSpeaker>[0]) => dispatchSpeaker(request),
  };
  const app = composeSpeaker({
    issues: createOctokitIssueRepository(githubAppClient(githubCredential)),
    operations: issueOperations,
    policy: createIssueManagementPolicy(
      configuration.github.defaultRepository,
      configuration.github.allowedRepositories,
    ),
    ingress: {
      settings: {
        databasePath: paths.applicationDatabase,
        // Broadcast: a supported GitHub event fans out to every managed thread's Speaker,
        // each judging relevance itself (#144). The repo→chat mapping now survives only for
        // specialist-return (resolveSpecialistReturnChat), not inbound routing.
        managedChats: configuration.managedChats,
      },
      dispatch: async (chatId, input) => await dispatchSpeaker({ id: chatId, input }),
    },
    graph: createGraphStore(paths.applicationDatabase),
    delegation,
    // The WhatsApp participation port is wired later by runWhatsAppSession, once the
    // live socket exists.
    health: () => {
      const runtime = ambientRuntimeHealth(getWhatsAppRuntimeStatus());
      return {
        ok: runtime.state === "healthy",
        installationId,
        ...subscription,
        runtime: { state: runtime.state, whatsapp: { phase: runtime.whatsapp.phase } },
      };
    },
    routes: (routes) => {
      installSmokeRoute(routes, {
        webhookSecret: githubCredential.webhookSecret,
        canaryConfigured: configuration.smoke !== undefined,
        control: () => whatsappControl,
      });
    },
  });

  // Deferred until the CLI observes a successful HTTP bind, so an occupied port
  // fails startup before WhatsApp ever connects (#87). For the instant between the
  // bind and the CLI invoking this starter, /health reports the WhatsApp phase as
  // "disabled"; every health consumer polls, so the window is harmless.
  deferWhatsAppRuntimeStart(() => {
    const whatsapp = startWhatsAppRuntime({
      storeDirectory: paths.whatsapp,
      applicationDatabase: paths.applicationDatabase,
      managedChats: configuration.managedChats,
      // The ADR 0001 boot sweep, deferred to here: once per boot, after the participation
      // port is wired (so the Speaker can voice each `interrupted` notification), detached,
      // errors caught. Any launch a crash left unsettled self-heals into a chat message.
      afterParticipationReady: () => {
        void sweepUnsettledLaunches(delegation).catch((cause) => {
          console.error("[delegation] boot sweep failed", cause);
        });
      },
      ...(configuration.smoke === undefined ? {} : { canaryChat: configuration.smoke.canaryChat }),
    });
    whatsappControl = whatsapp;
    for (const signal of ["SIGINT", "SIGTERM"] as const) {
      const shutdown = () => {
        void whatsapp.stop().finally(() => {
          process.removeListener(signal, shutdown);
          process.kill(process.pid, signal);
        });
      };
      process.once(signal, shutdown);
    }
  });

  return app;
};

export default await createAmbientAgentApp(getManagedRuntimeDependencies());
