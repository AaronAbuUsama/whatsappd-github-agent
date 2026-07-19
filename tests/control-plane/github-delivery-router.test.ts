import { createHmac } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Client } from "@libsql/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  createGitHubControlService,
  createGitHubDeliveryRelay,
  type GitHubAppConfiguration,
} from "../../packages/api/src/github-control.ts";
import { openControlDb } from "../../packages/db/src/control-db.ts";
import {
  createGitHubControlStore,
  GitHubControlStoreError,
  type GitHubAppRole,
} from "../../packages/db/src/github-control.ts";

const migrationDirectory = new URL("../../packages/db/src/migrations/", import.meta.url);
const apps = Object.fromEntries(
  (["coder", "reviewer", "planner"] as const).map((role, index) => [
    role,
    {
      role,
      appId: `app-${index + 1}`,
      slug: `ambient-${role}`,
      webhookSecret: `webhook-${role}`,
    } satisfies GitHubAppConfiguration,
  ]),
) as unknown as Readonly<Record<GitHubAppRole, GitHubAppConfiguration>>;

let client: Client | undefined;
let databaseRoot: string | undefined;

const database = async (): Promise<Client> => {
  databaseRoot = await mkdtemp(join(tmpdir(), "ambient-agent-control-github-"));
  const opened = await openControlDb({ url: `file:${join(databaseRoot, "control.sqlite")}` });
  client = opened.client;
  const migrations = (await readdir(migrationDirectory)).filter((file) => file.endsWith(".sql")).sort();
  for (const migration of migrations) {
    await client.executeMultiple(await readFile(new URL(migration, migrationDirectory), "utf8"));
  }
  return client;
};

const seedTenant = async (databaseClient: Client, suffix: string) => {
  const userId = `user-${suffix}`;
  const tenantId = `tenant-${suffix}`;
  await databaseClient.batch([
    {
      sql: "INSERT INTO user (id, name, email) VALUES (?1, ?2, ?3)",
      args: [userId, `User ${suffix}`, `${suffix}@example.com`],
    },
    {
      sql: `INSERT INTO subscription_entitlement (id, user_id, status)
            VALUES (?1, ?2, 'active')`,
      args: [`entitlement-${suffix}`, userId],
    },
    {
      sql: `INSERT INTO tenant (id, user_id, subscription_entitlement_id, display_name, tenant_db_name)
            VALUES (?1, ?2, ?3, ?4, ?5)`,
      args: [tenantId, userId, `entitlement-${suffix}`, `Tenant ${suffix}`, `tenant-db-${suffix}`],
    },
  ]);
  return { userId, tenantId };
};

const signature = (secret: string, body: string): string =>
  `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

afterEach(async () => {
  client?.close();
  client = undefined;
  if (databaseRoot !== undefined) await rm(databaseRoot, { recursive: true });
  databaseRoot = undefined;
});

describe("hosted GitHub callback and repository registry", () => {
  it("publishes only a healthy running Operate runtime as a GitHub delivery target", async () => {
    const databaseClient = await database();
    const owner = await seedTenant(databaseClient, "runtime-target");
    const store = createGitHubControlStore(databaseClient);
    await databaseClient.execute({
      sql: `INSERT INTO agent_instance (
        id, tenant_id, creds_store_key, desired_mode, applied_mode,
        runtime_base_url, dokploy_display_name, dokploy_creation_token
      ) VALUES (
        'runtime-target', ?1, 'tenant-db-runtime-target', 'setup', 'setup',
        'http://setup.internal', 'Runtime Target', 'creation-runtime-target'
      )`,
      args: [owner.tenantId],
    });

    await expect(store.runtimeTarget(owner.tenantId)).resolves.toBeNull();
    await databaseClient.execute({
      sql: `UPDATE tenant SET status = 'active', desired_state = 'running' WHERE id = ?1`,
      args: [owner.tenantId],
    });
    await databaseClient.execute({
      sql: `UPDATE agent_instance
        SET desired_mode = 'operate', applied_mode = 'operate', observed_state = 'healthy',
            phase = 'running', applied_config_version = 1,
            runtime_base_url = 'http://operate.internal'
        WHERE tenant_id = ?1`,
      args: [owner.tenantId],
    });
    await expect(store.runtimeTarget(owner.tenantId)).resolves.toEqual({
      tenantId: owner.tenantId,
      runtimeId: "runtime-target",
      baseUrl: "http://operate.internal",
    });
    await databaseClient.execute({
      sql: `UPDATE tenant SET config_version = 2 WHERE id = ?1`,
      args: [owner.tenantId],
    });
    await expect(store.runtimeTarget(owner.tenantId)).resolves.toBeNull();
    await databaseClient.execute({
      sql: `UPDATE agent_instance SET applied_config_version = 2 WHERE tenant_id = ?1`,
      args: [owner.tenantId],
    });
    await expect(store.runtimeTarget(owner.tenantId)).resolves.toEqual({
      tenantId: owner.tenantId,
      runtimeId: "runtime-target",
      baseUrl: "http://operate.internal",
    });
    await databaseClient.execute({
      sql: `UPDATE tenant SET status = 'suspended' WHERE id = ?1`,
      args: [owner.tenantId],
    });
    await expect(store.runtimeTarget(owner.tenantId)).resolves.toBeNull();
    await databaseClient.execute({
      sql: `UPDATE tenant SET status = 'active' WHERE id = ?1`,
      args: [owner.tenantId],
    });
    await databaseClient.execute({
      sql: `UPDATE subscription_entitlement SET status = 'canceled' WHERE user_id = ?1`,
      args: [owner.userId],
    });
    await expect(store.runtimeTarget(owner.tenantId)).resolves.toBeNull();
    await databaseClient.execute({
      sql: `UPDATE subscription_entitlement SET status = 'active' WHERE user_id = ?1`,
      args: [owner.userId],
    });
    await databaseClient.execute({
      sql: `UPDATE agent_instance
        SET observed_state = 'stopped', phase = 'stopped'
        WHERE tenant_id = ?1`,
      args: [owner.tenantId],
    });
    await expect(store.runtimeTarget(owner.tenantId)).resolves.toBeNull();
    await databaseClient.execute({
      sql: `UPDATE agent_instance
        SET observed_state = 'healthy', phase = 'blocked_invariant'
        WHERE tenant_id = ?1`,
      args: [owner.tenantId],
    });
    await expect(store.runtimeTarget(owner.tenantId)).resolves.toBeNull();
  });

  it("binds an expiring callback to one tenant and makes a duplicate callback replay-safe", async () => {
    const databaseClient = await database();
    const owner = await seedTenant(databaseClient, "owner");
    const other = await seedTenant(databaseClient, "other");
    const store = createGitHubControlStore(databaseClient);
    const installation = vi.fn(async () => ({
      accountLogin: "acme",
      repositories: [
        { id: 101, owner: "acme", name: "alpha" },
        { id: 102, owner: "acme", name: "beta" },
      ],
    }));
    const service = createGitHubControlService({
      store,
      apps,
      installations: { installation },
      now: () => 1_000,
      state: () => "tenant-bound-state",
    });
    const started = await service.beginInstallation({ ...owner, role: "coder" });
    expect(started.url).toContain("ambient-coder/installations/new?state=tenant-bound-state");

    await expect(
      service.completeInstallation({ role: "coder", state: "wrong-state", installationId: 501 }),
    ).rejects.toMatchObject({ code: "installation_state" });
    await expect(
      service.completeInstallation({ role: "coder", state: started.state, installationId: 501 }),
    ).resolves.toMatchObject({ status: "installed", tenantId: owner.tenantId });
    await expect(
      service.completeInstallation({ role: "coder", state: started.state, installationId: 501 }),
    ).resolves.toMatchObject({ status: "duplicate", tenantId: owner.tenantId });
    expect(installation).toHaveBeenCalledTimes(1);

    expect(await store.repositories(owner.tenantId, owner.userId, "coder")).toHaveLength(2);
    expect(await store.repositories(owner.tenantId, other.userId, "coder")).toEqual([]);
    await store.replaceRepositorySelection({
      tenantId: owner.tenantId,
      userId: owner.userId,
      role: "coder",
      repositoryIds: [101],
      defaultRepositoryId: 101,
      nowMs: 1_001,
    });
    await expect(
      store.replaceRepositorySelection({
        tenantId: owner.tenantId,
        userId: other.userId,
        role: "coder",
        repositoryIds: [101],
        defaultRepositoryId: 101,
        nowMs: 1_002,
      }),
    ).rejects.toMatchObject({ code: "tenant_scope" });

    const callbackRows = await databaseClient.execute("SELECT state_hash FROM github_installation_callback");
    expect(callbackRows.rows[0]?.state_hash).not.toBe(started.state);
  });

  it("removes revoked installation grants after durably admitting the signed webhook", async () => {
    const databaseClient = await database();
    const owner = await seedTenant(databaseClient, "revoked");
    const store = createGitHubControlStore(databaseClient);
    await store.beginInstallation({
      stateHash: "state-hash",
      tenantId: owner.tenantId,
      userId: owner.userId,
      role: "planner",
      createdAtMs: 1,
      expiresAtMs: 100,
    });
    await store.completeInstallation({
      stateHash: "state-hash",
      role: "planner",
      installationId: 700,
      accountLogin: "acme",
      repositories: [{ id: 701, owner: "acme", name: "repo" }],
      nowMs: 2,
    });
    const service = createGitHubControlService({
      store,
      apps,
      installations: { installation: async () => ({ accountLogin: "unused", repositories: [] }) },
      now: () => 3,
    });
    const body = JSON.stringify({ action: "deleted", installation: { id: 700 } });
    await databaseClient.execute(`CREATE TRIGGER reject_revocation
      BEFORE UPDATE OF status ON github_installation
      WHEN new.status = 'revoked'
      BEGIN
        SELECT RAISE(ABORT, 'injected registry failure');
      END`);
    await expect(
      service.receiveWebhook({
        role: "planner",
        signature: signature(apps.planner.webhookSecret, body),
        deliveryGuid: "revocation-guid",
        eventName: "installation",
        body,
      }),
    ).rejects.toThrow(/injected registry failure/);
    expect(await store.delivery(apps.planner.appId, "revocation-guid")).toBeUndefined();
    expect(await store.repositories(owner.tenantId, owner.userId, "planner")).toHaveLength(1);
    await databaseClient.execute("DROP TRIGGER reject_revocation");
    await expect(
      service.receiveWebhook({
        role: "planner",
        signature: signature(apps.planner.webhookSecret, body),
        deliveryGuid: "revocation-guid",
        eventName: "installation",
        body,
      }),
    ).resolves.toMatchObject({ status: 202, body: { admitted: "inserted" } });

    expect(await store.repositories(owner.tenantId, owner.userId, "planner")).toEqual([]);
    const installation = await databaseClient.execute({
      sql: "SELECT status FROM github_installation WHERE installation_id = ?1",
      args: [700],
    });
    expect(installation.rows[0]?.status).toBe("revoked");
    expect(await store.delivery(apps.planner.appId, "revocation-guid")).toMatchObject({ tenantId: owner.tenantId });

    const postRevocationBody = JSON.stringify({ action: "opened", installation: { id: 700 } });
    await service.receiveWebhook({
      role: "planner",
      signature: signature(apps.planner.webhookSecret, postRevocationBody),
      deliveryGuid: "post-revocation-guid",
      eventName: "issues",
      body: postRevocationBody,
    });
    expect(await store.delivery(apps.planner.appId, "post-revocation-guid")).toMatchObject({ tenantId: null });
  });

  it.each(["deleted", "suspend"] as const)(
    "invalidates the applied route when an installation is %s",
    async (action) => {
      const databaseClient = await database();
      const owner = await seedTenant(databaseClient, action);
      const store = createGitHubControlStore(databaseClient);
      await databaseClient.batch([
        {
          sql: `INSERT INTO github_installation (tenant_id, role, installation_id, status, account_login)
                VALUES (?1, 'reviewer', 720, 'installed', 'acme')`,
          args: [owner.tenantId],
        },
        {
          sql: `INSERT INTO github_repository
                  (tenant_id, installation_role, installation_id, repository_id, owner, name, selected, is_default)
                VALUES (?1, 'reviewer', 720, 721, 'acme', 'repo', 1, 1)`,
          args: [owner.tenantId],
        },
        { sql: "INSERT INTO delivery_route (tenant_id, status) VALUES (?1, 'ready')", args: [owner.tenantId] },
      ]);
      const service = createGitHubControlService({
        store,
        apps,
        installations: { installation: async () => ({ accountLogin: "unused", repositories: [] }) },
        now: () => 10,
      });
      const body = JSON.stringify({ action, installation: { id: 720 } });
      await service.receiveWebhook({
        role: "reviewer",
        signature: signature(apps.reviewer.webhookSecret, body),
        deliveryGuid: `${action}-guid`,
        eventName: "installation",
        body,
      });

      expect((await databaseClient.execute("SELECT config_version FROM tenant")).rows[0]?.config_version).toBe(2);
      expect((await databaseClient.execute("SELECT status FROM delivery_route")).rows[0]?.status).toBe("degraded");
      expect(await store.repositories(owner.tenantId, owner.userId, "reviewer")).toEqual([]);
    },
  );

  it("invalidates the applied route when GitHub removes a selected repository", async () => {
    const databaseClient = await database();
    const owner = await seedTenant(databaseClient, "removed");
    const store = createGitHubControlStore(databaseClient);
    await databaseClient.batch([
      {
        sql: `INSERT INTO github_installation (tenant_id, role, installation_id, status, account_login)
              VALUES (?1, 'coder', 730, 'installed', 'acme')`,
        args: [owner.tenantId],
      },
      {
        sql: `INSERT INTO github_repository
                (tenant_id, installation_role, installation_id, repository_id, owner, name, selected, is_default)
              VALUES (?1, 'coder', 730, 731, 'acme', 'repo', 1, 1)`,
        args: [owner.tenantId],
      },
      { sql: "INSERT INTO delivery_route (tenant_id, status) VALUES (?1, 'ready')", args: [owner.tenantId] },
    ]);
    const service = createGitHubControlService({
      store,
      apps,
      installations: { installation: async () => ({ accountLogin: "unused", repositories: [] }) },
      now: () => 11,
    });
    const body = JSON.stringify({
      action: "removed",
      installation: { id: 730 },
      repositories_removed: [{ id: 731 }],
    });
    await service.receiveWebhook({
      role: "coder",
      signature: signature(apps.coder.webhookSecret, body),
      deliveryGuid: "repository-removed-guid",
      eventName: "installation_repositories",
      body,
    });

    expect((await databaseClient.execute("SELECT config_version FROM tenant")).rows[0]?.config_version).toBe(2);
    expect((await databaseClient.execute("SELECT status FROM delivery_route")).rows[0]?.status).toBe("degraded");
    expect(await store.repositories(owner.tenantId, owner.userId, "coder")).toEqual([]);
  });
});

describe("durable GitHub delivery router", () => {
  it("verifies before persistence and scopes duplicate GUIDs by GitHub App identity", async () => {
    const databaseClient = await database();
    const store = createGitHubControlStore(databaseClient);
    const service = createGitHubControlService({
      store,
      apps,
      installations: { installation: async () => ({ accountLogin: "unused", repositories: [] }) },
      now: () => 10,
    });
    const body = JSON.stringify({ action: "opened", installation: { id: 123 } });
    const receive = (role: GitHubAppRole, webhookSignature: string | undefined, deliveryBody = body) =>
      service.receiveWebhook({
        role,
        signature: webhookSignature,
        deliveryGuid: "shared-guid",
        eventName: "issues",
        body: deliveryBody,
      });

    await expect(receive("planner", "sha256=bad")).resolves.toMatchObject({ status: 401 });
    expect((await databaseClient.execute("SELECT count(*) AS count FROM github_delivery_outbox")).rows[0]?.count).toBe(
      0,
    );
    await expect(receive("planner", signature(apps.planner.webhookSecret, body))).resolves.toMatchObject({
      status: 202,
      body: { admitted: "inserted" },
    });
    await expect(receive("planner", signature(apps.planner.webhookSecret, body))).resolves.toMatchObject({
      status: 202,
      body: { admitted: "duplicate" },
    });
    await expect(receive("coder", signature(apps.coder.webhookSecret, body))).resolves.toMatchObject({
      status: 202,
      body: { admitted: "inserted" },
    });
    const changedBody = JSON.stringify({ action: "edited", installation: { id: 123 } });
    await expect(receive("planner", signature(apps.planner.webhookSecret, changedBody), changedBody)).rejects.toEqual(
      expect.objectContaining<Partial<GitHubControlStoreError>>({ code: "delivery_collision" }),
    );
    expect((await databaseClient.execute("SELECT count(*) AS count FROM github_delivery_outbox")).rows[0]?.count).toBe(
      2,
    );
  });

  it("reclaims an expired lease and rejects a wrong-tenant acknowledgement", async () => {
    const databaseClient = await database();
    const owner = await seedTenant(databaseClient, "lease");
    const store = createGitHubControlStore(databaseClient, { claimTtlMs: 10 });
    await databaseClient.execute({
      sql: `INSERT INTO github_installation (tenant_id, role, installation_id, status, account_login)
            VALUES (?1, 'reviewer', 900, 'installed', 'acme')`,
      args: [owner.tenantId],
    });
    await store.acceptDelivery({
      githubAppId: apps.reviewer.appId,
      deliveryGuid: "lease-guid",
      eventName: "issues",
      installationRole: "reviewer",
      installationId: 900,
      payloadJson: JSON.stringify({ action: "opened", installation: { id: 900 } }),
      payloadSha256: "payload-hash",
      receivedAtMs: 100,
    });

    expect(await store.claimDueDeliveries(100, "claim-one", 1)).toHaveLength(1);
    expect(await store.claimDueDeliveries(109, "claim-two", 1)).toHaveLength(0);
    const reclaimed = await store.claimDueDeliveries(110, "claim-two", 1);
    expect(reclaimed[0]?.attemptCount).toBe(2);
    await expect(
      store.acknowledgeDelivery({
        githubAppId: apps.reviewer.appId,
        deliveryGuid: "lease-guid",
        tenantId: "tenant-wrong",
        claimId: "claim-two",
        resultJson: JSON.stringify({ status: "unsupported", deliveryId: "lease-guid" }),
        acknowledgedAtMs: 111,
        configVersion: null,
      }),
    ).rejects.toMatchObject({ code: "delivery_claim" });
  });

  it("survives tenant downtime, rejects nonterminal acknowledgements, and admits exactly once after recovery", async () => {
    const databaseClient = await database();
    const owner = await seedTenant(databaseClient, "recovery");
    const store = createGitHubControlStore(databaseClient);
    await databaseClient.execute({
      sql: `INSERT INTO github_installation (tenant_id, role, installation_id, status, account_login)
            VALUES (?1, 'coder', 800, 'installed', 'acme')`,
      args: [owner.tenantId],
    });
    await store.acceptDelivery({
      githubAppId: apps.coder.appId,
      deliveryGuid: "recovery-guid",
      eventName: "issues",
      installationRole: "coder",
      installationId: 800,
      payloadJson: JSON.stringify({ action: "opened", installation: { id: 800 } }),
      payloadSha256: "recovery-payload",
      receivedAtMs: 1_000,
    });
    let phase: "down" | "wrong" | "nonterminal" | "up" = "down";
    let tenantAdmissions = 0;
    let now = 1_000;
    const relay = createGitHubDeliveryRelay({
      store,
      now: () => now,
      random: () => 0,
      claimId: () => `claim-${phase}`,
      targets: {
        resolve: async (tenantId) => ({
          tenantId,
          runtimeId: "runtime-correct",
          baseUrl: "http://runtime.internal",
          webhookSecret: "runtime-secret",
        }),
      },
      deliveries: {
        deliver: async (_target, delivery) => {
          if (phase === "down") throw new Error("runtime unavailable");
          if (phase === "wrong") {
            return {
              runtimeId: "runtime-other-tenant",
              githubAppId: delivery.githubAppId,
              result: { status: "unsupported", deliveryId: delivery.deliveryId },
            };
          }
          if (phase === "nonterminal") {
            return {
              runtimeId: "runtime-correct",
              githubAppId: delivery.githubAppId,
              result: {
                status: "duplicate",
                record: {
                  githubAppId: delivery.githubAppId,
                  deliveryId: delivery.deliveryId,
                  eventName: delivery.name,
                  status: "received",
                  receivedAt: "2026-07-18T00:00:00.000Z",
                },
              },
            };
          }
          tenantAdmissions += 1;
          return {
            runtimeId: "runtime-correct",
            githubAppId: delivery.githubAppId,
            result: {
              status: "failed",
              record: {
                githubAppId: delivery.githubAppId,
                deliveryId: delivery.deliveryId,
                eventName: delivery.name,
                status: "failed",
                receivedAt: "2026-07-18T00:00:00.000Z",
              },
            },
          };
        },
      },
    });

    await expect(relay.drainOnce()).resolves.toEqual({ claimed: 1, acknowledged: 0, retried: 1 });
    phase = "wrong";
    now += 1;
    await expect(relay.drainOnce()).resolves.toEqual({ claimed: 1, acknowledged: 0, retried: 1 });
    phase = "nonterminal";
    now += 1;
    await expect(relay.drainOnce()).resolves.toEqual({ claimed: 1, acknowledged: 0, retried: 1 });
    phase = "up";
    now += 1;
    await expect(relay.drainOnce()).resolves.toEqual({ claimed: 1, acknowledged: 1, retried: 0 });
    expect(tenantAdmissions).toBe(1);
    await expect(relay.drainOnce()).resolves.toEqual({ claimed: 0, acknowledged: 0, retried: 0 });
    expect(await store.delivery(apps.coder.appId, "recovery-guid")).toMatchObject({
      state: "acked",
      attemptCount: 4,
      lastError: null,
    });
  });

  it("promotes only an acknowledgement for the exact current applied configuration", async () => {
    const databaseClient = await database();
    const owner = await seedTenant(databaseClient, "revision");
    const store = createGitHubControlStore(databaseClient);
    await databaseClient.batch([
      {
        sql: `INSERT INTO agent_instance (
                id, tenant_id, creds_store_key, desired_mode, observed_state,
                dokploy_display_name, dokploy_creation_token, applied_config_version,
                remote_config_operation_id, remote_config_owner_id, remote_config_fencing_token,
                remote_config_target_version, remote_config_state
              ) VALUES (?1, ?2, ?3, 'operate', 'healthy', ?4, ?5, 1, 'op-1', 'owner-1', 1, 1, 'confirmed')`,
        args: ["instance-revision", owner.tenantId, "tenant-db-revision", "Runtime revision", "token-revision"],
      },
      {
        sql: `INSERT INTO github_installation (tenant_id, role, installation_id, status, account_login)
              VALUES (?1, 'planner', 910, 'installed', 'acme'),
                     (?1, 'coder', 920, 'installed', 'acme'),
                     (?1, 'reviewer', 930, 'installed', 'acme')`,
        args: [owner.tenantId],
      },
      {
        sql: `INSERT INTO github_repository
                (tenant_id, installation_role, installation_id, repository_id, owner, name, selected, is_default)
              VALUES (?1, 'planner', 910, 911, 'acme', 'alpha', 1, 1),
                     (?1, 'planner', 910, 912, 'acme', 'beta', 0, 0),
                     (?1, 'coder', 920, 921, 'acme', 'coder', 1, 1),
                     (?1, 'reviewer', 930, 931, 'acme', 'reviewer', 1, 1)`,
        args: [owner.tenantId],
      },
      {
        sql: "INSERT INTO delivery_route (tenant_id, status) VALUES (?1, 'ready')",
        args: [owner.tenantId],
      },
    ]);

    await expect(
      store.replaceRepositorySelection({
        ...owner,
        role: "planner",
        repositoryIds: [912],
        defaultRepositoryId: 912,
        nowMs: 2,
      }),
    ).resolves.toEqual({
      updated: true,
      currentConfigVersion: 2,
      appliedConfigVersion: 1,
      remoteConfigState: "confirmed",
    });
    expect((await databaseClient.execute("SELECT status FROM delivery_route")).rows[0]?.status).toBe("pending");
    expect(
      JSON.parse(String((await databaseClient.execute("SELECT config_json FROM tenant")).rows[0]?.config_json)),
    ).toMatchObject({
      github: {
        kind: "github-app",
        credential: "github",
        defaultRepository: "acme/beta",
        allowedRepositories: ["acme/beta"],
      },
    });
    await expect(
      store.replaceRepositorySelection({
        ...owner,
        role: "planner",
        repositoryIds: [912],
        defaultRepositoryId: 912,
        nowMs: 3,
      }),
    ).resolves.toMatchObject({ updated: false, currentConfigVersion: 2 });

    await databaseClient.execute({
      sql: `UPDATE agent_instance
               SET applied_config_version = 2, remote_config_target_version = 2
             WHERE tenant_id = ?1`,
      args: [owner.tenantId],
    });
    for (const [guid, receivedAtMs] of [
      ["stale-revision", 4],
      ["current-revision", 5],
    ] as const) {
      await store.acceptDelivery({
        githubAppId: apps.planner.appId,
        deliveryGuid: guid,
        eventName: "issues",
        installationRole: "planner",
        installationId: 910,
        payloadJson: JSON.stringify({ action: "opened", installation: { id: 910 } }),
        payloadSha256: `${guid}-hash`,
        receivedAtMs,
      });
    }
    let configVersion = 1;
    const relay = createGitHubDeliveryRelay({
      store,
      now: () => 6,
      claimId: () => `claim-${configVersion}`,
      targets: {
        resolve: async (tenantId) => ({
          tenantId,
          runtimeId: "runtime-revision",
          baseUrl: "http://runtime.internal",
          webhookSecret: "runtime-secret",
        }),
      },
      deliveries: {
        deliver: async (_target, delivery) => ({
          runtimeId: "runtime-revision",
          githubAppId: delivery.githubAppId,
          configVersion,
          result: { status: "unsupported", deliveryId: delivery.deliveryId },
        }),
      },
    });

    await expect(relay.drainOnce(1)).resolves.toEqual({ claimed: 1, acknowledged: 1, retried: 0 });
    expect((await databaseClient.execute("SELECT status FROM delivery_route")).rows[0]?.status).toBe("pending");
    configVersion = 2;
    await expect(relay.drainOnce(1)).resolves.toEqual({ claimed: 1, acknowledged: 1, retried: 0 });
    expect((await databaseClient.execute("SELECT status FROM delivery_route")).rows[0]?.status).toBe("ready");
    await expect(relay.drainOnce()).resolves.toEqual({ claimed: 0, acknowledged: 0, retried: 0 });
  });
});
