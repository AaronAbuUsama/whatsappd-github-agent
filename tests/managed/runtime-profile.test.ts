import { expect, it, vi } from "vite-plus/test";
import * as v from "valibot";

import { createAmbientAgentSetupApp } from "../../apps/runtime/src/setup-app.ts";
import { startWhatsAppSetupRuntime } from "../../apps/runtime/src/host/whatsapp-setup-runtime.ts";
import { BRIDGE_AUTH_HEADER } from "../../packages/installation/src/bridge-contract.ts";
import { managedPaths } from "../../packages/installation/src/paths.ts";
import {
  getManagedRuntimeDependencies,
  installManagedRuntimeDependencies,
  resolveTenantRuntimeSetupBoot,
  type TenantRuntimeSetupBoot,
} from "../../packages/installation/src/runtime-dependencies.ts";
import { runtimeBridgeAuthorization } from "../../packages/installation/src/runtime-health.ts";
import { ManagedConfigSchema, createManagedConfig } from "../../packages/installation/src/schema.ts";
import type { ManagedWhatsAppAccount } from "../../packages/installation/src/whatsapp-account.ts";

const setupEnvironment = {
  AMBIENT_AGENT_RUNTIME_PROFILE: "setup",
  AMBIENT_AGENT_CONFIG_VERSION: "7",
  AMBIENT_AGENT_RUNTIME_ID: "runtime-202",
  AMBIENT_AGENT_RUNTIME_BRIDGE_SECRET: "bridge-secret-202",
  TENANT_DB_URL: "libsql://tenant-202.example",
  TENANT_DB_TOKEN: "tenant-token-202",
  PORT: "3202",
} as const;

it("boots setup with only health, pairing, and chat enumeration around one WhatsApp owner", async () => {
  const paths = managedPaths({ dataDirectory: "/private/tenant-202" });
  const boot: TenantRuntimeSetupBoot = {
    mode: "setup",
    runtimeId: "runtime-202",
    bridgeSecret: "bridge-secret-202",
    port: 3202,
    paths,
    credentialEnvironment: {
      TENANT_DB_URL: "libsql://tenant-202.example",
      TENANT_DB_TOKEN: "tenant-token-202",
    },
    deployment: { configVersion: 7, mode: "setup" },
  };
  const synchronizedChats = vi.fn(async () => [{ jid: "project@g.us", name: "Project", kind: "group" as const }]);
  const setupRuntime = {
    status: () => ({
      phase: "pairing" as const,
      pairing: { method: "qr" as const, qr: "fake-qr-challenge", expiresAt: 60_000 },
    }),
    synchronizedChats,
    stop: async () => undefined,
  };
  const startWhatsApp = vi.fn(() => setupRuntime);
  const app = createAmbientAgentSetupApp(boot, { startWhatsApp });

  const health = await app.request("/health");
  expect(health.status).toBe(200);
  expect(await health.json()).toEqual({
    ok: true,
    runtimeId: "runtime-202",
    runtime: { state: "healthy", whatsapp: { phase: "pairing" } },
    deployment: { configVersion: 7, mode: "setup" },
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
  expect(startWhatsApp).toHaveBeenCalledWith({
    storeDirectory: paths.whatsapp,
    applicationDatabase: paths.applicationDatabase,
    credentialEnvironment: boot.credentialEnvironment,
  });
  expect(synchronizedChats).toHaveBeenCalledTimes(1);
  expect((await app.request("/deliveries", { method: "POST" })).status).toBe(404);
  expect((await app.request("/smoke")).status).toBe(404);
  expect((await app.request("/agents/speaker")).status).toBe(404);
});

it("keeps pairing material in the authenticated bridge instead of runtime output", async () => {
  let finishAuthentication!: (identity: { jid: string }) => void;
  const authentication = new Promise<{ jid: string }>((resolve) => {
    finishAuthentication = resolve;
  });
  const account: ManagedWhatsAppAccount = {
    authenticate: vi.fn(async ({ onPairing }) => {
      onPairing({ method: "qr", qr: "fake-qr-challenge", expiresAt: 60_000 });
      return await authentication;
    }),
    synchronizedChats: vi.fn(async () => []),
    session: () => ({}) as never,
    stop: vi.fn(async () => undefined),
  };
  const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const writeError = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const archive = { append: vi.fn(() => true), close: vi.fn() };
  const runtime = startWhatsAppSetupRuntime(
    {
      storeDirectory: "/private/tenant-202/whatsapp",
      applicationDatabase: "/private/tenant-202/application.sqlite",
      credentialEnvironment: {
        TENANT_DB_URL: "libsql://tenant-202.example",
        TENANT_DB_TOKEN: "tenant-token-202",
      },
    },
    { createAccount: () => account, createArchive: () => archive as never },
  );

  await vi.waitFor(() => expect(runtime.status()).toMatchObject({ phase: "pairing" }));
  expect(write).not.toHaveBeenCalled();
  expect(writeError).not.toHaveBeenCalled();
  finishAuthentication({ jid: "15550000202@s.whatsapp.net" });
  await vi.waitFor(() =>
    expect(runtime.status()).toEqual({
      phase: "online",
      accountJid: "15550000202@s.whatsapp.net",
    }),
  );
  const app = createAmbientAgentSetupApp(
    {
      mode: "setup",
      runtimeId: "runtime-202",
      bridgeSecret: "bridge-secret-202",
      port: 3202,
      paths: managedPaths({ dataDirectory: "/private/tenant-202" }),
      credentialEnvironment: {
        TENANT_DB_URL: "libsql://tenant-202.example",
        TENANT_DB_TOKEN: "tenant-token-202",
      },
      deployment: { configVersion: 7, mode: "setup" },
    },
    { startWhatsApp: () => runtime },
  );
  const paired = await app.request("/pairing", {
    headers: {
      [BRIDGE_AUTH_HEADER]: runtimeBridgeAuthorization("bridge-secret-202", "pairing-read"),
    },
  });
  await expect(paired.json()).resolves.toEqual({
    status: "paired",
    accountJid: "15550000202@s.whatsapp.net",
  });
  await runtime.stop();
  expect(archive.close).toHaveBeenCalledTimes(1);
});

it("releases setup resources when WhatsApp authentication fails", async () => {
  const account: ManagedWhatsAppAccount = {
    authenticate: vi.fn(async () => {
      throw new Error("logged_out");
    }),
    synchronizedChats: vi.fn(async () => []),
    session: () => ({}) as never,
    stop: vi.fn(async () => undefined),
  };
  const archive = { append: vi.fn(() => true), close: vi.fn() };
  const runtime = startWhatsAppSetupRuntime(
    {
      storeDirectory: "/private/tenant-202/whatsapp",
      applicationDatabase: "/private/tenant-202/application.sqlite",
      credentialEnvironment: {
        TENANT_DB_URL: "libsql://tenant-202.example",
        TENANT_DB_TOKEN: "tenant-token-202",
      },
    },
    { createAccount: () => account, createArchive: () => archive as never },
  );

  await vi.waitFor(() => expect(runtime.status()).toEqual({ phase: "failed", error: "logged_out" }));
  expect(account.stop).toHaveBeenCalledTimes(1);
  expect(archive.close).toHaveBeenCalledTimes(1);

  await runtime.stop();
  expect(account.stop).toHaveBeenCalledTimes(1);
  expect(archive.close).toHaveBeenCalledTimes(1);
});

it("shares storage across setup, activation rollback, and repair without weakening operate configuration", () => {
  const paths = managedPaths({ dataDirectory: "/private/tenant-202" });
  const configuration = createManagedConfig(["project@g.us"], "owner/repository");
  installManagedRuntimeDependencies({
    authentication: {} as never,
    configuration,
    githubCredential: { webhookSecret: "operate-secret" } as never,
    paths,
  });

  const setup = resolveTenantRuntimeSetupBoot(setupEnvironment, paths);
  expect(setup.paths).toBe(paths);
  expect(getManagedRuntimeDependencies()).toMatchObject({ paths, configuration });

  const failedActivationRollback = resolveTenantRuntimeSetupBoot(setupEnvironment, paths);
  expect(failedActivationRollback.paths).toBe(paths);
  expect(getManagedRuntimeDependencies()).toMatchObject({ paths, configuration });

  const repair = resolveTenantRuntimeSetupBoot(setupEnvironment, paths);
  expect(repair.paths).toBe(paths);
  expect(getManagedRuntimeDependencies()).toMatchObject({ paths, configuration });

  expect(v.safeParse(ManagedConfigSchema, { ...configuration, managedChats: [] }).success).toBe(false);
  expect(
    v.safeParse(ManagedConfigSchema, {
      ...configuration,
      github: { ...configuration.github, allowedRepositories: [] },
    }).success,
  ).toBe(false);
});

it("fails setup closed before starting a runtime when its environment contract is incomplete", () => {
  const paths = managedPaths({ dataDirectory: "/private/tenant-202" });
  expect(resolveTenantRuntimeSetupBoot(setupEnvironment, paths)).toMatchObject({
    mode: "setup",
    runtimeId: "runtime-202",
    bridgeSecret: "bridge-secret-202",
    port: 3202,
  });
  expect(() =>
    resolveTenantRuntimeSetupBoot(
      {
        ...setupEnvironment,
        TENANT_DB_TOKEN: undefined,
      },
      paths,
    ),
  ).toThrow("TENANT_DB_URL and TENANT_DB_TOKEN");
  expect(() =>
    resolveTenantRuntimeSetupBoot({ ...setupEnvironment, AMBIENT_AGENT_RUNTIME_PROFILE: "operate" }, paths),
  ).toThrow("requires AMBIENT_AGENT_RUNTIME_PROFILE=setup");
  expect(() => resolveTenantRuntimeSetupBoot({ ...setupEnvironment, PORT: "invalid" }, paths)).toThrow("runtime port");
});
