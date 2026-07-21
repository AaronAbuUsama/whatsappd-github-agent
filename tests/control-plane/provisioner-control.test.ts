import { readdir, readFile } from "node:fs/promises";

import type { Client } from "@libsql/client";
import { afterEach, describe, expect, test } from "vitest";

import { acquireLease, openControlDb, releaseLease } from "../../packages/db/src/control-db";
import {
  acknowledgeRemoteQuiescence,
  beginRemoteConfig,
  bindDokployApplication,
  blockRemoteConfig,
  confirmRemoteConfig,
  readProvisioningTarget,
  writeAgentObservation,
  writeTenantDatabaseCredentials,
} from "../../packages/db/src/provisioner-control";

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

async function seed(client: Client) {
  await client.execute("INSERT INTO user (id, name, email) VALUES ('user-p', 'Provisioner', 'p@example.com')");
  await client.execute(`INSERT INTO subscription_entitlement (
    id, user_id, status
  ) VALUES ('entitlement-p', 'user-p', 'active')`);
  await client.execute(`INSERT INTO tenant (
    id, user_id, subscription_entitlement_id, display_name, tenant_db_name,
    desired_state, config_json, config_version
  ) VALUES (
    'tenant-p', 'user-p', 'entitlement-p', 'Ada', 'tenant-db-p',
    'running', '{"model":"ready"}', 2
  )`);
  await client.execute(`INSERT INTO agent_instance (
    id, tenant_id, creds_store_key, desired_mode, dokploy_display_name,
    dokploy_creation_token
  ) VALUES (
    'agent-p', 'tenant-p', 'tenant-db-p', 'setup', 'Ambient Ada', 'create-p'
  )`);
  return { tenantId: "tenant-p", key: "tenant-db-p" } as const;
}

afterEach(() => {
  db?.close();
  db = undefined;
});

describe("provisioner control store", () => {
  test("fences tenant credentials, stable application binding, and observations", async () => {
    const client = await migrate();
    const seeded = await seed(client);
    const first = await acquireLease(client, seeded.key, "owner-a");
    expect(first).not.toBeNull();
    if (!first) throw new Error("first lease missing");

    expect(
      await writeTenantDatabaseCredentials(
        client,
        seeded.key,
        first,
        "libsql://tenant-db-p.turso.io",
        "v1.ciphertext",
      ),
    ).toBe(true);
    expect(await bindDokployApplication(client, seeded.key, first, "app-p", "ambient-p-r4nd0m")).toBe(true);
    expect(await bindDokployApplication(client, seeded.key, first, "app-other", "ambient-other")).toBe(false);
    expect(
      await writeAgentObservation(client, seeded.key, first, {
        observedState: "healthy",
        phase: "running",
        runtimeBaseUrl: "http://ambient-p-r4nd0m:3000",
        errorCode: null,
      }),
    ).toBe(true);
    expect(await releaseLease(client, seeded.key, first)).toBe(true);

    const successor = await acquireLease(client, seeded.key, "owner-b");
    expect(successor).not.toBeNull();
    if (!successor) throw new Error("successor lease missing");
    expect(
      await writeTenantDatabaseCredentials(
        client,
        seeded.key,
        first,
        "libsql://stale.turso.io",
        "v1.stale",
      ),
    ).toBe(false);
    expect(
      await writeAgentObservation(client, seeded.key, first, {
        observedState: "failed",
        phase: "blocked_invariant",
        runtimeBaseUrl: null,
        errorCode: "stale_write",
      }),
    ).toBe(false);

    const target = await readProvisioningTarget(client, seeded.tenantId);
    expect(target).toMatchObject({
      tenantId: seeded.tenantId,
      hasCurrentActivationIntent: false,
      tenantStatus: "onboarding",
      appliedMode: "stopped",
      tenantDbUrl: "libsql://tenant-db-p.turso.io",
      tenantDbTokenCiphertext: "v1.ciphertext",
      dokployApplicationId: "app-p",
      dokployAppName: "ambient-p-r4nd0m",
      observedState: "healthy",
      phase: "running",
      entitlementStatus: "active",
    });
  });

  test("blocks successor config writes until an exact audited operator acknowledgement", async () => {
    const client = await migrate();
    const seeded = await seed(client);
    const first = await acquireLease(client, seeded.key, "owner-a");
    expect(first).not.toBeNull();
    if (!first) throw new Error("first lease missing");

    expect(await beginRemoteConfig(client, seeded.key, first, "remote-op-2", 2, "setup")).toBe(true);
    expect(await releaseLease(client, seeded.key, first)).toBe(true);
    const successor = await acquireLease(client, seeded.key, "owner-b");
    expect(successor).not.toBeNull();
    if (!successor) throw new Error("successor lease missing");

    expect(await confirmRemoteConfig(client, seeded.key, successor, "remote-op-2", "setup")).toBe(false);
    expect(await beginRemoteConfig(client, seeded.key, successor, "remote-op-3", 3, "setup")).toBe(false);
    expect(await blockRemoteConfig(client, seeded.key, successor, "remote-op-2")).toBe(true);
    expect(
      await acknowledgeRemoteQuiescence(client, seeded.key, first, {
        operationId: "remote-op-2",
        actorId: "operator-aaron",
        evidenceNote: "Dokploy audit drained; stable application observed at zero tasks.",
        auditId: "audit-rejected-stale",
      }),
    ).toBe(false);
    expect(
      await acknowledgeRemoteQuiescence(client, seeded.key, successor, {
        operationId: "wrong-operation",
        actorId: "operator-aaron",
        evidenceNote: "Dokploy audit drained; stable application observed at zero tasks.",
        auditId: "audit-rejected-wrong-operation",
      }),
    ).toBe(false);
    expect(await beginRemoteConfig(client, seeded.key, successor, "remote-op-3", 3, "setup")).toBe(false);
    expect(
      await acknowledgeRemoteQuiescence(client, seeded.key, successor, {
        operationId: "remote-op-2",
        actorId: "operator-aaron",
        evidenceNote: "Dokploy audit drained; stable application observed at zero tasks.",
        auditId: "audit-accepted",
      }),
    ).toBe(true);
    await client.execute({
      sql: `UPDATE tenant SET config_version = 3, config_json = '{"model":"ready","revision":3}'
        WHERE id = ?1`,
      args: [seeded.tenantId],
    });
    expect(await beginRemoteConfig(client, seeded.key, successor, "remote-op-3", 3, "setup")).toBe(true);
    expect(await confirmRemoteConfig(client, seeded.key, successor, "remote-op-3", "setup")).toBe(true);
    expect(await readProvisioningTarget(client, seeded.tenantId)).toMatchObject({
      appliedConfigVersion: 3,
      appliedMode: "setup",
    });

    const audits = await client.execute(`SELECT id, operation_id, actor_id, outcome
      FROM provisioner_operator_audit ORDER BY id`);
    expect(audits.rows).toEqual([
      expect.objectContaining({ id: "audit-accepted", operation_id: "remote-op-2", outcome: "accepted" }),
      expect.objectContaining({
        id: "audit-rejected-stale",
        operation_id: "remote-op-2",
        outcome: "rejected",
      }),
      expect.objectContaining({
        id: "audit-rejected-wrong-operation",
        operation_id: "wrong-operation",
        actor_id: "operator-aaron",
        outcome: "rejected",
      }),
    ]);
  });
});
