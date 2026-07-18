import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { RPCHandler } from "@orpc/server/fetch";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createAppRouter } from "../../packages/api/src/routers/index";
import { entitlementSnapshot } from "../../packages/auth/src/subscription-entitlement";
import type { SubscriptionLifecycleEvent } from "../../packages/auth/src/subscription-entitlement";

const users = [
  "replay-user",
  "trial-user",
  "cancel-user",
  "resume-user",
  "onboarding-user",
  "repair-user",
  "suspended-user",
  "archived-user",
  "confirming-user",
  "signed-user",
];
const scratch = mkdtempSync(join(tmpdir(), "ambient-entitlement-"));
const databasePath = join(scratch, "control.db");

let authPackage: typeof import("../../packages/auth/src/index");

const event = (
  userId: string,
  type: SubscriptionLifecycleEvent["type"],
  subscriptionStatus: string,
  occurredAt: string,
  overrides: Partial<SubscriptionLifecycleEvent> = {},
): SubscriptionLifecycleEvent => ({
  type,
  occurredAt: new Date(occurredAt),
  userId,
  polarCustomerId: `customer-${userId}`,
  polarSubscriptionId: `subscription-${userId}`,
  subscriptionStatus,
  cancelAtPeriodEnd: false,
  ...overrides,
});

const runtime = (tenantId: string) => {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  const row = database
    .prepare(`SELECT
      agent_instance.desired_mode,
      agent_instance.creds_store_key,
      tenant.status,
      tenant.desired_state,
      tenant.tenant_db_token_ciphertext
    FROM agent_instance
    JOIN tenant ON tenant.id = agent_instance.tenant_id
    WHERE agent_instance.tenant_id = ?`)
    .get(tenantId);
  database.close();
  return row;
};

beforeAll(async () => {
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA foreign_keys = ON");
  const migrationDirectory = join(process.cwd(), "packages/db/src/migrations");
  const migrationFile = readdirSync(migrationDirectory).find((file) => file.endsWith(".sql"));
  if (!migrationFile) throw new Error("control-plane migration is missing");
  const migration = readFileSync(join(migrationDirectory, migrationFile), "utf8").replaceAll(
    "--> statement-breakpoint",
    "",
  );
  database.exec(migration);
  database.exec(`
    ${users
      .map(
        (userId) =>
          `INSERT INTO user (id, name, email, email_verified, created_at, updated_at)
            VALUES ('${userId}', '${userId}', '${userId}@example.com', 1, 0, 0);`,
      )
      .join("\n")}
    ${["cancel", "resume", "onboarding", "repair", "suspended", "archived"]
      .map(
        (name) =>
          `INSERT INTO subscription_entitlement (id, user_id, status, updated_at_ms)
            VALUES ('entitlement-${name}', '${name}-user', 'inactive', 0);`,
      )
      .join("\n")}
    INSERT INTO tenant (
      id, user_id, subscription_entitlement_id, display_name, status,
      tenant_db_name, tenant_db_url, tenant_db_token_ciphertext, desired_state, updated_at_ms
    ) VALUES
      ('tenant-cancel', 'cancel-user', 'entitlement-cancel', 'Cancel', 'active',
        'db-cancel', 'libsql://tenant-cancel', 'cipher-cancel', 'running', 0),
      ('tenant-resume', 'resume-user', 'entitlement-resume', 'Resume', 'active',
        'db-resume', 'libsql://tenant-resume', 'cipher-resume', 'running', 0),
      ('tenant-onboarding', 'onboarding-user', 'entitlement-onboarding', 'Onboarding', 'onboarding',
        'db-onboarding', 'libsql://tenant-onboarding', 'cipher-onboarding', 'stopped', 0),
      ('tenant-repair', 'repair-user', 'entitlement-repair', 'Repair', 'active',
        'db-repair', 'libsql://tenant-repair', 'cipher-repair', 'running', 0),
      ('tenant-suspended', 'suspended-user', 'entitlement-suspended', 'Suspended', 'suspended',
        'db-suspended', 'libsql://tenant-suspended', 'cipher-suspended', 'stopped', 0),
      ('tenant-archived', 'archived-user', 'entitlement-archived', 'Archived', 'archived',
        'db-archived', 'libsql://tenant-archived', 'cipher-archived', 'deleted', 0);
    INSERT INTO agent_instance (
      id, tenant_id, creds_store_key, desired_mode, dokploy_display_name,
      dokploy_creation_token, updated_at_ms
    ) VALUES
      ('instance-cancel', 'tenant-cancel', 'db-cancel', 'operate', 'cancel', 'token-cancel', 0),
      ('instance-resume', 'tenant-resume', 'db-resume', 'operate', 'resume', 'token-resume', 0),
      ('instance-onboarding', 'tenant-onboarding', 'db-onboarding', 'stopped', 'onboarding', 'token-onboarding', 0),
      ('instance-repair', 'tenant-repair', 'db-repair', 'setup', 'repair', 'token-repair', 0),
      ('instance-suspended', 'tenant-suspended', 'db-suspended', 'setup', 'suspended', 'token-suspended', 0),
      ('instance-archived', 'tenant-archived', 'db-archived', 'stopped', 'archived', 'token-archived', 0);
  `);
  database.close();

  Object.assign(process.env, {
    NODE_ENV: "test",
    DATABASE_URL: `file:${databasePath}`,
    DATABASE_AUTH_TOKEN: "test-token",
    BETTER_AUTH_SECRET: "test-secret-that-is-at-least-32-characters",
    BETTER_AUTH_URL: "http://localhost:3000/api/auth",
    POLAR_ACCESS_TOKEN: "polar-test-token",
    POLAR_SUCCESS_URL: "http://localhost:3001/success",
    POLAR_WEBHOOK_SECRET: "polar-webhook-test-secret",
    CORS_ORIGIN: "http://localhost:3001",
  });
  authPackage = await import("../../packages/auth/src/index");
}, 30_000);

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe.sequential("subscription entitlement projection", () => {
  it("ignores duplicate and out-of-order lifecycle events", async () => {
    const active = event("replay-user", "subscription.active", "active", "2026-07-18T12:00:00.000Z");
    await authPackage.subscriptionEntitlements.reduce(active);
    await authPackage.subscriptionEntitlements.reduce(active);
    await authPackage.subscriptionEntitlements.reduce(
      event("replay-user", "subscription.past_due", "past_due", "2026-07-18T11:00:00.000Z"),
    );

    const projection = await authPackage.subscriptionEntitlements.get("replay-user");
    expect(projection).toMatchObject({ status: "active" });
    expect(projection?.lastEventId).toContain("subscription.active");
  });

  it("settles equal-time distinct events in a deterministic fail-closed order", async () => {
    const occurredAt = "2026-07-18T12:30:00.000Z";
    await authPackage.subscriptionEntitlements.reduce(
      event("replay-user", "subscription.revoked", "canceled", occurredAt),
    );
    await authPackage.subscriptionEntitlements.reduce(
      event("replay-user", "subscription.active", "active", occurredAt),
    );

    expect(await authPackage.subscriptionEntitlements.get("replay-user")).toMatchObject({ status: "canceled" });
  });

  it("grants active and trialing subscriptions", async () => {
    await authPackage.subscriptionEntitlements.reduce(
      event("trial-user", "subscription.created", "trialing", "2026-07-18T12:00:00.000Z"),
    );
    expect(await authPackage.subscriptionEntitlements.get("trial-user")).toMatchObject({ status: "trialing" });
  });

  it("keeps end-of-period cancellation entitled until revocation", async () => {
    await authPackage.subscriptionEntitlements.reduce(
      event("cancel-user", "subscription.canceled", "active", "2026-07-18T12:00:00.000Z", {
        cancelAtPeriodEnd: true,
      }),
    );
    expect(await authPackage.subscriptionEntitlements.get("cancel-user")).toMatchObject({ status: "active" });

    const revoked = await authPackage.subscriptionEntitlements.reduce(
      event("cancel-user", "subscription.revoked", "canceled", "2026-08-18T00:00:00.000Z"),
    );
    expect(entitlementSnapshot(revoked)).toMatchObject({
      status: "canceled",
      entitled: false,
      runtimeStopRequested: true,
    });
    expect(runtime("tenant-cancel")).toEqual({
      desired_mode: "stopped",
      creds_store_key: "db-cancel",
      status: "active",
      desired_state: "stopped",
      tenant_db_token_ciphertext: "cipher-cancel",
    });
  });

  it("restores entitlement without starting a runtime stopped by billing", async () => {
    await authPackage.subscriptionEntitlements.reduce(
      event("resume-user", "subscription.updated", "past_due", "2026-07-18T13:00:00.000Z"),
    );
    expect(entitlementSnapshot(await authPackage.subscriptionEntitlements.get("resume-user"))).toMatchObject({
      status: "past_due",
      entitled: false,
      runtimeStopRequested: true,
    });
    expect(runtime("tenant-resume")).toMatchObject({
      desired_mode: "stopped",
      status: "active",
      desired_state: "stopped",
    });

    const resumed = await authPackage.subscriptionEntitlements.reduce(
      event("resume-user", "subscription.uncanceled", "active", "2026-07-18T14:00:00.000Z"),
    );
    expect(entitlementSnapshot(resumed)).toMatchObject({
      status: "active",
      entitled: true,
      runtimeStopRequested: false,
    });
    expect(runtime("tenant-resume")).toMatchObject({
      desired_mode: "stopped",
      status: "active",
      desired_state: "stopped",
    });
  });

  it("does not bypass explicit activation when an onboarding tenant becomes entitled", async () => {
    await authPackage.subscriptionEntitlements.reduce(
      event("onboarding-user", "subscription.active", "active", "2026-07-18T15:00:00.000Z"),
    );
    expect(runtime("tenant-onboarding")).toMatchObject({ desired_mode: "stopped", status: "onboarding" });
  });

  it("does not overwrite an active tenant's temporary setup repair mode", async () => {
    await authPackage.subscriptionEntitlements.reduce(
      event("repair-user", "subscription.active", "active", "2026-07-18T15:30:00.000Z"),
    );
    expect(runtime("tenant-repair")).toMatchObject({ desired_mode: "setup", status: "active" });
  });

  it("does not treat a non-billing suspension as authority to start setup", async () => {
    await authPackage.subscriptionEntitlements.reduce(
      event("suspended-user", "subscription.active", "active", "2026-07-18T15:45:00.000Z"),
    );
    expect(runtime("tenant-suspended")).toMatchObject({
      desired_mode: "setup",
      status: "suspended",
      desired_state: "stopped",
    });
  });

  it("does not overwrite an archived tenant's terminal deletion intent", async () => {
    await authPackage.subscriptionEntitlements.reduce(
      event("archived-user", "subscription.revoked", "canceled", "2026-07-18T16:00:00.000Z"),
    );
    expect(runtime("tenant-archived")).toMatchObject({
      desired_mode: "stopped",
      status: "archived",
      desired_state: "deleted",
      tenant_db_token_ciphertext: "cipher-archived",
    });
  });

  it("shows confirming when Polar is active before the signed projection arrives", () => {
    expect(entitlementSnapshot(null, true)).toEqual({
      status: "confirming",
      entitled: false,
      runtimeStopRequested: true,
      lastEventId: null,
    });
  });
});

describe("billing API authorization", () => {
  it("rejects an unauthenticated entitlement read before invoking billing state", async () => {
    let reads = 0;
    const router = createAppRouter({
      getEntitlementSnapshot: async () => {
        reads += 1;
        return entitlementSnapshot(null);
      },
    });
    const handler = new RPCHandler(router);
    const result = await handler.handle(new Request("http://localhost/rpc/billing/entitlement", { method: "POST" }), {
      prefix: "/rpc",
      context: { auth: null, session: null },
    });

    expect(result.matched).toBe(true);
    if (!result.matched) throw new Error("billing entitlement procedure did not match");
    expect(result.response.status).toBe(401);
    expect(reads).toBe(0);
  });

  it("returns confirming through the protected API while the signed projection is delayed", async () => {
    const { polarClient } = await import("../../packages/auth/src/lib/payments");
    const providerState = vi
      .spyOn(polarClient.customers, "getStateExternal")
      .mockResolvedValue({ activeSubscriptions: [{}] } as never);

    try {
      const handler = new RPCHandler(createAppRouter({ getEntitlementSnapshot: authPackage.getEntitlementSnapshot }));
      const result = await handler.handle(new Request("http://localhost/rpc/billing/entitlement", { method: "POST" }), {
        prefix: "/rpc",
        context: {
          auth: null,
          session: { user: { id: "confirming-user" } } as never,
        },
      });

      expect(result.matched).toBe(true);
      if (!result.matched) throw new Error("billing entitlement procedure did not match");
      expect(result.response.status).toBe(200);
      expect(await result.response.text()).toContain('"confirming"');
      expect(providerState).toHaveBeenCalledWith({ externalId: "confirming-user" });
    } finally {
      providerState.mockRestore();
    }
  });

  it("rejects an unsigned webhook and accepts the same lifecycle event when signed", async () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const payload = subscriptionPayload("signed-user", "active");
    const body = JSON.stringify(payload);
    const unsigned = await authPackage.auth.handler(
      new Request("http://localhost:3000/api/auth/polar/webhooks", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "webhook-id": "unsigned-event",
          "webhook-timestamp": String(timestamp),
          "webhook-signature": "v1,invalid",
        },
        body,
      }),
    );
    expect(unsigned.status).toBe(400);
    expect(await authPackage.subscriptionEntitlements.get("signed-user")).toBeNull();

    const webhookId = "signed-event";
    const signature = createHmac("sha256", process.env.POLAR_WEBHOOK_SECRET!)
      .update(`${webhookId}.${timestamp}.${body}`)
      .digest("base64");
    const signed = await authPackage.auth.handler(
      new Request("http://localhost:3000/api/auth/polar/webhooks", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "webhook-id": webhookId,
          "webhook-timestamp": String(timestamp),
          "webhook-signature": `v1,${signature}`,
        },
        body,
      }),
    );

    expect(signed.status).toBe(200);
    expect(await signed.json()).toEqual({ received: true });
    expect(await authPackage.subscriptionEntitlements.get("signed-user")).toMatchObject({ status: "active" });
  });
});

const subscriptionPayload = (userId: string, status: string) => {
  const now = new Date().toISOString();
  const periodEnd = new Date(Date.now() + 30 * 24 * 60 * 60 * 1_000).toISOString();
  return {
    type: "subscription.active",
    timestamp: now,
    data: {
      created_at: now,
      modified_at: now,
      id: `subscription-${userId}`,
      amount: 2_000,
      currency: "usd",
      recurring_interval: "month",
      recurring_interval_count: 1,
      status,
      current_period_start: now,
      current_period_end: periodEnd,
      trial_start: null,
      trial_end: null,
      cancel_at_period_end: false,
      canceled_at: null,
      started_at: now,
      ends_at: null,
      ended_at: null,
      customer_id: `customer-${userId}`,
      product_id: "product-pro",
      discount_id: null,
      checkout_id: "checkout-test",
      customer_cancellation_reason: null,
      customer_cancellation_comment: null,
      metadata: {},
      custom_field_data: {},
      customer: {
        id: `customer-${userId}`,
        created_at: now,
        modified_at: now,
        metadata: {},
        external_id: userId,
        email: `${userId}@example.com`,
        email_verified: true,
        type: "individual",
        name: "Test User",
        billing_address: null,
        tax_id: null,
        locale: "en",
        organization_id: "organization-test",
        deleted_at: null,
        avatar_url: "https://example.com/avatar.png",
      },
      product: {
        id: "product-pro",
        created_at: now,
        modified_at: now,
        trial_interval: null,
        trial_interval_count: null,
        name: "Pro",
        description: null,
        visibility: "public",
        recurring_interval: "month",
        recurring_interval_count: 1,
        is_recurring: true,
        is_archived: false,
        organization_id: "organization-test",
        metadata: {},
        prices: [],
        benefits: [],
        medias: [],
        attached_custom_fields: [],
      },
      discount: null,
      prices: [],
      meters: [],
      pending_update: null,
    },
  };
};
