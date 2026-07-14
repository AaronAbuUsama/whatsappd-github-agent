import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { runCli, type CliOutput } from "../../src/cli/program.ts";
import { managedPaths, type ManagedPaths } from "../../src/managed/paths.ts";

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
  return { output, stdout: () => stdout, stderr: () => stderr };
};

const files = async () => {
  const parent = await mkdtemp(join(tmpdir(), "ambient-agent-cli-"));
  roots.push(parent);
  const token = join(parent, "token.txt");
  const auth = join(parent, "auth.json");
  await writeFile(token, "github-secret-token\n", { mode: 0o600 });
  await writeFile(
    auth,
    JSON.stringify({
      "openai-codex": {
        type: "oauth",
        access: "access-secret",
        refresh: "refresh-secret",
        expires: 2_000_000_000_000,
      },
    }),
    { mode: 0o600 },
  );
  return { parent, data: join(parent, "managed"), token, auth };
};

describe("managed CLI", () => {
  it("starts the generated runtime from the selected managed installation", async () => {
    const paths = await files();
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

  it("supports a fully scripted setup and deterministic status", async () => {
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
          "--pi-auth-file",
          paths.auth,
        ],
        init,
      ),
    ).toBe(0);
    expect(init.stdout()).toContain("Created secure managed installation");
    expect(init.stdout()).not.toContain("github-secret-token");

    const status = harness();
    expect(await runCli(["--data-dir", paths.data, "status", "--json"], status)).toBe(0);
    expect(JSON.parse(status.stdout())).toMatchObject({
      state: "configured",
      dataDirectory: paths.data,
    });
    expect(status.stdout()).not.toContain("access-secret");
    expect(status.stderr()).toBe("");
  });

  it("uses injectable prompt answers and setup remains non-destructive", async () => {
    const paths = await files();
    const prompted = harness();
    const setupPrompts = {
      managedChat: async () => "120363000@g.us",
      repository: async () => "owner/repo",
      githubToken: async () => "prompted-github-secret",
      piAuthPath: async () => paths.auth,
    };
    expect(await runCli(["--data-dir", paths.data, "init"], { ...prompted, setupPrompts })).toBe(0);

    const second = harness();
    const forbiddenPrompts = {
      managedChat: async (): Promise<string> => {
        throw new Error("managed chat prompt must not run");
      },
      repository: async (): Promise<string> => {
        throw new Error("repository prompt must not run");
      },
      githubToken: async (): Promise<string> => {
        throw new Error("GitHub prompt must not run");
      },
      piAuthPath: async (): Promise<string> => {
        throw new Error("Pi prompt must not run");
      },
    };
    await rm(paths.token);
    await rm(paths.auth);
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
      managedChat: async () => "120363000@g.us",
      repository: async () => "owner/repo",
      githubToken: async () => "prompted-github-secret",
      piAuthPath: async () => paths.auth,
    };
    expect(await runCli(["--data-dir", paths.data], { ...prompted, setupPrompts })).toBe(0);
    expect(prompted.stdout()).toContain("Created secure managed installation");

    const status = harness();
    expect(await runCli(["--data-dir", paths.data], status)).toBe(0);
    expect(status.stdout()).toContain(`Data directory: ${paths.data}`);
    expect(status.stdout()).toContain("configured");
  });

  it("never opens prompts in a non-interactive process with missing scripted values", async () => {
    const paths = await files();
    const cli = harness();
    let promptsOpened = 0;
    const setupPrompts = {
      managedChat: async () => {
        promptsOpened += 1;
        return "120363000@g.us";
      },
      repository: async () => {
        promptsOpened += 1;
        return "owner/repo";
      },
      githubToken: async () => {
        promptsOpened += 1;
        return "secret";
      },
      piAuthPath: async () => {
        promptsOpened += 1;
        return paths.auth;
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
    expect(cli.stderr()).toContain("Non-interactive init requires --repository, --github-token-file, --pi-auth-file");
  });

  it("returns stable nonzero codes for unconfigured and damaged installs", async () => {
    const paths = await files();
    const missing = harness();
    expect(await runCli(["--data-dir", paths.data, "status"], missing)).toBe(2);
    expect(missing.stdout()).toContain("unconfigured");

    const broken = harness();
    await import("node:fs/promises").then(({ mkdir }) => mkdir(paths.data, { mode: 0o700 }));
    expect(await runCli(["--data-dir", paths.data, "doctor"], broken)).toBe(1);
    expect(broken.stdout()).toContain("damaged");
    expect(broken.stdout()).toContain("Fix:");
  });
});
