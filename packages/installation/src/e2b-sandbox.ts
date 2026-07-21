import { posix } from "node:path";

import { createSandboxSessionEnv, type FileStat, type SandboxApi, type SandboxFactory, type SessionEnv } from "@flue/runtime";
import { CommandExitError, Sandbox, TimeoutError } from "e2b";

/**
 * Where a job's workspace tree lives inside the sandbox. `/home/user` is E2B's home for
 * the default sandbox user, and the Flue E2B blueprint resolves workspace paths from it.
 * The Coder and Reviewer runtimes take this as their `workspacesRoot`: with the agent
 * shells on E2B (ADR 0021) the workspace is a path in the micro-VM, never on the host.
 */
export const E2B_SANDBOX_HOME = "/home/user";
export const E2B_WORKSPACES_ROOT = `${E2B_SANDBOX_HOME}/workspaces`;

/**
 * Workspace-local `TMPDIR` (#172). The model's shell tools run the target repo's install and
 * tests, and those spawn binaries out of the temp directory — which fails `EACCES` the moment
 * `/tmp` is mounted `noexec`. That is the recorded cause of the Coder green path never once
 * completing (`docs/proof/behavior-battery.md` BAT-0a).
 *
 * This is deliberately NOT assumed away for E2B. Whether a given template mounts `/tmp` exec
 * is a provider detail we do not control and have never measured; pointing TMPDIR at the
 * workspace tree removes the dependency on that detail entirely. Kept at the workspaces root
 * rather than under a job's directory so a per-job cleanup never destroys it.
 */
export const E2B_TMP_DIR = `${E2B_WORKSPACES_ROOT}/.tmp`;

/**
 * The slice of the `e2b` SDK's `Sandbox` this adapter drives. Structural, in the same
 * spirit as Flue's own `BashLike`, so a test can supply a fake without standing up the
 * whole SDK class. `defaultCreate` below assigns the real `Sandbox` to it, so the shape
 * is still type-checked against the installed SDK.
 */
export interface E2BSandboxLike {
  readonly files: {
    read(path: string, options: { format: "bytes" }): Promise<Uint8Array>;
    write(path: string, data: string | ArrayBuffer): Promise<unknown>;
    list(path: string): Promise<readonly { readonly name: string }[]>;
    makeDir(path: string): Promise<boolean>;
    remove(path: string): Promise<void>;
    exists(path: string): Promise<boolean>;
    getInfo(path: string): Promise<{
      readonly type?: string;
      readonly size: number;
      readonly modifiedTime?: Date;
      readonly symlinkTarget?: string;
    }>;
  };
  readonly commands: {
    run(
      command: string,
      options?: { cwd?: string; envs?: Record<string, string>; timeoutMs?: number; signal?: AbortSignal },
    ): Promise<{ stdout: string; stderr: string; exitCode: number }>;
  };
  kill(): Promise<boolean>;
}

const decoder = new TextDecoder();

/** Detach the view from any pooled backing store — E2B's `write` takes an ArrayBuffer. */
const arrayBuffer = (content: Uint8Array): ArrayBuffer =>
  content.buffer.slice(content.byteOffset, content.byteOffset + content.byteLength) as ArrayBuffer;

/** Single-quote a path for the one place this adapter has to build a shell word. */
const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

class E2BSandboxApi implements SandboxApi {
  constructor(
    private readonly sandbox: E2BSandboxLike,
    private readonly cwd: string,
    private readonly defaultTimeoutMs: number,
  ) {}

  /** Relative paths resolve against the session cwd; absolute paths pass through. */
  private path(path: string): string {
    return posix.resolve(this.cwd, path);
  }

  async readFile(path: string): Promise<string> {
    return decoder.decode(await this.readFileBuffer(path));
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    return await this.sandbox.files.read(this.path(path), { format: "bytes" });
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    // E2B's write creates the missing parents itself — the `FlueFs.writeFile` guarantee.
    await this.sandbox.files.write(this.path(path), typeof content === "string" ? content : arrayBuffer(content));
  }

  async stat(path: string): Promise<FileStat> {
    const info = await this.sandbox.files.getInfo(this.path(path));
    return {
      isFile: info.type === "file",
      isDirectory: info.type === "dir",
      isSymbolicLink: info.symlinkTarget !== undefined,
      size: info.size,
      // FileStat forbids fabricated placeholders, so an absent mtime stays absent.
      ...(info.modifiedTime === undefined ? {} : { mtime: info.modifiedTime }),
    };
  }

  async readdir(path: string): Promise<string[]> {
    return (await this.sandbox.files.list(this.path(path))).map((entry) => entry.name);
  }

  async exists(path: string): Promise<boolean> {
    return await this.sandbox.files.exists(this.path(path));
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    // E2B's makeDir always creates the parents and answers false when the path is already
    // there. Non-recursive mkdir over an existing path throws, as it does on Node.
    const created = await this.sandbox.files.makeDir(this.path(path));
    if (!created && options?.recursive !== true) throw new Error(`Sandbox path already exists: ${path}`);
  }

  async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
    const target = this.path(path);
    if (options?.recursive !== true && options?.force !== true) {
      await this.sandbox.files.remove(target);
      return;
    }
    // E2B's files.remove() has no recursive or force flag, and Flue's blueprint adapter
    // simply rejects both. We cannot: the Coder and the Reviewer each clean their
    // workspace through this seam mid-job (coder/workflow.ts, reviewer/workflow.ts), so
    // rejecting would fail every job before the model runs. `rm` inside the sandbox is
    // the same deletion with the flags E2B's file API omits.
    const flags = `-${options.recursive === true ? "r" : ""}${options.force === true ? "f" : ""}`;
    const result = await this.exec(`rm ${flags} -- ${shellQuote(target)}`);
    if (result.exitCode !== 0) throw new Error(result.stderr || `Sandbox rm exited ${result.exitCode}: ${path}`);
  }

  async exec(
    command: string,
    options?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number; signal?: AbortSignal },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    try {
      const { stdout, stderr, exitCode } = await this.sandbox.commands.run(command, {
        cwd: this.path(options?.cwd ?? this.cwd),
        // E2B's own default is 60s, far under a repo's test run, so an unspecified
        // deadline falls back to the job's sandbox budget rather than E2B's.
        timeoutMs: options?.timeoutMs ?? this.defaultTimeoutMs,
        // TMPDIR first so a caller can still override it deliberately.
        envs: { TMPDIR: E2B_TMP_DIR, ...options?.env },
        ...(options?.signal === undefined ? {} : { signal: options.signal }),
      });
      return { stdout, stderr, exitCode };
    } catch (cause) {
      // A non-zero exit is a shell result, not an adapter failure; E2B raises it.
      if (cause instanceof CommandExitError) {
        return { stdout: cause.stdout, stderr: cause.stderr, exitCode: cause.exitCode };
      }
      // 124 is what a timed-out command reports, matching `timeout(1)` and the sandbox
      // this replaces, so a deadline reads as a red command rather than a crashed job.
      if (cause instanceof TimeoutError) {
        return { stdout: "", stderr: cause.message, exitCode: 124 };
      }
      throw cause;
    }
  }
}

export interface E2BSandboxOptions {
  /**
   * The job's whole budget: how long E2B keeps the sandbox alive, and the deadline a
   * shell command inherits when its caller names none.
   */
  readonly timeoutMs: number;
  /** E2B template to boot. Undefined uses the account's default template. */
  readonly template?: string;
  /**
   * The E2B API key, passed explicitly to `Sandbox.create` rather than left to the SDK's
   * implicit `E2B_API_KEY` read (#251): the sandbox selector owns key resolution now, so the
   * key travels through config rather than the ambient process environment.
   */
  readonly apiKey?: string;
  /** Seam for tests; production creates a real provider sandbox. */
  readonly create?: (options: { timeoutMs: number; template?: string; apiKey?: string }) => Promise<E2BSandboxLike>;
}

const defaultCreate = async (options: { timeoutMs: number; template?: string; apiKey?: string }): Promise<E2BSandboxLike> => {
  const createOptions = {
    timeoutMs: options.timeoutMs,
    ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
  };
  return options.template === undefined
    ? await Sandbox.create(createOptions)
    : await Sandbox.create(options.template, createOptions);
};

/**
 * Per-job E2B micro-VMs behind Flue's `SandboxFactory` seam (ADR 0021). The runtime
 * container mounts no Docker socket, so a sandbox escape lands in a disposable provider
 * VM rather than on the host holding tenant sessions and secrets.
 *
 * Authentication is the SDK's own `E2B_API_KEY` environment variable — operator
 * configuration, tenant-independent, never tenant data.
 */
export const e2bSandbox = (options: E2BSandboxOptions): SandboxFactory => {
  const create = options.create ?? defaultCreate;
  // Flue calls createSessionEnv once per initialized harness and may repeat the call with
  // the same context id, so keying on that id gives one sandbox per job instead of one
  // per harness.
  const sessions = new Map<string, Promise<SessionEnv>>();
  return {
    async createSessionEnv({ id }) {
      const existing = sessions.get(id);
      if (existing !== undefined) return await existing;
      const session = (async (): Promise<SessionEnv> => {
        const sandbox = await create({
          timeoutMs: options.timeoutMs,
          ...(options.template === undefined ? {} : { template: options.template }),
          ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
        });
        // ponytail: SandboxFactory has no teardown hook, so the job's sandbox dies on its
        // own provider timeout rather than at the last task. This timer drops our
        // reference (the map would otherwise grow for the process's life) and kills the
        // sandbox promptly. Destroy it at the real end of the job once Flue's seam
        // exposes session-env disposal.
        setTimeout(() => {
          sessions.delete(id);
          void sandbox.kill().catch(() => undefined);
        }, options.timeoutMs).unref();
        // TMPDIR must exist before the first command names it.
        await sandbox.files.makeDir(E2B_TMP_DIR);
        return createSandboxSessionEnv(new E2BSandboxApi(sandbox, E2B_SANDBOX_HOME, options.timeoutMs), E2B_SANDBOX_HOME);
      })();
      sessions.set(id, session);
      // A failed boot must not be cached as this job's permanent answer.
      session.catch(() => sessions.delete(id));
      return await session;
    },
  };
};
