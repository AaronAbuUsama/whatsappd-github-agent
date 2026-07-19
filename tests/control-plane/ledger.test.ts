import { readdir, readFile } from "node:fs/promises";

import type { Client } from "@libsql/client";
import { afterEach, describe, expect, test } from "vitest";

import {
  acquireLease,
  openControlDb,
  releaseLease,
  renewLease,
  writeAgentPhase,
} from "../../packages/db/src/control-db";

const migrationDirectory = new URL("../../packages/db/src/migrations/", import.meta.url);

let db: Client | undefined;

async function migrate() {
  const migrations = (await readdir(migrationDirectory)).filter((file) => file.endsWith(".sql")).sort();
  if (migrations.length === 0) throw new Error("control-plane migration is missing");

  const opened = await openControlDb({ url: "file::memory:" });
  db = opened.client;
  for (const migration of migrations) {
    await db.executeMultiple(await readFile(new URL(migration, migrationDirectory), "utf8"));
  }
  return db;
}

async function seedTenant(client: Client, suffix: string, status = "onboarding") {
  const userId = `user-${suffix}`;
  const entitlementId = `entitlement-${suffix}`;
  const tenantId = `tenant-${suffix}`;
  const credsStoreKey = `tenant-db-${suffix}`;

  await client.execute({
    sql: "INSERT INTO user (id, name, email) VALUES (?1, ?2, ?3)",
    args: [userId, `User ${suffix}`, `${suffix}@example.com`],
  });
  await client.execute({
    sql: `INSERT INTO subscription_entitlement (
      id, user_id, polar_customer_id, polar_subscription_id, status, last_event_id
    ) VALUES (?1, ?2, ?3, ?4, 'active', ?5)`,
    args: [entitlementId, userId, `customer-${suffix}`, `subscription-${suffix}`, `event-${suffix}`],
  });
  await client.execute({
    sql: `INSERT INTO tenant (
      id, user_id, subscription_entitlement_id, display_name, status, tenant_db_name
    ) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    args: [tenantId, userId, entitlementId, `Ambience ${suffix}`, status, credsStoreKey],
  });

  return { userId, entitlementId, tenantId, credsStoreKey };
}

async function seedInstance(client: Client, tenantId: string, credsStoreKey: string, suffix: string) {
  await client.execute({
    sql: `INSERT INTO agent_instance (
      id, tenant_id, creds_store_key, dokploy_display_name, dokploy_creation_token
    ) VALUES (?1, ?2, ?3, ?4, ?5)`,
    args: [`agent-${suffix}`, tenantId, credsStoreKey, `Ambient ${suffix}`, `create-${suffix}`],
  });
}

async function seedReadyCapabilities(client: Client, tenantId: string, suffix: string) {
  await client.execute({
    sql: `UPDATE agent_instance
      SET desired_mode = 'operate', observed_state = 'healthy', observed_at_ms = 1,
          applied_config_version = 1, applied_mode = 'operate'
      WHERE tenant_id = ?1`,
    args: [tenantId],
  });
  await client.execute({
    sql: `INSERT INTO model_connection (
      tenant_id, status, credential_version, verified_at_ms
    ) VALUES (?1, 'ready', 1, 1)`,
    args: [tenantId],
  });
  await client.execute({
    sql: `INSERT INTO whatsapp_connection (
      tenant_id, status, account_jid, observed_at_ms
    ) VALUES (?1, 'online', ?2, 1)`,
    args: [tenantId, `account-${suffix}@s.whatsapp.net`],
  });
  await client.execute({
    sql: `INSERT INTO managed_chat_selection (tenant_id, status, selected_at_ms)
      VALUES (?1, 'selected', 1)`,
    args: [tenantId],
  });
  await client.execute({
    sql: `INSERT INTO tenant_managed_chat (tenant_id, jid, display_name, kind)
      VALUES (?1, ?2, ?3, 'group')`,
    args: [tenantId, `chat-${suffix}@g.us`, `Chat ${suffix}`],
  });
  const installationId = Number(suffix.replaceAll(/\D/g, "")) + 1_000;
  for (const [offset, role] of ["coder", "reviewer", "planner"].entries()) {
    await client.execute({
      sql: `INSERT INTO github_installation (
        tenant_id, role, installation_id, status, account_login
      ) VALUES (?1, ?2, ?3, 'installed', ?4)`,
      args: [tenantId, role, installationId + offset, `org-${suffix}`],
    });
  }
  const repositoryId = Number(suffix.replaceAll(/\D/g, "")) + 2_000;
  for (const [offset, role] of ["coder", "reviewer", "planner"].entries()) {
    await client.execute({
      sql: `INSERT INTO github_repository (
        tenant_id, installation_role, installation_id, repository_id, owner, name, selected, is_default
      ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, 1)`,
      args: [tenantId, role, installationId + offset, repositoryId, `org-${suffix}`, `repo-${suffix}`],
    });
  }
  await client.execute({
    sql: "INSERT INTO delivery_route (tenant_id, status, observed_at_ms) VALUES (?1, 'ready', 1)",
    args: [tenantId],
  });
}

afterEach(() => {
  db?.close();
  db = undefined;
});

describe("control-plane ledger migration", () => {
  test("creates every authoritative ledger row", async () => {
    const client = await migrate();
    const result = await client.execute("SELECT name FROM sqlite_master WHERE type IN ('table', 'view') ORDER BY name");

    expect(result.rows.map((row) => row.name)).toEqual(
      expect.arrayContaining([
        "agent_instance",
        "control_operation",
        "delivery_route",
        "github_delivery_outbox",
        "github_installation",
        "github_installation_callback",
        "github_repository",
        "managed_chat_selection",
        "model_connection",
        "provisioner_lease",
        "provisioner_operator_audit",
        "subscription_entitlement",
        "tenant",
        "tenant_managed_chat",
        "tenant_readiness",
        "whatsapp_connection",
      ]),
    );
    const agentColumns = await client.execute("PRAGMA table_info(agent_instance)");
    expect(agentColumns.rows.map((row) => row.name)).toContain("runtime_base_url");
  });

  test("rejects relationships that cross tenant boundaries", async () => {
    const client = await migrate();
    const first = await seedTenant(client, "1");
    const second = await seedTenant(client, "2");
    await client.execute({
      sql: `INSERT INTO github_installation (
        tenant_id, role, installation_id, status
      ) VALUES (?1, 'planner', 1001, 'installed')`,
      args: [first.tenantId],
    });

    await expect(seedInstance(client, second.tenantId, first.credsStoreKey, "cross-tenant")).rejects.toThrow(
      /FOREIGN KEY constraint failed/,
    );
    await expect(
      client.execute({
        sql: `INSERT INTO github_repository (
          tenant_id, installation_role, installation_id, repository_id, owner, name
        ) VALUES (?1, 'planner', 1001, 2001, 'owner', 'repo')`,
        args: [second.tenantId],
      }),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);
  });

  test("enforces the single-instance and single-default uniqueness spine", async () => {
    const client = await migrate();
    const seeded = await seedTenant(client, "3");
    await seedInstance(client, seeded.tenantId, seeded.credsStoreKey, "3");
    await client.execute({
      sql: `INSERT INTO github_installation (
        tenant_id, role, installation_id, status
      ) VALUES (?1, 'planner', 1003, 'installed')`,
      args: [seeded.tenantId],
    });
    await client.execute({
      sql: `INSERT INTO github_repository (
        tenant_id, installation_role, installation_id, repository_id, owner, name, selected, is_default
      ) VALUES (?1, 'planner', 1003, 2003, 'owner', 'first', 1, 1)`,
      args: [seeded.tenantId],
    });

    await expect(
      client.execute({
        sql: `INSERT INTO agent_instance (
          id, tenant_id, creds_store_key, dokploy_display_name, dokploy_creation_token
        ) VALUES ('agent-duplicate', ?1, ?2, 'duplicate', 'duplicate')`,
        args: [seeded.tenantId, seeded.credsStoreKey],
      }),
    ).rejects.toThrow(/UNIQUE constraint failed/);
    await expect(
      client.execute({
        sql: `INSERT INTO github_repository (
          tenant_id, installation_role, installation_id, repository_id, owner, name, selected, is_default
        ) VALUES (?1, 'planner', 1003, 2004, 'owner', 'second', 1, 1)`,
        args: [seeded.tenantId],
      }),
    ).rejects.toThrow(/UNIQUE constraint failed/);
    await expect(
      client.execute({
        sql: "UPDATE tenant SET tenant_db_url = 'libsql://partial' WHERE id = ?1",
        args: [seeded.tenantId],
      }),
    ).rejects.toThrow(/CHECK constraint failed/);
  });

  test("cascades one user deletion through the complete tenant ledger", async () => {
    const client = await migrate();
    const seeded = await seedTenant(client, "4", "active");
    await seedInstance(client, seeded.tenantId, seeded.credsStoreKey, "4");
    await seedReadyCapabilities(client, seeded.tenantId, "4");
    await client.execute({
      sql: `INSERT INTO provisioner_lease (
        creds_store_key, owner_id, fencing_token, expires_at_ms
      ) VALUES (?1, 'owner-4', 1, 9999999999999)`,
      args: [seeded.credsStoreKey],
    });
    await client.execute({
      sql: `INSERT INTO control_operation (
        id, tenant_id, kind, operation_identity
      ) VALUES ('operation-4', ?1, 'provision_setup', 'provision-4')`,
      args: [seeded.tenantId],
    });
    await client.execute({
      sql: `INSERT INTO github_delivery_outbox (
        github_app_id, delivery_guid, event_name, installation_role, installation_id, tenant_id,
        payload_json, payload_sha256, next_attempt_at_ms, received_at_ms
      ) VALUES ('planner-app', 'delivery-4', 'issues', 'planner', 1006, ?1, '{}', 'payload-4', 1, 1)`,
      args: [seeded.tenantId],
    });

    await client.execute({ sql: "DELETE FROM user WHERE id = ?1", args: [seeded.userId] });

    for (const table of [
      "subscription_entitlement",
      "tenant",
      "agent_instance",
      "provisioner_lease",
      "provisioner_operator_audit",
      "model_connection",
      "whatsapp_connection",
      "managed_chat_selection",
      "tenant_managed_chat",
      "github_installation",
      "github_installation_callback",
      "github_repository",
      "github_delivery_outbox",
      "delivery_route",
      "control_operation",
    ]) {
      const result = await client.execute(`SELECT count(*) AS count FROM ${table}`);
      expect(Number(result.rows[0]?.count), table).toBe(0);
    }
  });

  test("opens with foreign keys enabled and rejects a stale lease fence", async () => {
    const client = await migrate();
    const seeded = await seedTenant(client, "5");
    await seedInstance(client, seeded.tenantId, seeded.credsStoreKey, "5");
    const foreignKeys = await client.execute("PRAGMA foreign_keys");
    expect(Number(foreignKeys.rows[0]?.foreign_keys)).toBe(1);

    const first = await acquireLease(client, seeded.credsStoreKey, "first-owner");
    expect(first).not.toBeNull();
    if (!first) throw new Error("first lease was not acquired");
    expect(await writeAgentPhase(client, seeded.credsStoreKey, first, "provisioning")).toBe(true);
    expect(await renewLease(client, seeded.credsStoreKey, first)).not.toBeNull();
    expect(await releaseLease(client, seeded.credsStoreKey, first)).toBe(true);

    const successor = await acquireLease(client, seeded.credsStoreKey, "successor-owner");
    expect(successor?.fencingToken).toBe(first.fencingToken + 1);
    if (!successor) throw new Error("successor lease was not acquired");
    expect(await writeAgentPhase(client, seeded.credsStoreKey, first, "running")).toBe(false);
    expect(await releaseLease(client, seeded.credsStoreKey, first)).toBe(false);
    expect(await writeAgentPhase(client, seeded.credsStoreKey, successor, "running")).toBe(true);
  });

  test("returns one durable receipt for repeated operation identity", async () => {
    const client = await migrate();
    const seeded = await seedTenant(client, "6");
    const insertReceipt = (id: string) =>
      client.execute({
        sql: `INSERT INTO control_operation (
          id, tenant_id, kind, operation_identity
        ) VALUES (?1, ?2, 'activate', 'activate-revision-1')
        ON CONFLICT (tenant_id, operation_identity) DO UPDATE
          SET operation_identity = excluded.operation_identity
        RETURNING id`,
        args: [id, seeded.tenantId],
      });

    expect((await insertReceipt("operation-first")).rows[0]?.id).toBe("operation-first");
    expect((await insertReceipt("operation-retry")).rows[0]?.id).toBe("operation-first");
    const count = await client.execute("SELECT count(*) AS count FROM control_operation");
    expect(Number(count.rows[0]?.count)).toBe(1);
    await expect(
      client.execute({
        sql: `INSERT INTO control_operation (
          id, tenant_id, kind, operation_identity
        ) VALUES ('operation-typo', ?1, 'activte', 'operation-typo')`,
        args: [seeded.tenantId],
      }),
    ).rejects.toThrow(/CHECK constraint failed/);
  });

  test("derives readiness from current independent facts and config revisions", async () => {
    const client = await migrate();
    const seeded = await seedTenant(client, "7", "active");
    await seedInstance(client, seeded.tenantId, seeded.credsStoreKey, "7");
    await seedReadyCapabilities(client, seeded.tenantId, "7");
    const readiness = async () => {
      const result = await client.execute({
        sql: "SELECT readiness FROM tenant_readiness WHERE tenant_id = ?1",
        args: [seeded.tenantId],
      });
      return result.rows[0]?.readiness;
    };

    expect(await readiness()).toBe("degraded");
    await client.execute({
      sql: "UPDATE tenant SET desired_state = 'running' WHERE id = ?1",
      args: [seeded.tenantId],
    });
    expect(await readiness()).toBe("healthy");
    await client.execute({
      sql: "UPDATE agent_instance SET applied_mode = 'setup' WHERE tenant_id = ?1",
      args: [seeded.tenantId],
    });
    expect(await readiness()).toBe("degraded");
    await client.execute({
      sql: "UPDATE agent_instance SET applied_mode = 'operate' WHERE tenant_id = ?1",
      args: [seeded.tenantId],
    });
    expect(await readiness()).toBe("healthy");
    await expect(
      client.execute({
        sql: `UPDATE github_installation SET installation_id = 3007
          WHERE tenant_id = ?1 AND role = 'coder'`,
        args: [seeded.tenantId],
      }),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);
    await client.execute({
      sql: "DELETE FROM github_repository WHERE tenant_id = ?1 AND installation_role = 'coder'",
      args: [seeded.tenantId],
    });
    await client.execute({
      sql: `UPDATE github_installation SET installation_id = 3007
        WHERE tenant_id = ?1 AND role = 'coder'`,
      args: [seeded.tenantId],
    });
    expect(await readiness()).toBe("degraded");
    await client.execute({
      sql: `INSERT INTO github_repository (
        tenant_id, installation_role, installation_id, repository_id, owner, name, selected, is_default
      ) VALUES (?1, 'coder', 3007, 2007, 'org-7', 'repo-7', 1, 1)`,
      args: [seeded.tenantId],
    });
    expect(await readiness()).toBe("healthy");
    await client.execute({
      sql: "UPDATE subscription_entitlement SET status = 'trialing' WHERE id = ?1",
      args: [seeded.entitlementId],
    });
    expect(await readiness()).toBe("healthy");
    await client.execute({
      sql: "UPDATE tenant SET config_version = 2 WHERE id = ?1",
      args: [seeded.tenantId],
    });
    expect(await readiness()).toBe("degraded");
    await client.execute({
      sql: "UPDATE agent_instance SET applied_config_version = 2 WHERE tenant_id = ?1",
      args: [seeded.tenantId],
    });
    expect(await readiness()).toBe("healthy");
    await client.execute({
      sql: "UPDATE tenant SET desired_state = 'deleted' WHERE id = ?1",
      args: [seeded.tenantId],
    });
    expect(await readiness()).toBe("degraded");
    await client.execute({
      sql: "UPDATE tenant SET desired_state = 'running' WHERE id = ?1",
      args: [seeded.tenantId],
    });
    expect(await readiness()).toBe("healthy");
    await client.execute({
      sql: "UPDATE subscription_entitlement SET status = 'past_due' WHERE id = ?1",
      args: [seeded.entitlementId],
    });
    expect(await readiness()).toBe("suspended");

    const tenantColumns = await client.execute("PRAGMA table_info(tenant)");
    expect(tenantColumns.rows.map((row) => row.name)).not.toContain("readiness");
    expect(tenantColumns.rows.map((row) => row.name)).not.toContain("onboarding_projection");
  });
});
