import type { OAuthCredential } from "@earendil-works/pi-ai";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import type { SessionStore, WhatsAppSession } from "whatsappd";

import {
  createLibsqlChatGptCredentialStore,
  libsqlStore,
  tenantCredentialDatabaseFromEnvironment,
} from "../../packages/installation/src/tenant-credentials.ts";
import {
  createChatGptAuthentication,
  type ChatGptOAuthAdapter,
} from "../../packages/engine/src/model/chatgpt-authentication.ts";
import { createManagedChatGptAuthentication } from "../../packages/installation/src/chatgpt-authentication.ts";
import { managedPaths } from "../../packages/installation/src/paths.ts";
import { createWhatsAppAccount } from "../../packages/installation/src/whatsapp-account.ts";

const roots: string[] = [];

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
});
