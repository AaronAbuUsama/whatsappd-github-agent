import { createHash } from "node:crypto";

import type { WhatsAppRuntimeStatus } from "../host/whatsapp-runtime.js";

export type AmbientRuntimeState = "configured" | "stopped" | "starting" | "healthy" | "degraded" | "failed";

export interface AmbientRuntimeHealth {
  readonly state: AmbientRuntimeState;
  readonly whatsapp: WhatsAppRuntimeStatus;
}

/** Stable, non-secret correlation token derived from the app-owned random webhook secret. */
export const runtimeInstallationId = (webhookSecret: string): string =>
  createHash("sha256").update(`ambient-agent\0${webhookSecret}`).digest("base64url").slice(0, 22);

export const ambientRuntimeHealth = (whatsapp: WhatsAppRuntimeStatus): AmbientRuntimeHealth => ({
  state:
    whatsapp.phase === "online"
      ? "healthy"
      : whatsapp.phase === "starting"
        ? "starting"
        : whatsapp.phase === "failed"
          ? "failed"
          : whatsapp.phase === "stopped"
            ? "stopped"
            : "degraded",
  whatsapp,
});

const runtimeStates = new Set<AmbientRuntimeState>([
  "configured",
  "stopped",
  "starting",
  "healthy",
  "degraded",
  "failed",
]);
const whatsappPhases = new Set<WhatsAppRuntimeStatus["phase"]>(["disabled", "starting", "online", "failed", "stopped"]);

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
    if (
      value.installationId !== options.installationId ||
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
