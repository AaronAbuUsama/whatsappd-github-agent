import { Hono, type Context } from "hono";

import type { GitHubIngressResult, RoutedGitHubWebhookDelivery } from "@ambient-agent/engine/github/ingress.ts";
import { handleGitHubDelivery } from "@ambient-agent/engine/github/ingress-runtime.ts";
import {
  BRIDGE_AUTH_HEADER,
  bridgePairing,
  type BridgeGitHubDelivery,
} from "@ambient-agent/installation/bridge-contract.ts";
import {
  runtimeBridgeAuthorizationMatches,
  type RuntimeBridgePurpose,
  type WhatsAppRuntimeStatus,
} from "@ambient-agent/installation/runtime-health.ts";
import { WhatsAppAccountError } from "@ambient-agent/installation/whatsapp-account.ts";
import type { WhatsAppRuntimeControl } from "./whatsapp-runtime.ts";

export interface BridgeRouteOptions {
  readonly runtimeId: string;
  readonly webhookSecret: string;
  readonly status: () => WhatsAppRuntimeStatus;
  readonly control: () => WhatsAppRuntimeControl | undefined;
  readonly deliver?: (delivery: BridgeGitHubDelivery) => Promise<GitHubIngressResult>;
}

const authorized = (context: Context, options: BridgeRouteOptions, purpose: RuntimeBridgePurpose): boolean =>
  runtimeBridgeAuthorizationMatches(context.req.header(BRIDGE_AUTH_HEADER), options.webhookSecret, purpose);

const chatErrorResponse = (context: Context, cause: WhatsAppAccountError) => {
  if (cause.code === "not_authenticated") return context.json({ error: cause.message }, 409);
  if (cause.code === "timeout") return context.json({ error: cause.message }, 504);
  return context.json({ error: cause.message }, 503);
};

const githubDelivery = (value: unknown): BridgeGitHubDelivery | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.githubAppId !== "string" ||
    candidate.githubAppId.length === 0 ||
    typeof candidate.deliveryId !== "string" ||
    candidate.deliveryId.length === 0 ||
    typeof candidate.name !== "string" ||
    candidate.name.length === 0 ||
    typeof candidate.payload !== "object" ||
    candidate.payload === null ||
    Array.isArray(candidate.payload)
  ) {
    return undefined;
  }
  return candidate as unknown as BridgeGitHubDelivery;
};

const deliveryIsDurable = (result: GitHubIngressResult): boolean =>
  result.status !== "deferred" && (result.status !== "duplicate" || result.record.status !== "received");

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

  app.post("/deliveries", async (context) => {
    context.header("Cache-Control", "no-store");
    if (!authorized(context, options, "delivery-push")) {
      return context.json({ error: "bridge authorization rejected" }, 403);
    }
    const delivery = githubDelivery(await context.req.json().catch(() => undefined));
    if (delivery === undefined) return context.json({ error: "malformed GitHub delivery" }, 400);
    try {
      const result =
        options.deliver === undefined
          ? await handleGitHubDelivery(delivery as RoutedGitHubWebhookDelivery)
          : await options.deliver(delivery);
      return context.json(
        { runtimeId: options.runtimeId, githubAppId: delivery.githubAppId, result },
        deliveryIsDurable(result) ? 200 : 503,
      );
    } catch (cause) {
      console.error("[bridge] GitHub delivery failed", cause);
      return context.json({ error: "GitHub delivery failed before durable ingress" }, 503);
    }
  });
};
