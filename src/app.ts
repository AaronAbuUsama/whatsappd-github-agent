import { flue } from "@flue/runtime/routing";
import { Hono } from "hono";

import { dispatchAmbience } from "./ambience/dispatch.js";
import {
  configureIssueManagementRuntime,
  createIssueManagementPolicy,
} from "./capabilities/issue-management/runtime.js";
import { createIssueOperationStore } from "./capabilities/issue-management/operation-store.js";
import { installGitHubIngressRuntime } from "./github/ingress-runtime.js";
import { createOctokitIssueRepository } from "./host/github-issue-repository.js";
import { getWhatsAppRuntimeStatus, startWhatsAppRuntime } from "./host/whatsapp-runtime.js";
import { installAgentActivityReporter } from "./logging/agent-activity-reporter.js";
import {
  deferWhatsAppRuntimeStart,
  getManagedRuntimeDependencies,
  type ManagedRuntimeDependencies,
} from "./managed/runtime-dependencies.js";
import { ambientRuntimeHealth, runtimeInstallationId } from "./managed/runtime-health.js";
import { connectPiChatGptSubscription } from "./model/pi-subscription.js";

export const createAmbientAgentApp = async ({
  authentication,
  configuration,
  githubCredential,
  paths,
}: ManagedRuntimeDependencies): Promise<Hono> => {
  installAgentActivityReporter();
  const subscription = await connectPiChatGptSubscription({ authentication });
  installGitHubIngressRuntime(
    {
      databasePath: paths.applicationDatabase,
      routes: new Map([[configuration.github.defaultRepository.toLowerCase(), configuration.managedChats[0]!]]),
    },
    async (chatId, input) => await dispatchAmbience({ id: chatId, input }),
  );
  configureIssueManagementRuntime({
    repository: createOctokitIssueRepository(githubCredential.token),
    operations: createIssueOperationStore(paths.applicationDatabase),
    policy: createIssueManagementPolicy(
      configuration.github.defaultRepository,
      configuration.github.allowedRepositories,
    ),
  });

  const app = new Hono();
  app.get("/health", (context) => {
    const runtime = ambientRuntimeHealth(getWhatsAppRuntimeStatus());
    return context.json({
      ok: runtime.state === "healthy",
      installationId: runtimeInstallationId(githubCredential.webhookSecret),
      ...subscription,
      runtime: { state: runtime.state, whatsapp: { phase: runtime.whatsapp.phase } },
    });
  });
  app.route("/", flue());

  // Deferred until the CLI observes a successful HTTP bind, so an occupied port
  // fails startup before WhatsApp ever connects (#87). For the instant between the
  // bind and the CLI invoking this starter, /health reports the WhatsApp phase as
  // "disabled"; every health consumer polls, so the window is harmless.
  deferWhatsAppRuntimeStart(() => {
    const whatsapp = startWhatsAppRuntime({
      storeDirectory: paths.whatsapp,
      applicationDatabase: paths.applicationDatabase,
      managedChats: configuration.managedChats,
    });
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
