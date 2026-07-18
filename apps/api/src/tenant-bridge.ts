import {
  BRIDGE_AUTH_HEADER,
  type BridgeChats,
  type BridgeHealth,
  type BridgePairing,
} from "@ambient-agent/installation/bridge-contract.ts";
import { runtimeBridgeAuthorization, type RuntimeBridgePurpose } from "@ambient-agent/installation/runtime-health.ts";
import { z } from "zod";

const healthSchema: z.ZodType<BridgeHealth> = z.object({
  ok: z.boolean(),
  runtimeId: z.string().min(1),
  runtime: z.object({
    state: z.enum(["stopped", "starting", "healthy", "failed"]),
    whatsapp: z.object({
      phase: z.enum(["disabled", "starting", "pairing", "online", "failed", "stopped"]),
    }),
  }),
});

const pairingSchema: z.ZodType<BridgePairing> = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("pairing"),
    method: z.enum(["qr", "pairing_code"]),
    qr: z.string().optional(),
    code: z.string().optional(),
    expiresAt: z.number(),
  }),
  z.object({ status: z.literal("paired") }),
  z.object({ status: z.literal("not_pairing") }),
]);

const chatsSchema: z.ZodType<BridgeChats> = z.array(
  z.object({
    jid: z.string().min(1),
    name: z.string(),
    kind: z.enum(["group", "direct"]),
    lastActivityAt: z.number().optional(),
  }),
);

export interface TenantBridgeOptions {
  readonly baseUrl: string;
  readonly webhookSecret: string;
  readonly fetch?: typeof globalThis.fetch;
}

export class TenantBridgeError extends Error {
  override readonly name = "TenantBridgeError";

  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const responseJson = async (response: Response): Promise<unknown> => {
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const message =
      typeof body === "object" && body !== null && "error" in body && typeof body.error === "string"
        ? body.error
        : `Tenant bridge returned HTTP ${response.status}`;
    throw new TenantBridgeError(response.status, message);
  }
  return body;
};

const parseResponse = <Value>(schema: z.ZodType<Value>, value: unknown, resource: string): Value => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new TenantBridgeError(502, `Tenant bridge returned malformed ${resource} data`);
  return parsed.data;
};

export const tenantBridge = (options: TenantBridgeOptions) => {
  const baseUrl = options.baseUrl.replace(/\/+$/u, "");
  const fetch = options.fetch ?? globalThis.fetch;
  const authorized = async (path: string, purpose: RuntimeBridgePurpose): Promise<unknown> =>
    await responseJson(
      await fetch(`${baseUrl}${path}`, {
        headers: { [BRIDGE_AUTH_HEADER]: runtimeBridgeAuthorization(options.webhookSecret, purpose) },
      }),
    );

  return {
    health: async (): Promise<BridgeHealth> =>
      parseResponse(healthSchema, await responseJson(await fetch(`${baseUrl}/health`)), "health"),
    pairing: async (): Promise<BridgePairing> =>
      parseResponse(pairingSchema, await authorized("/pairing", "pairing-read"), "pairing"),
    chats: async (): Promise<BridgeChats> =>
      parseResponse(chatsSchema, await authorized("/chats", "chats-read"), "chats"),
  };
};
