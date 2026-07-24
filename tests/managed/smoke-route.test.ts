import { Hono } from "hono";
import { describe, expect, it, vi } from "vite-plus/test";

import { installSmokeRoute } from "../../apps/runtime/src/host/smoke-route.ts";
import { WhatsAppSmokeCanaryError, type WhatsAppRuntimeControl } from "../../apps/runtime/src/host/whatsapp-runtime.ts";
import { runtimeSmokeAuthorization } from "../../packages/installation/src/runtime-health.ts";

const SECRET = "private-webhook-secret";
const NONCE = "abc123";
const TIMEOUT = 30_000;

const request = async (app: Hono, body: unknown, authorization?: string): Promise<Response> =>
  await app.request("/smoke", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authorization === undefined ? {} : { "x-ambient-agent-smoke": authorization }),
    },
    body: JSON.stringify(body),
  });

const control = (smokeCanary: WhatsAppRuntimeControl["smokeCanary"]): WhatsAppRuntimeControl => ({
  smokeCanary,
  synchronizedChats: async () => [],
  reloadManagedChats: () => undefined,
  stop: async () => undefined,
});

const appWith = (options: { readonly configured?: boolean; readonly runtime?: WhatsAppRuntimeControl }): Hono => {
  const app = new Hono();
  installSmokeRoute(app, {
    webhookSecret: SECRET,
    canaryConfigured: options.configured ?? true,
    control: () => options.runtime,
  });
  return app;
};

describe("POST /smoke", () => {
  it("enforces the public request validation and authorization boundary", async () => {
    const app = appWith({});
    expect((await request(app, { nonce: "bad nonce", timeoutMillis: TIMEOUT })).status).toBe(400);
    expect((await request(app, { nonce: NONCE, timeoutMillis: TIMEOUT })).status).toBe(403);
    expect((await request(app, { nonce: NONCE, timeoutMillis: TIMEOUT }, "wrong")).status).toBe(403);
  });

  it("reports missing configuration and runtime availability distinctly", async () => {
    const authorization = runtimeSmokeAuthorization(SECRET, NONCE, TIMEOUT);
    expect(
      (await request(appWith({ configured: false }), { nonce: NONCE, timeoutMillis: TIMEOUT }, authorization)).status,
    ).toBe(409);
    expect((await request(appWith({}), { nonce: NONCE, timeoutMillis: TIMEOUT }, authorization)).status).toBe(503);
  });

  it.each([
    [400, "The configured smoke canary group is not a Managed Chat."],
    [409, "A live smoke canary is already running."],
    [503, "The WhatsApp account cannot send smoke canaries."],
    [504, "The SMOKE canary timed out."],
  ] as const)("preserves a typed runtime %s response", async (status, message) => {
    const runtime = control(async () => {
      throw new WhatsAppSmokeCanaryError(status, message);
    });
    const response = await request(
      appWith({ runtime }),
      { nonce: NONCE, timeoutMillis: TIMEOUT },
      runtimeSmokeAuthorization(SECRET, NONCE, TIMEOUT),
    );
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: message });
  });

  it("returns the observer receipt once and rejects a replayed nonce", async () => {
    const smokeCanary = vi.fn(async () => ({
      chatId: "120363000@g.us",
      text: `SMOKE ${NONCE} — ignore`,
      stages: ["admission", "dispatch", "settled-silent"] as const,
    }));
    const app = appWith({ runtime: control(smokeCanary) });
    const authorization = runtimeSmokeAuthorization(SECRET, NONCE, TIMEOUT);

    const response = await request(app, { nonce: NONCE, timeoutMillis: TIMEOUT }, authorization);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      chatId: "120363000@g.us",
      text: `SMOKE ${NONCE} — ignore`,
      stages: ["admission", "dispatch", "settled-silent"],
    });
    expect((await request(app, { nonce: NONCE, timeoutMillis: TIMEOUT }, authorization)).status).toBe(409);
    expect(smokeCanary).toHaveBeenCalledTimes(1);
  });
});
