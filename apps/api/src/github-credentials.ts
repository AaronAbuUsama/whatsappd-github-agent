import type { Client } from "@libsql/client";
import { GITHUB_APP_REFERENCES } from "@ambient-agent/installation/schema.ts";
import { z } from "zod";

import type { TenantRuntimeCredentialFiles } from "./provisioner";

type GitHubAppReference = (typeof GITHUB_APP_REFERENCES)[number];

const appSchema = z.object({
  appId: z.string().regex(/^\d+$/u, "GitHub App IDs must be numeric strings"),
  slug: z.string().min(1),
  privateKey: z.string().min(1),
  webhookSecret: z.string().min(1),
});

const appsSchema = z.object({
  coder: appSchema,
  reviewer: appSchema,
  planner: appSchema,
});

export const parseJsonEnvironment = (value: string, name: string): unknown => {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new Error(`${name} must contain valid JSON`);
  }
};

export const parseHostedGitHubApps = (appsJson: string) =>
  appsSchema.parse(parseJsonEnvironment(appsJson, "GITHUB_APPS_JSON"));

/**
 * Compose only the runtime credential files. Installation ownership stays in
 * the #205 registry; per-tenant bridge identity stays in the #206 secret codec.
 */
export const createGitHubCredentialFilesForTenant = (options: {
  readonly client: Pick<Client, "execute">;
  readonly appsJson: string;
  readonly runtimeBridgeSecretForTenant: (tenantId: string) => string;
}) => {
  const apps = parseHostedGitHubApps(options.appsJson);
  return async (tenantId: string): Promise<TenantRuntimeCredentialFiles | null> => {
    const result = await options.client.execute({
      sql: `SELECT role, installation_id
              FROM github_installation
             WHERE tenant_id = ?1 AND status = 'installed'
             ORDER BY role`,
      args: [tenantId],
    });
    const installationIds = new Map<GitHubAppReference, string>();
    for (const row of result.rows) {
      const role = String(row.role);
      const installationId = row.installation_id;
      if (
        !GITHUB_APP_REFERENCES.includes(role as GitHubAppReference) ||
        installationId === null ||
        installationId === undefined ||
        !/^\d+$/u.test(String(installationId))
      ) {
        return null;
      }
      installationIds.set(role as GitHubAppReference, String(installationId));
    }
    if (GITHUB_APP_REFERENCES.some((role) => !installationIds.has(role))) return null;
    return Object.fromEntries(
      GITHUB_APP_REFERENCES.map((role) => [
        role,
        JSON.stringify({
          schemaVersion: 1,
          kind: "github-app",
          appId: apps[role].appId,
          installationId: installationIds.get(role)!,
          privateKey: apps[role].privateKey,
          ...(role === "planner"
            ? { webhookSecret: options.runtimeBridgeSecretForTenant(tenantId) }
            : {}),
        }),
      ]),
    ) as TenantRuntimeCredentialFiles;
  };
};
