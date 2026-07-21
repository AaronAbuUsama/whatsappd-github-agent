import { describe, expect, it } from "vite-plus/test";
import { CommandExitError, TimeoutError } from "e2b";

import {
  E2B_WORKSPACES_ROOT,
  e2bSandbox,
  type E2BSandboxLike,
} from "../../packages/installation/src/e2b-sandbox.ts";

interface RunCall {
  readonly command: string;
  readonly options?: { cwd?: string; envs?: Record<string, string>; timeoutMs?: number };
}

/** A stand-in for the provider sandbox: the E2B key is operator config we do not have. */
const fakeSandbox = (overrides: {
  run?: (command: string, options?: RunCall["options"]) => Promise<{ stdout: string; stderr: string; exitCode: number }>;
} = {}) => {
  const runs: RunCall[] = [];
  const removed: string[] = [];
  const written: { path: string; data: string | ArrayBuffer }[] = [];
  let killed = 0;
  const sandbox: E2BSandboxLike = {
    files: {
      read: async (path) => new TextEncoder().encode(`bytes of ${path}`),
      write: async (path, data) => {
        written.push({ path, data });
        return {};
      },
      list: async () => [{ name: "package.json" }, { name: "src" }],
      makeDir: async () => true,
      remove: async (path) => {
        removed.push(path);
      },
      exists: async () => true,
      getInfo: async () => ({ type: "dir", size: 4_096, modifiedTime: new Date(0) }),
    },
    commands: {
      run: async (command, options) => {
        runs.push({ command, ...(options === undefined ? {} : { options }) });
        return await (overrides.run ?? (async () => ({ stdout: "ok", stderr: "", exitCode: 0 })))(command, options);
      },
    },
    kill: async () => {
      killed += 1;
      return true;
    },
  };
  return { sandbox, runs, removed, written, killed: () => killed };
};

const sessionFor = async (fake: E2BSandboxLike, id = "job-1", timeoutMs = 900_000) =>
  await e2bSandbox({ timeoutMs, create: async () => fake }).createSessionEnv({ id });

describe("E2B sandbox adapter", () => {
  it("runs commands in the sandbox, defaulting the deadline to the job budget", async () => {
    const fake = fakeSandbox();
    const env = await sessionFor(fake.sandbox);

    await expect(env.exec("pnpm test", { env: { CI: "1" } })).resolves.toEqual({
      stdout: "ok",
      stderr: "",
      exitCode: 0,
    });
    expect(fake.runs[0]).toEqual({
      command: "pnpm test",
      // E2B's own default is 60s — far under a repo's test run. TMPDIR is workspace-local
      // (#172) so a `noexec /tmp` in any template cannot fail the repo's install or tests.
      options: {
        cwd: "/home/user",
        timeoutMs: 900_000,
        envs: { TMPDIR: "/home/user/workspaces/.tmp", CI: "1" },
      },
    });

    await env.exec("pnpm test", { cwd: `${E2B_WORKSPACES_ROOT}/issue-7`, timeoutMs: 1_000 });
    expect(fake.runs[1]?.options).toEqual({
      cwd: `${E2B_WORKSPACES_ROOT}/issue-7`,
      timeoutMs: 1_000,
      envs: { TMPDIR: `${E2B_WORKSPACES_ROOT}/.tmp` },
    });
  });

  it("reports a failed command as a red result and a deadline as exit 124", async () => {
    const failing = await sessionFor(
      fakeSandbox({
        run: async () => {
          throw new CommandExitError({ stdout: "partial", stderr: "boom", exitCode: 2 });
        },
      }).sandbox,
    );
    await expect(failing.exec("pnpm test")).resolves.toEqual({ stdout: "partial", stderr: "boom", exitCode: 2 });

    const timing = await sessionFor(
      fakeSandbox({
        run: async () => {
          throw new TimeoutError("command timed out");
        },
      }).sandbox,
      "job-timeout",
    );
    await expect(timing.exec("sleep 999")).resolves.toMatchObject({ exitCode: 124 });
  });

  it("deletes recursively through the shell, which E2B's file API cannot express", async () => {
    const fake = fakeSandbox();
    const env = await sessionFor(fake.sandbox);

    await env.rm(`${E2B_WORKSPACES_ROOT}/issue-7`, { recursive: true, force: true });
    expect(fake.runs.at(-1)?.command).toBe(`rm -rf -- '${E2B_WORKSPACES_ROOT}/issue-7'`);
    expect(fake.removed).toEqual([]);

    await env.rm(`${E2B_WORKSPACES_ROOT}/issue-7/.source.tar.gz`);
    expect(fake.removed).toEqual([`${E2B_WORKSPACES_ROOT}/issue-7/.source.tar.gz`]);
  });

  it("raises a failed recursive delete instead of reporting a clean workspace", async () => {
    const env = await sessionFor(
      fakeSandbox({ run: async () => ({ stdout: "", stderr: "Permission denied", exitCode: 1 }) }).sandbox,
    );
    await expect(env.rm("/home/user/workspaces/issue-7", { recursive: true })).rejects.toThrow("Permission denied");
  });

  it("maps sandbox file metadata without fabricating what E2B does not report", async () => {
    const env = await sessionFor(fakeSandbox().sandbox);
    await expect(env.stat(`${E2B_WORKSPACES_ROOT}/issue-7`)).resolves.toEqual({
      isFile: false,
      isDirectory: true,
      isSymbolicLink: false,
      size: 4_096,
      mtime: new Date(0),
    });
    await expect(env.readdir(E2B_WORKSPACES_ROOT)).resolves.toEqual(["package.json", "src"]);
    await expect(env.readFile("/home/user/note.txt")).resolves.toBe("bytes of /home/user/note.txt");
  });

  it("gives one job one sandbox even when Flue initializes several harnesses", async () => {
    let created = 0;
    const fake = fakeSandbox();
    const factory = e2bSandbox({
      timeoutMs: 900_000,
      create: async () => {
        created += 1;
        return fake.sandbox;
      },
    });

    await factory.createSessionEnv({ id: "job-1" });
    await factory.createSessionEnv({ id: "job-1" });
    expect(created).toBe(1);

    await factory.createSessionEnv({ id: "job-2" });
    expect(created).toBe(2);
  });

  it("does not cache a failed sandbox boot as the job's answer", async () => {
    let attempts = 0;
    const fake = fakeSandbox();
    const factory = e2bSandbox({
      timeoutMs: 900_000,
      create: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error("E2B unreachable");
        return fake.sandbox;
      },
    });

    await expect(factory.createSessionEnv({ id: "job-1" })).rejects.toThrow("E2B unreachable");
    await expect(factory.createSessionEnv({ id: "job-1" })).resolves.toBeDefined();
    expect(attempts).toBe(2);
  });

  it("threads the explicit E2B API key and template into sandbox creation (#251)", async () => {
    let created: { timeoutMs: number; template?: string; apiKey?: string } | undefined;
    const fake = fakeSandbox();
    const factory = e2bSandbox({
      timeoutMs: 1_000,
      apiKey: "e2b_secret_key",
      template: "flue-node",
      create: async (options) => {
        created = options;
        return fake.sandbox;
      },
    });

    await factory.createSessionEnv({ id: "job-key" });
    // The key is passed explicitly rather than read implicitly from the process environment.
    expect(created).toEqual({ timeoutMs: 1_000, template: "flue-node", apiKey: "e2b_secret_key" });
  });
});
