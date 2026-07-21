import { createGitHubDeliveryRelay, type GitHubRuntimeDeliveryTarget } from "@ambient-agent/api/github-control";
import { createGitHubControlStore, type GitHubAppRole } from "@ambient-agent/db/github-control";
import { runtimeInstallationId } from "@ambient-agent/installation/runtime-health.ts";
import type { Hono } from "hono";
import { z } from "zod";

import { installGitHubRoutes, type GitHubAppServerConfiguration } from "./github-routes";
import { parseHostedGitHubApps, parseJsonEnvironment } from "./github-credentials";
import { tenantBridge } from "./tenant-bridge";

const runtimeSecretsSchema = z.record(z.string().min(1), z.string().min(1));

export const installHostedGitHub = (options: {
  readonly app: Hono;
  readonly client: Parameters<typeof createGitHubControlStore>[0];
  readonly appsJson: string;
  readonly runtimeSecretsJson?: string;
  readonly runtimeSecretForTenant?: (tenantId: string) => string | null;
  readonly runtimeIdForTenant?: (tenantId: string) => string;
  readonly fetch?: typeof globalThis.fetch;
  readonly relayIntervalMs?: number;
}): (() => void) => {
  const parsedApps = parseHostedGitHubApps(options.appsJson);
  const roles: readonly GitHubAppRole[] = ["coder", "reviewer", "planner"];
  const apps = Object.fromEntries(
    roles.map((role) => [role, { role, ...parsedApps[role] } satisfies GitHubAppServerConfiguration]),
  ) as unknown as Readonly<Record<GitHubAppRole, GitHubAppServerConfiguration>>;
  const store = createGitHubControlStore(options.client);
  installGitHubRoutes(options.app, { store, apps });

  if ((options.runtimeSecretForTenant === undefined) !== (options.runtimeIdForTenant === undefined)) {
    throw new Error("Hosted GitHub delivery requires both runtime bridge-secret and runtime-ID resolvers");
  }
  if (options.runtimeSecretsJson === undefined && options.runtimeSecretForTenant === undefined) {
    return () => undefined;
  }
  const runtimeSecrets =
    options.runtimeSecretForTenant !== undefined || options.runtimeSecretsJson === undefined
      ? {}
      : runtimeSecretsSchema.parse(
          parseJsonEnvironment(options.runtimeSecretsJson, "GITHUB_RUNTIME_DELIVERY_SECRETS_JSON"),
        );
  const relay = createGitHubDeliveryRelay({
    store,
    targets: {
      resolve: async (tenantId): Promise<GitHubRuntimeDeliveryTarget | null> => {
        const runtime = await store.runtimeTarget(tenantId);
        const webhookSecret = options.runtimeSecretForTenant
          ? options.runtimeSecretForTenant(tenantId)
          : runtimeSecrets[tenantId];
        return runtime === null || webhookSecret === undefined || webhookSecret === null
          ? null
          : {
              tenantId,
              runtimeId: options.runtimeIdForTenant?.(tenantId) ?? runtimeInstallationId(webhookSecret),
              baseUrl: runtime.baseUrl,
              webhookSecret,
            };
      },
    },
    deliveries: {
      deliver: async (target, delivery) =>
        await tenantBridge({
          baseUrl: target.baseUrl,
          webhookSecret: target.webhookSecret,
          ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        }).deliver(delivery),
    },
  });
  let draining = false;
  const drain = async (): Promise<void> => {
    if (draining) return;
    draining = true;
    try {
      await relay.drainOnce();
    } catch (cause) {
      console.error("[github-delivery-relay] drain failed", cause);
    } finally {
      draining = false;
    }
  };
  const interval = setInterval(() => void drain(), options.relayIntervalMs ?? 1_000);
  interval.unref();
  void drain();
  return () => clearInterval(interval);
};
