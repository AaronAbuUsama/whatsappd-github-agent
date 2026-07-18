import { Hono, type Context } from "hono";

import { BRIDGE_AUTH_HEADER, bridgePairing } from "@ambient-agent/installation/bridge-contract.ts";
import {
  runtimeBridgeAuthorizationMatches,
  type RuntimeBridgePurpose,
  type WhatsAppRuntimeStatus,
} from "@ambient-agent/installation/runtime-health.ts";
import { WhatsAppAccountError } from "@ambient-agent/installation/whatsapp-account.ts";
import type { WhatsAppRuntimeControl } from "./whatsapp-runtime.ts";

export interface BridgeRouteOptions {
  readonly webhookSecret: string;
  readonly status: () => WhatsAppRuntimeStatus;
  readonly control: () => WhatsAppRuntimeControl | undefined;
}

const authorized = (context: Context, options: BridgeRouteOptions, purpose: RuntimeBridgePurpose): boolean =>
  runtimeBridgeAuthorizationMatches(context.req.header(BRIDGE_AUTH_HEADER), options.webhookSecret, purpose);

const chatErrorResponse = (context: Context, cause: WhatsAppAccountError) => {
  if (cause.code === "not_authenticated") return context.json({ error: cause.message }, 409);
  if (cause.code === "timeout") return context.json({ error: cause.message }, 504);
  return context.json({ error: cause.message }, 503);
};

export const installBridgeRoute = (app: Hono, options: BridgeRouteOptions): void => {
  app.get("/pairing", (context) => {
    context.header("Cache-Control", "no-store");
    if (!authorized(context, options, "pairing-read")) {
      return context.json({ error: "bridge authorization rejected" }, 403);
    }
    return context.json(bridgePairing(options.status()));
  });

  app.get("/chats", async (context) => {
    context.header("Cache-Control", "no-store");
    if (!authorized(context, options, "chats-read")) {
      return context.json({ error: "bridge authorization rejected" }, 403);
    }
    const control = options.control();
    if (control === undefined) return context.json({ error: "WhatsApp runtime is not started" }, 503);
    try {
      return context.json(await control.synchronizedChats());
    } catch (cause) {
      if (cause instanceof WhatsAppAccountError) return chatErrorResponse(context, cause);
      console.error("[bridge] chat enumeration failed", cause);
      return context.json({ error: "chat enumeration failed" }, 500);
    }
  });
};
