import { createGitHubDeliveryRelay, type GitHubRuntimeDeliveryTarget } from "@ambient-agent/api/github-control";
import { createGitHubControlStore, type GitHubAppRole } from "@ambient-agent/db/github-control";
import { runtimeInstallationId } from "@ambient-agent/installation/runtime-health.ts";
import type { Hono } from "hono";
import { z } from "zod";

import { installGitHubRoutes, type GitHubAppServerConfiguration } from "./github-routes";
import { tenantBridge } from "./tenant-bridge";

const appSchema = z.object({
  appId: z.string().min(1),
  slug: z.string().min(1),
  privateKey: z.string().min(1),
  webhookSecret: z.string().min(1),
});

const appsSchema = z.object({
  coder: appSchema,
  reviewer: appSchema,
  planner: appSchema,
});

const runtimeSecretsSchema = z.record(z.string().min(1), z.string().min(1));

const parseJson = (value: string, name: string): unknown => {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`${name} must contain valid JSON`);
  }
};

export const installHostedGitHub = (options: {
  readonly app: Hono;
  readonly client: Parameters<typeof createGitHubControlStore>[0];
  readonly appsJson: string;
  readonly runtimeSecretsJson?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly relayIntervalMs?: number;
}): (() => void) => {
  const parsedApps = appsSchema.parse(parseJson(options.appsJson, "GITHUB_APPS_JSON"));
  const roles: readonly GitHubAppRole[] = ["coder", "reviewer", "planner"];
  const apps = Object.fromEntries(
    roles.map((role) => [role, { role, ...parsedApps[role] } satisfies GitHubAppServerConfiguration]),
  ) as unknown as Readonly<Record<GitHubAppRole, GitHubAppServerConfiguration>>;
  const store = createGitHubControlStore(options.client);
  installGitHubRoutes(options.app, { store, apps });

  if (options.runtimeSecretsJson === undefined) return () => undefined;
  const runtimeSecrets = runtimeSecretsSchema.parse(
    parseJson(options.runtimeSecretsJson, "GITHUB_RUNTIME_DELIVERY_SECRETS_JSON"),
  );
  const relay = createGitHubDeliveryRelay({
    store,
    targets: {
      resolve: async (tenantId): Promise<GitHubRuntimeDeliveryTarget | null> => {
        const runtime = await store.runtimeTarget(tenantId);
        const webhookSecret = runtimeSecrets[tenantId];
        return runtime === null || webhookSecret === undefined
          ? null
          : {
              tenantId,
              runtimeId: runtimeInstallationId(webhookSecret),
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
