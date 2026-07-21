import { Buffer } from "node:buffer";

import type { Client } from "@libsql/client";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  createHostedTenantProvisioner,
  startTenantProvisionerReconciliation,
} from "../../apps/api/src/provisioner-hosted";
import { createTenantSecretCodec } from "../../apps/api/src/provisioner-providers";
import { runtimeInstallationId } from "../../packages/installation/src/runtime-health";

afterEach(() => vi.useRealTimers());

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

  test("builds tenant-bound runtime secrets and GitHub credential files from the hosted contracts", async () => {
    const encryptionKey = Buffer.alloc(32, 9).toString("base64");
    const client = {
      execute: vi.fn(async () => ({
        rows: [
          { role: "coder", installation_id: 101 },
          { role: "reviewer", installation_id: 102 },
          { role: "planner", installation_id: 103 },
        ],
      })),
    } as unknown as Client;
    const provisioner = createHostedTenantProvisioner({
      client,
      environment: {
        DOKPLOY_API_URL: "https://dokploy.example",
        DOKPLOY_API_KEY: "dokploy-secret",
        DOKPLOY_ENVIRONMENT_ID: "environment-one",
        DOKPLOY_SERVER_ID: "server-one",
        DOKPLOY_WORKER_HOSTNAME: "worker-one",
        TENANT_RUNTIME_IMAGE: "ghcr.io/ambient/runtime:sha-one",
        TURSO_ORG: "ambient-org",
        TURSO_PLATFORM_TOKEN: "turso-secret",
        TENANT_SECRET_ENCRYPTION_KEY: encryptionKey,
        GITHUB_APPS_JSON: JSON.stringify({
          coder: {
            appId: "11",
            slug: "ambient-coder",
            privateKey: "coder-private-key",
            webhookSecret: "coder-webhook-secret",
          },
          reviewer: {
            appId: "12",
            slug: "ambient-reviewer",
            privateKey: "reviewer-private-key",
            webhookSecret: "reviewer-webhook-secret",
          },
          planner: {
            appId: "13",
            slug: "ambient-planner",
            privateKey: "planner-private-key",
            webhookSecret: "global-github-webhook-secret-must-not-reach-the-runtime",
          },
        }),
      },
    });

    expect(provisioner).toMatchObject({
      reconcileTenant: expect.any(Function),
      reconcilePendingTenants: expect.any(Function),
      acknowledgeQuiescence: expect.any(Function),
      reconciliationIntervalMs: 5_000,
      decryptTenantToken: expect.any(Function),
      runtimeCredentialFilesForTenant: expect.any(Function),
      runtimeBridgeSecretForTenant: expect.any(Function),
      runtimeIdForTenant: expect.any(Function),
    });
    const encrypted = createTenantSecretCodec(encryptionKey).encrypt("private-tenant-token");
    expect(provisioner!.decryptTenantToken(encrypted)).toBe("private-tenant-token");
    const files = await provisioner!.runtimeCredentialFilesForTenant("tenant-one");
    expect(Object.keys(files ?? {})).toEqual(["coder", "reviewer", "planner"]);
    expect(JSON.parse(files!.coder)).toEqual({
      schemaVersion: 1,
      kind: "github-app",
      appId: "11",
      installationId: "101",
      privateKey: "coder-private-key",
    });
    expect(JSON.parse(files!.planner)).toEqual({
      schemaVersion: 1,
      kind: "github-app",
      appId: "13",
      installationId: "103",
      privateKey: "planner-private-key",
      webhookSecret: provisioner!.runtimeBridgeSecretForTenant("tenant-one"),
    });
    expect(files!.planner).not.toContain("global-github-webhook-secret-must-not-reach-the-runtime");
    expect(provisioner!.runtimeIdForTenant("tenant-one")).toBe(
      runtimeInstallationId(provisioner!.runtimeBridgeSecretForTenant("tenant-one")),
    );
  });

  test("keeps sweeping later transitions without overlapping a slow sweep", async () => {
    vi.useFakeTimers();
    let releaseFirst: (() => void) | undefined;
    const firstSweep = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const reconcilePendingTenants = vi
      .fn<() => Promise<unknown>>()
      .mockReturnValueOnce(firstSweep)
      .mockResolvedValue([]);
    const loop = startTenantProvisionerReconciliation(
      { reconcilePendingTenants },
      { intervalMs: 1_000 },
    );

    expect(reconcilePendingTenants).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(reconcilePendingTenants).toHaveBeenCalledTimes(1);
    releaseFirst?.();
    await firstSweep;
    await vi.advanceTimersByTimeAsync(1_000);
    expect(reconcilePendingTenants).toHaveBeenCalledTimes(2);

    loop.stop();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(reconcilePendingTenants).toHaveBeenCalledTimes(2);
  });
});
