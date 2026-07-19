import { Hono } from "hono";
import { describe, expect, it, vi } from "vite-plus/test";

import { installBridgeRoute, type BridgeRouteOptions } from "../../apps/runtime/src/host/bridge-route.ts";
import type { WhatsAppRuntimeControl } from "../../apps/runtime/src/host/whatsapp-runtime.ts";
import { BRIDGE_AUTH_HEADER } from "../../packages/installation/src/bridge-contract.ts";
import {
  runtimeBridgeAuthorization,
  type WhatsAppRuntimeStatus,
} from "../../packages/installation/src/runtime-health.ts";
import { WhatsAppAccountError } from "../../packages/installation/src/whatsapp-account.ts";

const SECRET = "private-webhook-secret";

const runtimeControl = (
  synchronizedChats: WhatsAppRuntimeControl["synchronizedChats"] = async () => [],
): WhatsAppRuntimeControl => ({
  smokeCanary: async () => ({
    chatId: "unused@g.us",
    text: "unused",
    stages: ["admission", "dispatch", "settled-silent"],
  }),
  synchronizedChats,
  stop: async () => undefined,
});

const request = async (app: Hono, path: "/pairing" | "/chats", purpose?: "pairing-read" | "chats-read") =>
  await app.request(path, {
    headers: purpose === undefined ? undefined : { [BRIDGE_AUTH_HEADER]: runtimeBridgeAuthorization(SECRET, purpose) },
  });

const appWith = (options: {
  readonly status: () => WhatsAppRuntimeStatus;
  readonly control?: () => WhatsAppRuntimeControl | undefined;
  readonly deliver?: BridgeRouteOptions["deliver"];
}): Hono => {
  const app = new Hono();
  installBridgeRoute(app, {
    runtimeId: "runtime-1",
    webhookSecret: SECRET,
    status: options.status,
    control: options.control ?? (() => runtimeControl()),
    ...(options.deliver === undefined ? {} : { deliver: options.deliver }),
  });
  return app;
};

describe("tenant runtime bridge", () => {
  it("prevents authenticated bridge polling responses from being cached", async () => {
    const available = appWith({ status: () => ({ phase: "pairing" }) });
    const unavailable = appWith({ status: () => ({ phase: "stopped" }), control: () => undefined });
    const responses = [
      await request(available, "/pairing"),
      await request(available, "/pairing", "pairing-read"),
      await request(available, "/chats"),
      await request(available, "/chats", "chats-read"),
      await request(unavailable, "/chats", "chats-read"),
    ];

    for (const response of responses) expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects missing, invalid, and cross-purpose authorization while allowing polling replays", async () => {
    const app = appWith({ status: () => ({ phase: "starting" }) });

    expect((await request(app, "/pairing")).status).toBe(403);
    expect((await app.request("/pairing", { headers: { [BRIDGE_AUTH_HEADER]: "wrong" } })).status).toBe(403);
    expect((await request(app, "/pairing", "chats-read")).status).toBe(403);
    expect((await request(app, "/chats", "pairing-read")).status).toBe(403);
    expect((await request(app, "/pairing", "pairing-read")).status).toBe(200);
    expect((await request(app, "/pairing", "pairing-read")).status).toBe(200);
  });

  it("maps runtime status transitions to the ratified pairing polling shapes", async () => {
    let status: WhatsAppRuntimeStatus = { phase: "starting" };
    const app = appWith({ status: () => status });

    await expect((await request(app, "/pairing", "pairing-read")).json()).resolves.toEqual({
      status: "not_pairing",
    });
    status = {
      phase: "pairing",
      pairing: { method: "qr", qr: "safe-qr-challenge", expiresAt: 60_000 },
    };
    await expect((await request(app, "/pairing", "pairing-read")).json()).resolves.toEqual({
      status: "pairing",
      method: "qr",
      qr: "safe-qr-challenge",
      expiresAt: 60_000,
    });
    status = { phase: "online", accountJid: "15550000001@s.whatsapp.net" };
    await expect((await request(app, "/pairing", "pairing-read")).json()).resolves.toEqual({
      status: "paired",
      accountJid: "15550000001@s.whatsapp.net",
    });
    status = { phase: "stopped" };
    await expect((await request(app, "/pairing", "pairing-read")).json()).resolves.toEqual({
      status: "not_pairing",
    });
  });

  it("returns synchronized chat candidates without broad account access", async () => {
    const synchronizedChats = vi.fn(async () => [
      { jid: "project@g.us", name: "Project", kind: "group" as const, lastActivityAt: 3_000 },
      { jid: "person@s.whatsapp.net", name: "Person", kind: "direct" as const },
    ]);
    const app = appWith({
      status: () => ({ phase: "online" }),
      control: () => runtimeControl(synchronizedChats),
    });

    const response = await request(app, "/chats", "chats-read");
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual([
      { jid: "project@g.us", name: "Project", kind: "group", lastActivityAt: 3_000 },
      { jid: "person@s.whatsapp.net", name: "Person", kind: "direct" },
    ]);
    expect(synchronizedChats).toHaveBeenCalledTimes(1);
  });

  it.each([
    [409, new WhatsAppAccountError("not_authenticated", "Authenticate WhatsApp before discovering chats.")],
    [504, new WhatsAppAccountError("timeout", "WhatsApp conversation sync timed out.")],
    [503, new WhatsAppAccountError("logged_out", "WhatsApp authentication ended in logged_out.")],
  ] as const)("maps an account enumeration failure to HTTP %s", async (expectedStatus, cause) => {
    const app = appWith({
      status: () => ({ phase: "starting" }),
      control: () =>
        runtimeControl(async () => {
          throw cause;
        }),
    });

    const response = await request(app, "/chats", "chats-read");
    expect(response.status).toBe(expectedStatus);
    await expect(response.json()).resolves.toEqual({ error: cause.message });
  });

  it("distinguishes an unavailable runtime from an unexpected enumeration failure", async () => {
    const unavailable = appWith({ status: () => ({ phase: "disabled" }), control: () => undefined });
    const unavailableResponse = await request(unavailable, "/chats", "chats-read");
    expect(unavailableResponse.status).toBe(503);
    await expect(unavailableResponse.json()).resolves.toEqual({ error: "WhatsApp runtime is not started" });

    const failed = appWith({
      status: () => ({ phase: "online" }),
      control: () =>
        runtimeControl(async () => {
          throw new Error("private provider detail");
        }),
    });
    const failedResponse = await request(failed, "/chats", "chats-read");
    expect(failedResponse.status).toBe(500);
    await expect(failedResponse.json()).resolves.toEqual({ error: "chat enumeration failed" });
  });

  it("authenticates delivery pushes and acknowledges only settled tenant ingress", async () => {
    const deliver = vi.fn<NonNullable<BridgeRouteOptions["deliver"]>>(async (delivery) => ({
      status: "unsupported",
      deliveryId: delivery.deliveryId,
    }));
    const app = appWith({ status: () => ({ phase: "online" }), deliver });
    const body = { githubAppId: "app-1", deliveryId: "guid-1", name: "issues", payload: { action: "opened" } };

    expect((await app.request("/deliveries", { method: "POST", body: JSON.stringify(body) })).status).toBe(403);
    expect(
      (
        await app.request("/deliveries", {
          method: "POST",
          headers: { [BRIDGE_AUTH_HEADER]: runtimeBridgeAuthorization(SECRET, "pairing-read") },
          body: JSON.stringify(body),
        })
      ).status,
    ).toBe(403);
    const response = await app.request("/deliveries", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [BRIDGE_AUTH_HEADER]: runtimeBridgeAuthorization(SECRET, "delivery-push"),
      },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({
      runtimeId: "runtime-1",
      githubAppId: "app-1",
      result: { status: "unsupported", deliveryId: "guid-1" },
    });
    expect(deliver).toHaveBeenCalledWith(body);
  });

  it("keeps deferred and interrupted duplicate ingress retryable", async () => {
    const body = { githubAppId: "app-1", deliveryId: "guid-2", name: "pull_request", payload: {} };
    const requestDelivery = async (deliver: NonNullable<BridgeRouteOptions["deliver"]>) => {
      const app = appWith({ status: () => ({ phase: "online" }), deliver });
      return await app.request("/deliveries", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [BRIDGE_AUTH_HEADER]: runtimeBridgeAuthorization(SECRET, "delivery-push"),
        },
        body: JSON.stringify(body),
      });
    };

    expect(
      (
        await requestDelivery(async () => ({
          status: "deferred",
          deliveryId: "guid-2",
          repository: "acme/repo",
          reason: "correlation pending",
        }))
      ).status,
    ).toBe(503);
    expect(
      (
        await requestDelivery(async () => ({
          status: "duplicate",
          record: {
            githubAppId: "app-1",
            deliveryId: "guid-2",
            eventName: "pull_request",
            status: "received",
            receivedAt: "2026-07-18T00:00:00.000Z",
          },
        }))
      ).status,
    ).toBe(503);
  });
});
