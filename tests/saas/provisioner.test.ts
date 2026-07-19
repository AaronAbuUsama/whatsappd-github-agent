import { readdir, readFile } from "node:fs/promises";

import type { Client } from "@libsql/client";
import { afterEach, describe, expect, test } from "vitest";

import {
  createTenantProvisioner,
  type DokployApplication,
  type DokployManifest,
  type DokployProvider,
  type TenantDatabaseProvider,
  type TenantSecretCodec,
} from "../../apps/api/src/provisioner";
import { openControlDb } from "../../packages/db/src/control-db";

const migrationDirectory = new URL("../../packages/db/src/migrations/", import.meta.url);

let db: Client | undefined;

async function migrate() {
  const migrations = (await readdir(migrationDirectory)).filter((file) => file.endsWith(".sql")).sort();
  const opened = await openControlDb({ url: "file::memory:" });
  db = opened.client;
  for (const migration of migrations) {
    await db.executeMultiple(await readFile(new URL(migration, migrationDirectory), "utf8"));
  }
  return db;
}

async function seed(client: Client, suffix: string, configVersion = 1) {
  await client.execute({
    sql: "INSERT INTO user (id, name, email) VALUES (?1, ?2, ?3)",
    args: [`user-${suffix}`, `User ${suffix}`, `${suffix}@example.com`],
  });
  await client.execute({
    sql: `INSERT INTO subscription_entitlement (id, user_id, status)
      VALUES (?1, ?2, 'active')`,
    args: [`entitlement-${suffix}`, `user-${suffix}`],
  });
  await client.execute({
    sql: `INSERT INTO tenant (
      id, user_id, subscription_entitlement_id, display_name, tenant_db_name,
      desired_state, config_json, config_version
    ) VALUES (?1, ?2, ?3, ?4, ?5, 'running', ?6, ?7)`,
    args: [
      `tenant-${suffix}`,
      `user-${suffix}`,
      `entitlement-${suffix}`,
      `Coworker ${suffix}`,
      `tenant-db-${suffix}`,
      JSON.stringify({ revision: configVersion, tenant: suffix }),
      configVersion,
    ],
  });
  await client.execute({
    sql: `INSERT INTO agent_instance (
      id, tenant_id, creds_store_key, desired_mode, dokploy_display_name,
      dokploy_creation_token
    ) VALUES (?1, ?2, ?3, 'setup', ?4, ?5)`,
    args: [
      `agent-${suffix}`,
      `tenant-${suffix}`,
      `tenant-db-${suffix}`,
      `Ambient ${suffix}`,
      `creation-${suffix}`,
    ],
  });
  return `tenant-${suffix}`;
}

class FakeTurso implements TenantDatabaseProvider {
  readonly databases = new Map<string, string>();
  readonly mintedTokens = new Map<string, string[]>();

  async ensureDatabase(name: string, beforeMutation: () => Promise<void>) {
    let url = this.databases.get(name);
    if (!url) {
      await beforeMutation();
      url = `libsql://${name}.turso.test`;
      this.databases.set(name, url);
    }
    return { url };
  }

  async mintToken(name: string, beforeMutation: () => Promise<void>) {
    await beforeMutation();
    const tokens = this.mintedTokens.get(name) ?? [];
    const token = `scoped-token:${name}:${tokens.length + 1}`;
    tokens.push(token);
    this.mintedTokens.set(name, tokens);
    return token;
  }
}

class FakeDokploy implements DokployProvider {
  readonly applications = new Map<string, DokployApplication>();
  readonly manifests = new Map<string, DokployManifest>();
  readonly taskCounts = new Map<string, number>();
  readonly calls: string[] = [];
  failCreateAfterInsert = false;
  failPrepare = false;
  failStartAfterScale = false;
  nextApplication = 1;

  async listApplications() {
    this.calls.push("list");
    return [...this.applications.values()];
  }

  async inspectApplication(applicationId: string) {
    this.calls.push(`inspect:${applicationId}`);
    return this.applications.get(applicationId) ?? null;
  }

  async createApplication(
    input: { readonly name: string; readonly appName: string; readonly description: string },
    beforeMutation: () => Promise<void>,
  ) {
    await beforeMutation();
    const index = this.nextApplication++;
    const application = {
      applicationId: `application-${index}`,
      appName: `${input.appName}-remote-${index}`,
      name: input.name,
      description: input.description,
    };
    this.applications.set(application.applicationId, application);
    this.taskCounts.set(application.appName, 0);
    this.calls.push(`create:${application.applicationId}`);
    if (this.failCreateAfterInsert) {
      this.failCreateAfterInsert = false;
      throw new Error("simulated response loss after create");
    }
    return application;
  }

  async deleteApplication(applicationId: string, beforeMutation: () => Promise<void>) {
    await beforeMutation();
    const application = this.applications.get(applicationId);
    if (application) this.taskCounts.delete(application.appName);
    this.applications.delete(applicationId);
    this.calls.push(`delete:${applicationId}`);
  }

  async prepareApplication(
    manifest: DokployManifest,
    beforeMutation: () => Promise<void>,
  ): Promise<void> {
    await beforeMutation();
    this.calls.push(`prepare:${manifest.applicationId}`);
    if (this.failPrepare) throw new Error("simulated uncertain config write");
    this.manifests.set(manifest.applicationId, structuredClone(manifest));
  }

  async manifestMatches(manifest: DokployManifest) {
    this.calls.push(`manifest:${manifest.applicationId}`);
    return JSON.stringify(this.manifests.get(manifest.applicationId)) === JSON.stringify(manifest);
  }

  async deployApplication(applicationId: string, beforeMutation: () => Promise<void>) {
    await beforeMutation();
    this.calls.push(`deploy:${applicationId}`);
  }

  async startApplication(applicationId: string, beforeMutation: () => Promise<void>) {
    await beforeMutation();
    const application = this.applications.get(applicationId);
    if (!application) throw new Error("missing application");
    this.taskCounts.set(application.appName, 1);
    this.calls.push(`start:${applicationId}`);
    if (this.failStartAfterScale) {
      this.failStartAfterScale = false;
      throw new Error("simulated response loss after start");
    }
  }

  async stopApplication(applicationId: string, beforeMutation: () => Promise<void>) {
    await beforeMutation();
    const application = this.applications.get(applicationId);
    if (application) this.taskCounts.set(application.appName, 0);
    this.calls.push(`stop:${applicationId}`);
  }

  async waitForTaskCount(appName: string, expected: 0 | 1) {
    this.calls.push(`tasks:${appName}:${expected}`);
    return this.taskCounts.get(appName) ?? 0;
  }

  async health(_baseUrl: string, _runtimeId: string) {
    this.calls.push("health");
    return true;
  }
}

const secrets: TenantSecretCodec = {
  encrypt: (plaintext) => `encrypted:${plaintext}`,
  decrypt: (ciphertext) => {
    if (!ciphertext.startsWith("encrypted:")) throw new Error("invalid ciphertext");
    return ciphertext.slice("encrypted:".length);
  },
  bridgeSecret: (tenantId) => `bridge:${tenantId}`,
  runtimeId: (tenantId) => `runtime:${tenantId}`,
};

const provisionerFor = (client: Client, turso: FakeTurso, dokploy: FakeDokploy) => {
  let id = 0;
  return createTenantProvisioner({
    client,
    turso,
    dokploy,
    secrets,
    configuration: {
      runtimeImage: "ghcr.io/ambient-agent/runtime:sha-test",
      workerHostname: "worker-one",
      networkName: "dokploy-network",
      dataDirectory: "/root/.ambient-agent",
      port: 3000,
    },
    createId: () => `generated-${++id}`,
  });
};

afterEach(() => {
  db?.close();
  db = undefined;
});

describe("tenant provisioner", () => {
  test("reconciles repeated create/start and stop calls against one stable application", async () => {
    const client = await migrate();
    const tenantId = await seed(client, "stable");
    const turso = new FakeTurso();
    const dokploy = new FakeDokploy();
    const provisioner = provisionerFor(client, turso, dokploy);

    expect(await provisioner.reconcileTenant(tenantId)).toMatchObject({ status: "running" });
    expect(await provisioner.reconcileTenant(tenantId)).toMatchObject({ status: "running" });

    const applicationIds = [...dokploy.applications.keys()];
    expect(applicationIds).toHaveLength(1);
    expect(dokploy.calls.filter((call) => call.startsWith("create:"))).toHaveLength(1);
    expect(dokploy.calls.filter((call) => call.startsWith("start:"))).toHaveLength(2);
    const manifest = dokploy.manifests.get(applicationIds[0]!);
    expect(manifest).toMatchObject({
      replicas: 1,
      autoDeploy: false,
      placementSwarm: { Constraints: ["node.hostname==worker-one"] },
      networkSwarm: [{ Target: "dokploy-network" }],
      updateConfigSwarm: { Parallelism: 1, Order: "stop-first" },
      rollbackConfigSwarm: { Parallelism: 1, Order: "stop-first" },
      environment: { HOME: "/root" },
    });
    expect(dokploy.calls.indexOf(`prepare:${applicationIds[0]}`)).toBeLessThan(
      dokploy.calls.indexOf(`start:${applicationIds[0]}`),
    );

    await client.execute({
      sql: "UPDATE tenant SET desired_state = 'stopped' WHERE id = ?1",
      args: [tenantId],
    });
    expect(await provisioner.reconcileTenant(tenantId)).toMatchObject({ status: "stopped", taskCount: 0 });
    expect(await provisioner.reconcileTenant(tenantId)).toMatchObject({ status: "stopped", taskCount: 0 });
    expect(dokploy.calls.filter((call) => call.startsWith("stop:"))).toHaveLength(2);
  });

  test("recovers a response-lost create without creating or starting a second shell", async () => {
    const client = await migrate();
    const tenantId = await seed(client, "crash");
    const turso = new FakeTurso();
    const dokploy = new FakeDokploy();
    dokploy.failCreateAfterInsert = true;
    const provisioner = provisionerFor(client, turso, dokploy);

    expect(await provisioner.reconcileTenant(tenantId)).toMatchObject({ status: "running" });
    expect(dokploy.applications.size).toBe(1);
    expect(dokploy.calls.filter((call) => call.startsWith("create:"))).toHaveLength(1);
    expect(dokploy.calls.filter((call) => call.startsWith("start:"))).toHaveLength(1);
    const bound = await client.execute({
      sql: "SELECT dokploy_application_id FROM agent_instance WHERE tenant_id = ?1",
      args: [tenantId],
    });
    expect(bound.rows[0]?.dokploy_application_id).toBe([...dokploy.applications.keys()][0]);
  });

  test("restarts a new config revision on the same stopped-first application", async () => {
    const client = await migrate();
    const tenantId = await seed(client, "restart");
    const turso = new FakeTurso();
    const dokploy = new FakeDokploy();
    const provisioner = provisionerFor(client, turso, dokploy);

    expect(await provisioner.reconcileTenant(tenantId)).toMatchObject({ status: "running" });
    await client.execute({
      sql: `UPDATE tenant SET config_version = 2, config_json = '{"revision":2}' WHERE id = ?1`,
      args: [tenantId],
    });
    await client.execute({
      sql: "UPDATE agent_instance SET desired_mode = 'operate' WHERE tenant_id = ?1",
      args: [tenantId],
    });
    expect(await provisioner.reconcileTenant(tenantId)).toMatchObject({ status: "running" });
    expect(await provisioner.reconcileTenant(tenantId)).toMatchObject({ status: "running" });

    expect(dokploy.applications.size).toBe(1);
    expect(dokploy.calls.filter((call) => call.startsWith("prepare:"))).toHaveLength(2);
    expect(dokploy.calls.filter((call) => call.startsWith("deploy:"))).toHaveLength(2);
    expect(dokploy.calls.filter((call) => call.startsWith("start:"))).toHaveLength(3);
    expect(dokploy.calls.filter((call) => call.startsWith("stop:"))).toHaveLength(1);
    expect([...dokploy.manifests.values()][0]?.command).toContain("dist/cli/main.js");
  });

  test("blocks a response-lost start while configuration is still pending", async () => {
    const client = await migrate();
    const tenantId = await seed(client, "start-unknown");
    const turso = new FakeTurso();
    const dokploy = new FakeDokploy();
    dokploy.failStartAfterScale = true;
    const provisioner = provisionerFor(client, turso, dokploy);

    expect(await provisioner.reconcileTenant(tenantId)).toMatchObject({
      status: "blocked",
      errorCode: "dokploy_config_outcome_unknown",
    });
    const state = await client.execute({
      sql: `SELECT applied_config_version, remote_config_state
        FROM agent_instance WHERE tenant_id = ?1`,
      args: [tenantId],
    });
    expect(state.rows[0]).toMatchObject({ applied_config_version: 0, remote_config_state: "blocked_unknown" });
    expect([...dokploy.taskCounts.values()]).toEqual([0]);
  });

  test("fails an uncertain config mutation closed until exact operator acknowledgement", async () => {
    const client = await migrate();
    const tenantId = await seed(client, "unknown", 2);
    const turso = new FakeTurso();
    const dokploy = new FakeDokploy();
    dokploy.failPrepare = true;
    const provisioner = provisionerFor(client, turso, dokploy);

    expect(await provisioner.reconcileTenant(tenantId)).toMatchObject({
      status: "blocked",
      errorCode: "dokploy_config_outcome_unknown",
    });
    const prepareCalls = dokploy.calls.filter((call) => call.startsWith("prepare:")).length;
    expect(await provisioner.reconcileTenant(tenantId)).toMatchObject({ status: "blocked" });
    expect(dokploy.calls.filter((call) => call.startsWith("prepare:"))).toHaveLength(prepareCalls);
    const pending = await client.execute({
      sql: `SELECT remote_config_operation_id, remote_config_state
        FROM agent_instance WHERE tenant_id = ?1`,
      args: [tenantId],
    });
    const operationId = String(pending.rows[0]?.remote_config_operation_id);
    expect(pending.rows[0]?.remote_config_state).toBe("blocked_unknown");
    const application = [...dokploy.applications.values()][0];
    if (!application) throw new Error("bound application missing");

    dokploy.applications.set(application.applicationId, {
      ...application,
      description: "operator-mutated-marker",
    });
    expect(
      await provisioner.acknowledgeQuiescence({
        tenantId,
        operationId,
        actorId: "operator-aaron",
        evidenceNote: "Dokploy was drained and the bound service was observed at zero tasks.",
      }),
    ).toBe(false);
    dokploy.applications.set(application.applicationId, application);

    expect(
      await provisioner.acknowledgeQuiescence({
        tenantId,
        operationId: "wrong-operation",
        actorId: "operator-aaron",
        evidenceNote: "Dokploy was drained and the bound service was observed at zero tasks.",
      }),
    ).toBe(false);
    expect(
      await provisioner.acknowledgeQuiescence({
        tenantId,
        operationId,
        actorId: "operator-aaron",
        evidenceNote: "Dokploy was drained and the bound service was observed at zero tasks.",
      }),
    ).toBe(true);
  });

  test("keeps each Turso token inside only its tenant manifest", async () => {
    const client = await migrate();
    const firstTenant = await seed(client, "one");
    const secondTenant = await seed(client, "two");
    const turso = new FakeTurso();
    const dokploy = new FakeDokploy();
    const provisioner = provisionerFor(client, turso, dokploy);

    expect(await provisioner.reconcileTenant(firstTenant)).toMatchObject({ status: "running" });
    expect(await provisioner.reconcileTenant(secondTenant)).toMatchObject({ status: "running" });

    const manifests = [...dokploy.manifests.values()];
    expect(manifests).toHaveLength(2);
    for (const manifest of manifests) {
      const databaseUrl = manifest.environment.TENANT_DB_URL;
      if (!databaseUrl) throw new Error("tenant database URL missing from manifest");
      const ownName = new URL(databaseUrl).hostname.split(".")[0]!;
      expect(manifest.environment.TENANT_DB_TOKEN).toContain(ownName);
      const otherName = ownName.endsWith("one") ? "tenant-db-two" : "tenant-db-one";
      expect(manifest.environment.TENANT_DB_TOKEN).not.toContain(otherName);
      expect(manifest.configJson).not.toContain("scoped-token:");
    }
  });
});
