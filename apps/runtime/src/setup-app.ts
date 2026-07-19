import { Hono } from "hono";

import { bridgeHealth } from "@ambient-agent/installation/bridge-contract.ts";
import type { TenantRuntimeSetupBoot } from "@ambient-agent/installation/runtime-dependencies.ts";
import { installBridgeRoute } from "./host/bridge-route.ts";
import { stopRuntimeOnSignal } from "./host/runtime-signals.ts";
import { startWhatsAppSetupRuntime, type WhatsAppSetupRuntime } from "./host/whatsapp-setup-runtime.ts";

interface SetupRuntimeServices {
  readonly startWhatsApp: typeof startWhatsAppSetupRuntime;
}

export const createAmbientAgentSetupApp = (
  boot: TenantRuntimeSetupBoot,
  services: SetupRuntimeServices = { startWhatsApp: startWhatsAppSetupRuntime },
): Hono => {
  let whatsapp: WhatsAppSetupRuntime | undefined;
  const startOnce = (): void => {
    if (whatsapp !== undefined) return;
    whatsapp = services.startWhatsApp({
      storeDirectory: boot.paths.whatsapp,
      applicationDatabase: boot.paths.applicationDatabase,
      credentialEnvironment: boot.credentialEnvironment,
    });
    stopRuntimeOnSignal(whatsapp);
  };
  const status = () => whatsapp?.status() ?? { phase: "disabled" as const };
  const app = new Hono();
  app.use("*", async (_context, next) => {
    startOnce();
    await next();
  });
  app.get("/health", (context) => context.json(bridgeHealth(boot.runtimeId, status())));
  installBridgeRoute(app, {
    webhookSecret: boot.bridgeSecret,
    status,
    control: () => whatsapp,
  });
  return app;
};
