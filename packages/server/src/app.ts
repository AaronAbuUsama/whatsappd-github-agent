import type { Hono } from "hono";

import "@ambient-agent/core/braintrust.ts";
import { composeAmbience } from "@ambient-agent/core/ambience/compose.ts";
import { dispatchAmbience } from "@ambient-agent/core/ambience/dispatch.ts";
import { createIssueManagementPolicy } from "@ambient-agent/core/capabilities/issue-management/runtime.ts";
import { createIssueOperationStore } from "@ambient-agent/core/capabilities/issue-management/operation-store.ts";
import { createOctokitIssueRepository } from "@ambient-agent/core/host/github-issue-repository.ts";
import {
  getWhatsAppRuntimeStatus,
  startWhatsAppRuntime,
  type WhatsAppRuntimeControl,
} from "./host/whatsapp-runtime.js";
import { installSmokeRoute } from "./host/smoke-route.js";
import { installAgentActivityReporter } from "@ambient-agent/core/logging/agent-activity-reporter.ts";
import {
  deferWhatsAppRuntimeStart,
  getManagedRuntimeDependencies,
  type ManagedRuntimeDependencies,
} from "@ambient-agent/core/managed/runtime-dependencies.ts";
import { ambientRuntimeHealth, runtimeInstallationId } from "@ambient-agent/core/managed/runtime-health.ts";
import { connectPiChatGptSubscription } from "@ambient-agent/core/model/pi-subscription.ts";

export const createAmbientAgentApp = async ({
  authentication,
  configuration,
  githubCredential,
  paths,
}: ManagedRuntimeDependencies): Promise<Hono> => {
  installAgentActivityReporter();
  const subscription = await connectPiChatGptSubscription({ authentication });
  const issueOperations = createIssueOperationStore(paths.applicationDatabase);
  const installationId = runtimeInstallationId(githubCredential.webhookSecret);
  let whatsappControl: WhatsAppRuntimeControl | undefined;
  const app = composeAmbience({
    issues: createOctokitIssueRepository(githubCredential.token),
    operations: issueOperations,
    policy: createIssueManagementPolicy(
      configuration.github.defaultRepository,
      configuration.github.allowedRepositories,
    ),
    ingress: {
      settings: {
        databasePath: paths.applicationDatabase,
        routes: new Map([[configuration.github.defaultRepository.toLowerCase(), configuration.managedChats[0]!]]),
      },
      dispatch: async (chatId, input) => await dispatchAmbience({ id: chatId, input }),
    },
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
