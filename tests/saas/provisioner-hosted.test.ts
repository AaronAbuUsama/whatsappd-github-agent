import { Buffer } from "node:buffer";

import type { Client } from "@libsql/client";
import { describe, expect, test } from "vitest";

import { createHostedTenantProvisioner } from "../../apps/api/src/provisioner-hosted";

describe("hosted tenant provisioner composition", () => {
  test("is disabled when no provider configuration is present", () => {
    expect(createHostedTenantProvisioner({ client: {} as Client, environment: {} })).toBeNull();
  });

  test("fails API startup on partial provider configuration", () => {
    expect(() =>
      createHostedTenantProvisioner({
        client: {} as Client,
        environment: { DOKPLOY_API_URL: "https://dokploy.example" },
      }),
    ).toThrow(/DOKPLOY_API_KEY/u);
  });

  test("builds the in-process reconciler only from a complete environment", () => {
    const provisioner = createHostedTenantProvisioner({
      client: {} as Client,
      environment: {
        DOKPLOY_API_URL: "https://dokploy.example",
        DOKPLOY_API_KEY: "dokploy-secret",
        DOKPLOY_ENVIRONMENT_ID: "environment-one",
        DOKPLOY_SERVER_ID: "server-one",
        DOKPLOY_WORKER_HOSTNAME: "worker-one",
        TENANT_RUNTIME_IMAGE: "ghcr.io/ambient/runtime:sha-one",
        TURSO_ORG: "ambient-org",
        TURSO_PLATFORM_TOKEN: "turso-secret",
        TENANT_SECRET_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
      },
    });

    expect(provisioner).toMatchObject({
      reconcileTenant: expect.any(Function),
      reconcilePendingTenants: expect.any(Function),
      acknowledgeQuiescence: expect.any(Function),
      runtimeBridgeSecretForTenant: expect.any(Function),
      runtimeIdForTenant: expect.any(Function),
    });
  });
});
