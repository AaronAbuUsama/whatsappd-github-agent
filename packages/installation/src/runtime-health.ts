import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import type { PairingProgress } from "./whatsapp-account.ts";

export type AmbientRuntimeState = "stopped" | "starting" | "healthy" | "failed";
export type WhatsAppRuntimePhase = "disabled" | "starting" | "pairing" | "online" | "failed" | "stopped";
export interface WhatsAppRuntimeStatus {
  readonly phase: WhatsAppRuntimePhase;
  /** Runtime-authenticated account identity; never populated from user input or pairing material. */
  readonly accountJid?: string;
  readonly chatTarget?: string;
  readonly botIds?: readonly string[];
  readonly pairing?: PairingProgress;
  readonly error?: string;
}

export interface AmbientRuntimeHealth {
  readonly state: AmbientRuntimeState;
  readonly whatsapp: WhatsAppRuntimeStatus;
}

/** Stable, non-secret correlation token derived from the app-owned random webhook secret. */
export const runtimeInstallationId = (webhookSecret: string): string =>
  createHash("sha256").update(`ambient-agent\0${webhookSecret}`).digest("base64url").slice(0, 22);

/** Request-scoped proof of the private runtime credential; unlike runtimeId, this value is never published. */
export const runtimeSmokeAuthorization = (webhookSecret: string, nonce: string, timeoutMillis: number): string =>
  createHmac("sha256", webhookSecret).update(`ambient-agent-smoke\0${nonce}\0${timeoutMillis}`).digest("base64url");

export type RuntimeBridgePurpose = "pairing-read" | "chats-read" | "delivery-push";

/** Replay-safe proof for a polled bridge resource, isolated from every other bridge purpose. */
export const runtimeBridgeAuthorization = (webhookSecret: string, purpose: RuntimeBridgePurpose): string =>
  createHmac("sha256", webhookSecret).update(`ambient-agent-bridge\0${purpose}`).digest("base64url");

const authorizationMatches = (candidate: string | undefined, expected: string): boolean => {
  if (candidate === undefined) return false;
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(candidate);
  return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
};

export const runtimeSmokeAuthorizationMatches = (
  candidate: string | undefined,
  webhookSecret: string,
  nonce: string,
  timeoutMillis: number,
): boolean => {
  return authorizationMatches(candidate, runtimeSmokeAuthorization(webhookSecret, nonce, timeoutMillis));
};

export const runtimeBridgeAuthorizationMatches = (
  candidate: string | undefined,
  webhookSecret: string,
  purpose: RuntimeBridgePurpose,
): boolean => authorizationMatches(candidate, runtimeBridgeAuthorization(webhookSecret, purpose));

export const ambientRuntimeHealth = (whatsapp: WhatsAppRuntimeStatus): AmbientRuntimeHealth => ({
  state:
    whatsapp.phase === "online"
      ? "healthy"
      : whatsapp.phase === "failed"
        ? "failed"
        : whatsapp.phase === "stopped"
          ? "stopped"
          : // "disabled" is the instant between the HTTP bind and the deferred WhatsApp start.
            "starting",
  whatsapp,
});

const runtimeStates = new Set<AmbientRuntimeState>(["stopped", "starting", "healthy", "failed"]);
const whatsappPhases = new Set<WhatsAppRuntimeStatus["phase"]>([
  "disabled",
  "starting",
  "pairing",
  "online",
  "failed",
  "stopped",
]);

/** Bounded local HTTP observation; only an explicit refusal means stopped, never stale-process inference. */
export const probeAmbientRuntimeHealth = async (options: {
  readonly port: number;
  readonly installationId: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMillis?: number;
}): Promise<AmbientRuntimeHealth> => {
  try {
    const response = await (options.fetch ?? globalThis.fetch)(`http://127.0.0.1:${options.port}/health`, {
      signal: AbortSignal.timeout(options.timeoutMillis ?? 750),
    });
    if (!response.ok) throw new Error(`The local health endpoint returned HTTP ${response.status}.`);
    const value = (await response.json()) as Record<string, unknown>;
    const runtime = value.runtime as Record<string, unknown> | undefined;
    const whatsapp = runtime?.whatsapp as Record<string, unknown> | undefined;
    const runtimeIdMatches =
      value.runtimeId === options.installationId || value.installationId === options.installationId;
    if (
      !runtimeIdMatches ||
      !runtimeStates.has(runtime?.state as AmbientRuntimeState) ||
      !whatsappPhases.has(whatsapp?.phase as never)
    ) {
      throw new Error("The local health response is malformed.");
    }
    return {
      state: runtime!.state as AmbientRuntimeState,
      whatsapp: { phase: whatsapp!.phase as WhatsAppRuntimeStatus["phase"] },
    };
  } catch (cause) {
    const code =
      typeof cause === "object" && cause !== null && "cause" in cause
        ? (cause.cause as { readonly code?: unknown } | undefined)?.code
        : undefined;
    return code === "ECONNREFUSED"
      ? { state: "stopped", whatsapp: { phase: "stopped" } }
      : { state: "failed", whatsapp: { phase: "failed" } };
  }
};
