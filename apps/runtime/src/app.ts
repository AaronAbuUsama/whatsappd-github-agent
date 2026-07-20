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
import { configureReviewerRuntime } from "@ambient-agent/agents/capabilities/reviewer/runtime.ts";
import { reviewerSlug, type ReviewerGitHub } from "@ambient-agent/agents/capabilities/reviewer/github.ts";
import { reviewer } from "@ambient-agent/agents/capabilities/reviewer/workflow.ts";
import type { CoderGitHub } from "@ambient-agent/agents/capabilities/coder/workflow.ts";
import { githubAppClient } from "@ambient-agent/installation/github-app-client.ts";
import { readManagedGitHubAppCredential } from "@ambient-agent/installation/configuration.ts";
import { E2B_WORKSPACES_ROOT } from "@ambient-agent/installation/e2b-sandbox.ts";
import { createOctokitIssueRepository } from "@ambient-agent/installation/github-issue-repository.ts";
import { invoke } from "@flue/runtime";
import {
  getWhatsAppRuntimeStatus,
  startWhatsAppRuntime,
  type WhatsAppRuntimeControl,
} from "./host/whatsapp-runtime.ts";
import { installSmokeRoute } from "./host/smoke-route.ts";
import { installBridgeRoute } from "./host/bridge-route.ts";
import { stopRuntimeOnSignal } from "./host/runtime-signals.ts";
import {
  deferWhatsAppRuntimeStart,
  getManagedRuntimeDependencies,
  type ManagedRuntimeDependencies,
} from "@ambient-agent/installation/runtime-dependencies.ts";
import { bridgeHealth } from "@ambient-agent/installation/bridge-contract.ts";
import { runtimeInstallationId } from "@ambient-agent/installation/runtime-health.ts";
import {
  configureAgentModelProfiles,
  connectPiApiKeyProvider,
  connectPiChatGptSubscription,
  SUBSCRIPTION_PROVIDER_ID,
} from "@ambient-agent/engine/model/pi-subscription.ts";

/**
 * Bind the Coder's deployment runtime (§8 template rule 1: config-bound, never per-job).
 * The coder GitHub App does not exist on every install yet; a missing credential file is
 * expected, so we skip configuration rather than fail the whole runtime's boot.
 */
const configureCoderRuntimeIfProvisioned = async (
  paths: ManagedRuntimeDependencies["paths"],
  sandbox: ManagedRuntimeDependencies["agentSandbox"],
): Promise<void> => {
  if (sandbox === undefined) {
    console.warn("[coder] no isolated sandbox binding; start_coder_job is mounted but unprovisioned");
    return;
  }
  let credential: Awaited<ReturnType<typeof readManagedGitHubAppCredential>>;
  try {
    credential = await readManagedGitHubAppCredential(paths.githubAppCredentials.coder);
  } catch {
    console.warn("[coder] no coder App credential; start_coder_job is mounted but unprovisioned");
    return;
  }
  configureCoderRuntime({
    github: githubAppClient(credential) as unknown as CoderGitHub,
    sandbox,
    workspacesRoot: E2B_WORKSPACES_ROOT,
  });
};

const configureReviewerRuntimeIfProvisioned = async (
  paths: ManagedRuntimeDependencies["paths"],
  sandbox: ManagedRuntimeDependencies["agentSandbox"],
): Promise<{ github: ReviewerGitHub; appSlug: string } | undefined> => {
  if (sandbox === undefined) {
    console.warn("[reviewer] no isolated sandbox binding; automatic PR review is disabled");
    return undefined;
  }
  try {
    const credential = await readManagedGitHubAppCredential(paths.githubAppCredentials.reviewer);
    const github = githubAppClient(credential) as unknown as ReviewerGitHub;
    const appSlug = await reviewerSlug(github);
    configureReviewerRuntime({
      github,
      sandbox,
      workspacesRoot: E2B_WORKSPACES_ROOT,
    });
    return { github, appSlug };
  } catch {
    console.warn("[reviewer] no reviewer App credential; automatic PR review is unprovisioned");
    return undefined;
  }
};

export const createAmbientAgentApp = async ({
  authentication,
  configuration,
  bridge,
  deployment,
  githubCredential,
  paths,
  agentSandbox,
  modelApiKey,
}: ManagedRuntimeDependencies): Promise<Hono> => {
  const { provider, profiles } = configuration.model;
  configureAgentModelProfiles(profiles, provider);
  // An API-key provider needs no api registration: every `api` pi's catalog names is already
  // built in, so the key is the whole binding.
  const subscription =
    provider === SUBSCRIPTION_PROVIDER_ID
      ? await connectPiChatGptSubscription({ authentication, profiles })
      : await connectPiApiKeyProvider({ provider, apiKey: modelApiKey ?? "", profiles });
  const issueOperations = createIssueOperationStore(paths.applicationDatabase);
  const runtimeId = bridge?.runtimeId ?? runtimeInstallationId(githubCredential.webhookSecret);
  // The Coder Specialist (#158) runs under its own App identity in the same config-bound
  // per-job E2B sandbox as the Reviewer (ADR 0021) — never a host-local shell. The coder
  // App or the sandbox may not be provisioned yet; if either is absent, the start_coder_job
  // tool stays mounted but a launch fails loudly rather than blocking boot.
  await configureCoderRuntimeIfProvisioned(paths, agentSandbox);
  const reviewerProvisioned = await configureReviewerRuntimeIfProvisioned(paths, agentSandbox);
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
      ...(reviewerProvisioned ? {
        review: {
          repositories: configuration.github.reviewRepositories,
          launch: async (input) => {
            const admitted = await invoke(reviewer, { input });
            delegation.ledger.record({ runId: admitted.runId, workflow: "reviewer", launchedAt: new Date().toISOString() });
            return admitted;
          },
          command: {
            appSlug: reviewerProvisioned.appSlug,
            permission: async (input) =>
              (await reviewerProvisioned.github.repos.getCollaboratorPermissionLevel(input)).data.permission,
            pullRequest: async ({ owner, repo, pullRequest }) => {
              const { data } = await reviewerProvisioned.github.pulls.get({ owner, repo, pull_number: pullRequest });
              return { state: data.state, draft: data.draft ?? false, headSha: data.head.sha };
            },
          },
        },
      } : {}),
    },
    graph: createGraphStore(paths.applicationDatabase),
    delegation,
    // The WhatsApp participation port is wired later by runWhatsAppSession, once the
    // live socket exists.
    health: () => {
      return {
        ...subscription,
        ...bridgeHealth(runtimeId, getWhatsAppRuntimeStatus(), deployment),
      };
    },
    routes: (routes) => {
      installSmokeRoute(routes, {
        webhookSecret: githubCredential.webhookSecret,
        canaryConfigured: configuration.smoke !== undefined,
        control: () => whatsappControl,
      });
      installBridgeRoute(routes, {
        runtimeId,
        webhookSecret: bridge?.bridgeSecret ?? githubCredential.webhookSecret,
        ...(bridge === undefined ? {} : { configVersion: bridge.configVersion }),
        status: getWhatsAppRuntimeStatus,
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
    stopRuntimeOnSignal(whatsapp);
  });

  return app;
};

export default await createAmbientAgentApp(getManagedRuntimeDependencies());
