import type { Hono } from "hono";

import { configureBraintrustTracing } from "@ambient-agent/engine/braintrust.ts";
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
import { readProvisionedGitHubAppCredential } from "@ambient-agent/installation/configuration.ts";
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
 * Bind the Coder's deployment runtime (§8 template rule 1: config-bound, never per-job). The
 * sandbox is always resolved now (#251, `local` by default), and a missing or mispasted coder App
 * credential fails boot loudly (#247) rather than mounting `start_coder_job` against a dead
 * identity — the configured-but-inert failure the one-box plan bans for the Speaker and Coder alike.
 */
const configureCoderRuntimeBinding = async (
  paths: ManagedRuntimeDependencies["paths"],
  agentSandbox: ManagedRuntimeDependencies["agentSandbox"],
): Promise<void> => {
  const credential = await readProvisionedGitHubAppCredential(paths.githubAppCredentials.coder, "coder");
  configureCoderRuntime({
    github: githubAppClient(credential) as unknown as CoderGitHub,
    sandbox: agentSandbox.sandbox,
    workspacesRoot: agentSandbox.workspacesRoot,
  });
};

/**
 * Bind the Reviewer's deployment runtime. A missing or mispasted reviewer App credential fails boot
 * loudly (#247), same as the Coder. Resolving the App's own slug is a network call whose transient
 * failure leaves review unprovisioned with a warning rather than bricking a boot: the Reviewer's
 * GitHub access is verified lazily, exactly as the Coder's is, so a GitHub blip at boot must not
 * take down a runtime whose Coder path (T3) does not depend on it. The review ingress itself stays
 * off until a deployment opts repositories into `reviewRepositories` (T5b, #254).
 */
const configureReviewerRuntimeBinding = async (
  paths: ManagedRuntimeDependencies["paths"],
  agentSandbox: ManagedRuntimeDependencies["agentSandbox"],
): Promise<{ github: ReviewerGitHub; appSlug: string } | undefined> => {
  const credential = await readProvisionedGitHubAppCredential(paths.githubAppCredentials.reviewer, "reviewer");
  const github = githubAppClient(credential) as unknown as ReviewerGitHub;
  try {
    const appSlug = await reviewerSlug(github);
    configureReviewerRuntime({
      github,
      sandbox: agentSandbox.sandbox,
      workspacesRoot: agentSandbox.workspacesRoot,
    });
    return { github, appSlug };
  } catch (cause) {
    console.warn("[reviewer] could not resolve the reviewer App identity; automatic PR review is unprovisioned", cause);
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
  braintrustApiKey,
}: ManagedRuntimeDependencies): Promise<Hono> => {
  const { provider, profiles } = configuration.model;
  configureAgentModelProfiles(profiles, provider);
  // Register Braintrust tracing here, inside the runtime bundle, so the isolate-scoped
  // @flue/runtime observer attaches to the same isolate that emits events (#252). The key
  // arrives through the dependencies the CLI read from credentials/braintrust.json; tracing
  // stays off when runtime.tracing.enabled is false (the CLI passes no key) — never from env.
  configureBraintrustTracing({
    ...(configuration.runtime.tracing.enabled && braintrustApiKey !== undefined ? { apiKey: braintrustApiKey } : {}),
    ...(configuration.runtime.tracing.project === undefined ? {} : { project: configuration.runtime.tracing.project }),
  });
  // An API-key provider needs no api registration: every `api` pi's catalog names is already
  // built in, so the key is the whole binding.
  const subscription =
    provider === SUBSCRIPTION_PROVIDER_ID
      ? await connectPiChatGptSubscription({ authentication, profiles })
      : await connectPiApiKeyProvider({ provider, apiKey: modelApiKey ?? "", profiles });
  const issueOperations = createIssueOperationStore(paths.applicationDatabase);
  const runtimeId = bridge?.runtimeId ?? runtimeInstallationId(githubCredential.webhookSecret);
  // The Coder Specialist (#158) runs under its own App identity in the config-bound per-job
  // sandbox the selector resolved (ADR 0021, #251) — shared with the Reviewer. A missing or
  // mispasted coder App credential fails boot loudly rather than mounting a dead capability.
  await configureCoderRuntimeBinding(paths, agentSandbox);
  const reviewerProvisioned = await configureReviewerRuntimeBinding(paths, agentSandbox);
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
