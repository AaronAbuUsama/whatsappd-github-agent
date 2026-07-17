import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { runCli, type CliOutput } from "../../src/cli/program.ts";
import { inspectManagedData } from "@ambient-agent/core/managed/installation.ts";
import { deferWhatsAppRuntimeStart, getManagedRuntimeDependencies } from "@ambient-agent/core/managed/runtime-dependencies.ts";
import { managedPaths, type ManagedPaths } from "@ambient-agent/core/managed/paths.ts";
import type { ChatGptOAuthAdapter } from "@ambient-agent/core/model/chatgpt-authentication.ts";
import { ChatGptReadinessError } from "@ambient-agent/core/model/pi-subscription.ts";
import { WhatsAppAccountError } from "@ambient-agent/core/whatsapp/account.ts";
import { createIssueOperationStore } from "@ambient-agent/core/capabilities/issue-management/operation-store.ts";
import type { UncertainWorkController } from "@ambient-agent/core/managed/uncertain-work.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const harness = () => {
  let stdout = "";
  let stderr = "";
  const output: CliOutput = {
    stdout: (text) => {
      stdout += text;
    },
    stderr: (text) => {
      stderr += text;
    },
  };
  const chatGptOAuth: ChatGptOAuthAdapter = {
    login: async (callbacks) => {
      callbacks.onDeviceCode({
        verificationUri: "https://auth.example/device",
        userCode: "ABCD-EFGH",
        expiresInSeconds: 900,
        intervalSeconds: 5,
      });
      return {
        type: "oauth",
        access: "access-secret",
        refresh: "refresh-secret",
        expires: 2_000_000_000_000,
        accountId: "provider-metadata",
      };
    },
    refresh: async (credential) => ({
      ...credential,
      access: "rotated-access-secret",
      refresh: "rotated-refresh-secret",
      expires: 2_000_000_000_000,
    }),
    authorization: async (credential) => ({ apiKey: credential.access }),
  };
  const setupPrompts = {
    selectChat: async (candidates: readonly { readonly jid: string }[]) => candidates[0]!.jid,
    repository: async (discovered?: string) => discovered ?? "owner/repo",
    githubCredential: async (discovered?: { readonly token: string; readonly source: string }) =>
      discovered ?? { token: "prompted-github-secret", source: "secure prompt" },
    review: async () => true,
    validationError: () => undefined,
  };
  const firstRunServices = {
    whatsappFor: (paths: ManagedPaths) => ({
      authenticate: async () => {
        await writeFile(join(paths.whatsapp, "creds.json"), JSON.stringify({ registered: true }), { mode: 0o600 });
        return { jid: "15550000000@s.whatsapp.net" };
      },
      synchronizedChats: async () => [
        { jid: "120363000@g.us", name: "Managed Test Chat", kind: "group" as const, lastActivityAt: 1_000 },
        { jid: "120363999@g.us", name: "Smoke Canary", kind: "group" as const, lastActivityAt: 900 },
      ],
      session: () => {
        throw new Error("not used during setup");
      },
      stop: async () => undefined,
    }),
    discoverRepository: async () => undefined,
    discoverCredential: async () => undefined,
    verifyGitHub: async (_token: string, repository: string) => repository,
  };
  return {
    output,
    stdout: () => stdout,
    stderr: () => stderr,
    chatGptOAuth,
    interactive: true,
    setupPrompts,
    firstRunServices,
  };
};

const files = async () => {
  const parent = await mkdtemp(join(tmpdir(), "ambient-agent-cli-"));
  roots.push(parent);
  const token = join(parent, "token.txt");
  await writeFile(token, "github-secret-token\n", { mode: 0o600 });
  return { parent, data: join(parent, "managed"), token };
};

describe("managed CLI", () => {
  it("starts the generated runtime from the selected managed installation", async () => {
    const paths = await files();
    await runCli(
      [
        "--data-dir",
        paths.data,
        "init",
        "--chat",
        "120363000@g.us",
        "--repository",
        "owner/repo",
        "--github-token-file",
        paths.token,
      ],
      harness(),
    );
    const cli = harness();
    const starts: ManagedPaths[] = [];

    expect(
      await runCli(["--data-dir", paths.data, "start"], {
        ...cli,
        startRuntime: async (managed) => {
          starts.push(managed);
        },
      }),
    ).toBe(0);
    expect(starts).toEqual([managedPaths({ dataDirectory: paths.data })]);
    expect(cli.stderr()).toBe("");
  });

  it("refuses to start an unconfigured or structurally damaged installation", async () => {
    const paths = await files();
    const unconfigured = harness();
    const startRuntime = vi.fn(async () => undefined);

    expect(await runCli(["--data-dir", paths.data, "start"], { ...unconfigured, startRuntime })).toBe(1);
    expect(unconfigured.stderr()).toContain("not configured");
    expect(startRuntime).not.toHaveBeenCalled();

    await runCli(
      [
        "--data-dir",
        paths.data,
        "init",
        "--chat",
        "120363000@g.us",
        "--repository",
        "owner/repo",
        "--github-token-file",
        paths.token,
      ],
      harness(),
    );
    const managed = managedPaths({ dataDirectory: paths.data });
    const outside = join(paths.parent, "start-outside-credentials");
    await mkdir(outside, { mode: 0o700 });
    await rm(managed.credentials, { recursive: true });
    await symlink(outside, managed.credentials);
    const damaged = harness();

    expect(await runCli(["--data-dir", paths.data, "start"], { ...damaged, startRuntime })).toBe(1);
    expect(damaged.stderr()).toContain("Refusing to start corrupt managed data");
    expect(startRuntime).not.toHaveBeenCalled();
    await expect(lstat(join(outside, "chatgpt-oauth.json.lock"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("passes typed managed dependencies without exporting credentials through process.env", async () => {
    const paths = await files();
    const init = harness();
    const initExitCode = await runCli(
      [
        "--data-dir",
        paths.data,
        "init",
        "--chat",
        "120363000@g.us",
        "--repository",
        "owner/repo",
        "--github-token-file",
        paths.token,
      ],
      init,
    );
    expect(initExitCode, init.stderr()).toBe(0);
    await writeFile(join(paths.data, ".env"), "GITHUB_WEBHOOK_SECRET=dotenv-webhook-secret\nPORT=7777\n");

    const managed = managedPaths({ dataDirectory: paths.data });
    const managedWebhookSecret = JSON.parse(await readFile(managed.githubCredential, "utf8")).webhookSecret as string;
    const expectedDirectory = await realpath(paths.data);
    const keys = ["GITHUB_ALLOWED_REPOS", "GITHUB_REPO", "GITHUB_TOKEN", "GITHUB_WEBHOOK_SECRET", "PORT"] as const;
    const previousDirectory = process.cwd();
    const previousEnvironment = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    for (const key of keys) delete process.env[key];
    process.env.PORT = "8888";
    process.env.GITHUB_REPO = "external/override-must-not-win";
    process.env.GITHUB_ALLOWED_REPOS = "external/override-must-not-win";
    process.env.GITHUB_TOKEN = "external-secret-must-not-win";
    process.env.GITHUB_WEBHOOK_SECRET = "external-webhook-must-not-win";

    try {
      const cli = harness();
      let imports = 0;
      const exitCode = await runCli(["--data-dir", paths.data, "start"], {
        ...cli,
        importRuntime: async () => {
          imports += 1;
          deferWhatsAppRuntimeStart(() => undefined);
          const runtime = getManagedRuntimeDependencies();
          await expect(runtime.authentication.inspect()).resolves.toEqual({ state: "ready" });
          expect(runtime).toMatchObject({
            configuration: {
              managedChats: ["120363000@g.us"],
              github: { defaultRepository: "owner/repo", allowedRepositories: ["owner/repo"] },
            },
            githubCredential: {
              token: "github-secret-token",
              webhookSecret: managedWebhookSecret,
            },
            paths: managed,
          });
          expect(process.cwd()).toBe(expectedDirectory);
          expect(process.env).toMatchObject({
            GITHUB_ALLOWED_REPOS: "external/override-must-not-win",
            GITHUB_REPO: "external/override-must-not-win",
            GITHUB_TOKEN: "external-secret-must-not-win",
            GITHUB_WEBHOOK_SECRET: "external-webhook-must-not-win",
            PORT: "3000",
          });
        },
      });
      expect(exitCode, cli.stderr()).toBe(0);
      expect(imports).toBe(1);
      expect(cli.stderr()).toBe("");
    } finally {
      process.chdir(previousDirectory);
      for (const key of keys) {
        const value = previousEnvironment[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });

  it("fails an occupied configured port with one actionable message before WhatsApp ever starts", async () => {
    const paths = await files();
    await runCli(
      [
        "--data-dir",
        paths.data,
        "init",
        "--chat",
        "120363000@g.us",
        "--repository",
        "owner/repo",
        "--github-token-file",
        paths.token,
      ],
      harness(),
    );
    expect(await runCli(["--data-dir", paths.data, "config", "--port", "42069"], { ...harness(), interactive: false })).toBe(
      0,
    );

    const cli = harness();
    let whatsappStarted = false;
    const exitCode = await runCli(["--data-dir", paths.data, "start"], {
      ...cli,
      importRuntime: async () => {
        deferWhatsAppRuntimeStart(() => {
          whatsappStarted = true;
        });
        const failure = new Error("listen EADDRINUSE: address already in use 127.0.0.1:42069") as NodeJS.ErrnoException;
        failure.code = "EADDRINUSE";
        throw failure;
      },
    });
    expect(exitCode).toBe(1);
    expect(whatsappStarted).toBe(false);
    expect(cli.stderr()).toContain("Port 42069 is already in use");
    expect(cli.stderr()).toContain("ambient-agent config --port");

    // The generated server aggregates the bind failure with cleanup errors when its
    // own shutdown also fails; the port message must survive that wrapping.
    const wrapped = harness();
    const wrappedExitCode = await runCli(["--data-dir", paths.data, "start"], {
      ...wrapped,
      importRuntime: async () => {
        const failure = new Error("listen EADDRINUSE: address already in use 127.0.0.1:42069") as NodeJS.ErrnoException;
        failure.code = "EADDRINUSE";
        throw new AggregateError([failure, new Error("cleanup failed")], "[flue] Node server shutdown failed.");
      },
    });
    expect(wrappedExitCode).toBe(1);
    expect(wrapped.stderr()).toContain("Port 42069 is already in use");
  });

  it("propagates non-port import failures without the port remediation", async () => {
    const paths = await files();
    await runCli(
      [
        "--data-dir",
        paths.data,
        "init",
        "--chat",
        "120363000@g.us",
        "--repository",
        "owner/repo",
        "--github-token-file",
        paths.token,
      ],
      harness(),
    );

    const cli = harness();
    const exitCode = await runCli(["--data-dir", paths.data, "start"], {
      ...cli,
      importRuntime: async () => {
        throw new Error("generated server exploded");
      },
    });
    expect(exitCode).toBe(1);
    expect(cli.stderr()).toContain("generated server exploded");
    expect(cli.stderr()).not.toContain("already in use");
  });

  it("starts the deferred WhatsApp runtime only after the server import binds its port", async () => {
    const paths = await files();
    await runCli(
      [
        "--data-dir",
        paths.data,
        "init",
        "--chat",
        "120363000@g.us",
        "--repository",
        "owner/repo",
        "--github-token-file",
        paths.token,
      ],
      harness(),
    );

    const cli = harness();
    const events: string[] = [];
    const exitCode = await runCli(["--data-dir", paths.data, "start"], {
      ...cli,
      importRuntime: async () => {
        deferWhatsAppRuntimeStart(() => events.push("whatsapp-started"));
        events.push("listener-bound");
      },
    });
    expect(exitCode, cli.stderr()).toBe(0);
    expect(events).toEqual(["listener-bound", "whatsapp-started"]);
  });

  it("supports a fully scripted setup and deterministic status", async () => {
    const paths = await files();
    const init = harness();
    const initExitCode = await runCli(
      [
        "--data-dir",
        paths.data,
        "init",
        "--chat",
        "120363000@g.us",
        "--repository",
        "owner/repo",
        "--github-token-file",
        paths.token,
      ],
      init,
    );
    expect(initExitCode, init.stderr()).toBe(0);
    expect(init.stdout()).toContain("Created secure managed installation");
    expect(init.stdout()).toContain("https://auth.example/device");
    expect(init.stdout()).toContain("ABCD-EFGH");
    expect(init.stdout()).not.toContain("github-secret-token");

    const status = harness();
    expect(await runCli(["--data-dir", paths.data, "status", "--json"], status)).toBe(0);
    expect(JSON.parse(status.stdout())).toMatchObject({
      state: "ready",
      dataDirectory: paths.data,
      chatgpt: "ready",
      modelAuthentication: { state: "ready" },
    });
    expect(status.stdout()).not.toContain("access-secret");
    expect(status.stderr()).toBe("");
  });

  it("imports a stopped local WhatsApp store into the private setup stage", async () => {
    const paths = await files();
    const source = join(paths.parent, "legacy-whatsapp");
    await mkdir(source, { mode: 0o755 });
    await writeFile(join(source, "creds.json"), JSON.stringify({ registered: true }), { mode: 0o644 });
    await writeFile(join(source, "session-key.json"), "private-session-material", { mode: 0o644 });

    const cli = harness();
    const exitCode = await runCli(
      [
        "--data-dir",
        paths.data,
        "init",
        "--whatsapp-store",
        source,
        "--chat",
        "120363000@g.us",
        "--repository",
        "owner/repo",
        "--github-token-file",
        paths.token,
      ],
      {
        ...cli,
        firstRunServices: {
          ...cli.firstRunServices,
          whatsappFor: (managed) => ({
            authenticate: async () => {
              await expect(readFile(join(managed.whatsapp, "creds.json"), "utf8")).resolves.toContain(
                '"registered":true',
              );
              return { jid: "15550000000@s.whatsapp.net" };
            },
            synchronizedChats: async () => [
              { jid: "120363000@g.us", name: "Managed Test Chat", kind: "group", lastActivityAt: 1_000 },
            ],
            session: () => {
              throw new Error("not used during setup");
            },
            stop: async () => undefined,
          }),
        },
      },
    );

    expect(exitCode, cli.stderr()).toBe(0);
    const managedStore = managedPaths({ dataDirectory: paths.data }).whatsapp;
    await expect(readFile(join(source, "session-key.json"), "utf8")).resolves.toBe("private-session-material");
    await expect(readFile(join(managedStore, "session-key.json"), "utf8")).resolves.toBe("private-session-material");
    expect((await lstat(managedStore)).mode & 0o777).toBe(0o700);
    expect((await lstat(join(managedStore, "session-key.json"))).mode & 0o777).toBe(0o600);
  });

  it("rejects a WhatsApp store that contains the managed setup stage", async () => {
    const paths = await files();
    const cli = harness();

    const exitCode = await runCli(
      [
        "--data-dir",
        paths.data,
        "init",
        "--whatsapp-store",
        paths.parent,
        "--chat",
        "120363000@g.us",
        "--repository",
        "owner/repo",
        "--github-token-file",
        paths.token,
      ],
      cli,
    );

    expect(exitCode).toBe(1);
    expect(cli.stderr()).toContain("source and managed staging directory must not overlap");
    await expect(lstat(paths.data)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects links in an imported WhatsApp store without committing setup", async () => {
    const paths = await files();
    const source = join(paths.parent, "legacy-whatsapp");
    const outside = join(paths.parent, "outside-session-key.json");
    await mkdir(source, { mode: 0o700 });
    await writeFile(outside, "must-not-copy", { mode: 0o600 });
    await symlink(outside, join(source, "session-key.json"));
    const cli = harness();

    const exitCode = await runCli(
      [
        "--data-dir",
        paths.data,
        "init",
        "--whatsapp-store",
        source,
        "--chat",
        "120363000@g.us",
        "--repository",
        "owner/repo",
        "--github-token-file",
        paths.token,
      ],
      cli,
    );

    expect(exitCode).toBe(1);
    expect(cli.stderr()).toContain("only directories and regular files");
    await expect(lstat(paths.data)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(outside, "utf8")).resolves.toBe("must-not-copy");
  });

  it("uses an explicit Managed Chat for an imported online session with no fresh chat index", async () => {
    const paths = await files();
    const source = join(paths.parent, "legacy-whatsapp");
    await mkdir(source, { mode: 0o700 });
    await writeFile(join(source, "creds.json"), JSON.stringify({ registered: true }), { mode: 0o600 });

    const cli = harness();
    const exitCode = await runCli(
      [
        "--data-dir",
        paths.data,
        "init",
        "--authorize",
        "--whatsapp-store",
        source,
        "--chat",
        "120363000@g.us",
        "--repository",
        "owner/repo",
        "--github-token-file",
        paths.token,
      ],
      {
        ...cli,
        interactive: false,
        firstRunServices: {
          ...cli.firstRunServices,
          whatsappFor: () => ({
            authenticate: async () => ({ jid: "15550000000@s.whatsapp.net" }),
            synchronizedChats: async () => {
              throw new WhatsAppAccountError("timeout", "WhatsApp conversation sync timed out.");
            },
            session: () => {
              throw new Error("not used during setup");
            },
            stop: async () => undefined,
          }),
        },
      },
    );

    expect(exitCode, cli.stderr()).toBe(0);
    const config = JSON.parse(await readFile(managedPaths({ dataDirectory: paths.data }).config, "utf8")) as {
      managedChats: string[];
    };
    expect(config.managedChats).toEqual(["120363000@g.us"]);
  });

  it.each([
    ["empty sync", async () => [], "did not synchronize any supported chats"],
    [
      "sync timeout",
      async () => {
        throw new WhatsAppAccountError("timeout", "WhatsApp conversation sync timed out.");
      },
      "conversation sync timed out",
    ],
  ])("does not trust an imported chat after fresh pairing with %s", async (_case, synchronizedChats, message) => {
    const paths = await files();
    const source = join(paths.parent, "legacy-whatsapp");
    await mkdir(source, { mode: 0o700 });
    await writeFile(join(source, "creds.json"), JSON.stringify({ registered: true }), { mode: 0o600 });
    const cli = harness();

    const exitCode = await runCli(
      [
        "--data-dir",
        paths.data,
        "init",
        "--whatsapp-store",
        source,
        "--chat",
        "120363000@g.us",
        "--repository",
        "owner/repo",
        "--github-token-file",
        paths.token,
      ],
      {
        ...cli,
        firstRunServices: {
          ...cli.firstRunServices,
          whatsappFor: () => ({
            authenticate: async (callbacks) => {
              callbacks.onPairing?.({ method: "qr", qr: "fresh-pairing", expiresAt: 60_000 });
              return { jid: "15550000000@s.whatsapp.net" };
            },
            synchronizedChats,
            session: () => {
              throw new Error("not used during setup");
            },
            stop: async () => undefined,
          }),
        },
      },
    );

    expect(exitCode).toBe(1);
    expect(cli.stderr()).toContain(message);
    await expect(lstat(paths.data)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    ["stopped", 0],
    ["starting", 0],
    ["healthy", 0],
    ["failed", 3],
  ] as const)("reports observed local runtime state %s", async (runtimeState, expectedExit) => {
    const paths = await files();
    await runCli(
      [
        "--data-dir",
        paths.data,
        "init",
        "--chat",
        "120363000@g.us",
        "--repository",
        "owner/repo",
        "--github-token-file",
        paths.token,
      ],
      harness(),
    );
    const status = harness();
    expect(
      await runCli(["--data-dir", paths.data, "status", "--json"], {
        ...status,
        runtimeHealthFor: async () => ({
          state: runtimeState,
          whatsapp: {
            phase: runtimeState === "healthy" ? "online" : runtimeState,
          },
        }),
      }),
    ).toBe(expectedExit);
    expect(JSON.parse(status.stdout())).toMatchObject({ observedRuntime: { state: runtimeState } });
  });

  it("explains the read-only predecessor webhook-secret migration state", async () => {
    const paths = await files();
    await runCli(
      [
        "--data-dir",
        paths.data,
        "init",
        "--chat",
        "120363000@g.us",
        "--repository",
        "owner/repo",
        "--github-token-file",
        paths.token,
      ],
      harness(),
    );
    const credentialPath = managedPaths({ dataDirectory: paths.data }).githubCredential;
    const credential = JSON.parse(await readFile(credentialPath, "utf8")) as Record<string, unknown>;
    delete credential.webhookSecret;
    await writeFile(credentialPath, JSON.stringify(credential), { mode: 0o600 });

    const status = harness();
    expect(await runCli(["--data-dir", paths.data, "status", "--json"], status)).toBe(3);
    expect(JSON.parse(status.stdout())).toMatchObject({
      observedRuntime: { state: "stopped" },
      checks: [
        { name: "application-database", state: "ready" },
        { name: "flue-database", state: "ready" },
        { name: "whatsapp-session", state: "paired" },
        { name: "github-credential", state: "ready" },
        {
          name: "github-webhook-secret",
          state: "warning",
          code: "github.webhook-secret-migration-pending",
          remediation: expect.stringContaining("ambient-agent start"),
        },
      ],
    });
  });

  it("reconfigures through validated owning services without replacing databases or model credentials", async () => {
    const paths = await files();
    const cli = harness();
    expect(
      await runCli(
        [
          "--data-dir",
          paths.data,
          "init",
          "--chat",
          "120363000@g.us",
          "--repository",
          "owner/repo",
          "--github-token-file",
          paths.token,
        ],
        cli,
      ),
    ).toBe(0);
    const managed = managedPaths({ dataDirectory: paths.data });
    const beforeApplication = await readFile(managed.applicationDatabase);
    const beforeFlue = await readFile(managed.flueDatabase);
    const beforeModel = await readFile(managed.chatGptOAuthCredential, "utf8");
    const existingConfig = JSON.parse(await readFile(managed.config, "utf8")) as Record<string, unknown>;
    await writeFile(
      managed.config,
      JSON.stringify({
        ...existingConfig,
        managedChats: ["120363000@g.us", "15551234567@s.whatsapp.net"],
        github: {
          ...(existingConfig.github as Record<string, unknown>),
          allowedRepositories: ["owner/repo", "owner/other"],
        },
      }),
      { mode: 0o600 },
    );

    const config = harness();
    expect(
      await runCli(["--data-dir", paths.data, "config", "--repository", "Owner/Next", "--port", "4321"], {
        ...config,
        interactive: false,
      }),
    ).toBe(0);
    expect(JSON.parse(await readFile(managed.config, "utf8"))).toMatchObject({
      managedChats: ["120363000@g.us", "15551234567@s.whatsapp.net"],
      github: {
        defaultRepository: "Owner/Next",
        allowedRepositories: ["owner/repo", "owner/other", "Owner/Next"],
      },
      runtime: { port: 4321 },
    });
    await expect(readFile(managed.applicationDatabase)).resolves.toEqual(beforeApplication);
    await expect(readFile(managed.flueDatabase)).resolves.toEqual(beforeFlue);
    await expect(readFile(managed.chatGptOAuthCredential, "utf8")).resolves.toBe(beforeModel);
    expect(config.stdout()).not.toContain("github-secret-token");
  });

  it("configures a dedicated canary group as a managed chat", async () => {
    const paths = await files();
    await runCli(
      [
        "--data-dir",
        paths.data,
        "init",
        "--chat",
        "120363000@g.us",
        "--repository",
        "owner/repo",
        "--github-token-file",
        paths.token,
      ],
      harness(),
    );
    const cli = harness();

    expect(
      await runCli(["--data-dir", paths.data, "config", "--canary-chat", "120363999@g.us"], {
        ...cli,
        interactive: false,
      }),
    ).toBe(0);
    await expect(readFile(managedPaths({ dataDirectory: paths.data }).config, "utf8")).resolves.toSatisfy(
      (source: string) => {
        const config = JSON.parse(source) as { readonly managedChats: string[]; readonly smoke?: unknown };
        return (
          JSON.stringify(config.managedChats) === JSON.stringify(["120363000@g.us", "120363999@g.us"]) &&
          JSON.stringify(config.smoke) === JSON.stringify({ canaryChat: "120363999@g.us" })
        );
      },
    );
  });

  it("reports Uncertain work as degraded without exposing stored targets or provider errors", async () => {
    const paths = await files();
    await runCli(
      [
        "--data-dir",
        paths.data,
        "init",
        "--chat",
        "120363000@g.us",
        "--repository",
        "owner/repo",
        "--github-token-file",
        paths.token,
      ],
      harness(),
    );
    const operations = createIssueOperationStore(managedPaths({ dataDirectory: paths.data }).applicationDatabase);
    operations.begin({
      operationId: "private-operation-id",
      kind: "update-issue",
      repository: "owner/repo",
      issueNumber: 42,
      target: { body: "private issue body must not be printed" },
      startedAt: "2026-07-15T01:00:00.000Z",
    });
    operations.uncertain(
      "private-operation-id",
      "provider error with private credential material",
      "2026-07-15T01:01:00.000Z",
    );
    operations.close();

    const status = harness();
    expect(await runCli(["--data-dir", paths.data, "status", "--json"], status)).toBe(3);
    expect(JSON.parse(status.stdout())).toMatchObject({
      uncertainWork: {
        health: "degraded",
        externalMutations: 1,
        total: 1,
        mutationKinds: { "update-issue": 1 },
      },
      windowDeliveries: { pending: 0, failed: 0 },
    });
    expect(status.stdout()).not.toContain("private issue body");
    expect(status.stdout()).not.toContain("credential material");
  });

  it("renders a corrupt application-database diagnosis without reopening it for uncertainty", async () => {
    const paths = await files();
    await runCli(
      [
        "--data-dir",
        paths.data,
        "init",
        "--chat",
        "120363000@g.us",
        "--repository",
        "owner/repo",
        "--github-token-file",
        paths.token,
      ],
      harness(),
    );
    await writeFile(managedPaths({ dataDirectory: paths.data }).applicationDatabase, "not a sqlite database");
    const status = harness();

    expect(await runCli(["--data-dir", paths.data, "status", "--json"], status)).toBe(3);
    expect(JSON.parse(status.stdout())).toMatchObject({
      checks: expect.arrayContaining([expect.objectContaining({ name: "application-database", state: "failed" })]),
    });
    expect(status.stderr()).toBe("");
  });

  it("routes explicit doctor decisions through the headless Uncertain-work controller", async () => {
    const paths = await files();
    await runCli(
      [
        "--data-dir",
        paths.data,
        "init",
        "--chat",
        "120363000@g.us",
        "--repository",
        "owner/repo",
        "--github-token-file",
        paths.token,
      ],
      harness(),
    );
    const retry = vi
      .fn()
      .mockResolvedValueOnce({
        ref: "mutation:operation-1" as const,
        outcome: "retried" as const,
        replacementRef: "mutation:operation-2" as const,
      })
      .mockResolvedValueOnce({
        ref: "mutation:operation-3" as const,
        outcome: "failed" as const,
        replacementRef: "mutation:operation-4" as const,
      });
    const close = vi.fn();
    const controller: UncertainWorkController = {
      status: () => ({
        health: "healthy",
        externalMutations: 0,
        total: 0,
        mutationKinds: {},
      }),
      diagnose: async () => {
        throw new Error("diagnose must not run for explicit retry");
      },
      retry,
      abandon: () => {
        throw new Error("abandon must not run");
      },
      acceptObserved: async () => {
        throw new Error("acceptObserved must not run");
      },
      close,
    };
    const cli = harness();

    expect(
      await runCli(["--data-dir", paths.data, "doctor", "--retry", "mutation:operation-1", "--json"], {
        ...cli,
        uncertainWorkFor: async () => controller,
      }),
    ).toBe(0);
    expect(retry).toHaveBeenCalledWith("mutation:operation-1");
    expect(close).toHaveBeenCalledOnce();
    expect(JSON.parse(cli.stdout())).toMatchObject({
      uncertainAction: {
        ref: "mutation:operation-1",
        outcome: "retried",
        replacementRef: "mutation:operation-2",
      },
      uncertainWork: { health: "healthy", total: 0 },
    });

    const failed = harness();
    expect(
      await runCli(["--data-dir", paths.data, "doctor", "--retry", "mutation:operation-3", "--json"], {
        ...failed,
        uncertainWorkFor: async () => controller,
      }),
    ).toBe(1);
    expect(JSON.parse(failed.stdout())).toMatchObject({
      uncertainAction: { ref: "mutation:operation-3", outcome: "failed" },
      uncertainWork: { health: "healthy", total: 0 },
    });
  });

  it("fails uncertain-work actions loudly when the GitHub credential is unusable", async () => {
    const paths = await files();
    await runCli(
      [
        "--data-dir",
        paths.data,
        "init",
        "--chat",
        "120363000@g.us",
        "--repository",
        "owner/repo",
        "--github-token-file",
        paths.token,
      ],
      harness(),
    );
    await writeFile(managedPaths({ dataDirectory: paths.data }).githubCredential, "not json", { mode: 0o600 });

    const cli = harness();
    const uncertainWorkFor = vi.fn();
    expect(
      await runCli(["--data-dir", paths.data, "doctor", "--retry", "mutation:operation-1", "--json"], {
        ...cli,
        uncertainWorkFor,
      }),
    ).toBe(1);
    expect(cli.stderr()).toContain("usable GitHub credential");
    expect(uncertainWorkFor).not.toHaveBeenCalled();
  });

  it("still observes the runtime when the GitHub credential is unusable", async () => {
    const paths = await files();
    await runCli(
      [
        "--data-dir",
        paths.data,
        "init",
        "--chat",
        "120363000@g.us",
        "--repository",
        "owner/repo",
        "--github-token-file",
        paths.token,
      ],
      harness(),
    );
    await writeFile(managedPaths({ dataDirectory: paths.data }).githubCredential, "not json", { mode: 0o600 });

    const status = harness();
    expect(
      await runCli(["--data-dir", paths.data, "status", "--json"], {
        ...status,
        runtimeHealthFor: async () => ({ state: "healthy", whatsapp: { phase: "online" } }),
      }),
    ).toBe(3);
    expect(JSON.parse(status.stdout())).toMatchObject({
      observedRuntime: { state: "healthy" },
      checks: expect.arrayContaining([
        expect.objectContaining({ name: "whatsapp-session", state: "online" }),
        expect.objectContaining({ name: "github-credential", state: "reauthentication-required" }),
      ]),
    });
  });

  it("distinguishes expired credentials and refreshes them only when requested", async () => {
    const paths = await files();
    const init = harness();
    expect(
      await runCli(
        [
          "--data-dir",
          paths.data,
          "init",
          "--chat",
          "120363000@g.us",
          "--repository",
          "owner/repo",
          "--github-token-file",
          paths.token,
        ],
        init,
      ),
    ).toBe(0);
    const managed = managedPaths({ dataDirectory: paths.data });
    const expired = JSON.parse(await readFile(managed.chatGptOAuthCredential, "utf8")) as Record<string, unknown>;
    expired.expires = 1;
    await writeFile(managed.chatGptOAuthCredential, JSON.stringify(expired), { mode: 0o600 });

    const offline = harness();
    expect(await runCli(["--data-dir", paths.data, "doctor", "--json"], offline)).toBe(1);
    expect(JSON.parse(offline.stdout())).toMatchObject({
      modelAuthentication: { state: "expired-refreshable" },
    });

    const refreshed = harness();
    expect(await runCli(["--data-dir", paths.data, "doctor", "--refresh", "--json"], refreshed)).toBe(0);
    expect(JSON.parse(refreshed.stdout())).toMatchObject({ modelAuthentication: { state: "ready" } });
  });

  it("gates a real readiness request behind doctor --live", async () => {
    const paths = await files();
    const init = harness();
    await runCli(
      [
        "--data-dir",
        paths.data,
        "init",
        "--chat",
        "120363000@g.us",
        "--repository",
        "owner/repo",
        "--github-token-file",
        paths.token,
      ],
      init,
    );
    const live = harness();
    const readinessCheck = vi.fn(async () => ({
      model: "openai-codex/gpt-5.6-luna" as const,
      request: "complete" as const,
    }));
    const verifyGitHub = vi.fn(async (_token: string, repository: string) => repository);

    expect(
      await runCli(["--data-dir", paths.data, "doctor", "--live", "--json"], {
        ...live,
        readinessCheck,
        firstRunServices: { ...live.firstRunServices, verifyGitHub },
      }),
    ).toBe(0);
    expect(readinessCheck).toHaveBeenCalledTimes(1);
    expect(verifyGitHub).toHaveBeenCalledWith("github-secret-token", "owner/repo", expect.any(AbortSignal));
    expect(JSON.parse(live.stdout())).toMatchObject({
      checks: expect.arrayContaining([
        expect.objectContaining({ name: "github-access", state: "ready", code: "github.ready" }),
      ]),
      liveCheck: { request: "complete" },
    });
  });

  it("runs every smoke station and reports the live canary lifecycle", async () => {
    const paths = await files();
    await runCli(
      [
        "--data-dir",
        paths.data,
        "init",
        "--chat",
        "120363000@g.us",
        "--repository",
        "owner/repo",
        "--github-token-file",
        paths.token,
      ],
      harness(),
    );
    const managed = managedPaths({ dataDirectory: paths.data });
    const config = JSON.parse(await readFile(managed.config, "utf8")) as Record<string, unknown>;
    await writeFile(
      managed.config,
      `${JSON.stringify({ ...config, smoke: { canaryChat: "120363000@g.us" } }, null, 2)}\n`,
      { mode: 0o600 },
    );
    const cli = harness();

    expect(
      await runCli(["--data-dir", paths.data, "smoke"], {
        ...cli,
        readinessCheck: async () => ({ model: "openai-codex/gpt-5.6-luna", request: "complete" }),
        firstRunServices: {
          ...cli.firstRunServices,
          verifyGitHub: async (_token: string, repository: string) => repository,
        },
        runtimeHealthFor: async () => ({ state: "healthy", whatsapp: { phase: "online" } }),
        smokeCanaryFor: async (_paths: ManagedPaths, nonce: string) => ({
          chatId: "120363000@g.us",
          text: `SMOKE ${nonce} — ignore`,
          stages: ["admission", "dispatch", "settled-silent"] as const,
        }),
        createNonce: () => "abc123",
      }),
    ).toBe(0);
    expect(cli.stdout()).toBe(
      [
        "PASS installation: managed installation ready",
        "PASS chatgpt: authentication ready; live readiness complete",
        "PASS runtime: healthy; WhatsApp online",
        "PASS backlog: 0 pending, 0 failed, no Uncertain work",
        "PASS github: access to owner/repo",
        "PASS canary: SMOKE abc123 settled silent (admission → dispatch → settled-silent)",
        "",
      ].join("\n"),
    );
    expect(cli.stderr()).toBe("");
  });

  it("bounds the live readiness request with a dedicated timeout", async () => {
    const paths = await files();
    await runCli(
      [
        "--data-dir",
        paths.data,
        "init",
        "--chat",
        "120363000@g.us",
        "--repository",
        "owner/repo",
        "--github-token-file",
        paths.token,
      ],
      harness(),
    );
    const live = harness();
    const result = await runCli(["--data-dir", paths.data, "doctor", "--live", "--json"], {
      ...live,
      readinessTimeoutMillis: 10,
      readinessCheck: async (_authentication, signal) =>
        await new Promise((_, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    });

    expect(result).toBe(1);
    expect(JSON.parse(live.stdout())).toMatchObject({
      modelAuthentication: { state: "ready" },
      liveCheck: { request: "failed", reason: "request-failed" },
    });
  });

  it("reports a sanitized GitHub access failure through doctor --live", async () => {
    const paths = await files();
    await runCli(
      [
        "--data-dir",
        paths.data,
        "init",
        "--chat",
        "120363000@g.us",
        "--repository",
        "owner/repo",
        "--github-token-file",
        paths.token,
      ],
      harness(),
    );
    const live = harness();
    expect(
      await runCli(["--data-dir", paths.data, "doctor", "--live", "--json"], {
        ...live,
        readinessCheck: async () => ({ model: "openai-codex/gpt-5.6-luna", request: "complete" }),
        firstRunServices: {
          ...live.firstRunServices,
          verifyGitHub: async () => {
            throw new Error("provider failure containing private token material");
          },
        },
      }),
    ).toBe(1);
    expect(JSON.parse(live.stdout())).toMatchObject({
      checks: expect.arrayContaining([
        expect.objectContaining({ name: "github-access", state: "failed", code: "github.access-failed" }),
      ]),
    });
    expect(live.stdout()).not.toContain("private token material");
  });

  it("classifies a revoked credential as unusable when the gated live check rejects it", async () => {
    const paths = await files();
    const init = harness();
    await runCli(
      [
        "--data-dir",
        paths.data,
        "init",
        "--chat",
        "120363000@g.us",
        "--repository",
        "owner/repo",
        "--github-token-file",
        paths.token,
      ],
      init,
    );
    const live = harness();

    expect(
      await runCli(["--data-dir", paths.data, "doctor", "--live", "--json"], {
        ...live,
        readinessCheck: async () => {
          throw new ChatGptReadinessError(
            "credential-rejected",
            "ChatGPT rejected the managed credential during the live readiness check.",
          );
        },
      }),
    ).toBe(1);
    expect(JSON.parse(live.stdout())).toMatchObject({
      modelAuthentication: { state: "unusable" },
    });
    expect(live.stdout()).not.toContain("must-not-be-printed");
    expect(live.stderr()).toBe("");
  });

  it("reports a live transport failure without misclassifying the credential", async () => {
    const paths = await files();
    await runCli(
      [
        "--data-dir",
        paths.data,
        "init",
        "--chat",
        "120363000@g.us",
        "--repository",
        "owner/repo",
        "--github-token-file",
        paths.token,
      ],
      harness(),
    );
    const live = harness();

    expect(
      await runCli(["--data-dir", paths.data, "doctor", "--live", "--json"], {
        ...live,
        readinessCheck: async () => {
          throw new Error("network failure containing must-not-be-printed");
        },
      }),
    ).toBe(1);
    expect(JSON.parse(live.stdout())).toMatchObject({
      modelAuthentication: { state: "ready" },
      liveCheck: { request: "failed", reason: "request-failed" },
    });
    expect(live.stdout()).not.toContain("must-not-be-printed");
  });

  it("reports malformed and unusable ChatGPT credentials without exposing their contents", async () => {
    const malformedPaths = await files();
    const malformedInit = harness();
    await runCli(
      [
        "--data-dir",
        malformedPaths.data,
        "init",
        "--chat",
        "120363000@g.us",
        "--repository",
        "owner/repo",
        "--github-token-file",
        malformedPaths.token,
      ],
      malformedInit,
    );
    const malformedCredential = managedPaths({ dataDirectory: malformedPaths.data }).chatGptOAuthCredential;
    await writeFile(malformedCredential, '{"access":"must-not-be-printed"', { mode: 0o600 });
    const malformed = harness();
    expect(await runCli(["--data-dir", malformedPaths.data, "doctor", "--json"], malformed)).toBe(1);
    expect(JSON.parse(malformed.stdout())).toMatchObject({ modelAuthentication: { state: "malformed" } });
    expect(malformed.stdout()).not.toContain("must-not-be-printed");

    const unusablePaths = await files();
    const unusableInit = harness();
    await runCli(
      [
        "--data-dir",
        unusablePaths.data,
        "init",
        "--chat",
        "120363000@g.us",
        "--repository",
        "owner/repo",
        "--github-token-file",
        unusablePaths.token,
      ],
      unusableInit,
    );
    const unusableCredential = managedPaths({ dataDirectory: unusablePaths.data }).chatGptOAuthCredential;
    const expired = JSON.parse(await readFile(unusableCredential, "utf8")) as Record<string, unknown>;
    expired.expires = 1;
    await writeFile(unusableCredential, JSON.stringify(expired), { mode: 0o600 });
    const unusable = harness();
    const rejectingOAuth: ChatGptOAuthAdapter = {
      ...unusable.chatGptOAuth,
      refresh: async () => {
        throw new Error("provider rejected refresh with must-not-be-printed");
      },
    };
    expect(
      await runCli(["--data-dir", unusablePaths.data, "doctor", "--refresh", "--json"], {
        ...unusable,
        chatGptOAuth: rejectingOAuth,
      }),
    ).toBe(1);
    expect(JSON.parse(unusable.stdout())).toMatchObject({ modelAuthentication: { state: "unusable" } });
    expect(unusable.stdout()).not.toContain("must-not-be-printed");
  });

  it("reauthenticates a configured installation and repairs a malformed model credential", async () => {
    const paths = await files();
    await runCli(
      [
        "--data-dir",
        paths.data,
        "init",
        "--chat",
        "120363000@g.us",
        "--repository",
        "owner/repo",
        "--github-token-file",
        paths.token,
      ],
      harness(),
    );
    const credentialPath = managedPaths({ dataDirectory: paths.data }).chatGptOAuthCredential;
    await writeFile(credentialPath, "{malformed", { mode: 0o600 });
    const reauth = harness();

    expect(await runCli(["--data-dir", paths.data, "auth"], reauth)).toBe(0);
    expect(reauth.stdout()).toContain("ChatGPT authentication updated");
    expect(JSON.parse(await readFile(credentialPath, "utf8"))).toMatchObject({
      type: "oauth",
      access: "access-secret",
      refresh: "refresh-secret",
    });
    expect((await lstat(credentialPath)).mode & 0o777).toBe(0o600);
  });

  it("refuses non-file credential nodes before starting device authentication", async () => {
    const paths = await files();
    await runCli(
      [
        "--data-dir",
        paths.data,
        "init",
        "--chat",
        "120363000@g.us",
        "--repository",
        "owner/repo",
        "--github-token-file",
        paths.token,
      ],
      harness(),
    );
    const credentialPath = managedPaths({ dataDirectory: paths.data }).chatGptOAuthCredential;
    await rm(credentialPath);
    await mkdir(credentialPath, { mode: 0o700 });
    const cli = harness();
    const login = vi.fn(cli.chatGptOAuth.login);

    expect(
      await runCli(["--data-dir", paths.data, "auth"], {
        ...cli,
        chatGptOAuth: { ...cli.chatGptOAuth, login },
      }),
    ).toBe(1);
    expect(cli.stderr()).toContain("run ambient-agent doctor");
    expect(login).not.toHaveBeenCalled();
  });

  it("normalizes a missing legacy credential reference during explicit reauthentication", async () => {
    const paths = await files();
    await runCli(
      [
        "--data-dir",
        paths.data,
        "init",
        "--chat",
        "120363000@g.us",
        "--repository",
        "owner/repo",
        "--github-token-file",
        paths.token,
      ],
      harness(),
    );
    const managed = managedPaths({ dataDirectory: paths.data });
    const config = JSON.parse(await readFile(managed.config, "utf8")) as { model: { credential: string } };
    config.model.credential = "pi-auth";
    await writeFile(managed.config, JSON.stringify(config), { mode: 0o600 });
    await rm(managed.chatGptOAuthCredential);
    const reauth = harness();

    expect(await runCli(["--data-dir", paths.data, "auth"], reauth)).toBe(0);
    expect(JSON.parse(await readFile(managed.config, "utf8"))).toMatchObject({
      model: { credential: "chatgpt-oauth" },
    });
    await expect(lstat(managed.chatGptOAuthCredential)).resolves.toBeDefined();
  });

  it("does not inspect or migrate authentication through a damaged credential-directory symlink", async () => {
    const paths = await files();
    await runCli(
      [
        "--data-dir",
        paths.data,
        "init",
        "--chat",
        "120363000@g.us",
        "--repository",
        "owner/repo",
        "--github-token-file",
        paths.token,
      ],
      harness(),
    );
    const managed = managedPaths({ dataDirectory: paths.data });
    const outside = join(paths.parent, "outside-credentials");
    await mkdir(outside, { mode: 0o700 });
    await writeFile(
      join(outside, "pi-auth.json"),
      JSON.stringify({
        "openai-codex": {
          type: "oauth",
          access: "outside-access-secret",
          refresh: "outside-refresh-secret",
          expires: 2_000_000_000_000,
        },
      }),
      { mode: 0o600 },
    );
    await rm(managed.credentials, { recursive: true });
    await symlink(outside, managed.credentials);
    const status = harness();

    expect(await runCli(["--data-dir", paths.data, "status", "--json"], status)).toBe(3);
    expect(JSON.parse(status.stdout())).toMatchObject({
      state: "corrupt",
      modelAuthentication: { state: "unusable" },
    });
    const textStatus = harness();
    expect(await runCli(["--data-dir", paths.data, "status"], textStatus)).toBe(3);
    expect(textStatus.stdout()).toContain("Run ambient-agent doctor and repair the managed installation");
    await expect(lstat(join(outside, "pi-auth.json"))).resolves.toBeDefined();
    await expect(lstat(join(outside, "chatgpt-oauth.json"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(outside, "chatgpt-oauth.json.lock"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses injectable prompt answers and setup remains non-destructive", async () => {
    const paths = await files();
    const prompted = harness();
    const setupPrompts = {
      ...prompted.setupPrompts,
      selectChat: async () => "120363000@g.us",
      repository: async () => "owner/repo",
      githubCredential: async () => ({ token: "prompted-github-secret", source: "secure prompt" }),
    };
    expect(await runCli(["--data-dir", paths.data, "init"], { ...prompted, setupPrompts })).toBe(0);

    const second = harness();
    const forbiddenPrompts = {
      selectChat: async (): Promise<string> => {
        throw new Error("managed chat prompt must not run");
      },
      repository: async (): Promise<string> => {
        throw new Error("repository prompt must not run");
      },
      githubCredential: async (): Promise<{ token: string; source: string }> => {
        throw new Error("GitHub prompt must not run");
      },
      review: async (): Promise<boolean> => {
        throw new Error("review prompt must not run");
      },
      validationError: () => {
        throw new Error("validation prompt must not run");
      },
    };
    await rm(paths.token);
    expect(await runCli(["--data-dir", paths.data, "init"], { ...second, setupPrompts: forbiddenPrompts })).toBe(0);
    expect(second.stdout()).toContain("no files changed");
    expect(
      await import("node:fs/promises").then(({ readFile }) =>
        readFile(managedPaths({ dataDirectory: paths.data }).githubCredential, "utf8"),
      ),
    ).toContain("prompted-github-secret");
  });

  it("routes global-only data-directory invocations through the selected installation", async () => {
    const paths = await files();
    const prompted = harness();
    const setupPrompts = {
      ...prompted.setupPrompts,
      selectChat: async () => "120363000@g.us",
      repository: async () => "owner/repo",
      githubCredential: async () => ({ token: "prompted-github-secret", source: "secure prompt" }),
    };
    expect(await runCli(["--data-dir", paths.data], { ...prompted, setupPrompts })).toBe(0);
    expect(prompted.stdout()).toContain("Created secure managed installation");

    const status = harness();
    expect(await runCli(["--data-dir", paths.data], status)).toBe(0);
    expect(status.stdout()).toContain(`Data directory: ${paths.data}`);
    expect(status.stdout()).toContain("Ambient Agent: ready");
  });

  it("never opens prompts in a non-interactive process with missing scripted values", async () => {
    const paths = await files();
    const cli = harness();
    let promptsOpened = 0;
    const setupPrompts = {
      selectChat: async () => {
        promptsOpened += 1;
        return "120363000@g.us";
      },
      repository: async () => {
        promptsOpened += 1;
        return "owner/repo";
      },
      githubCredential: async () => {
        promptsOpened += 1;
        return { token: "secret", source: "prompt" };
      },
      review: async () => {
        promptsOpened += 1;
        return true;
      },
      validationError: () => {
        promptsOpened += 1;
      },
    };

    expect(
      await runCli(["--data-dir", paths.data, "init", "--chat", "120363000@g.us"], {
        ...cli,
        setupPrompts,
        interactive: false,
      }),
    ).toBe(1);
    expect(promptsOpened).toBe(0);
    expect(cli.stderr()).toContain("valid managed ChatGPT credential");
  });

  it("returns stable nonzero codes for absent and incomplete installs", async () => {
    const paths = await files();
    const missing = harness();
    expect(await runCli(["--data-dir", paths.data, "status"], missing)).toBe(2);
    expect(missing.stdout()).toContain("absent");

    const broken = harness();
    await import("node:fs/promises").then(({ mkdir }) => mkdir(paths.data, { mode: 0o700 }));
    expect(await runCli(["--data-dir", paths.data, "doctor"], broken)).toBe(1);
    expect(broken.stdout()).toContain("incomplete");
    expect(broken.stdout()).toContain("Fix:");
  });

  it("prints the resolved data directory during init", async () => {
    const paths = await files();
    const cli = harness();
    await runCli(
      ["--data-dir", paths.data, "init", "--chat", "120363000@g.us", "--repository", "owner/repo"],
      cli,
    );
    expect(cli.stdout()).toContain(`Data directory: ${paths.data}`);
    expect(cli.stdout()).toContain("Created secure managed installation");
  });

  it("runs the one-time root migration before commands and skips it under --data-dir", async () => {
    const paths = await files();
    let migrations = 0;
    const skipped = harness();
    await runCli(["--data-dir", paths.data, "status"], {
      ...skipped,
      migrateManagedData: async () => {
        migrations += 1;
        return { migrated: false, root: paths.data };
      },
    });
    expect(migrations).toBe(0);

    const migratedCli = harness();
    vi.stubEnv("HOME", paths.parent);
    try {
      expect(
        await runCli(["status", "--json"], {
          ...migratedCli,
          migrateManagedData: async () => {
            migrations += 1;
            return { migrated: true, root: paths.data, source: join(paths.parent, "legacy") };
          },
        }),
      ).toBe(2);
    } finally {
      vi.unstubAllEnvs();
    }
    expect(migrations).toBe(1);
    expect(migratedCli.stderr()).toContain(`Moved managed data from ${join(paths.parent, "legacy")} to ${paths.data}`);
    expect(JSON.parse(migratedCli.stdout())).toMatchObject({ state: "absent" });
  });

  it("reports a missing WhatsApp store as ready + re-pair-required and refuses start with the repair pointer", async () => {
    const paths = await files();
    await runCli(
      [
        "--data-dir",
        paths.data,
        "init",
        "--chat",
        "120363000@g.us",
        "--repository",
        "owner/repo",
        "--github-token-file",
        paths.token,
      ],
      harness(),
    );
    await rm(managedPaths({ dataDirectory: paths.data }).whatsapp, { recursive: true });

    const status = harness();
    expect(await runCli(["--data-dir", paths.data, "status", "--json"], status)).toBe(3);
    expect(JSON.parse(status.stdout())).toMatchObject({
      state: "ready",
      checks: expect.arrayContaining([
        expect.objectContaining({ name: "whatsapp-session", state: "re-pair-required" }),
      ]),
    });

    const start = harness();
    const startRuntime = vi.fn(async () => undefined);
    expect(await runCli(["--data-dir", paths.data, "start"], { ...start, startRuntime })).toBe(1);
    expect(start.stderr()).toContain("ambient-agent repair whatsapp");
    expect(startRuntime).not.toHaveBeenCalled();
  });

  it("re-pairs WhatsApp through a validated private stage while preserving everything else", async () => {
    const paths = await files();
    await runCli(
      [
        "--data-dir",
        paths.data,
        "init",
        "--chat",
        "120363000@g.us",
        "--repository",
        "owner/repo",
        "--github-token-file",
        paths.token,
      ],
      harness(),
    );
    const managed = managedPaths({ dataDirectory: paths.data });
    await rm(managed.whatsapp, { recursive: true });
    const configBefore = await readFile(managed.config, "utf8");
    const credentialBefore = await readFile(managed.githubCredential, "utf8");
    const modelBefore = await readFile(managed.chatGptOAuthCredential, "utf8");
    const applicationBefore = await readFile(managed.applicationDatabase);

    const repair = harness();
    const staged: string[] = [];
    expect(
      await runCli(["--data-dir", paths.data, "repair", "whatsapp"], {
        ...repair,
        runtimeHealthFor: async () => ({ state: "stopped", whatsapp: { phase: "stopped" } }),
        firstRunServices: {
          ...repair.firstRunServices,
          whatsappFor: (staging: ManagedPaths) => ({
            authenticate: async () => {
              staged.push(staging.whatsapp);
              expect(staging.whatsapp).not.toBe(managed.whatsapp);
              await writeFile(join(staging.whatsapp, "creds.json"), JSON.stringify({ registered: true }), {
                mode: 0o600,
              });
              return { jid: "15550000000@s.whatsapp.net" };
            },
            synchronizedChats: async () => [
              { jid: "120363000@g.us", name: "Managed Test Chat", kind: "group" as const, lastActivityAt: 1_000 },
            ],
            session: () => {
              throw new Error("not used during repair");
            },
            stop: async () => undefined,
          }),
        },
      }),
    ).toBe(0);
    expect(staged).toHaveLength(1);
    expect(repair.stdout()).toContain("Replaced the managed WhatsApp store");
    await expect(readFile(join(managed.whatsapp, "creds.json"), "utf8")).resolves.toContain('"registered":true');
    await expect(readFile(managed.config, "utf8")).resolves.toBe(configBefore);
    await expect(readFile(managed.githubCredential, "utf8")).resolves.toBe(credentialBefore);
    await expect(readFile(managed.chatGptOAuthCredential, "utf8")).resolves.toBe(modelBefore);
    await expect(readFile(managed.applicationDatabase)).resolves.toEqual(applicationBefore);
    await expect(lstat(staged[0]!)).rejects.toMatchObject({ code: "ENOENT" });

    const status = harness();
    expect(await runCli(["--data-dir", paths.data, "status", "--json"], status)).toBe(0);
    expect(JSON.parse(status.stdout())).toMatchObject({
      state: "ready",
      checks: expect.arrayContaining([expect.objectContaining({ name: "whatsapp-session", state: "paired" })]),
    });
  });

  it("promotes nothing when the newly paired account cannot see the configured managed chat", async () => {
    const paths = await files();
    await runCli(
      [
        "--data-dir",
        paths.data,
        "init",
        "--chat",
        "120363000@g.us",
        "--repository",
        "owner/repo",
        "--github-token-file",
        paths.token,
      ],
      harness(),
    );
    const managed = managedPaths({ dataDirectory: paths.data });
    await rm(managed.whatsapp, { recursive: true });

    const repair = harness();
    expect(
      await runCli(["--data-dir", paths.data, "repair", "whatsapp"], {
        ...repair,
        runtimeHealthFor: async () => ({ state: "stopped", whatsapp: { phase: "stopped" } }),
        firstRunServices: {
          ...repair.firstRunServices,
          whatsappFor: (staging: ManagedPaths) => ({
            authenticate: async () => {
              await writeFile(join(staging.whatsapp, "creds.json"), JSON.stringify({ registered: true }), {
                mode: 0o600,
              });
              return { jid: "19998887777@s.whatsapp.net" };
            },
            synchronizedChats: async () => [
              { jid: "other@g.us", name: "Wrong Chat", kind: "group" as const, lastActivityAt: 1_000 },
            ],
            session: () => {
              throw new Error("not used during repair");
            },
            stop: async () => undefined,
          }),
        },
      }),
    ).toBe(1);
    expect(repair.stderr()).toContain("does not see the configured managed chat");
    await expect(lstat(managed.whatsapp)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await inspectManagedData({ dataDirectory: paths.data })).state).toBe("ready");
  });

  it("fails non-interactive repair with an actionable human-required message", async () => {
    const paths = await files();
    await runCli(
      [
        "--data-dir",
        paths.data,
        "init",
        "--chat",
        "120363000@g.us",
        "--repository",
        "owner/repo",
        "--github-token-file",
        paths.token,
      ],
      harness(),
    );
    await rm(managedPaths({ dataDirectory: paths.data }).whatsapp, { recursive: true });

    const repair = harness();
    expect(await runCli(["--data-dir", paths.data, "repair", "whatsapp"], { ...repair, interactive: false })).toBe(1);
    expect(repair.stderr()).toContain("requires a human to scan a QR code");
    expect(repair.stderr()).toContain("interactive terminal");
  });

  it.each(["healthy", "starting", "failed"] as const)(
    "refuses repair while a runtime is observed %s",
    async (state) => {
      const paths = await files();
      await runCli(
        [
          "--data-dir",
          paths.data,
          "init",
          "--chat",
          "120363000@g.us",
          "--repository",
          "owner/repo",
          "--github-token-file",
          paths.token,
        ],
        harness(),
      );
      await rm(managedPaths({ dataDirectory: paths.data }).whatsapp, { recursive: true });

      const repair = harness();
      expect(
        await runCli(["--data-dir", paths.data, "repair"], {
          ...repair,
          runtimeHealthFor: async () => ({ state, whatsapp: { phase: state === "healthy" ? "online" : state } }),
        }),
      ).toBe(1);
      expect(repair.stderr()).toContain("Stop the running ambient-agent start process");
    },
  );

  it("refuses repair when the store is already paired", async () => {
    const paths = await files();
    await runCli(
      [
        "--data-dir",
        paths.data,
        "init",
        "--chat",
        "120363000@g.us",
        "--repository",
        "owner/repo",
        "--github-token-file",
        paths.token,
      ],
      harness(),
    );
    const managed = managedPaths({ dataDirectory: paths.data });
    const storeBefore = await readFile(join(managed.whatsapp, "creds.json"), "utf8");

    const repair = harness();
    expect(await runCli(["--data-dir", paths.data, "repair", "whatsapp"], repair)).toBe(1);
    expect(repair.stderr()).toContain("already paired; nothing to repair");
    await expect(readFile(join(managed.whatsapp, "creds.json"), "utf8")).resolves.toBe(storeBefore);
  });

  it("routes a bare interactive invocation into guided re-pair when the store is missing", async () => {
    const paths = await files();
    await runCli(
      [
        "--data-dir",
        paths.data,
        "init",
        "--chat",
        "120363000@g.us",
        "--repository",
        "owner/repo",
        "--github-token-file",
        paths.token,
      ],
      harness(),
    );
    const managed = managedPaths({ dataDirectory: paths.data });
    await rm(managed.whatsapp, { recursive: true });

    const bare = harness();
    expect(
      await runCli(["--data-dir", paths.data], {
        ...bare,
        runtimeHealthFor: async () => ({ state: "stopped", whatsapp: { phase: "stopped" } }),
      }),
    ).toBe(0);
    expect(bare.stdout()).toContain("Replaced the managed WhatsApp store");
    await expect(readFile(join(managed.whatsapp, "creds.json"), "utf8")).resolves.toContain('"registered":true');
  });

  it("fails closed with a nonzero exit code when the root migration refuses to choose", async () => {
    const cli = harness();
    expect(
      await runCli(["status"], {
        ...cli,
        migrateManagedData: async () => {
          throw new Error("Managed data exists at both /home/a/.ambient-agent and the former default /home/a/.local/share/ambient-agent.");
        },
      }),
    ).toBe(1);
    expect(cli.stderr()).toContain("/home/a/.ambient-agent");
    expect(cli.stderr()).toContain("/home/a/.local/share/ambient-agent");
  });
});
