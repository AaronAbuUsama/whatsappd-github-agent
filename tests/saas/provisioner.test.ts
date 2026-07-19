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
  readonly healthRuntimeIds: string[] = [];
  readonly healthExpectations: Array<{
    readonly runtimeId: string;
    readonly configVersion: number;
    readonly mode: "setup" | "operate";
  }> = [];
  readonly deployedApplications = new Set<string>();
  readonly calls: string[] = [];
  failCreateAfterInsert = false;
  failPrepare = false;
  failStartAfterScale = false;
  failStopBeforeScale = false;
  beforeHealth: (() => Promise<void>) | null = null;
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

  async deployApplication(
    applicationId: string,
    deploymentMarker: string,
    heartbeat: () => Promise<void>,
  ) {
    await heartbeat();
    this.deployedApplications.add(applicationId);
    this.calls.push(`deploy:${applicationId}`);
    this.calls.push(`deployment:${deploymentMarker}`);
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
    if (this.failStopBeforeScale) throw new Error("simulated stop failure before scale");
    const application = this.applications.get(applicationId);
    if (application) this.taskCounts.set(application.appName, 0);
    this.calls.push(`stop:${applicationId}`);
  }

  async waitForTaskCount(
    application: Pick<DokployApplication, "applicationId" | "appName">,
    expected: 0 | 1,
    absent: "reject" | "if-never-deployed",
  ) {
    this.calls.push(`tasks:${application.appName}:${expected}:${absent}`);
    const count = this.taskCounts.get(application.appName);
    if (count !== undefined) return count;
    if (absent === "if-never-deployed" && !this.deployedApplications.has(application.applicationId)) {
      return 0;
    }
    throw new Error("service observation unavailable");
  }

  async health(
    _baseUrl: string,
    expected: {
      readonly runtimeId: string;
      readonly configVersion: number;
      readonly mode: "setup" | "operate";
    },
  ) {
    this.calls.push("health");
    this.healthRuntimeIds.push(expected.runtimeId);
    this.healthExpectations.push(expected);
    const beforeHealth = this.beforeHealth;
    this.beforeHealth = null;
    await beforeHealth?.();
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

const provisionerFor = (
  client: Client,
  turso: FakeTurso,
  dokploy: FakeDokploy,
  runtimeCredentialFilesForTenant: (
    tenantId: string,
  ) => Promise<Readonly<Record<"coder" | "reviewer" | "planner", string>> | null> = async (tenantId) => ({
    coder: JSON.stringify({ role: "coder", tenantId }),
    reviewer: JSON.stringify({ role: "reviewer", tenantId }),
    planner: JSON.stringify({ role: "planner", tenantId, webhookSecret: secrets.bridgeSecret(tenantId) }),
  }),
) => {
  let id = 0;
  return createTenantProvisioner({
    client,
    turso,
    dokploy,
    secrets,
    runtimeCredentialFilesForTenant,
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
    expect(dokploy.calls.filter((call) => call.startsWith("stop:"))).toHaveLength(3);
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

  test("stops an active runtime when the tenant becomes suspended", async () => {
    const client = await migrate();
    const tenantId = await seed(client, "suspended");
    const turso = new FakeTurso();
    const dokploy = new FakeDokploy();
    const provisioner = provisionerFor(client, turso, dokploy);

    expect(await provisioner.reconcileTenant(tenantId)).toMatchObject({ status: "running" });
    await client.execute({
      sql: "UPDATE tenant SET status = 'suspended' WHERE id = ?1",
      args: [tenantId],
    });

    expect(await provisioner.reconcilePendingTenants()).toEqual([
      expect.objectContaining({ tenantId, status: "stopped", taskCount: 0 }),
    ]);
    expect([...dokploy.taskCounts.values()]).toEqual([0]);
  });

  test("does not treat a missing bound record or absent Swarm service as quiescence", async () => {
    const client = await migrate();
    const tenantId = await seed(client, "missing-bound");
    const turso = new FakeTurso();
    const dokploy = new FakeDokploy();
    const provisioner = provisionerFor(client, turso, dokploy);

    expect(await provisioner.reconcileTenant(tenantId)).toMatchObject({ status: "running" });
    const application = [...dokploy.applications.values()][0];
    if (!application) throw new Error("bound application missing");
    dokploy.applications.delete(application.applicationId);
    dokploy.taskCounts.delete(application.appName);
    await client.execute({
      sql: "UPDATE tenant SET status = 'suspended' WHERE id = ?1",
      args: [tenantId],
    });

    expect(await provisioner.reconcileTenant(tenantId)).toMatchObject({ status: "retryable_error" });
    dokploy.taskCounts.set(application.appName, 0);
    expect(await provisioner.reconcileTenant(tenantId)).toMatchObject({
      status: "blocked",
      errorCode: "dokploy_bound_application_missing",
    });
  });

  test("gates onboarding operate mode on an activation for the current revision", async () => {
    const client = await migrate();
    const tenantId = await seed(client, "activation");
    const turso = new FakeTurso();
    const dokploy = new FakeDokploy();
    const provisioner = provisionerFor(client, turso, dokploy);

    expect(await provisioner.reconcileTenant(tenantId)).toMatchObject({ status: "running" });
    await client.execute({
      sql: `UPDATE tenant
        SET config_version = 2, config_json = '{"revision":2,"activated":true}'
        WHERE id = ?1`,
      args: [tenantId],
    });
    await client.execute({
      sql: "UPDATE agent_instance SET desired_mode = 'operate' WHERE tenant_id = ?1",
      args: [tenantId],
    });
    await client.execute({
      sql: `INSERT INTO control_operation (
        id, tenant_id, kind, status, operation_identity, target_config_version
      ) VALUES (
        'operation-activation', ?1, 'activate', 'pending', 'activate:activation:3', 3
      )`,
      args: [tenantId],
    });

    expect(await provisioner.reconcileTenant(tenantId)).toMatchObject({ status: "stopped" });
    await client.execute({
      sql: `UPDATE control_operation
        SET target_config_version = 2, operation_identity = 'activate:activation:2'
        WHERE id = 'operation-activation'`,
    });
    expect(await provisioner.reconcilePendingTenants()).toEqual([
      expect.objectContaining({ tenantId, status: "running", taskCount: 1 }),
    ]);
    expect(dokploy.healthRuntimeIds.at(-1)).toBe(`runtime:${tenantId}`);
    expect(dokploy.healthExpectations.at(-1)).toEqual({
      runtimeId: `runtime:${tenantId}`,
      configVersion: 2,
      mode: "operate",
    });
    expect([...dokploy.manifests.values()][0]?.environment.AMBIENT_AGENT_RUNTIME_ID).toBe(
      `runtime:${tenantId}`,
    );
    expect([...dokploy.manifests.values()][0]?.fileMounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ mountPath: "/root/.ambient-agent/credentials/github-coder.json" }),
        expect.objectContaining({ mountPath: "/root/.ambient-agent/credentials/github-reviewer.json" }),
        expect.objectContaining({
          mountPath: "/root/.ambient-agent/credentials/github-planner.json",
          content: expect.stringContaining(`bridge:${tenantId}`),
        }),
      ]),
    );
  });

  test("stops before Operate when tenant GitHub credential files are unavailable", async () => {
    const client = await migrate();
    const tenantId = await seed(client, "operate-identity");
    const turso = new FakeTurso();
    const dokploy = new FakeDokploy();
    const provisioner = provisionerFor(client, turso, dokploy, async () => null);

    expect(await provisioner.reconcileTenant(tenantId)).toMatchObject({ status: "running" });
    await client.execute({
      sql: `UPDATE tenant SET status = 'active' WHERE id = ?1`,
      args: [tenantId],
    });
    await client.execute({
      sql: `UPDATE agent_instance SET desired_mode = 'operate' WHERE tenant_id = ?1`,
      args: [tenantId],
    });

    expect(await provisioner.reconcileTenant(tenantId)).toMatchObject({
      status: "blocked",
      errorCode: "tenant_github_credentials_missing",
    });
    expect([...dokploy.taskCounts.values()]).toEqual([0]);
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
      sql: `UPDATE tenant SET status = 'active' WHERE id = ?1`,
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
    expect(dokploy.calls.filter((call) => call.startsWith("stop:"))).toHaveLength(2);
    expect([...dokploy.manifests.values()][0]?.command).toContain("dist/cli/main.js");

    await client.execute({
      sql: "UPDATE agent_instance SET desired_mode = 'setup' WHERE tenant_id = ?1",
      args: [tenantId],
    });
    expect(await provisioner.reconcilePendingTenants()).toEqual([
      expect.objectContaining({ tenantId, status: "running", taskCount: 1 }),
    ]);
    expect([...dokploy.manifests.values()][0]?.command).toContain("dist/cli/setup.js");
  });

  test("stops a stale started manifest when the confirmation target changes", async () => {
    const client = await migrate();
    const tenantId = await seed(client, "confirm-race");
    const turso = new FakeTurso();
    const dokploy = new FakeDokploy();
    dokploy.beforeHealth = async () => {
      await client.execute({
        sql: `UPDATE tenant
          SET config_version = 2, config_json = '{"revision":2,"changed_during_start":true}'
          WHERE id = ?1`,
        args: [tenantId],
      });
    };
    const provisioner = provisionerFor(client, turso, dokploy);

    expect(await provisioner.reconcileTenant(tenantId)).toMatchObject({
      status: "blocked",
      errorCode: "dokploy_config_outcome_unknown",
    });
    expect([...dokploy.taskCounts.values()]).toEqual([0]);
    expect(dokploy.calls.findLastIndex((call) => call.startsWith("stop:"))).toBeGreaterThan(
      dokploy.calls.findLastIndex((call) => call.startsWith("start:")),
    );
    const state = await client.execute({
      sql: `SELECT applied_config_version, applied_mode, remote_config_target_version,
          remote_config_state
        FROM agent_instance WHERE tenant_id = ?1`,
      args: [tenantId],
    });
    expect(state.rows[0]).toMatchObject({
      applied_config_version: 0,
      applied_mode: "stopped",
      remote_config_target_version: 1,
      remote_config_state: "blocked_unknown",
    });
  });

  test("stops a bound application before blocking a corrupt tenant token", async () => {
    const client = await migrate();
    const tenantId = await seed(client, "corrupt-token");
    const turso = new FakeTurso();
    const dokploy = new FakeDokploy();
    const provisioner = provisionerFor(client, turso, dokploy);

    expect(await provisioner.reconcileTenant(tenantId)).toMatchObject({ status: "running" });
    await client.execute({
      sql: "UPDATE tenant SET tenant_db_token_ciphertext = 'corrupt' WHERE id = ?1",
      args: [tenantId],
    });
    const stopsBefore = dokploy.calls.filter((call) => call.startsWith("stop:")).length;

    expect(await provisioner.reconcileTenant(tenantId)).toMatchObject({
      status: "blocked",
      errorCode: "tenant_token_decryption_failed",
    });
    expect([...dokploy.taskCounts.values()]).toEqual([0]);
    expect(dokploy.calls.filter((call) => call.startsWith("stop:")).length).toBe(stopsBefore + 1);
  });

  test("keeps a response-lost start pending until zero tasks are observed", async () => {
    const client = await migrate();
    const tenantId = await seed(client, "start-unknown");
    const turso = new FakeTurso();
    const dokploy = new FakeDokploy();
    dokploy.failStartAfterScale = true;
    dokploy.failStopBeforeScale = true;
    const provisioner = provisionerFor(client, turso, dokploy);

    expect(await provisioner.reconcileTenant(tenantId)).toMatchObject({
      status: "retryable_error",
      errorCode: "dokploy_quiescence_not_observed",
    });
    let state = await client.execute({
      sql: `SELECT applied_config_version, remote_config_state
        FROM agent_instance WHERE tenant_id = ?1`,
      args: [tenantId],
    });
    expect(state.rows[0]).toMatchObject({ applied_config_version: 0, remote_config_state: "pending" });
    expect([...dokploy.taskCounts.values()]).toEqual([1]);

    dokploy.failStopBeforeScale = false;
    expect(await provisioner.reconcileTenant(tenantId)).toMatchObject({
      status: "blocked",
      errorCode: "dokploy_config_outcome_unknown",
    });
    state = await client.execute({
      sql: `SELECT applied_config_version, remote_config_state
        FROM agent_instance WHERE tenant_id = ?1`,
      args: [tenantId],
    });
    expect(state.rows[0]).toMatchObject({ applied_config_version: 0, remote_config_state: "blocked_unknown" });
    expect([...dokploy.taskCounts.values()]).toEqual([0]);
  });

  test("keeps a takeover pending until zero tasks are observed", async () => {
    const client = await migrate();
    const tenantId = await seed(client, "takeover");
    const turso = new FakeTurso();
    const dokploy = new FakeDokploy();
    const provisioner = provisionerFor(client, turso, dokploy);

    expect(await provisioner.reconcileTenant(tenantId)).toMatchObject({ status: "running" });
    await client.execute({
      sql: `UPDATE agent_instance
        SET remote_config_operation_id = 'remote-op-takeover',
            remote_config_owner_id = 'expired-owner',
            remote_config_fencing_token = 1,
            remote_config_target_version = 2,
            remote_config_state = 'pending'
        WHERE tenant_id = ?1`,
      args: [tenantId],
    });
    dokploy.failStopBeforeScale = true;

    expect(await provisioner.reconcileTenant(tenantId)).toMatchObject({
      status: "retryable_error",
      errorCode: "dokploy_zero_tasks_not_observed",
    });
    let state = await client.execute({
      sql: "SELECT remote_config_state FROM agent_instance WHERE tenant_id = ?1",
      args: [tenantId],
    });
    expect(state.rows[0]?.remote_config_state).toBe("pending");
    expect([...dokploy.taskCounts.values()]).toEqual([1]);

    dokploy.failStopBeforeScale = false;
    expect(await provisioner.reconcileTenant(tenantId)).toMatchObject({
      status: "blocked",
      errorCode: "dokploy_config_outcome_unknown",
    });
    state = await client.execute({
      sql: "SELECT remote_config_state FROM agent_instance WHERE tenant_id = ?1",
      args: [tenantId],
    });
    expect(state.rows[0]?.remote_config_state).toBe("blocked_unknown");
    expect([...dokploy.taskCounts.values()]).toEqual([0]);
  });

  test("stops a drifted bound application before recording an identity block", async () => {
    const client = await migrate();
    const tenantId = await seed(client, "drift");
    const turso = new FakeTurso();
    const dokploy = new FakeDokploy();
    const provisioner = provisionerFor(client, turso, dokploy);

    expect(await provisioner.reconcileTenant(tenantId)).toMatchObject({ status: "running" });
    const application = [...dokploy.applications.values()][0];
    if (!application) throw new Error("bound application missing");
    dokploy.applications.set(application.applicationId, {
      ...application,
      description: "operator-mutated-marker",
    });
    dokploy.failStopBeforeScale = true;

    expect(await provisioner.reconcileTenant(tenantId)).toMatchObject({
      status: "retryable_error",
      errorCode: "dokploy_quiescence_not_observed",
    });
    expect(dokploy.taskCounts.get(application.appName)).toBe(1);
    dokploy.failStopBeforeScale = false;

    expect(await provisioner.reconcileTenant(tenantId)).toMatchObject({
      status: "blocked",
      errorCode: "dokploy_bound_application_mismatch",
    });
    expect(dokploy.taskCounts.get(application.appName)).toBe(0);
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
    dokploy.applications.delete(application.applicationId);
    dokploy.taskCounts.delete(application.appName);
    expect(
      await provisioner.acknowledgeQuiescence({
        tenantId,
        operationId,
        actorId: "operator-aaron",
        evidenceNote: "Dokploy was drained and the bound service was observed at zero tasks.",
      }),
    ).toBe(false);
    dokploy.applications.set(application.applicationId, application);
    dokploy.taskCounts.set(application.appName, 1);

    const stopCallsBeforeWrongAck = dokploy.calls.filter((call) => call.startsWith("stop:")).length;
    expect(
      await provisioner.acknowledgeQuiescence({
        tenantId,
        operationId: "wrong-operation",
        actorId: "operator-aaron",
        evidenceNote: "Dokploy was drained and the bound service was observed at zero tasks.",
      }),
    ).toBe(false);
    expect(dokploy.calls.filter((call) => call.startsWith("stop:"))).toHaveLength(
      stopCallsBeforeWrongAck,
    );
    expect(dokploy.taskCounts.get(application.appName)).toBe(1);
    expect(
      await provisioner.acknowledgeQuiescence({
        tenantId,
        operationId,
        actorId: "operator-aaron",
        evidenceNote: "Dokploy was drained and the bound service was observed at zero tasks.",
      }),
    ).toBe(true);
    expect(dokploy.taskCounts.get(application.appName)).toBe(0);
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
      expect(manifest.fileMounts.find((file) => file.filePath === "config.json")?.content).not.toContain(
        "scoped-token:",
      );
    }
  });
});
