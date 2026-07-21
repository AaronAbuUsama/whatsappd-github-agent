import { Hono } from "hono";

import { runtimeSmokeAuthorizationMatches } from "@ambient-agent/installation/runtime-health.ts";
import {
  WhatsAppSmokeCanaryError,
  type WhatsAppRuntimeControl,
  type WhatsAppSmokeCanaryStatus,
} from "./whatsapp-runtime.ts";

export interface SmokeRouteOptions {
  readonly webhookSecret: string;
  readonly canaryConfigured: boolean;
  readonly control: () => WhatsAppRuntimeControl | undefined;
}

export const installSmokeRoute = (app: Hono, options: SmokeRouteOptions): void => {
  const usedNonces = new Set<string>();
  app.post("/smoke", async (context) => {
    const body = await context.req.json().catch(() => undefined);
    const nonce = (body as { readonly nonce?: unknown } | undefined)?.nonce;
    const timeoutMillis = (body as { readonly timeoutMillis?: unknown } | undefined)?.timeoutMillis;
    if (
      typeof nonce !== "string" ||
      !/^[A-Za-z0-9_-]{4,64}$/.test(nonce) ||
      !Number.isInteger(timeoutMillis) ||
      Number(timeoutMillis) < 1 ||
      Number(timeoutMillis) > 300_000
    ) {
      return context.json({ error: "invalid smoke canary request" }, 400);
    }
    if (
      !runtimeSmokeAuthorizationMatches(
        context.req.header("x-ambient-agent-smoke"),
        options.webhookSecret,
        nonce,
        Number(timeoutMillis),
      )
    ) {
      return context.json({ error: "smoke authorization rejected" }, 403);
    }
    if (usedNonces.has(nonce)) return context.json({ error: "smoke nonce already used" }, 409);
    usedNonces.add(nonce);
    if (!options.canaryConfigured) {
      return context.json({ error: "no dedicated smoke canary group configured" }, 409);
    }
    const control = options.control();
    if (control === undefined) return context.json({ error: "WhatsApp runtime is not started" }, 503);
    try {
      return context.json(await control.smokeCanary(nonce, Number(timeoutMillis)));
    } catch (cause) {
      const status: WhatsAppSmokeCanaryStatus = cause instanceof WhatsAppSmokeCanaryError ? cause.status : 504;
      return context.json({ error: cause instanceof Error ? cause.message : "live canary failed" }, status);
    }
  });
};
