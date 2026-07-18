import type { Hono } from "hono";

import "@ambient-agent/engine/braintrust.ts";
import { composeSpeaker } from "@ambient-agent/agents/speaker/compose.ts";
import { dispatchSpeaker } from "@ambient-agent/agents/speaker/dispatch.ts";
import { createIssueManagementPolicy } from "@ambient-agent/agents/capabilities/issue-management/runtime.ts";
import { createIssueOperationStore } from "@ambient-agent/engine/github/operation-store.ts";
import { createGraphStore } from "@ambient-agent/engine/graph/store.ts";
import { githubAppClient } from "@ambient-agent/installation/github-app-client.ts";
import { createOctokitIssueRepository } from "@ambient-agent/installation/github-issue-repository.ts";
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

export const createAmbientAgentApp = async ({
  authentication,
  configuration,
  githubCredential,
  paths,
}: ManagedRuntimeDependencies): Promise<Hono> => {
  const subscription = await connectPiChatGptSubscription({ authentication });
  const issueOperations = createIssueOperationStore(paths.applicationDatabase);
  const installationId = runtimeInstallationId(githubCredential.webhookSecret);
  let whatsappControl: WhatsAppRuntimeControl | undefined;
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
