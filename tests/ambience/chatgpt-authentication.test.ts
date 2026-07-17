import { InMemoryCredentialStore, type CredentialStore, type OAuthCredential } from "@earendil-works/pi-ai";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  ChatGptAuthenticationError,
  createManagedChatGptCredentialStore,
  createChatGptAuthentication,
  type ChatGptOAuthAdapter,
  type DeviceCodeCallbacks,
} from "@ambient-agent/core/model/chatgpt-authentication.ts";
import { createManagedChatGptAuthentication } from "@ambient-agent/core/managed/chatgpt-authentication.ts";
import { managedPaths } from "@ambient-agent/core/managed/paths.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const credential = (overrides: Partial<OAuthCredential> = {}): OAuthCredential => ({
  type: "oauth",
  access: "access-secret",
  refresh: "refresh-secret",
  expires: 2_000_000_000_000,
  accountId: "account-provider-metadata",
  ...overrides,
});

const adapter = (overrides: Partial<ChatGptOAuthAdapter> = {}): ChatGptOAuthAdapter => ({
  login: vi.fn(async (callbacks) => {
    callbacks.onDeviceCode({
      verificationUri: "https://auth.example/device",
      userCode: "ABCD-EFGH",
      expiresInSeconds: 900,
      intervalSeconds: 5,
    });
    return credential();
  }),
  refresh: vi.fn(async () => credential()),
  authorization: vi.fn(async (value) => ({ apiKey: value.access })),
  ...overrides,
});

describe("ChatGPT authentication", () => {
  it("reports the device code and persists the complete provider credential", async () => {
    const store = new InMemoryCredentialStore();
    const oauth = adapter();
    const callbacks: DeviceCodeCallbacks = {
      onDeviceCode: vi.fn(),
      onProgress: vi.fn(),
    };
    const authentication = createChatGptAuthentication({ store, oauth });

    await authentication.authenticate(callbacks);

    expect(callbacks.onDeviceCode).toHaveBeenCalledWith({
      verificationUri: "https://auth.example/device",
      userCode: "ABCD-EFGH",
      expiresInSeconds: 900,
      intervalSeconds: 5,
    });
    expect(callbacks.onProgress).toHaveBeenCalledWith({ phase: "complete" });
    expect(await store.read("openai-codex")).toEqual(credential());
    await expect(authentication.inspect()).resolves.toEqual({ state: "ready" });
  });

  it("reports cancellation as a typed failure without exposing provider details", async () => {
    const authentication = createChatGptAuthentication({
      store: new InMemoryCredentialStore(),
      oauth: adapter({
        login: vi.fn(async () => {
          throw new Error("Login cancelled with accidental-secret-response");
        }),
      }),
    });

    const failure = await authentication
      .authenticate({ onDeviceCode: vi.fn() }, AbortSignal.abort())
      .then(() => undefined)
      .catch((cause: unknown) => cause);

    expect(failure).toBeInstanceOf(ChatGptAuthenticationError);
    expect(failure).toMatchObject({ code: "cancelled" });
    expect(String(failure)).not.toContain("accidental-secret-response");
  });

  it("distinguishes an aborted timeout signal from user cancellation", async () => {
    const signal = AbortSignal.abort(new DOMException("The operation timed out.", "TimeoutError"));
    const authentication = createChatGptAuthentication({
      store: new InMemoryCredentialStore(),
      oauth: adapter({
        login: vi.fn(async () => {
          throw signal.reason;
        }),
      }),
    });

    await expect(authentication.authenticate({ onDeviceCode: vi.fn() }, signal)).rejects.toMatchObject({
      code: "timeout",
    });
  });

  it.each([
    ["Device flow timed out with secret-body", "device-code-expired"],
    ["Provider request timed out with secret-body", "timeout"],
    ["Invalid OpenAI Codex device code response: secret-body", "malformed-response"],
    ["OpenAI Codex device auth failed with status 401: secret-body", "provider-rejected"],
  ] as const)("classifies login failure %s without reflecting provider responses", async (message, code) => {
    const authentication = createChatGptAuthentication({
      store: new InMemoryCredentialStore(),
      oauth: adapter({
        login: vi.fn(async () => {
          throw new Error(message);
        }),
      }),
    });

    const failure = await authentication
      .authenticate({ onDeviceCode: vi.fn() })
      .then(() => undefined)
      .catch((cause: unknown) => cause);

    expect(failure).toMatchObject({ code });
    expect(String(failure)).not.toContain("secret-body");
  });

  it("refreshes an expired credential once across concurrent authorization requests", async () => {
    const store = new InMemoryCredentialStore();
    await store.modify("openai-codex", async () => credential({ expires: 1 }));
    const rotated = credential({ access: "rotated-access", refresh: "rotated-refresh", expires: 3_000 });
    const oauth = adapter({ refresh: vi.fn(async () => rotated) });
    const authentication = createChatGptAuthentication({ store, oauth, now: () => 2_000 });

    await expect(Promise.all([authentication.authorization(), authentication.authorization()])).resolves.toEqual([
      { apiKey: "rotated-access" },
      { apiKey: "rotated-access" },
    ]);
    expect(oauth.refresh).toHaveBeenCalledTimes(1);
    expect(await store.read("openai-codex")).toEqual(rotated);
  });

  it("does not treat a rotated credential as ready when persistence fails", async () => {
    const expired = credential({ expires: 1 });
    const store: CredentialStore = {
      read: vi.fn(async () => expired),
      modify: vi.fn(async (_provider, change) => {
        await change(expired);
        throw new Error("disk write failed with rotated-access-secret");
      }),
      delete: vi.fn(async () => undefined),
    };
    const authentication = createChatGptAuthentication({
      store,
      oauth: adapter({ refresh: vi.fn(async () => credential({ expires: 3_000 })) }),
      now: () => 2_000,
    });

    const failure = await authentication
      .authorization()
      .then(() => undefined)
      .catch((cause: unknown) => cause);

    expect(failure).toMatchObject({ code: "persistence-failed" });
    expect(String(failure)).not.toContain("rotated-access-secret");
    await expect(authentication.inspect()).resolves.toMatchObject({ state: "unusable" });
  });

  it("stores one complete credential atomically in the managed ChatGPT file", async () => {
    const root = await mkdtemp(join(tmpdir(), "ambient-agent-chatgpt-"));
    roots.push(root);
    const path = join(root, "credentials", "chatgpt-oauth.json");
    const store = createManagedChatGptCredentialStore({ path });

    await store.modify("openai-codex", async () => credential());

    expect((await lstat(join(root, "credentials"))).mode & 0o777).toBe(0o700);
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    const persisted = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    expect(persisted).toEqual(credential());
    expect(persisted).not.toHaveProperty("openai-codex");
  });

  it("preserves the previous credential and removes the temporary file when atomic replacement fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "ambient-agent-chatgpt-write-failure-"));
    roots.push(root);
    const directory = join(root, "credentials");
    const path = join(directory, "chatgpt-oauth.json");
    const original = credential({ access: "original-access", refresh: "original-refresh" });
    await createManagedChatGptCredentialStore({ path }).modify("openai-codex", async () => original);
    const store = createManagedChatGptCredentialStore({
      path,
      beforeCommit: async () => {
        throw new Error("injected replacement failure");
      },
    });

    await expect(
      store.modify("openai-codex", async () =>
        credential({ access: "replacement-access", refresh: "replacement-refresh" }),
      ),
    ).rejects.toThrow("injected replacement failure");

    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(original);
    expect((await lstat(path)).mode & 0o777).toBe(0o600);
    expect((await readdir(directory)).filter((entry) => entry.endsWith(".tmp"))).toEqual([]);
  });

  it("keeps inspection read-only and migrates the provisional credential only on an explicit write", async () => {
    const root = await mkdtemp(join(tmpdir(), "ambient-agent-chatgpt-migration-"));
    roots.push(root);
    const paths = managedPaths({ dataDirectory: root });
    const credentials = paths.credentials;
    await mkdir(credentials, { mode: 0o700 });
    await writeFile(
      paths.config,
      JSON.stringify({
        schemaVersion: 1,
        managedChats: ["120363000@g.us"],
        model: { provider: "openai-codex", credential: "pi-auth" },
        github: {
          kind: "personal-token",
          credential: "github",
          defaultRepository: "owner/repo",
          allowedRepositories: ["owner/repo"],
        },
      }),
      { mode: 0o600 },
    );
    await writeFile(paths.legacyPiAuthCredential, JSON.stringify({ "openai-codex": credential() }), { mode: 0o600 });
    const authentication = createManagedChatGptAuthentication(paths, adapter());
    const beforeEntries = await readdir(credentials);
    const beforeConfig = await readFile(paths.config, "utf8");
    const beforeLegacy = await readFile(paths.legacyPiAuthCredential, "utf8");

    await expect(authentication.inspect()).resolves.toEqual({ state: "ready" });
    expect(await readdir(credentials)).toEqual(beforeEntries);
    expect(await readFile(paths.config, "utf8")).toBe(beforeConfig);
    expect(await readFile(paths.legacyPiAuthCredential, "utf8")).toBe(beforeLegacy);
    await expect(lstat(paths.legacyPiAuthCredential)).resolves.toBeDefined();
    await expect(lstat(paths.chatGptOAuthCredential)).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await readFile(paths.config, "utf8"))).toMatchObject({
      model: { provider: "openai-codex", credential: "pi-auth" },
    });

    await authentication.authenticate({ onDeviceCode: vi.fn() });

    await expect(lstat(paths.legacyPiAuthCredential)).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await readFile(paths.chatGptOAuthCredential, "utf8"))).toEqual(credential());
    expect(JSON.parse(await readFile(paths.config, "utf8"))).toMatchObject({
      model: { provider: "openai-codex", credential: "chatgpt-oauth" },
    });
    expect((await lstat(paths.config)).mode & 0o777).toBe(0o600);
  });

  it("refuses a symlinked managed credential directory inside the store boundary", async () => {
    const parent = await mkdtemp(join(tmpdir(), "ambient-agent-chatgpt-boundary-"));
    roots.push(parent);
    const root = join(parent, "managed");
    const outside = join(parent, "outside");
    await mkdir(root, { mode: 0o700 });
    await mkdir(outside, { mode: 0o755 });
    await writeFile(join(outside, "pi-auth.json"), JSON.stringify({ "openai-codex": credential() }), {
      mode: 0o600,
    });
    await symlink(outside, join(root, "credentials"));
    const paths = managedPaths({ dataDirectory: root });
    const authentication = createManagedChatGptAuthentication(paths, adapter());

    await expect(authentication.authorization()).rejects.toMatchObject({ code: "persistence-failed" });
    expect((await lstat(outside)).mode & 0o777).toBe(0o755);
    await expect(lstat(join(outside, "chatgpt-oauth.json.lock"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(outside, "pi-auth.json"))).resolves.toBeDefined();
  });

  it("keeps the legacy credential reference valid when config normalization fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "ambient-agent-chatgpt-migration-failure-"));
    roots.push(root);
    const directory = join(root, "credentials");
    const path = join(directory, "chatgpt-oauth.json");
    const legacyPath = join(directory, "pi-auth.json");
    await mkdir(directory, { mode: 0o700 });
    await writeFile(legacyPath, JSON.stringify({ "openai-codex": credential() }), { mode: 0o600 });
    const store = createManagedChatGptCredentialStore({
      path,
      legacyPath,
      onLegacyMigration: async () => {
        throw new Error("injected config write failure");
      },
    });

    await expect(store.replace("openai-codex", credential())).rejects.toThrow("injected config write failure");
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(credential());
    expect(JSON.parse(await readFile(legacyPath, "utf8"))).toEqual({ "openai-codex": credential() });

    const recovered = createManagedChatGptCredentialStore({
      path,
      legacyPath,
      onLegacyMigration: async () => undefined,
    });
    await expect(recovered.replace("openai-codex", credential())).resolves.toBeUndefined();
    await expect(lstat(legacyPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses the file lock to refresh once across independent service instances", async () => {
    const root = await mkdtemp(join(tmpdir(), "ambient-agent-chatgpt-lock-"));
    roots.push(root);
    const path = join(root, "credentials", "chatgpt-oauth.json");
    const seed = createManagedChatGptCredentialStore({ path });
    await seed.modify("openai-codex", async () => credential({ expires: 1 }));
    const rotated = credential({ access: "shared-rotated", refresh: "shared-refresh", expires: 3_000 });
    const oauth = adapter({
      refresh: vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return rotated;
      }),
    });
    const first = createChatGptAuthentication({
      store: createManagedChatGptCredentialStore({ path }),
      oauth,
      now: () => 2_000,
    });
    const second = createChatGptAuthentication({
      store: createManagedChatGptCredentialStore({ path }),
      oauth,
      now: () => 2_000,
    });

    await expect(Promise.all([first.authorization(), second.authorization()])).resolves.toEqual([
      { apiKey: "shared-rotated" },
      { apiKey: "shared-rotated" },
    ]);
    expect(oauth.refresh).toHaveBeenCalledTimes(1);
  });

  it("waits beyond five seconds for a peer that is refreshing under the credential lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "ambient-agent-chatgpt-slow-refresh-"));
    roots.push(root);
    const path = join(root, "credentials", "chatgpt-oauth.json");
    await createManagedChatGptCredentialStore({ path }).modify("openai-codex", async () => credential({ expires: 1 }));
    let refreshStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      refreshStarted = resolve;
    });
    const oauth = adapter({
      refresh: vi.fn(async () => {
        refreshStarted();
        await new Promise((resolve) => setTimeout(resolve, 5_100));
        return credential({ access: "slow-rotated", refresh: "slow-refresh", expires: 3_000 });
      }),
    });
    const first = createChatGptAuthentication({
      store: createManagedChatGptCredentialStore({ path }),
      oauth,
      now: () => 2_000,
    });
    const second = createChatGptAuthentication({
      store: createManagedChatGptCredentialStore({ path }),
      oauth,
      now: () => 2_000,
    });

    const firstAuthorization = first.authorization();
    await started;
    await expect(Promise.all([firstAuthorization, second.authorization()])).resolves.toEqual([
      { apiKey: "slow-rotated" },
      { apiKey: "slow-rotated" },
    ]);
    expect(oauth.refresh).toHaveBeenCalledTimes(1);
  }, 8_000);

  it("releases the credential lock when cancellation interrupts refresh", async () => {
    const root = await mkdtemp(join(tmpdir(), "ambient-agent-chatgpt-refresh-cancel-"));
    roots.push(root);
    const path = join(root, "credentials", "chatgpt-oauth.json");
    const expired = credential({ expires: 1 });
    await createManagedChatGptCredentialStore({ path }).modify("openai-codex", async () => expired);
    const authentication = createChatGptAuthentication({
      store: createManagedChatGptCredentialStore({ path }),
      oauth: adapter({ refresh: async () => await new Promise<OAuthCredential>(() => undefined) }),
      now: () => 2_000,
    });

    await expect(authentication.authorization(AbortSignal.timeout(20))).rejects.toMatchObject({ code: "timeout" });
    await expect(authentication.inspect()).resolves.toEqual({ state: "expired-refreshable" });
    await expect(createManagedChatGptCredentialStore({ path }).read("openai-codex")).resolves.toEqual(expired);
    await expect(lstat(`${path}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
  });

});
