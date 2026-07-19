import { describe, expect, it, vi } from "vite-plus/test";

import { tenantBridge, TenantBridgeError } from "../../apps/api/src/tenant-bridge.ts";
import { BRIDGE_AUTH_HEADER } from "../../packages/installation/src/bridge-contract.ts";
import { runtimeBridgeAuthorization } from "../../packages/installation/src/runtime-health.ts";

const SECRET = "private-webhook-secret";

describe("control-plane tenant bridge client", () => {
  it("polls health, pairing, and chats with the correct trust boundary and wire shapes", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json({
          ok: false,
          runtimeId: "runtime-id",
          runtime: { state: "starting", whatsapp: { phase: "pairing" } },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          status: "pairing",
          method: "pairing_code",
          code: "ABCD-EFGH",
          expiresAt: 60_000,
        }),
      )
      .mockResolvedValueOnce(
        Response.json([{ jid: "project@g.us", name: "Project", kind: "group", lastActivityAt: 3_000 }]),
      );
    const bridge = tenantBridge({
      baseUrl: "http://tenant.internal/",
      webhookSecret: SECRET,
      fetch,
    });

    await expect(bridge.health()).resolves.toEqual({
      ok: false,
      runtimeId: "runtime-id",
      runtime: { state: "starting", whatsapp: { phase: "pairing" } },
    });
    await expect(bridge.pairing()).resolves.toEqual({
      status: "pairing",
      method: "pairing_code",
      code: "ABCD-EFGH",
      expiresAt: 60_000,
    });
    await expect(bridge.chats()).resolves.toEqual([
      { jid: "project@g.us", name: "Project", kind: "group", lastActivityAt: 3_000 },
    ]);

    expect(fetch).toHaveBeenNthCalledWith(1, "http://tenant.internal/health");
    expect(fetch).toHaveBeenNthCalledWith(2, "http://tenant.internal/pairing", {
      headers: { [BRIDGE_AUTH_HEADER]: runtimeBridgeAuthorization(SECRET, "pairing-read") },
    });
    expect(fetch).toHaveBeenNthCalledWith(3, "http://tenant.internal/chats", {
      headers: { [BRIDGE_AUTH_HEADER]: runtimeBridgeAuthorization(SECRET, "chats-read") },
    });
  });

  it("rejects non-success responses instead of casting an error payload as bridge data", async () => {
    const bridge = tenantBridge({
      baseUrl: "http://tenant.internal",
      webhookSecret: SECRET,
      fetch: async () => Response.json({ error: "WhatsApp runtime is not started" }, { status: 503 }),
    });

    const rejection = bridge.chats().catch((cause: unknown) => cause);
    await expect(rejection).resolves.toBeInstanceOf(TenantBridgeError);
    await expect(rejection).resolves.toMatchObject({
      name: "TenantBridgeError",
      status: 503,
      message: "WhatsApp runtime is not started",
    });
  });

  it("rejects malformed success payloads at the control-plane boundary", async () => {
    const bridge = tenantBridge({
      baseUrl: "http://tenant.internal",
      webhookSecret: SECRET,
      fetch: async () => Response.json({ ok: true, runtimeId: 123, runtime: {} }),
    });

    await expect(bridge.health()).rejects.toMatchObject({
      name: "TenantBridgeError",
      status: 502,
      message: "Tenant bridge returned malformed health data",
    });
  });

  it("pushes a purpose-bound GitHub delivery and validates the runtime acknowledgement", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      Response.json({
        runtimeId: "runtime-1",
        githubAppId: "app-1",
        configVersion: 7,
        result: { status: "unsupported", deliveryId: "guid-1" },
      }),
    );
    const delivery = { githubAppId: "app-1", deliveryId: "guid-1", name: "issues", payload: { action: "opened" } };
    const bridge = tenantBridge({ baseUrl: "http://tenant.internal/", webhookSecret: SECRET, fetch });

    await expect(bridge.deliver(delivery)).resolves.toMatchObject({
      runtimeId: "runtime-1",
      githubAppId: "app-1",
      configVersion: 7,
      result: { status: "unsupported", deliveryId: "guid-1" },
    });
    expect(fetch).toHaveBeenCalledWith("http://tenant.internal/deliveries", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [BRIDGE_AUTH_HEADER]: runtimeBridgeAuthorization(SECRET, "delivery-push"),
      },
      body: JSON.stringify(delivery),
      signal: expect.any(AbortSignal),
    });
  });

  it("aborts a hung tenant delivery request at the bridge boundary", async () => {
    const bridge = tenantBridge({
      baseUrl: "http://tenant.internal",
      webhookSecret: SECRET,
      deliveryTimeoutMillis: 1,
      fetch: async (_input, init) =>
        await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        }),
    });

    await expect(
      bridge.deliver({ githubAppId: "app-1", deliveryId: "guid-hung", name: "issues", payload: {} }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
  });
});
