import { ambientRuntimeHealth, type AmbientRuntimeState, type WhatsAppRuntimeStatus } from "./runtime-health.ts";
import type { RuntimeDeploymentIdentity } from "./runtime-dependencies.ts";
import type { ChatCandidate, PairingProgress } from "./whatsapp-account.ts";

export const BRIDGE_AUTH_HEADER = "x-ambient-agent-bridge";

/** Coarse unauthenticated liveness. Pairing material is deliberately absent. */
export interface BridgeHealth {
  readonly ok: boolean;
  readonly runtimeId: string;
  readonly runtime: {
    readonly state: AmbientRuntimeState;
    readonly whatsapp: { readonly phase: WhatsAppRuntimeStatus["phase"] };
  };
  readonly deployment?: RuntimeDeploymentIdentity;
}

export type BridgePairing =
  | ({ readonly status: "pairing" } & PairingProgress)
  | { readonly status: "paired"; readonly accountJid: string }
  | { readonly status: "not_pairing" };

export type BridgeChats = readonly ChatCandidate[];

export interface BridgeGitHubDelivery {
  readonly githubAppId: string;
  readonly deliveryId: string;
  readonly name: string;
  readonly payload: Record<string, unknown>;
}

export interface BridgeGitHubDeliveryAck {
  readonly runtimeId: string;
  readonly githubAppId: string;
  readonly result: Record<string, unknown> & { readonly status: string };
}

export const bridgeHealth = (
  runtimeId: string,
  status: WhatsAppRuntimeStatus,
  deployment?: RuntimeDeploymentIdentity,
): BridgeHealth => {
  const runtime = ambientRuntimeHealth(status);
  return {
    ok: runtime.state === "healthy",
    runtimeId,
    runtime: { state: runtime.state, whatsapp: { phase: runtime.whatsapp.phase } },
    ...(deployment === undefined ? {} : { deployment }),
  };
};

/** Setup liveness is the serving profile; WhatsApp pairing is a later capability fact. */
export const setupBridgeHealth = (
  runtimeId: string,
  status: WhatsAppRuntimeStatus,
  deployment?: RuntimeDeploymentIdentity,
): BridgeHealth => {
  const health = bridgeHealth(runtimeId, status, deployment);
  if (status.phase === "failed" || status.phase === "stopped") return health;
  return { ...health, ok: true, runtime: { ...health.runtime, state: "healthy" } };
};

export const bridgePairing = (status: WhatsAppRuntimeStatus): BridgePairing => {
  if (status.phase === "pairing" && status.pairing !== undefined) {
    return { status: "pairing", ...status.pairing };
  }
  const accountJid = status.accountJid?.trim();
  return status.phase === "online" && accountJid
    ? { status: "paired", accountJid }
    : { status: "not_pairing" };
};
