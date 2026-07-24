import { dirname, join } from "node:path";

import type { Hono } from "hono";

import { configureBraintrustTracing } from "@ambient-agent/engine/braintrust.ts";
import { composeSpeaker } from "@ambient-agent/agents/speaker/compose.ts";
import { admitGitHubEventToBrain } from "@ambient-agent/engine/github/up-inbox.ts";
import { createIssueManagementPolicy } from "@ambient-agent/agents/capabilities/issue-management/runtime.ts";
import { createIssueOperationStore } from "@ambient-agent/engine/github/operation-store.ts";
import { createGraphStore } from "@ambient-agent/engine/graph/store.ts";
import { seedRepositoryFacts } from "@ambient-agent/agents/capabilities/graph/seed-repositories.ts";
import { installDelegationBridge } from "@ambient-agent/agents/capabilities/delegation/bridge.ts";
import { configureCoderRuntime } from "@ambient-agent/agents/capabilities/coder/runtime.ts";
import { createCodingJobRegistry } from "@ambient-agent/agents/capabilities/coder/registry.ts";
import { createRepairLauncher } from "@ambient-agent/agents/capabilities/coder/continuation.ts";
import { configureReviewerRuntime } from "@ambient-agent/agents/capabilities/reviewer/runtime.ts";
import { reviewerSlug, type ReviewerGitHub } from "@ambient-agent/agents/capabilities/reviewer/github.ts";
import { reviewer } from "@ambient-agent/agents/capabilities/reviewer/workflow.ts";
import { coder, type CoderGitHub } from "@ambient-agent/agents/capabilities/coder/workflow.ts";
import { parseGitHubRepository } from "@ambient-agent/engine/github/repository.ts";
import {
  createInstallationResolver,
  githubAppJwtClient,
  type InstallationResolver,
} from "@ambient-agent/installation/github-app-client.ts";
import { readManagedConfig, readProvisionedGitHubAppCredential } from "@ambient-agent/installation/configuration.ts";
import { createManagedConfigStore } from "@ambient-agent/installation/managed-config-store.ts";
import { applyManagedAuthorization, reloadAuthorizationOnSignal } from "./host/authorization-reload.ts";
import { createOctokitIssueRepository } from "@ambient-agent/installation/github-issue-repository.ts";
import { invoke } from "@flue/runtime";
import { createFlueClient } from "@flue/sdk";
import { configureScribeAttemptDispatch } from "@ambient-agent/agents/scribe/coalescer.ts";
import { scribeDirectBaseUrl, scribeDirectToken } from "@ambient-agent/agents/scribe/direct-access.ts";
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
  registry: ReturnType<typeof createCodingJobRegistry>,
): Promise<{ github: (repo: { owner: string; repo: string }) => Promise<CoderGitHub> }> => {
  const credential = await readProvisionedGitHubAppCredential(paths.githubAppCredentials.coder, "coder");
  const resolver = createInstallationResolver(credential);
  const github = async (repo: { owner: string; repo: string }) =>
    (await resolver.octokitFor(repo.owner, repo.repo)) as unknown as CoderGitHub;
  configureCoderRuntime({
    github,
    sandbox: agentSandbox.sandbox,
    workspacesRoot: agentSandbox.workspacesRoot,
    registry,
  });
  return { github };
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
): Promise<{ resolver: InstallationResolver; appSlug: string } | undefined> => {
  const credential = await readProvisionedGitHubAppCredential(paths.githubAppCredentials.reviewer, "reviewer");
  const resolver = createInstallationResolver(credential);
  try {
    // The App slug is App-identity (a JWT route), the same across every installation, so it is
    // resolved once against the App JWT rather than any one installation.
    const appSlug = await reviewerSlug(githubAppJwtClient(credential) as unknown as ReviewerGitHub);
    configureReviewerRuntime({
      github: async (repo) => (await resolver.octokitFor(repo.owner, repo.repo)) as unknown as ReviewerGitHub,
      sandbox: agentSandbox.sandbox,
      workspacesRoot: agentSandbox.workspacesRoot,
    });
    return { resolver, appSlug };
  } catch (cause) {
    console.warn("[reviewer] could not resolve the reviewer App identity; automatic PR review is unprovisioned", cause);
    return undefined;
  }
};

export const createAmbientAgentApp = async ({
  authentication,
  configuration,
  deployment,
  githubCredential,
  paths,
  agentSandbox,
  modelApiKey,
  braintrustApiKey,
}: ManagedRuntimeDependencies): Promise<Hono> => {
  const { provider, profiles } = configuration.model;
  configureAgentModelProfiles(profiles, provider);
  const scribeClient = createFlueClient({
    baseUrl: scribeDirectBaseUrl(configuration.runtime.port),
    token: scribeDirectToken(),
  });
  configureScribeAttemptDispatch((attemptId, batch) =>
    scribeClient.agents.prompt("scribe", attemptId, { message: JSON.stringify(batch) }),
  );
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
  installDelegationBridge();
  const runtimeId = runtimeInstallationId(githubCredential.webhookSecret);
  // The Coder Specialist (#158) runs under its own App identity in the config-bound per-job
  // sandbox the selector resolved (ADR 0021, #251) — shared with the Reviewer. A missing or
  // mispasted coder App credential fails boot loudly rather than mounting a dead capability.
  // #211: the coding-job registry — the durable PR→job map that lets a Reviewer REQUEST_CHANGES
  // find the issue/branch/budgets to repair against. Its own SQLite file (not the audited,
  // migration-governed application database), rebuilt lazily; it holds no GitHub-owned review state.
  const codingJobRegistry = createCodingJobRegistry(join(dirname(paths.applicationDatabase), "coding-jobs.sqlite"));
  const coderBinding = await configureCoderRuntimeBinding(paths, agentSandbox, codingJobRegistry);
  const reviewerProvisioned = await configureReviewerRuntimeBinding(paths, agentSandbox);
  let whatsappControl: WhatsAppRuntimeControl | undefined;
  // The Speaker/Planner file one identity, but issues may be filed across orgs — resolve the
  // installation-scoped client per issue repository (multi-org). Every issue op carries a full
  // {owner, repo}, so we route through the repo-installation lookup, which works for both User and
  // Organization owners. A single transient lookup failure falls back to the stored installation id.
  const plannerResolver = createInstallationResolver(githubCredential);
  // S2 (#19): seed the authorized repositories and surface→repository relations as Graph facts
  // with provenance, so the Brain resolves the target repository from the Graph per decision
  // instead of guessing (F4). Authorization stays in config; this is the relation, not the
  // permission boundary. Idempotent — a re-run against unchanged config is a no-op.
  const graph = createGraphStore(paths.applicationDatabase);
  seedRepositoryFacts(graph, {
    allowedRepositories: configuration.github.allowedRepositories,
    surfaceRepositories: configuration.github.surfaceRepositories,
  });
  // S8 (#179): the DB-backed live source for authorization-knob reloads. Re-seeded from config.json
  // (the durable source of truth) at every boot; a live change writes both, then a SIGHUP reload
  // rebuilds the gate Set and repo allowlists in place — no restart, WhatsApp stream untouched. It is
  // its own SQLite file, deliberately NOT a table in the audited application database: that schema is
  // migration-governed and rejects unknown tables, and this store is ephemeral (rebuilt from config).
  const managedConfigStore = createManagedConfigStore(
    join(dirname(paths.applicationDatabase), "managed-config.sqlite"),
  );
  managedConfigStore.replace(configuration);
  // Hoisted so the SIGHUP reload can rebuild them in place. `reviewRepositories` is the exact mutable
  // array the ingress reads live (see ingress `review.repositories`), so splicing it updates the
  // Reviewer allowlist with no re-wiring.
  const policy = createIssueManagementPolicy(
    configuration.github.defaultRepository,
    configuration.github.allowedRepositories,
  );
  const reviewRepositories = [...configuration.github.reviewRepositories];
  const app = composeSpeaker({
    issues: createOctokitIssueRepository((repository) =>
      plannerResolver.octokitFor(repository.owner, repository.repo),
    ),
    operations: issueOperations,
    policy,
    ingress: {
      settings: {
        databasePath: paths.applicationDatabase,
      },
      // GitHub events enter the single Brain up-inbox (§4). The Brain — not a routing table —
      // decides which Surface(s) hear each event. The port is configured once the Brain inbox
      // exists, inside startWhatsAppRuntime, so this resolves lazily.
      admit: (event) => admitGitHubEventToBrain(event),
      ...(reviewerProvisioned ? {
        review: {
          repositories: reviewRepositories,
          launch: async (input) => {
            const admitted = await invoke(reviewer, { input });
            return admitted;
          },
          // #211: a Reviewer-App REQUEST_CHANGES on a registered Coder PR repairs it. The launcher
          // owns the registry idempotency guard + two-cycle budget; over-budget demotes to draft
          // and posts one lifecycle comment under the Coder App identity, launching no run.
          repair: createRepairLauncher({
            registry: codingJobRegistry,
            github: coderBinding.github,
            invokeCoder: (input) => invoke(coder, { input } as never),
            parseRepository: (repository) =>
              parseGitHubRepository(repository, (value) => new Error(`Coder repository must be owner/repo, got ${value}`)),
          }),
          command: {
            appSlug: reviewerProvisioned.appSlug,
            permission: async (input) => {
              const gh = (await reviewerProvisioned.resolver.octokitFor(input.owner, input.repo)) as unknown as ReviewerGitHub;
              return (await gh.repos.getCollaboratorPermissionLevel(input)).data.permission;
            },
            pullRequest: async ({ owner, repo, pullRequest }) => {
              const gh = (await reviewerProvisioned.resolver.octokitFor(owner, repo)) as unknown as ReviewerGitHub;
              const { data } = await gh.pulls.get({ owner, repo, pull_number: pullRequest });
              return { state: data.state, draft: data.draft ?? false, headSha: data.head.sha };
            },
          },
        },
      } : {}),
    },
    graph,
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
        webhookSecret: githubCredential.webhookSecret,
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
      ...(configuration.smoke === undefined ? {} : { canaryChat: configuration.smoke.canaryChat }),
    });
    whatsappControl = whatsapp;
    stopRuntimeOnSignal(whatsapp);
  });

  // S8 (#179): reload the authorization knobs in place on SIGHUP — the operator's trigger after the
  // real `ambient-agent config` command commits to config.json (its durable source of truth). We re-read
  // config.json, refresh the DB-backed store from it, and apply the re-validated snapshot: the gate Set
  // (+ each authorized chat's Surface), the two repo allowlists, and the repository Graph facts all
  // catch up with no restart. The WhatsApp session, model provider, port and sandbox stay restart-only.
  reloadAuthorizationOnSignal(async () => {
    const next = await readManagedConfig(paths.config);
    managedConfigStore.replace(next);
    applyManagedAuthorization(managedConfigStore.current(), {
      reloadManagedChats: (chatIds) => whatsappControl?.reloadManagedChats(chatIds),
      policy,
      reviewRepositories,
      reseedRepositoryGraph: (config) =>
        seedRepositoryFacts(graph, {
          allowedRepositories: config.github.allowedRepositories,
          surfaceRepositories: config.github.surfaceRepositories,
        }),
    });
  });

  return app;
};

export default await createAmbientAgentApp(getManagedRuntimeDependencies());
