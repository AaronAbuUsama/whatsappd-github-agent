import type { Client } from "@libsql/client";
import { z } from "zod";

import { createTenantProvisioner } from "./provisioner";
import {
  createDokployProvider,
  createTenantSecretCodec,
  createTursoPlatformClient,
} from "./provisioner-providers";

const providerKeys = [
  "DOKPLOY_API_URL",
  "DOKPLOY_API_KEY",
  "DOKPLOY_ENVIRONMENT_ID",
  "DOKPLOY_SERVER_ID",
  "DOKPLOY_WORKER_HOSTNAME",
  "TENANT_RUNTIME_IMAGE",
  "TURSO_ORG",
  "TURSO_PLATFORM_TOKEN",
  "TENANT_SECRET_ENCRYPTION_KEY",
] as const;

const configurationSchema = z.object({
  DOKPLOY_API_URL: z.url(),
  DOKPLOY_API_KEY: z.string().min(1),
  DOKPLOY_ENVIRONMENT_ID: z.string().min(1),
  DOKPLOY_SERVER_ID: z.string().min(1),
  DOKPLOY_WORKER_HOSTNAME: z.string().min(1),
  DOKPLOY_NETWORK_NAME: z.string().min(1).default("dokploy-network"),
  TENANT_RUNTIME_IMAGE: z.string().min(1),
  TENANT_RUNTIME_DATA_DIRECTORY: z
    .string()
    .regex(/^\/[^\s]*\/\.ambient-agent$/u, "must be an absolute .ambient-agent directory")
    .default("/root/.ambient-agent"),
  TENANT_RUNTIME_PORT: z.coerce.number().int().positive().max(65_535).default(3000),
  TURSO_ORG: z.string().min(1),
  TURSO_GROUP: z.string().min(1).default("default"),
  TURSO_PLATFORM_TOKEN: z.string().min(1),
  TENANT_SECRET_ENCRYPTION_KEY: z.string().min(1),
});

export const createHostedTenantProvisioner = (options: {
  readonly client: Client;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof globalThis.fetch;
}) => {
  const environment = options.environment ?? process.env;
  if (!providerKeys.some((key) => environment[key]?.trim())) return null;
  const configuration = configurationSchema.parse(environment);
  const secrets = createTenantSecretCodec(configuration.TENANT_SECRET_ENCRYPTION_KEY);
  const provisioner = createTenantProvisioner({
    client: options.client,
    turso: createTursoPlatformClient({
      organization: configuration.TURSO_ORG,
      group: configuration.TURSO_GROUP,
      platformToken: configuration.TURSO_PLATFORM_TOKEN,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    }),
    dokploy: createDokployProvider({
      baseUrl: configuration.DOKPLOY_API_URL,
      apiKey: configuration.DOKPLOY_API_KEY,
      environmentId: configuration.DOKPLOY_ENVIRONMENT_ID,
      serverId: configuration.DOKPLOY_SERVER_ID,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    }),
    secrets,
    configuration: {
      runtimeImage: configuration.TENANT_RUNTIME_IMAGE,
      workerHostname: configuration.DOKPLOY_WORKER_HOSTNAME,
      networkName: configuration.DOKPLOY_NETWORK_NAME,
      dataDirectory: configuration.TENANT_RUNTIME_DATA_DIRECTORY,
      port: configuration.TENANT_RUNTIME_PORT,
    },
  });
  return {
    ...provisioner,
    runtimeBridgeSecretForTenant: secrets.bridgeSecret,
    runtimeIdForTenant: secrets.runtimeId,
  };
};
