import { join } from "node:path";

import { expect, it, vi } from "vite-plus/test";
import * as v from "valibot";

import type { WhatsAppRuntimeControl } from "../../apps/runtime/src/host/whatsapp-runtime.ts";
import { BRIDGE_AUTH_HEADER } from "../../packages/installation/src/bridge-contract.ts";
import { managedPaths } from "../../packages/installation/src/paths.ts";
import {
  installManagedRuntimeDependencies,
  resolveTenantRuntimeBoot,
  transitionTenantRuntimeProfile,
  type TenantRuntimeSetupBoot,
} from "../../packages/installation/src/runtime-dependencies.ts";
import { runtimeBridgeAuthorization } from "../../packages/installation/src/runtime-health.ts";
import { ManagedConfigSchema, createManagedConfig } from "../../packages/installation/src/schema.ts";

const setupEnvironment = {
  AMBIENT_AGENT_RUNTIME_PROFILE: "setup",
  AMBIENT_AGENT_RUNTIME_ID: "runtime-202",
  AMBIENT_AGENT_RUNTIME_BRIDGE_SECRET: "bridge-secret-202",
  TENANT_DB_URL: `file:${join(process.cwd(), ".runtime-profile-test.sqlite")}`,
  TENANT_DB_TOKEN: "tenant-token-202",
} as const;

const previousSetupEnvironment = Object.fromEntries(
  Object.keys(setupEnvironment).map((name) => [name, process.env[name]]),
);
Object.assign(process.env, setupEnvironment);
const { createAmbientAgentSetupApp } = await import("../../apps/runtime/src/app.ts");
for (const [name, value] of Object.entries(previousSetupEnvironment)) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

const control = (synchronizedChats: WhatsAppRuntimeControl["synchronizedChats"]): WhatsAppRuntimeControl => ({
  synchronizedChats,
  smokeCanary: async () => ({
    chatId: "unused@g.us",
    text: "unused",
    stages: ["admission", "dispatch", "settled-silent"],
  }),
  stop: async () => undefined,
});

it("boots setup with only health, pairing, and chat enumeration around one WhatsApp owner", async () => {
  const paths = managedPaths({ dataDirectory: "/private/tenant-202" });
  const boot: TenantRuntimeSetupBoot = {
    mode: "setup",
    runtimeId: "runtime-202",
    bridgeSecret: "bridge-secret-202",
    paths,
    credentialEnvironment: {
      TENANT_DB_URL: "libsql://tenant-202.example",
      TENANT_DB_TOKEN: "tenant-token-202",
    },
  };
  const synchronizedChats = vi.fn(async () => [{ jid: "project@g.us", name: "Project", kind: "group" as const }]);
  const startWhatsApp = vi.fn(() => control(synchronizedChats));
  const app = createAmbientAgentSetupApp(boot, {
    startWhatsApp,
    status: () => ({
      phase: "pairing",
      pairing: { method: "qr", qr: "fake-qr-challenge", expiresAt: 60_000 },
    }),
  });

  const health = await app.request("/health");
  expect(health.status).toBe(200);
  expect(await health.json()).toEqual({
    ok: false,
    runtimeId: "runtime-202",
    runtime: { state: "starting", whatsapp: { phase: "pairing" } },
  });
  expect(JSON.stringify(await (await app.request("/health")).json())).not.toContain("fake-qr-challenge");

  const pairing = await app.request("/pairing", {
    headers: {
      [BRIDGE_AUTH_HEADER]: runtimeBridgeAuthorization(boot.bridgeSecret, "pairing-read"),
    },
  });
  expect(await pairing.json()).toEqual({
    status: "pairing",
    method: "qr",
    qr: "fake-qr-challenge",
    expiresAt: 60_000,
  });

  const chats = await app.request("/chats", {
    headers: {
      [BRIDGE_AUTH_HEADER]: runtimeBridgeAuthorization(boot.bridgeSecret, "chats-read"),
    },
  });
  expect(await chats.json()).toEqual([{ jid: "project@g.us", name: "Project", kind: "group" }]);
  expect(startWhatsApp).toHaveBeenCalledTimes(1);
  expect(startWhatsApp).toHaveBeenCalledWith(
    expect.objectContaining({
      applicationDatabase: paths.applicationDatabase,
      storeDirectory: paths.whatsapp,
      managedChats: [],
      environment: boot.credentialEnvironment,
    }),
  );
  expect(synchronizedChats).toHaveBeenCalledTimes(1);
  expect((await app.request("/smoke")).status).toBe(404);
  expect((await app.request("/agents/speaker")).status).toBe(404);
});

it("selects setup before strict operate composition and fails closed on an incomplete tenant contract", () => {
  const paths = managedPaths({ dataDirectory: "/private/tenant-202" });
  installManagedRuntimeDependencies({
    authentication: {} as never,
    configuration: createManagedConfig(["project@g.us"], "owner/repository"),
    githubCredential: { webhookSecret: "operate-secret" } as never,
    paths,
  });

  expect(resolveTenantRuntimeBoot(setupEnvironment, paths)).toMatchObject({
    mode: "setup",
    runtimeId: "runtime-202",
    bridgeSecret: "bridge-secret-202",
  });
  expect(resolveTenantRuntimeBoot({ AMBIENT_AGENT_RUNTIME_PROFILE: "operate" }, paths).mode).toBe("operate");
  expect(() =>
    resolveTenantRuntimeBoot(
      {
        ...setupEnvironment,
        TENANT_DB_TOKEN: undefined,
      },
      paths,
    ),
  ).toThrow("TENANT_DB_URL and TENANT_DB_TOKEN");

  const strict = createManagedConfig(["project@g.us"], "owner/repository");
  expect(v.safeParse(ManagedConfigSchema, { ...strict, managedChats: [] }).success).toBe(false);
  expect(
    v.safeParse(ManagedConfigSchema, {
      ...strict,
      github: { ...strict.github, allowedRepositories: [] },
    }).success,
  ).toBe(false);
});

it("keeps activation rollback and WhatsApp repair on the same application with Managed Chats preserved", () => {
  const setup = {
    applicationId: "dokploy-app-202",
    mode: "setup" as const,
    managedChats: ["project@g.us"],
  };

  const operate = transitionTenantRuntimeProfile(setup, "activation.succeeded");
  expect(operate).toEqual({ ...setup, mode: "operate" });
  expect(transitionTenantRuntimeProfile(setup, "activation.failed")).toEqual(setup);

  const repairing = transitionTenantRuntimeProfile(operate, "repair.started");
  expect(repairing).toEqual({ ...operate, mode: "setup" });
  expect(transitionTenantRuntimeProfile(repairing, "repair.completed")).toEqual(operate);
});
