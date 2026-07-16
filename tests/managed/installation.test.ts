import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  inspectGitHubCredentialComponent,
  inspectManagedData,
  installManagedData,
  installPreparedManagedData,
  promoteReplacementWhatsAppStore,
} from "../../src/managed/installation.ts";
import { managedPaths, type ManagedPaths } from "../../src/managed/paths.ts";
import { createManagedChatGptCredentialStore } from "../../src/model/chatgpt-authentication.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const fixture = async () => {
  const parent = await mkdtemp(join(tmpdir(), "ambient-agent-test-"));
  roots.push(parent);
  const dataDirectory = join(parent, "managed");
  const githubToken = "github-secret-token";
  const chatGptCredential = {
    type: "oauth" as const,
    access: "chatgpt-access-secret",
    refresh: "chatgpt-refresh-secret",
    expires: 2_000_000_000_000,
    accountId: "provider-metadata",
  };
  const authenticateChatGpt = async (paths: ManagedPaths) => {
    const store = createManagedChatGptCredentialStore({ path: paths.chatGptOAuthCredential });
    await store.modify("openai-codex", async () => chatGptCredential);
  };
  return { parent, dataDirectory, githubToken, chatGptCredential, authenticateChatGpt };
};

describe.skipIf(process.platform === "win32")("managed installation on POSIX", () => {
  it("creates the complete skeleton with private permissions and secret references", async () => {
    const input = {
      ...(await fixture()),
      managedChats: ["120363000@g.us"],
      defaultRepository: "owner/repo",
    };
    const previousUmask = process.umask(0o777);
    const result = await installManagedData(input).finally(() => process.umask(previousUmask));
    const paths = managedPaths(input);

    expect(result.created).toBe(true);
    expect(result.inspection.state).toBe("ready");
    expect((await lstat(paths.root)).mode & 0o777).toBe(0o700);
    for (const path of [paths.credentials, paths.whatsapp, paths.logs]) {
      expect((await lstat(path)).mode & 0o777).toBe(0o700);
    }
    for (const path of [
      paths.config,
      paths.githubCredential,
      paths.chatGptOAuthCredential,
      paths.applicationDatabase,
      paths.flueDatabase,
    ]) {
      expect((await lstat(path)).mode & 0o777).toBe(0o600);
    }

    const config = await readFile(paths.config, "utf8");
    expect(config).toContain('"credential": "github"');
    expect(config).toContain('"credential": "chatgpt-oauth"');
    expect(config).not.toContain(input.githubToken);
    expect(config).not.toContain(input.chatGptCredential.access);
    expect(await readFile(paths.githubCredential, "utf8")).toContain(input.githubToken);
  });

  it("is idempotent and never silently replaces credentials", async () => {
    const base = {
      ...(await fixture()),
      managedChats: ["120363000@g.us"],
      defaultRepository: "owner/repo",
    };
    await installManagedData(base);
    const paths = managedPaths(base);
    const original = await readFile(paths.githubCredential, "utf8");

    const second = await installManagedData({ ...base, githubToken: "replacement-secret" });

    expect(second.created).toBe(false);
    expect(await readFile(paths.githubCredential, "utf8")).toBe(original);
    expect(original).not.toContain("replacement-secret");
  });

  it("removes staged files when ChatGPT authentication is cancelled", async () => {
    const base = await fixture();
    await expect(
      installManagedData({
        ...base,
        managedChats: ["120363000@g.us"],
        defaultRepository: "owner/repo",
        authenticateChatGpt: async () => {
          throw new Error("ChatGPT device-code authentication was cancelled.");
        },
      }),
    ).rejects.toThrow("cancelled");

    await expect(lstat(base.dataDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(inspectManagedData(base)).resolves.toMatchObject({ state: "absent" });
  });

  it("discovers setup values inside the private stage before atomically promoting them", async () => {
    const base = await fixture();
    let stagedRoot = "";
    const result = await installPreparedManagedData({
      dataDirectory: base.dataDirectory,
      prepare: async (paths) => {
        stagedRoot = paths.root;
        expect(paths.root).not.toBe(base.dataDirectory);
        expect((await lstat(paths.root)).mode & 0o777).toBe(0o700);
        expect((await lstat(paths.credentials)).mode & 0o777).toBe(0o700);
        expect((await lstat(paths.whatsapp)).mode & 0o777).toBe(0o700);
        expect((await lstat(paths.applicationDatabase)).mode & 0o777).toBe(0o600);
        await base.authenticateChatGpt(paths);
        return {
          managedChats: ["120363000@g.us"],
          defaultRepository: "owner/repo",
          githubToken: base.githubToken,
        };
      },
    });

    expect(result).toMatchObject({ created: true, inspection: { state: "ready" } });
    expect(stagedRoot).not.toBe(base.dataDirectory);
    await expect(lstat(stagedRoot)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(managedPaths(base).config, "utf8")).toContain("120363000@g.us");
  });

  it("validates the complete staging tree before committing it", async () => {
    const base = await fixture();
    await expect(
      installManagedData({
        ...base,
        managedChats: ["120363000@g.us"],
        defaultRepository: "owner/repo",
        authenticateChatGpt: async () => undefined,
      }),
    ).rejects.toThrow("Managed staging verification failed");

    await expect(lstat(base.dataDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(inspectManagedData(base)).resolves.toMatchObject({ state: "absent" });
  });

  it("refuses a concurrent setup for the same managed directory", async () => {
    const base = await fixture();
    let releaseAuthentication!: () => void;
    let authenticationStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      authenticationStarted = resolve;
    });
    const hold = new Promise<void>((resolve) => {
      releaseAuthentication = resolve;
    });
    const first = installManagedData({
      ...base,
      managedChats: ["120363000@g.us"],
      defaultRepository: "owner/repo",
      authenticateChatGpt: async (paths) => {
        await base.authenticateChatGpt(paths);
        authenticationStarted();
        await hold;
      },
    });
    await started;

    await expect(
      installManagedData({
        ...base,
        managedChats: ["120363000@g.us"],
        defaultRepository: "owner/repo",
      }),
    ).rejects.toThrow(/setup.*in progress/i);

    releaseAuthentication();
    await expect(first).resolves.toMatchObject({ created: true });
  });

  it("distinguishes an absent install from a corrupt install", async () => {
    const base = await fixture();
    expect((await inspectManagedData(base)).state).toBe("absent");

    await installManagedData({
      ...base,
      managedChats: ["120363000@g.us"],
      defaultRepository: "owner/repo",
    });
    await writeFile(managedPaths(base).config, "not json", "utf8");

    const corrupt = await inspectManagedData(base);
    expect(corrupt.state).toBe("corrupt");
    expect(corrupt.diagnostics.map((item) => item.code)).toContain("json.invalid");
  });

  it("classifies missing skeleton pieces as incomplete, never corrupt", async () => {
    const base = await fixture();
    await installManagedData({
      ...base,
      managedChats: ["120363000@g.us"],
      defaultRepository: "owner/repo",
    });
    const paths = managedPaths(base);
    await rm(paths.config);
    await rm(paths.logs, { recursive: true });

    const incomplete = await inspectManagedData(base);
    expect(incomplete.state).toBe("incomplete");
    expect(incomplete.diagnostics.map((item) => item.code)).toEqual(
      expect.arrayContaining(["path.missing-file", "path.missing-directory"]),
    );
  });

  it("keeps the installation ready when only component-owned paths are missing", async () => {
    const base = await fixture();
    await installManagedData({
      ...base,
      managedChats: ["120363000@g.us"],
      defaultRepository: "owner/repo",
    });
    const paths = managedPaths(base);
    await rm(paths.whatsapp, { recursive: true });
    await rm(paths.githubCredential);
    await rm(paths.chatGptOAuthCredential);

    const inspection = await inspectManagedData(base);
    expect(inspection.state).toBe("ready");
    expect(inspection.diagnostics).toEqual([]);
  });

  it("classifies a broken GitHub credential file into the component, not the installation", async () => {
    const base = await fixture();
    await installManagedData({
      ...base,
      managedChats: ["120363000@g.us"],
      defaultRepository: "owner/repo",
    });
    const paths = managedPaths(base);
    await writeFile(paths.githubCredential, "not json", { mode: 0o600 });

    expect((await inspectManagedData(base)).state).toBe("ready");
    const component = await inspectGitHubCredentialComponent(paths);
    expect(component.state).toBe("reauthentication-required");
    expect(component.diagnostics.map((item) => item.code)).toContain("json.invalid");

    await rm(paths.githubCredential);
    await expect(inspectGitHubCredentialComponent(paths)).resolves.toMatchObject({
      state: "reauthentication-required",
      diagnostics: [{ code: "path.missing-file" }],
    });
  });

  it("promotes only the replacement WhatsApp store and touches nothing else", async () => {
    const base = await fixture();
    await installManagedData({
      ...base,
      managedChats: ["120363000@g.us"],
      defaultRepository: "owner/repo",
    });
    const paths = managedPaths(base);
    await rm(paths.whatsapp, { recursive: true });
    const configBefore = await readFile(paths.config, "utf8");
    const credentialBefore = await readFile(paths.githubCredential, "utf8");
    const replacement = join(base.parent, "replacement-whatsapp");
    await mkdir(replacement, { mode: 0o700 });
    await writeFile(join(replacement, "creds.json"), JSON.stringify({ registered: true }), { mode: 0o600 });

    await promoteReplacementWhatsAppStore(paths, replacement);

    await expect(readFile(join(paths.whatsapp, "creds.json"), "utf8")).resolves.toContain('"registered":true');
    await expect(lstat(replacement)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(paths.config, "utf8")).resolves.toBe(configBefore);
    await expect(readFile(paths.githubCredential, "utf8")).resolves.toBe(credentialBefore);
    expect((await inspectManagedData(base)).state).toBe("ready");
  });

  it("rejects oversized managed JSON without reading the full payload", async () => {
    const base = await fixture();
    await installManagedData({
      ...base,
      managedChats: ["120363000@g.us"],
      defaultRepository: "owner/repo",
    });
    await writeFile(managedPaths(base).config, Buffer.alloc(1024 * 1024 + 1, 0x20), { mode: 0o600 });

    const inspection = await inspectManagedData(base);
    expect(inspection.state).toBe("corrupt");
    expect(inspection.diagnostics.map((item) => item.code)).toContain("file.too-large");
  });

  it("reports actionable credential permission failures without exposing credential contents", async () => {
    const base = await fixture();
    await installManagedData({
      ...base,
      managedChats: ["120363000@g.us"],
      defaultRepository: "owner/repo",
    });
    const paths = managedPaths(base);
    await chmod(paths.githubCredential, 0o644);

    expect((await inspectManagedData(base)).state).toBe("ready");
    const component = await inspectGitHubCredentialComponent(paths);
    const output = JSON.stringify(component);
    expect(component.state).toBe("reauthentication-required");
    expect(output).toContain("mode 0600");
    expect(output).not.toContain(base.githubToken);
    expect(output).not.toContain(base.chatGptCredential.access);
  });

  it("diagnoses invalid credential references without printing secrets", async () => {
    const base = await fixture();
    await installManagedData({
      ...base,
      managedChats: ["120363000@g.us"],
      defaultRepository: "owner/repo",
    });
    const configPath = managedPaths(base).config;
    const config = JSON.parse(await readFile(configPath, "utf8")) as {
      model: { credential: string };
    };
    config.model.credential = "../../unexpected";
    await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });

    const inspection = await inspectManagedData(base);
    expect(inspection.diagnostics.map((item) => item.code)).toContain("credential.reference");
    expect(JSON.stringify(inspection)).not.toContain(base.githubToken);
  });

  it("reports invalid schema field paths without reporting their values", async () => {
    const base = await fixture();
    await installManagedData({
      ...base,
      managedChats: ["120363000@g.us"],
      defaultRepository: "owner/repo",
    });
    const paths = managedPaths(base);
    const config = JSON.parse(await readFile(paths.config, "utf8")) as { managedChats: string[] };
    config.managedChats = [];
    await writeFile(paths.config, JSON.stringify(config), { mode: 0o600 });
    await writeFile(
      paths.githubCredential,
      JSON.stringify({ schemaVersion: 1, kind: "personal-token", token: 123456789 }),
      { mode: 0o600 },
    );

    const output = JSON.stringify(await inspectManagedData(base));
    expect(output).toContain("managedChats");
    expect(output).not.toContain("123456789");
    const component = JSON.stringify(await inspectGitHubCredentialComponent(paths));
    expect(component).toContain("token");
    expect(component).not.toContain("123456789");
  });

  it("never reflects unknown property names from credential files into component diagnostics", async () => {
    const base = await fixture();
    await installManagedData({
      ...base,
      managedChats: ["120363000@g.us"],
      defaultRepository: "owner/repo",
    });
    const paths = managedPaths(base);
    const secretAsPropertyName = "github_pat_secret_must_not_be_echoed";
    await writeFile(
      paths.githubCredential,
      JSON.stringify({
        schemaVersion: 1,
        kind: "personal-token",
        token: "still-valid",
        [secretAsPropertyName]: true,
      }),
      { mode: 0o600 },
    );

    const output = JSON.stringify(await inspectGitHubCredentialComponent(paths));
    expect(output).toContain("<unknown field>");
    expect(output).not.toContain(secretAsPropertyName);
  });

  it("never follows a managed JSON symlink while diagnosing it", async () => {
    const base = await fixture();
    await installManagedData({
      ...base,
      managedChats: ["120363000@g.us"],
      defaultRepository: "owner/repo",
    });
    const configPath = managedPaths(base).config;
    const outside = join(base.parent, "outside-secret.json");
    await writeFile(outside, JSON.stringify({ secret: "must-never-be-read" }), { mode: 0o600 });
    await rm(configPath);
    await symlink(outside, configPath);

    const inspection = await inspectManagedData(base);
    expect(inspection.state).toBe("corrupt");
    expect(inspection.diagnostics.map((item) => item.code)).toContain("path.not-file");
    expect(JSON.stringify(inspection)).not.toContain("must-never-be-read");
  });

  it("stops before credential children when the credential directory is a symlink", async () => {
    const base = await fixture();
    await installManagedData({
      ...base,
      managedChats: ["120363000@g.us"],
      defaultRepository: "owner/repo",
    });
    const paths = managedPaths(base);
    const outside = join(base.parent, "outside-credentials");
    const secretAsPropertyName = "outside_secret_property_name";
    await mkdir(outside, { mode: 0o700 });
    await writeFile(
      join(outside, "github.json"),
      JSON.stringify({ schemaVersion: 1, kind: "personal-token", token: "valid", [secretAsPropertyName]: true }),
      { mode: 0o600 },
    );
    await rm(paths.credentials, { recursive: true });
    await symlink(outside, paths.credentials);

    const inspection = await inspectManagedData(base);
    expect(inspection.state).toBe("corrupt");
    expect(inspection.diagnostics.map((item) => item.code)).toContain("path.not-directory");
    expect(JSON.stringify(inspection)).not.toContain(secretAsPropertyName);
  });

  it("classifies a dangling root symlink as corrupt instead of absent", async () => {
    const base = await fixture();
    await symlink(join(base.parent, "missing-target"), base.dataDirectory);
    const inspection = await inspectManagedData(base);
    expect(inspection.state).toBe("corrupt");
    expect(inspection.diagnostics.map((item) => item.code)).toContain("path.not-directory");
  });
});

describe("managed installation platform support", () => {
  it("fails closed on Windows until private ACL enforcement exists", async () => {
    const base = await fixture();
    await expect(
      installManagedData({
        ...base,
        platform: "win32",
        managedChats: ["120363000@g.us"],
        defaultRepository: "owner/repo",
      }),
    ).rejects.toThrow("fails closed");
    await expect(inspectManagedData({ ...base, platform: "win32" })).resolves.toMatchObject({
      state: "absent",
      diagnostics: [{ code: "platform.unsupported" }],
    });
  });
});
