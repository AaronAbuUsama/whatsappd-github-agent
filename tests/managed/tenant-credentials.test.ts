import type { OAuthCredential } from "@earendil-works/pi-ai";
import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { SessionStore, WhatsAppSession } from "whatsappd";

import {
  createLibsqlChatGptCredentialStore,
  libsqlStore,
  tenantCredentialDatabaseFromEnvironment,
  withTenantCredentialRollback,
  withTenantWhatsAppCredentialRollback,
} from "../../packages/installation/src/tenant-credentials.ts";
import {
  createChatGptAuthentication,
  type ChatGptOAuthAdapter,
} from "../../packages/engine/src/model/chatgpt-authentication.ts";
import { createManagedChatGptAuthentication } from "../../packages/installation/src/chatgpt-authentication.ts";
import { inspectWhatsAppSession } from "../../packages/installation/src/diagnostics.ts";
import { managedPaths } from "../../packages/installation/src/paths.ts";
import { createWhatsAppAccount } from "../../packages/installation/src/whatsapp-account.ts";

const roots: string[] = [];
const execFileAsync = promisify(execFile);

afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })));
});

const fixture = async (name: string) => {
  const root = await mkdtemp(join(tmpdir(), `ambient-agent-${name}-`));
  roots.push(root);
  return { root, url: `file:${join(root, "tenant.sqlite")}` };
};

const credential = (overrides: Partial<OAuthCredential> = {}): OAuthCredential => ({
  type: "oauth",
  access: "access-secret",
  refresh: "refresh-secret",
  expires: 2_000_000_000_000,
  accountId: "provider-account",
  ...overrides,
});

const oauthAdapter = (overrides: Partial<ChatGptOAuthAdapter> = {}): ChatGptOAuthAdapter => ({
  login: vi.fn(async () => credential()),
  refresh: vi.fn(async () => credential()),
  authorization: vi.fn(async (current) => ({ apiKey: current.access })),
  ...overrides,
});

describe("tenant credential storage", () => {
  it("persists WhatsApp auth-state batches across store instances", async () => {
    const { url } = await fixture("whatsapp-libsql");
    const first = libsqlStore({ url });

    await first.write({
      creds: JSON.stringify({ registered: true, me: { id: "15550000000@s.whatsapp.net" } }),
      "pre-key:1": "first-pre-key",
    });

    const reconnected = libsqlStore({ url });
    await expect(reconnected.read("creds")).resolves.toContain('"registered":true');
    await expect(reconnected.read("pre-key:1")).resolves.toBe("first-pre-key");

    await reconnected.write({ "pre-key:1": null, "session:peer": "rotated-session" });
    await expect(first.read("pre-key:1")).resolves.toBeNull();
    await expect(first.read("session:peer")).resolves.toBe("rotated-session");

    await reconnected.clear();
    await expect(first.read("creds")).resolves.toBeNull();
    await expect(first.read("session:peer")).resolves.toBeNull();
  });

  it("persists model credentials and refreshes once across independent store instances", async () => {
    const { url } = await fixture("model-libsql");
    const expired = credential({ expires: 1 });
    await createLibsqlChatGptCredentialStore({ url }).replace("openai-codex", expired);
    const rotated = credential({ access: "rotated-access", refresh: "rotated-refresh", expires: 3_000 });
    const oauth = oauthAdapter({
      refresh: vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 25));
        return rotated;
      }),
    });
    const first = createChatGptAuthentication({
      store: createLibsqlChatGptCredentialStore({ url }),
      oauth,
      now: () => 2_000,
    });
    const second = createChatGptAuthentication({
      store: createLibsqlChatGptCredentialStore({ url }),
      oauth,
      now: () => 2_000,
    });

    await expect(Promise.all([first.authorization(), second.authorization()])).resolves.toEqual([
      { apiKey: "rotated-access" },
      { apiKey: "rotated-access" },
    ]);
    expect(oauth.refresh).toHaveBeenCalledTimes(1);
    await expect(createLibsqlChatGptCredentialStore({ url }).read("openai-codex")).resolves.toEqual(rotated);
  });

  it("keeps the database writable while provider I/O runs during credential modification", async () => {
    const { url } = await fixture("model-provider-io");
    const models = createLibsqlChatGptCredentialStore({ url });
    await models.replace("openai-codex", credential({ expires: 1 }));

    let signalProviderStarted!: () => void;
    const providerStarted = new Promise<void>((resolve) => {
      signalProviderStarted = resolve;
    });
    let releaseProvider!: () => void;
    const providerReleased = new Promise<void>((resolve) => {
      releaseProvider = resolve;
    });
    const modification = models.modify("openai-codex", async () => {
      signalProviderStarted();
      await providerReleased;
      return credential({ access: "slow-provider-rotation", expires: 3_000 });
    });

    await providerStarted;
    const unrelatedWrite = libsqlStore({ url }).write({ "provider-io-probe": "written" });
    try {
      await expect(
        Promise.race([
          unrelatedWrite.then(() => "written"),
          new Promise<string>((resolve) => setTimeout(() => resolve("timed-out"), 1_000)),
        ]),
      ).resolves.toBe("written");
    } finally {
      releaseProvider();
      await Promise.all([modification, unrelatedWrite]);
    }

    await expect(libsqlStore({ url }).read("provider-io-probe")).resolves.toBe("written");
    await expect(models.read("openai-codex")).resolves.toMatchObject({ access: "slow-provider-rotation" });
  });

  it("serializes model credential rotation across independent processes", async () => {
    const { url } = await fixture("cross-process-model-libsql");
    await createLibsqlChatGptCredentialStore({ url }).replace("openai-codex", credential({ expires: 1 }));

    const runChild = async () => {
      try {
        const environment = Object.fromEntries(
          Object.entries(process.env).filter(([key]) => key !== "NODE_OPTIONS" && !key.startsWith("VITEST")),
        );
        return await execFileAsync(
          join(process.cwd(), "node_modules", ".bin", "tsx"),
          [join(process.cwd(), "tests", "fixtures", "tenant-credential-worker.ts"), url],
          { cwd: process.cwd(), env: environment },
        );
      } catch (cause) {
        const stderr = typeof cause === "object" && cause !== null ? Reflect.get(cause, "stderr") : undefined;
        throw new Error(`Cross-process credential worker failed: ${String(stderr)}`);
      }
    };
    const results = await Promise.all(Array.from({ length: 2 }, runChild));
    expect(results.map(({ stdout }) => JSON.parse(stdout) as { refreshed: boolean })).toEqual(
      expect.arrayContaining([{ refreshed: true }, { refreshed: false }]),
    );
    await expect(createLibsqlChatGptCredentialStore({ url }).read("openai-codex")).resolves.toMatchObject({
      access: "cross-process-rotated",
      refresh: "cross-process-refresh",
    });
  }, 15_000);

  it("restores both tenant credential stores when a multi-step workflow fails", async () => {
    const { url } = await fixture("credential-rollback");
    const database = { url };
    const whatsApp = libsqlStore(database);
    const models = createLibsqlChatGptCredentialStore(database);
    const original = credential({ access: "original-access", refresh: "original-refresh" });
    await whatsApp.write({ creds: JSON.stringify({ registered: false }), "pre-key:1": "original-pre-key" });
    await models.replace("openai-codex", original);

    await expect(
      withTenantCredentialRollback(database, async () => {
        await whatsApp.write({ creds: JSON.stringify({ registered: true }), "pre-key:1": null, "session:1": "new" });
        await models.replace("openai-codex", credential({ access: "changed-access" }));
        throw new Error("later workflow validation failed");
      }),
    ).rejects.toThrow("later workflow validation failed");

    await expect(whatsApp.read("creds")).resolves.toContain('"registered":false');
    await expect(whatsApp.read("pre-key:1")).resolves.toBe("original-pre-key");
    await expect(whatsApp.read("session:1")).resolves.toBeNull();
    await expect(models.read("openai-codex")).resolves.toEqual(original);

    const concurrentModelUpdate = credential({ access: "concurrent-access", refresh: "concurrent-refresh" });
    await expect(
      withTenantWhatsAppCredentialRollback(database, async () => {
        await whatsApp.write({ creds: JSON.stringify({ registered: true }) });
        await models.replace("openai-codex", concurrentModelUpdate);
        throw new Error("pairing validation failed");
      }),
    ).rejects.toThrow("pairing validation failed");
    await expect(whatsApp.read("creds")).resolves.toContain('"registered":false');
    await expect(models.read("openai-codex")).resolves.toEqual(concurrentModelUpdate);
  });

  it("uses the tenant database without creating a local model-credential fallback", async () => {
    const { root, url } = await fixture("configured-model-libsql");
    const paths = managedPaths({ dataDirectory: join(root, "managed") });
    const environment = { TENANT_DB_URL: url, TENANT_DB_TOKEN: "local-test-token" };
    const authentication = createManagedChatGptAuthentication(paths, oauthAdapter(), environment);

    await authentication.authenticate({ onDeviceCode: vi.fn() });

    await expect(createLibsqlChatGptCredentialStore({ url }).read("openai-codex")).resolves.toEqual(credential());
    await expect(lstat(paths.chatGptOAuthCredential)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("injects the tenant database store into whatsappd without creating a local fallback", async () => {
    const { root, url } = await fixture("configured-whatsapp-libsql");
    const storeDirectory = join(root, "whatsapp");
    let selectedStore: SessionStore | undefined;
    const session = {
      onMessage: () => () => undefined,
      onUpdate: () => () => undefined,
      onConversationSync: () => () => undefined,
      stop: async () => undefined,
    } as unknown as WhatsAppSession;
    const account = createWhatsAppAccount({
      storeDirectory,
      archive: { append: () => true },
      environment: { TENANT_DB_URL: url, TENANT_DB_TOKEN: "local-test-token" },
      sessionFactory: (store) => {
        selectedStore = store;
        return session;
      },
    });

    await selectedStore!.write({ creds: JSON.stringify({ registered: true }) });

    await expect(selectedStore!.read("creds")).resolves.toContain('"registered":true');
    await expect(lstat(storeDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    await account.stop();
  });

  it("fails closed instead of selecting local storage for partial tenant DB env", async () => {
    expect(() => tenantCredentialDatabaseFromEnvironment({ TENANT_DB_URL: "libsql://tenant.example" })).toThrow(
      "TENANT_DB_URL and TENANT_DB_TOKEN",
    );
    expect(() => tenantCredentialDatabaseFromEnvironment({ TENANT_DB_TOKEN: "scoped-secret" })).toThrow(
      "TENANT_DB_URL and TENANT_DB_TOKEN",
    );
  });

  it("reports an unreadable tenant WhatsApp store without accepting local pairing evidence", async () => {
    const { root } = await fixture("unreadable-whatsapp-libsql");
    const paths = managedPaths({ dataDirectory: join(root, "managed") });
    await mkdir(paths.whatsapp, { recursive: true });
    await writeFile(join(paths.whatsapp, "creds.json"), JSON.stringify({ registered: true }));

    await expect(
      inspectWhatsAppSession(paths, {
        TENANT_DB_URL: `file:${join(root, "missing-parent", "tenant.sqlite")}`,
        TENANT_DB_TOKEN: "local-test-token",
      }),
    ).resolves.toMatchObject({ state: "failed", code: "whatsapp.store-unreadable" });
  });
});
