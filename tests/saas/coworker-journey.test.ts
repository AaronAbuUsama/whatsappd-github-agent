import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";

import type { Client } from "@libsql/client";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { RPCHandler } from "@orpc/server/fetch";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  createCoworkerService,
  type CoworkerRuntimeSource,
  type CoworkerService,
} from "../../packages/api/src/coworker";
import { createAppRouter, type AppRouterClient } from "../../packages/api/src/routers/index";
import { openControlDb } from "../../packages/db/src/control-db";
import { createHostedCoworkerService } from "../../apps/api/src/coworker-hosted";

const migrationDirectory = new URL("../../packages/db/src/migrations/", import.meta.url);
const now = 1_800_000_000_000;
let database: Client | undefined;

async function migrate() {
  const opened = await openControlDb({ url: "file::memory:" });
  database = opened.client;
  const migrations = (await readdir(migrationDirectory)).filter((file) => file.endsWith(".sql")).sort();
  for (const migration of migrations) {
    await database.executeMultiple(await readFile(new URL(migration, migrationDirectory), "utf8"));
  }
  return database;
}

async function seedUser(client: Client, suffix: string, entitlement = "active") {
  const userId = `user-${suffix}`;
  await client.execute({
    sql: "INSERT INTO user (id, name, email) VALUES (?1, ?2, ?3)",
    args: [userId, `User ${suffix}`, `${suffix}@example.com`],
  });
  await client.execute({
    sql: `INSERT INTO subscription_entitlement (id, user_id, status, updated_at_ms)
          VALUES (?1, ?2, ?3, ?4)`,
    args: [`entitlement-${suffix}`, userId, entitlement, now],
  });
  return userId;
}

const runtimeSource = (): CoworkerRuntimeSource => ({
  health: async () => ({
    ok: true,
    runtimeId: "runtime-test",
    runtime: { state: "healthy", whatsapp: { phase: "online" } },
  }),
  pairing: async () => ({ status: "paired", accountJid: "account@s.whatsapp.net" }),
  chats: async () => [
    { jid: "family@g.us", name: "Family", kind: "group", lastActivityAt: now },
    { jid: "friend@s.whatsapp.net", name: "Friend", kind: "direct", lastActivityAt: now - 10 },
  ],
});

function appClient(service: CoworkerService, userId: string): AppRouterClient {
  const handler = new RPCHandler(
    createAppRouter({
      getEntitlementSnapshot: async () => ({
        status: "active",
        entitled: true,
        runtimeStopRequested: false,
        lastEventId: null,
      }),
      coworker: service,
    }),
  );
  return createORPCClient(
    new RPCLink({
      url: "http://localhost/rpc",
      fetch: async (url, options) => {
        const result = await handler.handle(new Request(url, options), {
          prefix: "/rpc",
          context: { auth: null, session: { user: { id: userId } } as never },
        });
        if (!result.matched) throw new Error(`Unmatched RPC request: ${url}`);
        return result.response;
      },
    }),
  );
}

async function createReadyOnboarding(client: Client, service: CoworkerService, userId: string, suffix: string) {
  const created = await service.create(userId, {
    displayName: `Coworker ${suffix}`,
    operationIdentity: `create-${suffix}`,
  });
  const tenantId = created.tenant?.id;
  if (!tenantId) throw new Error("coworker tenant was not created");

  await client.execute({
    sql: `UPDATE tenant SET tenant_db_url = ?2, tenant_db_token_ciphertext = ?3 WHERE id = ?1`,
    args: [tenantId, `libsql://${suffix}.turso.io`, `cipher-${suffix}`],
  });
  await client.execute({
    sql: `UPDATE agent_instance
             SET desired_mode = 'setup', observed_state = 'healthy', observed_at_ms = ?2,
                 runtime_base_url = ?3, applied_config_version = 1
           WHERE tenant_id = ?1`,
    args: [tenantId, now, `https://${suffix}.runtime.test`],
  });
  await client.execute({
    sql: `UPDATE control_operation
             SET status = 'succeeded', settled_at_ms = ?2, updated_at_ms = ?2
           WHERE tenant_id = ?1 AND kind = 'provision_setup'`,
    args: [tenantId, now],
  });
  await client.execute({
    sql: `UPDATE model_connection
             SET status = 'ready', credential_version = 1, verified_at_ms = ?2
           WHERE tenant_id = ?1`,
    args: [tenantId, now],
  });
  await client.execute({
    sql: `UPDATE whatsapp_connection
             SET status = 'online', account_jid = ?2, observed_at_ms = ?3
           WHERE tenant_id = ?1`,
    args: [tenantId, `${suffix}@s.whatsapp.net`, now],
  });
  await service.selectManagedChats(userId, { jids: ["family@g.us"] });

  for (const [offset, role] of ["coder", "reviewer", "planner"].entries()) {
    const installationId = 10_000 + offset + Number(suffix.replaceAll(/\D/gu, "") || "0") * 10;
    await client.execute({
      sql: `INSERT INTO github_installation
              (tenant_id, role, installation_id, status, account_login, updated_at_ms)
            VALUES (?1, ?2, ?3, 'installed', ?4, ?5)`,
      args: [tenantId, role, installationId, `org-${suffix}`, now],
    });
    await client.execute({
      sql: `INSERT INTO github_repository
              (tenant_id, installation_role, installation_id, repository_id, owner, name,
               selected, is_default, updated_at_ms)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1, 1, ?7)`,
      args: [tenantId, role, installationId, 20_000 + offset, `org-${suffix}`, `repo-${suffix}-${role}`, now],
    });
  }
  return tenantId;
}

afterEach(() => {
  database?.close();
  database = undefined;
});

describe("hosted coworker journey", () => {
  test("resumes from the first incomplete ledger capability without a stored wizard cursor", async () => {
    const client = await migrate();
    const userId = await seedUser(client, "resume");
    const service = createCoworkerService({ client, now: () => now, runtime: runtimeSource() });

    expect((await service.snapshot(userId)).nextAction).toBe("coworker");
    await service.create(userId, { displayName: "Ada", operationIdentity: "create-resume" });
    expect((await service.snapshot(userId)).nextAction).toBe("preparing");

    await client.execute({
      sql: `UPDATE tenant SET tenant_db_url = 'libsql://resume', tenant_db_token_ciphertext = 'cipher' WHERE user_id = ?1`,
      args: [userId],
    });
    await client.execute({
      sql: `UPDATE agent_instance
               SET desired_mode = 'setup', observed_state = 'healthy', observed_at_ms = ?2,
                   runtime_base_url = 'https://resume.runtime.test'
             WHERE tenant_id = (SELECT id FROM tenant WHERE user_id = ?1)`,
      args: [userId, now],
    });
    await client.execute({
      sql: `UPDATE control_operation
               SET status = 'succeeded', settled_at_ms = ?2, updated_at_ms = ?2
             WHERE tenant_id = (SELECT id FROM tenant WHERE user_id = ?1)
               AND kind = 'provision_setup'`,
      args: [userId, now],
    });
    expect((await service.snapshot(userId)).nextAction).toBe("model");
  });

  test("makes duplicate create and repair submissions idempotent through the authenticated API", async () => {
    const client = await migrate();
    const userId = await seedUser(client, "duplicate");
    const service = createCoworkerService({ client, now: () => now, runtime: runtimeSource() });
    const rpc = appClient(service, userId);
    const operationIdentity = randomUUID();

    const first = await rpc.coworker.create({ displayName: "Grace", operationIdentity });
    const duplicate = await rpc.coworker.create({ displayName: "Grace", operationIdentity });
    expect(duplicate.tenant?.id).toBe(first.tenant?.id);

    await client.execute({
      sql: "UPDATE tenant SET status = 'active', desired_state = 'running' WHERE user_id = ?1",
      args: [userId],
    });
    await client.execute({
      sql: "UPDATE agent_instance SET desired_mode = 'operate' WHERE tenant_id = ?1",
      args: [first.tenant?.id ?? ""],
    });
    await client.execute({
      sql: `UPDATE control_operation
               SET status = 'succeeded', settled_at_ms = ?2, updated_at_ms = ?2
             WHERE tenant_id = ?1 AND kind = 'provision_setup'`,
      args: [first.tenant?.id ?? "", now],
    });
    const repairIdentity = randomUUID();
    const repair = await rpc.coworker.whatsapp.beginRepair({ operationIdentity: repairIdentity });
    const repairDuplicate = await rpc.coworker.whatsapp.beginRepair({ operationIdentity: repairIdentity });

    expect(repairDuplicate.id).toBe(repair.id);
    await expect(rpc.coworker.whatsapp.beginRepair({ operationIdentity: randomUUID() })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect((await rpc.coworker.snapshot()).nextAction).toBe("operate");
    const operations = await client.execute({
      sql: "SELECT count(*) AS count FROM control_operation WHERE tenant_id = ?1 AND kind = 'repair'",
      args: [first.tenant?.id ?? ""],
    });
    expect(Number(operations.rows[0]?.count)).toBe(1);

    await client.execute({
      sql: `UPDATE control_operation
               SET status = 'succeeded', settled_at_ms = ?2, updated_at_ms = ?2
             WHERE id = ?1`,
      args: [repair.id, now],
    });
    await client.execute({
      sql: "UPDATE agent_instance SET desired_mode = 'operate' WHERE tenant_id = ?1",
      args: [first.tenant?.id ?? ""],
    });
    await client.execute({
      sql: `UPDATE whatsapp_connection
               SET status = 'online', account_jid = 'duplicate@s.whatsapp.net', observed_at_ms = ?2
             WHERE tenant_id = ?1`,
      args: [first.tenant?.id ?? "", now],
    });
    expect((await rpc.coworker.whatsapp.beginRepair({ operationIdentity: repairIdentity })).id).toBe(repair.id);
    expect(
      await client.execute({
        sql: `SELECT agent_instance.desired_mode, whatsapp_connection.status
                FROM agent_instance
                JOIN whatsapp_connection ON whatsapp_connection.tenant_id = agent_instance.tenant_id
               WHERE agent_instance.tenant_id = ?1`,
        args: [first.tenant?.id ?? ""],
      }),
    ).toMatchObject({ rows: [expect.objectContaining({ desired_mode: "operate", status: "online" })] });
  });

  test("does not create a tenant when entitlement is revoked at the create transaction boundary", async () => {
    const client = await migrate();
    const userId = await seedUser(client, "entitlement-race");
    let revokeBeforeBatch = true;
    const guardedClient: Pick<Client, "execute" | "batch"> = {
      execute: client.execute.bind(client),
      batch: async (statements, mode) => {
        if (revokeBeforeBatch) {
          revokeBeforeBatch = false;
          await client.execute({
            sql: "UPDATE subscription_entitlement SET status = 'canceled' WHERE user_id = ?1",
            args: [userId],
          });
        }
        return await client.batch(statements, mode);
      },
    };
    const service = createCoworkerService({ client: guardedClient, now: () => now });

    await expect(
      service.create(userId, { displayName: "Revoked", operationIdentity: "create-revoked" }),
    ).rejects.toMatchObject({ code: "entitlement_required" });
    expect(
      await client.execute({ sql: "SELECT count(*) AS count FROM tenant WHERE user_id = ?1", args: [userId] }),
    ).toMatchObject({ rows: [expect.objectContaining({ count: 0 })] });
  });

  test("keeps one-time model authorization material ephemeral and deduplicates the active attempt", async () => {
    const client = await migrate();
    const userId = await seedUser(client, "model-secret");
    let finishAuthorization: (() => void) | undefined;
    const completion = new Promise<void>((resolve) => {
      finishAuthorization = resolve;
    });
    const beginAuth = vi.fn(async () => ({
      challenge: {
        verificationUrl: "https://model.example.test/device",
        userCode: "ONE-TIME-SECRET",
        expiresAt: now + 60_000,
      },
      completion,
    }));
    const service = createCoworkerService({
      client,
      now: () => now,
      runtime: runtimeSource(),
      model: { beginAuth, verify: async () => true },
    });
    await service.create(userId, { displayName: "Model", operationIdentity: "create-model" });

    const first = await service.beginModelAuth(userId, { operationIdentity: "model-attempt" });
    const duplicate = await service.beginModelAuth(userId, { operationIdentity: "model-attempt" });
    expect(duplicate).toEqual(first);
    expect(beginAuth).toHaveBeenCalledTimes(1);
    const validating = await client.execute({
      sql: "SELECT * FROM model_connection WHERE tenant_id = (SELECT id FROM tenant WHERE user_id = ?1)",
      args: [userId],
    });
    expect(JSON.stringify(validating.rows)).not.toContain(first.userCode);
    expect(validating.rows[0]?.status).toBe("validating");

    finishAuthorization?.();
    await vi.waitFor(async () => {
      const settled = await client.execute({
        sql: "SELECT status, credential_version, verified_at_ms FROM model_connection WHERE tenant_id = (SELECT id FROM tenant WHERE user_id = ?1)",
        args: [userId],
      });
      expect(settled.rows[0]).toMatchObject({ status: "ready", credential_version: 1, verified_at_ms: now });
    });
  });

  test("does not let a negative manual model check invalidate a live authorization claim", async () => {
    const client = await migrate();
    const userId = await seedUser(client, "model-live-claim");
    let finishAuthorization: (() => void) | undefined;
    const completion = new Promise<void>((resolve) => {
      finishAuthorization = resolve;
    });
    const service = createCoworkerService({
      client,
      now: () => now,
      model: {
        beginAuth: async () => ({
          challenge: {
            verificationUrl: "https://model.example.test/device",
            userCode: "LIVE-CLAIM",
            expiresAt: now + 60_000,
          },
          completion,
        }),
        verify: async () => false,
      },
    });
    await service.create(userId, { displayName: "Live claim", operationIdentity: "create-live-claim" });
    await service.beginModelAuth(userId, { operationIdentity: "model-live-claim" });

    await expect(service.verifyModel(userId)).resolves.toEqual({ ready: false });
    expect(
      await client.execute({
        sql: "SELECT status FROM model_connection WHERE tenant_id = (SELECT id FROM tenant WHERE user_id = ?1)",
        args: [userId],
      }),
    ).toMatchObject({ rows: [expect.objectContaining({ status: "validating" })] });

    finishAuthorization?.();
    await vi.waitFor(async () => {
      expect(
        await client.execute({
          sql: "SELECT status FROM model_connection WHERE tenant_id = (SELECT id FROM tenant WHERE user_id = ?1)",
          args: [userId],
        }),
      ).toMatchObject({ rows: [expect.objectContaining({ status: "ready" })] });
    });
  });

  test("claims model authorization across service replicas before starting tenant auth", async () => {
    const client = await migrate();
    const userId = await seedUser(client, "model-replica");
    const completion = new Promise<void>(() => undefined);
    const beginAuth = vi.fn(async () => ({
      challenge: {
        verificationUrl: "https://model.example.test/device",
        userCode: "REPLICA-SECRET",
        expiresAt: now + 60_000,
      },
      completion,
    }));
    const model = { beginAuth, verify: async () => true };
    const firstReplica = createCoworkerService({ client, now: () => now, model });
    const secondReplica = createCoworkerService({ client, now: () => now, model });
    await firstReplica.create(userId, { displayName: "Replica", operationIdentity: "create-replica" });

    const attempts = await Promise.allSettled([
      firstReplica.beginModelAuth(userId, { operationIdentity: "replica-a" }),
      secondReplica.beginModelAuth(userId, { operationIdentity: "replica-b" }),
    ]);
    expect(attempts.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter(({ status }) => status === "rejected")).toHaveLength(1);
    expect(beginAuth).toHaveBeenCalledTimes(1);
  });

  test("returns a short-lived pairing challenge without persisting QR material", async () => {
    const client = await migrate();
    const userId = await seedUser(client, "pairing-secret");
    const qr = "SHORT-LIVED-QR-SECRET";
    const service = createCoworkerService({
      client,
      now: () => now,
      runtime: {
        ...runtimeSource(),
        pairing: async () => ({ status: "pairing", method: "qr", qr, expiresAt: now + 60_000 }),
      },
    });
    const created = await service.create(userId, {
      displayName: "Pairing",
      operationIdentity: "create-pairing",
    });
    await client.execute({
      sql: "UPDATE agent_instance SET runtime_base_url = 'https://pairing.runtime.test' WHERE tenant_id = ?1",
      args: [created.tenant?.id ?? ""],
    });

    expect(await service.pairing(userId)).toMatchObject({ status: "pairing", method: "qr", qr });
    const connection = await client.execute({
      sql: "SELECT * FROM whatsapp_connection WHERE tenant_id = ?1",
      args: [created.tenant?.id ?? ""],
    });
    expect(JSON.stringify(connection.rows)).not.toContain(qr);
  });

  test("advances onboarding from a real paired runtime observation without persisting challenge material", async () => {
    const client = await migrate();
    const userId = await seedUser(client, "pairing-observation");
    const service = createCoworkerService({ client, now: () => now, runtime: runtimeSource() });
    const created = await service.create(userId, {
      displayName: "Pairing observation",
      operationIdentity: "create-pairing-observation",
    });
    await client.execute({
      sql: `UPDATE agent_instance
               SET observed_state = 'healthy', observed_at_ms = ?2,
                   runtime_base_url = 'https://pairing-observation.runtime.test'
             WHERE tenant_id = ?1`,
      args: [created.tenant?.id ?? "", now],
    });
    await client.execute({
      sql: `UPDATE control_operation
               SET status = 'succeeded', settled_at_ms = ?2, updated_at_ms = ?2
             WHERE tenant_id = ?1 AND kind = 'provision_setup'`,
      args: [created.tenant?.id ?? "", now],
    });
    await client.execute({
      sql: `UPDATE model_connection
               SET status = 'ready', credential_version = 1, verified_at_ms = ?2
             WHERE tenant_id = ?1`,
      args: [created.tenant?.id ?? "", now],
    });

    expect((await service.snapshot(userId)).nextAction).toBe("whatsapp");
    await expect(service.pairing(userId)).resolves.toEqual({
      status: "paired",
      accountJid: "account@s.whatsapp.net",
    });
    expect(await service.snapshot(userId)).toMatchObject({
      nextAction: "chats",
      capabilities: { whatsapp: { state: "healthy", observedAtMs: now } },
    });
    expect(
      await client.execute({
        sql: "SELECT status, account_jid, observed_at_ms FROM whatsapp_connection WHERE tenant_id = ?1",
        args: [created.tenant?.id ?? ""],
      }),
    ).toMatchObject({
      rows: [expect.objectContaining({ status: "online", account_jid: "account@s.whatsapp.net", observed_at_ms: now })],
    });
  });

  test("does not claim WhatsApp readiness when the privileged runtime omits the authenticated account identity", async () => {
    const client = await migrate();
    const userId = await seedUser(client, "pairing-without-account");
    const service = createCoworkerService({
      client,
      now: () => now,
      runtime: { ...runtimeSource(), pairing: async () => ({ status: "paired" }) },
    });
    const created = await service.create(userId, {
      displayName: "Pairing without account",
      operationIdentity: "create-pairing-without-account",
    });
    await client.execute({
      sql: "UPDATE agent_instance SET runtime_base_url = 'https://pairing-without-account.test' WHERE tenant_id = ?1",
      args: [created.tenant?.id ?? ""],
    });

    await expect(service.pairing(userId)).resolves.toEqual({ status: "paired" });
    expect(await service.snapshot(userId)).toMatchObject({
      nextAction: "preparing",
      capabilities: { whatsapp: { state: "pending" } },
    });
    expect(
      await client.execute({
        sql: "SELECT status, account_jid, observed_at_ms FROM whatsapp_connection WHERE tenant_id = ?1",
        args: [created.tenant?.id ?? ""],
      }),
    ).toMatchObject({
      rows: [expect.objectContaining({ status: "unpaired", account_jid: null, observed_at_ms: null })],
    });
  });

  test("rejects a healthy response from a runtime outside the provisioned tenant identity", async () => {
    const client = await migrate();
    const userId = await seedUser(client, "runtime-identity");
    const service = createHostedCoworkerService({
      client,
      runtimeSecretForTenant: () => "tenant-bridge-secret",
      expectedRuntimeIdForTenant: () => "expected-runtime",
      fetch: async (input) => {
        const url = String(input);
        return Response.json(
          url.endsWith("/pairing")
            ? { status: "paired", accountJid: "wrong@s.whatsapp.net" }
            : {
                ok: true,
                runtimeId: "wrong-runtime",
                runtime: { state: "healthy", whatsapp: { phase: "online" } },
              },
        );
      },
    });
    const created = await service.create(userId, {
      displayName: "Runtime identity",
      operationIdentity: "create-runtime-identity",
    });
    await client.execute({
      sql: "UPDATE agent_instance SET runtime_base_url = 'https://runtime-identity.test' WHERE tenant_id = ?1",
      args: [created.tenant?.id ?? ""],
    });

    await expect(service.pairing(userId)).rejects.toMatchObject({ code: "runtime_unavailable" });
    expect(
      await client.execute({
        sql: "SELECT status, observed_at_ms FROM whatsapp_connection WHERE tenant_id = ?1",
        args: [created.tenant?.id ?? ""],
      }),
    ).toMatchObject({ rows: [expect.objectContaining({ status: "unpaired", observed_at_ms: null })] });
  });

  test("rejects stale activation revisions and accepts one current complete activation", async () => {
    const client = await migrate();
    const userId = await seedUser(client, "activation");
    const service = createCoworkerService({ client, now: () => now, runtime: runtimeSource() });
    const tenantId = await createReadyOnboarding(client, service, userId, "31");
    const rpc = appClient(service, userId);
    const reviewed = await rpc.coworker.snapshot();
    const currentConfigVersion = reviewed.tenant?.configVersion ?? 0;
    const expectedBasisFingerprint = reviewed.configurationRevision?.basisFingerprint ?? "";

    await expect(
      rpc.coworker.activate({
        expectedConfigVersion: currentConfigVersion + 1,
        expectedBasisFingerprint,
        operationIdentity: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const operation = await rpc.coworker.activate({
      expectedConfigVersion: currentConfigVersion,
      expectedBasisFingerprint,
      operationIdentity: "activate-current-revision",
    });
    expect(operation).toMatchObject({
      kind: "activate",
      status: "pending",
      targetConfigVersion: currentConfigVersion + 1,
    });
    const activated = await client.execute({
      sql: "SELECT config_json FROM tenant WHERE id = ?1",
      args: [tenantId],
    });
    expect(JSON.parse(String(activated.rows[0]?.config_json))).toMatchObject({
      managedChats: ["family@g.us"],
      github: {
        defaultRepository: "org-31/repo-31-planner",
        allowedRepositories: ["org-31/repo-31-planner"],
      },
    });
    expect(
      await client.execute({ sql: "SELECT config_version FROM tenant WHERE id = ?1", args: [tenantId] }),
    ).toMatchObject({ rows: [expect.objectContaining({ config_version: currentConfigVersion + 1 })] });
    expect(
      await client.execute({ sql: "SELECT status FROM delivery_route WHERE tenant_id = ?1", args: [tenantId] }),
    ).toMatchObject({ rows: [expect.objectContaining({ status: "pending" })] });
  });

  test("fails activation atomically when reviewed GitHub facts change before the write", async () => {
    const client = await migrate();
    const userId = await seedUser(client, "activation-race");
    const setupService = createCoworkerService({ client, now: () => now, runtime: runtimeSource() });
    const tenantId = await createReadyOnboarding(client, setupService, userId, "41");
    let mutateBeforeBatch = false;
    const guardedClient: Pick<Client, "execute" | "batch"> = {
      execute: client.execute.bind(client),
      batch: async (statements, mode) => {
        if (mutateBeforeBatch) {
          mutateBeforeBatch = false;
          await client.execute({
            sql: `UPDATE github_repository
                     SET is_default = 0, updated_at_ms = ?2
                   WHERE tenant_id = ?1 AND installation_role = 'coder'`,
            args: [tenantId, now + 1],
          });
        }
        return await client.batch(statements, mode);
      },
    };
    const service = createCoworkerService({ client: guardedClient, now: () => now, runtime: runtimeSource() });
    const reviewed = await service.snapshot(userId);
    const configVersion = reviewed.tenant?.configVersion ?? 0;
    mutateBeforeBatch = true;

    await expect(
      service.activate(userId, {
        expectedConfigVersion: configVersion,
        expectedBasisFingerprint: reviewed.configurationRevision?.basisFingerprint ?? "",
        operationIdentity: "activation-race",
      }),
    ).rejects.toMatchObject({ code: "stale_revision" });
    expect(
      await client.execute({ sql: "SELECT config_json, status FROM tenant WHERE id = ?1", args: [tenantId] }),
    ).toMatchObject({ rows: [expect.objectContaining({ config_json: "{}", status: "onboarding" })] });
    expect(
      await client.execute({
        sql: "SELECT count(*) AS count FROM control_operation WHERE tenant_id = ?1 AND kind = 'activate'",
        args: [tenantId],
      }),
    ).toMatchObject({ rows: [expect.objectContaining({ count: 0 })] });
  });

  test("rejects a changed GitHub basis even when its control-plane revision number is unchanged", async () => {
    const client = await migrate();
    const userId = await seedUser(client, "activation-fingerprint");
    const service = createCoworkerService({ client, now: () => now, runtime: runtimeSource() });
    const tenantId = await createReadyOnboarding(client, service, userId, "44");
    const reviewed = await service.snapshot(userId);
    await client.execute({
      sql: `UPDATE github_repository
               SET name = 'changed-after-review', updated_at_ms = ?2
             WHERE tenant_id = ?1 AND installation_role = 'planner'`,
      args: [tenantId, now + 1],
    });

    await expect(
      service.activate(userId, {
        expectedConfigVersion: reviewed.tenant?.configVersion ?? 0,
        expectedBasisFingerprint: reviewed.configurationRevision?.basisFingerprint ?? "",
        operationIdentity: "activation-fingerprint",
      }),
    ).rejects.toMatchObject({ code: "stale_revision" });
    expect(
      await client.execute({
        sql: "SELECT count(*) AS count FROM control_operation WHERE tenant_id = ?1 AND kind = 'activate'",
        args: [tenantId],
      }),
    ).toMatchObject({ rows: [expect.objectContaining({ count: 0 })] });
  });

  test("requires a live online WhatsApp phase for activation", async () => {
    const client = await migrate();
    const userId = await seedUser(client, "activation-health");
    const setupService = createCoworkerService({ client, now: () => now, runtime: runtimeSource() });
    await createReadyOnboarding(client, setupService, userId, "42");
    const service = createCoworkerService({
      client,
      now: () => now,
      runtime: {
        ...runtimeSource(),
        health: async () => ({
          ok: true,
          runtimeId: "runtime-test",
          runtime: { state: "healthy", whatsapp: { phase: "failed" } },
        }),
      },
    });
    const reviewed = await service.snapshot(userId);
    const configVersion = reviewed.tenant?.configVersion ?? 0;
    await expect(
      service.activate(userId, {
        expectedConfigVersion: configVersion,
        expectedBasisFingerprint: reviewed.configurationRevision?.basisFingerprint ?? "",
        operationIdentity: "activation-health",
      }),
    ).rejects.toMatchObject({ code: "runtime_unhealthy" });
  });

  test("settles activation and enters Operate only after the provisioner observes the applied revision", async () => {
    const client = await migrate();
    const userId = await seedUser(client, "activation-lifecycle");
    const setupService = createCoworkerService({ client, now: () => now, runtime: runtimeSource() });
    const tenantId = await createReadyOnboarding(client, setupService, userId, "43");
    const reconcileTenant = vi.fn(async (reconciledTenantId: string) => {
      await client.execute({
        sql: `UPDATE agent_instance
                 SET observed_state = 'healthy', observed_at_ms = ?2,
                     applied_config_version = (SELECT config_version FROM tenant WHERE id = ?1)
               WHERE tenant_id = ?1`,
        args: [reconciledTenantId, now],
      });
      return { status: "running" as const };
    });
    const service = createCoworkerService({
      client,
      now: () => now,
      runtime: runtimeSource(),
      lifecycle: { reconcileTenant },
    });
    const reviewed = await service.snapshot(userId);
    const configVersion = reviewed.tenant?.configVersion ?? 0;

    const operation = await service.activate(userId, {
      expectedConfigVersion: configVersion,
      expectedBasisFingerprint: reviewed.configurationRevision?.basisFingerprint ?? "",
      operationIdentity: "activation-lifecycle",
    });
    expect(operation.status).toBe("succeeded");
    expect(reconcileTenant).toHaveBeenCalledWith(tenantId);
    expect(await service.snapshot(userId)).toMatchObject({
      nextAction: "operate",
      tenant: { status: "active" },
    });
  });

  test("rebuilds and applies an active GitHub configuration through one revision-bound restart receipt", async () => {
    const client = await migrate();
    const userId = await seedUser(client, "github-repair");
    const setupService = createCoworkerService({ client, now: () => now, runtime: runtimeSource() });
    const tenantId = await createReadyOnboarding(client, setupService, userId, "45");
    const initialVersion = (await setupService.snapshot(userId)).tenant?.configVersion ?? 0;
    await client.execute({
      sql: "UPDATE tenant SET status = 'active', desired_state = 'running' WHERE id = ?1",
      args: [tenantId],
    });
    await client.execute({
      sql: `UPDATE agent_instance
               SET desired_mode = 'operate', phase = 'running', applied_config_version = ?2
             WHERE tenant_id = ?1`,
      args: [tenantId, initialVersion],
    });
    const reconcileTenant = vi.fn(async (reconciledTenantId: string) => {
      await client.execute({
        sql: `UPDATE agent_instance
                 SET observed_state = 'healthy', observed_at_ms = ?2,
                     applied_config_version = (SELECT config_version FROM tenant WHERE id = ?1)
               WHERE tenant_id = ?1`,
        args: [reconciledTenantId, now],
      });
      return { status: "running" as const };
    });
    const service = createCoworkerService({
      client,
      now: () => now,
      runtime: runtimeSource(),
      lifecycle: { reconcileTenant },
    });
    const staleReview = await service.snapshot(userId);
    await client.execute({
      sql: `UPDATE github_repository
               SET name = 'repaired-planner', updated_at_ms = ?2
             WHERE tenant_id = ?1 AND installation_role = 'planner'`,
      args: [tenantId, now + 1],
    });
    await expect(
      service.applyGitHubConfiguration(userId, {
        expectedConfigVersion: staleReview.configurationRevision?.configVersion ?? 0,
        expectedBasisFingerprint: staleReview.configurationRevision?.basisFingerprint ?? "",
        operationIdentity: "github-stale-review",
      }),
    ).rejects.toMatchObject({ code: "stale_revision" });

    const reviewed = await service.snapshot(userId);
    const operation = await service.applyGitHubConfiguration(userId, {
      expectedConfigVersion: reviewed.configurationRevision?.configVersion ?? 0,
      expectedBasisFingerprint: reviewed.configurationRevision?.basisFingerprint ?? "",
      operationIdentity: "github-current-review",
    });
    expect(operation).toMatchObject({
      kind: "restart",
      status: "succeeded",
      targetConfigVersion: initialVersion + 1,
    });
    expect(
      JSON.parse(
        String(
          (await client.execute({ sql: "SELECT config_json FROM tenant WHERE id = ?1", args: [tenantId] })).rows[0]
            ?.config_json,
        ),
      ),
    ).toMatchObject({
      github: {
        defaultRepository: "org-45/repaired-planner",
        allowedRepositories: ["org-45/repaired-planner"],
      },
    });
    await expect(
      service.applyGitHubConfiguration(userId, {
        expectedConfigVersion: reviewed.configurationRevision?.configVersion ?? 0,
        expectedBasisFingerprint: reviewed.configurationRevision?.basisFingerprint ?? "",
        operationIdentity: "github-current-review",
      }),
    ).resolves.toMatchObject({ id: operation.id, status: "succeeded" });
    expect(
      await client.execute({
        sql: "SELECT count(*) AS count FROM control_operation WHERE tenant_id = ?1 AND kind = 'restart'",
        args: [tenantId],
      }),
    ).toMatchObject({ rows: [expect.objectContaining({ count: 1 })] });
  });

  test("keeps Managed Chat changes onboarding-only and serializes same-kind operations", async () => {
    const client = await migrate();
    const userId = await seedUser(client, "active-guards");
    const service = createCoworkerService({ client, now: () => now, runtime: runtimeSource() });
    const created = await service.create(userId, { displayName: "Active", operationIdentity: "create-active" });
    await client.execute({ sql: "UPDATE tenant SET status = 'active' WHERE user_id = ?1", args: [userId] });
    await client.execute({
      sql: `UPDATE control_operation
               SET status = 'succeeded', settled_at_ms = ?2, updated_at_ms = ?2
             WHERE tenant_id = ?1 AND kind = 'provision_setup'`,
      args: [created.tenant?.id ?? "", now],
    });

    await expect(service.selectManagedChats(userId, { jids: ["family@g.us"] })).rejects.toMatchObject({
      code: "incomplete_capabilities",
    });
    const restarts = await Promise.allSettled([
      service.restartRuntime(userId, { operationIdentity: "restart-a" }),
      service.restartRuntime(userId, { operationIdentity: "restart-b" }),
    ]);
    expect(restarts.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(restarts.filter(({ status }) => status === "rejected")).toHaveLength(1);
    expect(
      await client.execute({
        sql: "SELECT count(*) AS count FROM control_operation WHERE tenant_id = ?1 AND kind = 'restart'",
        args: [created.tenant?.id ?? ""],
      }),
    ).toMatchObject({ rows: [expect.objectContaining({ count: 1 })] });
    await expect(
      service.beginWhatsappRepair(userId, { operationIdentity: "repair-while-restarting" }),
    ).rejects.toMatchObject({ code: "operation_identity_conflict" });
  });

  test("reconciles an uncertain named operation without issuing a replacement mutation", async () => {
    const client = await migrate();
    const userId = await seedUser(client, "uncertain-reconcile");
    const created = await createCoworkerService({ client, now: () => now }).create(userId, {
      displayName: "Uncertain",
      operationIdentity: "create-uncertain",
    });
    await client.execute({ sql: "UPDATE tenant SET status = 'active' WHERE user_id = ?1", args: [userId] });
    await client.execute({
      sql: `UPDATE control_operation
               SET status = 'succeeded', settled_at_ms = ?2, updated_at_ms = ?2
             WHERE tenant_id = ?1 AND kind = 'provision_setup'`,
      args: [created.tenant?.id ?? "", now],
    });
    const reconcileTenant = vi.fn(async () => ({ status: "running" as const }));
    const service = createCoworkerService({ client, now: () => now, lifecycle: { reconcileTenant } });
    const operation = await service.restartRuntime(userId, { operationIdentity: "restart-uncertain" });
    await client.execute({
      sql: `UPDATE control_operation
               SET status = 'uncertain', error_code = 'response_lost', settled_at_ms = ?2, updated_at_ms = ?2
             WHERE id = ?1`,
      args: [operation.id, now],
    });

    await expect(service.reconcileOperation(userId, { operationId: operation.id })).resolves.toMatchObject({
      id: operation.id,
      operationIdentity: "restart-uncertain",
      status: "succeeded",
    });
    expect(reconcileTenant).toHaveBeenCalledTimes(2);
    expect(
      await client.execute({
        sql: "SELECT count(*) AS count FROM control_operation WHERE tenant_id = ?1 AND kind = 'restart'",
        args: [created.tenant?.id ?? ""],
      }),
    ).toMatchObject({ rows: [expect.objectContaining({ count: 1 })] });
  });

  test("keeps tenant reads and mutations isolated to the authenticated owner", async () => {
    const client = await migrate();
    const ownerId = await seedUser(client, "owner");
    const attackerId = await seedUser(client, "attacker");
    const service = createCoworkerService({ client, now: () => now, runtime: runtimeSource() });
    const created = await service.create(ownerId, { displayName: "Owner", operationIdentity: "create-owner" });

    expect((await service.snapshot(attackerId)).tenant).toBeNull();
    await expect(service.restartRuntime(attackerId, { operationIdentity: "restart-owner" })).rejects.toMatchObject({
      code: "tenant_not_found",
    });
    expect((await service.snapshot(ownerId)).tenant?.id).toBe(created.tenant?.id);
  });

  test("degrades stale observations and never rewinds an active coworker into onboarding", async () => {
    const client = await migrate();
    const userId = await seedUser(client, "stale");
    const service = createCoworkerService({ client, now: () => now, staleAfterMs: 60_000, runtime: runtimeSource() });
    await service.create(userId, { displayName: "Stale", operationIdentity: "create-stale" });
    await client.execute({
      sql: `UPDATE tenant SET status = 'active', desired_state = 'running' WHERE user_id = ?1`,
      args: [userId],
    });
    await client.execute({
      sql: `UPDATE agent_instance
               SET desired_mode = 'operate', observed_state = 'healthy', observed_at_ms = ?2,
                   runtime_base_url = 'https://stale.runtime.test'
             WHERE tenant_id = (SELECT id FROM tenant WHERE user_id = ?1)`,
      args: [userId, now - 60_001],
    });

    const snapshot = await service.snapshot(userId);
    expect(snapshot).toMatchObject({ nextAction: "operate", readiness: "degraded" });
    expect(snapshot.capabilities.workspace).toMatchObject({ state: "degraded", stale: true });
  });

  test("preserves Managed Chats and Operate routing when a WhatsApp repair becomes uncertain", async () => {
    const client = await migrate();
    const userId = await seedUser(client, "repair");
    const service = createCoworkerService({ client, now: () => now, runtime: runtimeSource() });
    const tenantId = await createReadyOnboarding(client, service, userId, "52");
    const configVersion = (await service.snapshot(userId)).tenant?.configVersion ?? 0;
    await client.execute({
      sql: "UPDATE tenant SET status = 'active', desired_state = 'running' WHERE id = ?1",
      args: [tenantId],
    });
    await client.execute({
      sql: `UPDATE agent_instance
               SET desired_mode = 'operate', applied_config_version = ?2, phase = 'running'
             WHERE tenant_id = ?1`,
      args: [tenantId, configVersion],
    });

    const operation = await service.beginWhatsappRepair(userId, { operationIdentity: "repair-uncertain" });
    expect(await service.snapshot(userId)).toMatchObject({
      nextAction: "operate",
      capabilities: { whatsapp: { state: "repairing" }, chats: { state: "healthy" } },
    });
    await client.execute({
      sql: `UPDATE control_operation
               SET status = 'uncertain', error_code = 'repair_outcome_unknown',
                   settled_at_ms = ?2, updated_at_ms = ?2
             WHERE id = ?1`,
      args: [operation.id, now],
    });
    await client.execute({
      sql: "UPDATE whatsapp_connection SET status = 're_pair_required' WHERE tenant_id = ?1",
      args: [tenantId],
    });
    await expect(
      service.beginWhatsappRepair(userId, { operationIdentity: "repair-before-reconcile" }),
    ).rejects.toMatchObject({ code: "operation_identity_conflict" });

    const uncertain = await service.snapshot(userId);
    expect(uncertain).toMatchObject({
      nextAction: "operate",
      readiness: "degraded",
      capabilities: { whatsapp: { state: "uncertain" }, chats: { state: "healthy" } },
    });
    expect(uncertain.managedChats).toEqual([
      expect.objectContaining({ jid: "family@g.us", displayName: "Family", kind: "group" }),
    ]);
  });

  test("reuses the same provisioned runtime for re-pair and resumes Operate after auth is observed", async () => {
    const client = await migrate();
    const userId = await seedUser(client, "repair-resume");
    const setupService = createCoworkerService({ client, now: () => now, runtime: runtimeSource() });
    const tenantId = await createReadyOnboarding(client, setupService, userId, "53");
    const initialVersion = (await setupService.snapshot(userId)).tenant?.configVersion ?? 0;
    await client.execute({ sql: "UPDATE tenant SET status = 'active' WHERE id = ?1", args: [tenantId] });
    await client.execute({
      sql: `UPDATE agent_instance
               SET desired_mode = 'operate', applied_config_version = ?2, phase = 'running'
             WHERE tenant_id = ?1`,
      args: [tenantId, initialVersion],
    });
    const reconcileTenant = vi.fn(async (reconciledTenantId: string) => {
      await client.execute({
        sql: `UPDATE agent_instance
                 SET observed_state = 'healthy', observed_at_ms = ?2,
                     applied_config_version = (SELECT config_version FROM tenant WHERE id = ?1)
               WHERE tenant_id = ?1`,
        args: [reconciledTenantId, now],
      });
      return { status: "running" as const };
    });
    const service = createCoworkerService({
      client,
      now: () => now,
      runtime: runtimeSource(),
      lifecycle: { reconcileTenant },
    });

    const operation = await service.beginWhatsappRepair(userId, { operationIdentity: "repair-resume" });
    expect(operation.status).toBe("pending");
    expect((await service.snapshot(userId)).managedChats).toHaveLength(1);
    await expect(service.pairing(userId)).resolves.toEqual({
      status: "paired",
      accountJid: "account@s.whatsapp.net",
    });

    expect(await service.reconcileOperation(userId, { operationId: operation.id })).toMatchObject({
      status: "succeeded",
    });
    expect(await service.snapshot(userId)).toMatchObject({
      nextAction: "operate",
      tenant: { configVersion: initialVersion + 2 },
      capabilities: { chats: { state: "healthy" }, whatsapp: { state: "healthy" } },
    });
    expect(reconcileTenant).toHaveBeenCalledTimes(2);
  });

  test("projects billing suspension and recovery without deleting tenant state", async () => {
    const client = await migrate();
    const userId = await seedUser(client, "billing");
    const reconciledStates: string[] = [];
    const reconcileTenant = vi.fn(async (tenantId: string) => {
      const target = await client.execute({
        sql: `SELECT tenant.desired_state, agent_instance.desired_mode
                FROM tenant JOIN agent_instance ON agent_instance.tenant_id = tenant.id
               WHERE tenant.id = ?1`,
        args: [tenantId],
      });
      const status =
        target.rows[0]?.desired_state === "stopped" || target.rows[0]?.desired_mode === "stopped"
          ? ("stopped" as const)
          : ("running" as const);
      reconciledStates.push(status);
      return { status };
    });
    const service = createCoworkerService({
      client,
      now: () => now,
      runtime: runtimeSource(),
      lifecycle: { reconcileTenant },
    });
    const created = await service.create(userId, { displayName: "Billing", operationIdentity: "create-billing" });
    await client.execute({
      sql: `UPDATE tenant SET status = 'active', desired_state = 'running' WHERE user_id = ?1`,
      args: [userId],
    });
    await client.execute({
      sql: "UPDATE subscription_entitlement SET status = 'canceled' WHERE user_id = ?1",
      args: [userId],
    });
    await client.execute({
      sql: "UPDATE tenant SET desired_state = 'stopped' WHERE user_id = ?1",
      args: [userId],
    });
    await client.execute({
      sql: `UPDATE agent_instance
               SET desired_mode = 'stopped'
             WHERE tenant_id = (SELECT id FROM tenant WHERE user_id = ?1)`,
      args: [userId],
    });
    expect(await service.snapshot(userId)).toMatchObject({ nextAction: "operate", readiness: "suspended" });
    await service.refresh(userId);
    expect(reconciledStates.at(-1)).toBe("stopped");
    await expect(service.restartRuntime(userId, { operationIdentity: "restart-canceled" })).rejects.toMatchObject({
      code: "entitlement_required",
    });

    await client.execute({
      sql: "UPDATE subscription_entitlement SET status = 'active' WHERE user_id = ?1",
      args: [userId],
    });
    await service.refresh(userId);
    expect(reconciledStates.at(-1)).toBe("running");
    expect((await service.snapshot(userId)).tenant?.id).toBe(created.tenant?.id);
    expect((await service.snapshot(userId)).nextAction).toBe("operate");
    expect(
      await client.execute({
        sql: `SELECT tenant.desired_state, agent_instance.desired_mode
                FROM tenant JOIN agent_instance ON agent_instance.tenant_id = tenant.id
               WHERE tenant.id = ?1`,
        args: [created.tenant?.id ?? ""],
      }),
    ).toMatchObject({ rows: [expect.objectContaining({ desired_state: "running", desired_mode: "operate" })] });
  });

  test("restores the operate profile for an activation interrupted by billing suspension", async () => {
    const client = await migrate();
    const userId = await seedUser(client, "billing-activation");
    const service = createCoworkerService({
      client,
      now: () => now,
      runtime: runtimeSource(),
      lifecycle: { reconcileTenant: async () => ({ status: "lease_busy" }) },
    });
    const tenantId = await createReadyOnboarding(client, service, userId, "51");
    const revision = (await service.snapshot(userId)).configurationRevision;
    if (!revision) throw new Error("activation revision was not projected");
    await service.activate(userId, {
      expectedConfigVersion: revision.configVersion,
      expectedBasisFingerprint: revision.basisFingerprint,
      operationIdentity: "billing-activation",
    });
    await client.batch(
      [
        {
          sql: "UPDATE subscription_entitlement SET status = 'canceled' WHERE user_id = ?1",
          args: [userId],
        },
        { sql: "UPDATE tenant SET desired_state = 'stopped' WHERE id = ?1", args: [tenantId] },
        { sql: "UPDATE agent_instance SET desired_mode = 'stopped' WHERE tenant_id = ?1", args: [tenantId] },
      ],
      "write",
    );
    await client.execute({
      sql: "UPDATE subscription_entitlement SET status = 'active' WHERE user_id = ?1",
      args: [userId],
    });

    await service.refresh(userId);

    expect(
      await client.execute({
        sql: "SELECT desired_mode FROM agent_instance WHERE tenant_id = ?1",
        args: [tenantId],
      }),
    ).toMatchObject({ rows: [expect.objectContaining({ desired_mode: "operate" })] });
  });

  test("restores the setup profile for a WhatsApp repair interrupted by billing suspension", async () => {
    const client = await migrate();
    const userId = await seedUser(client, "billing-repair");
    const service = createCoworkerService({
      client,
      now: () => now,
      runtime: runtimeSource(),
      lifecycle: { reconcileTenant: async () => ({ status: "lease_busy" }) },
    });
    const tenantId = await createReadyOnboarding(client, service, userId, "52");
    await client.execute({
      sql: "UPDATE tenant SET status = 'active' WHERE id = ?1",
      args: [tenantId],
    });
    await service.beginWhatsappRepair(userId, { operationIdentity: "billing-repair" });
    await client.batch(
      [
        {
          sql: "UPDATE subscription_entitlement SET status = 'canceled' WHERE user_id = ?1",
          args: [userId],
        },
        { sql: "UPDATE tenant SET desired_state = 'stopped' WHERE id = ?1", args: [tenantId] },
        { sql: "UPDATE agent_instance SET desired_mode = 'stopped' WHERE tenant_id = ?1", args: [tenantId] },
      ],
      "write",
    );
    await client.execute({
      sql: "UPDATE subscription_entitlement SET status = 'active' WHERE user_id = ?1",
      args: [userId],
    });

    await service.refresh(userId);

    expect(
      await client.execute({
        sql: "SELECT desired_mode FROM agent_instance WHERE tenant_id = ?1",
        args: [tenantId],
      }),
    ).toMatchObject({ rows: [expect.objectContaining({ desired_mode: "setup" })] });
  });
});
