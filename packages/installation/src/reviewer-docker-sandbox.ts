import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, posix } from "node:path";

import { createSandboxSessionEnv, type FileStat, type SandboxApi, type SandboxFactory } from "@flue/runtime";

interface ProcessResult {
  readonly stdout: Uint8Array;
  readonly stderr: string;
  readonly exitCode: number;
  readonly interrupted: boolean;
}

const runProcess = async (
  executable: string,
  args: readonly string[],
  options: { readonly input?: string | Uint8Array; readonly timeoutMs?: number; readonly signal?: AbortSignal } = {},
): Promise<ProcessResult> =>
  await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ["pipe", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let interrupted = false;
    const stop = () => {
      interrupted = true;
      child.kill("SIGKILL");
    };
    const timer = options.timeoutMs === undefined ? undefined : setTimeout(stop, options.timeoutMs);
    options.signal?.addEventListener("abort", stop, { once: true });
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (timer !== undefined) clearTimeout(timer);
      options.signal?.removeEventListener("abort", stop);
      resolve({
        stdout: new Uint8Array(Buffer.concat(stdout)),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode: interrupted ? 124 : (code ?? 1),
        interrupted,
      });
    });
    child.stdin.end(options.input);
  });

class DockerSandboxApi implements SandboxApi {
  private sequence = 0;

  constructor(
    private readonly executable: string,
    private readonly image: string,
    private readonly hostRoot: string,
    private readonly cwd: string,
    private readonly session: string,
  ) {}

  private path(path: string): string {
    const resolved = posix.resolve(this.cwd, path);
    if (resolved !== this.cwd && !resolved.startsWith(`${this.cwd}/`)) {
      throw new Error(`Reviewer sandbox path escapes ${this.cwd}: ${path}`);
    }
    return resolved;
  }

  private async container(
    command: string,
    args: readonly string[] = [],
    options: {
      readonly cwd?: string;
      readonly env?: Readonly<Record<string, string>>;
      readonly input?: string | Uint8Array;
      readonly timeoutMs?: number;
      readonly signal?: AbortSignal;
    } = {},
  ): Promise<ProcessResult> {
    const name = `${this.session}-${++this.sequence}`;
    const result = await runProcess(this.executable, [
      "run", "--rm", "--name", name, "--network", "bridge", "-i",
      "--mount", `type=bind,src=${this.hostRoot},dst=${this.cwd}`,
      "--workdir", this.path(options.cwd ?? this.cwd),
      ...Object.entries(options.env ?? {}).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
      // Keep pnpm's content-addressed store inside the disposable container instead
      // of leaking a per-review cache into the persistent workspace bind mount.
      "--env", "npm_config_store_dir=/tmp/pnpm-store",
      "--env", "pnpm_config_store_dir=/tmp/pnpm-store",
      this.image,
      "sh", "-c", command, "sh", ...args,
    ], options);
    if (result.interrupted) {
      await runProcess(this.executable, ["rm", "--force", name]).catch(() => undefined);
    }
    return result;
  }

  private async required(command: string, args: readonly string[] = [], input?: string | Uint8Array): Promise<ProcessResult> {
    const result = await this.container(command, args, { input });
    if (result.exitCode !== 0) throw new Error(result.stderr || `Reviewer sandbox command exited ${result.exitCode}`);
    return result;
  }

  async readFile(path: string): Promise<string> {
    return Buffer.from((await this.readFileBuffer(path))).toString("utf8");
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    return (await this.required("cat -- \"$1\"", [this.path(path)])).stdout;
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    await this.required("umask 077; cat > \"$1\"", [this.path(path)], content);
  }

  async stat(path: string): Promise<FileStat> {
    const output = Buffer.from((await this.required(
      "if [ -L \"$1\" ]; then type=l; elif [ -f \"$1\" ]; then type=f; elif [ -d \"$1\" ]; then type=d; else type=o; fi; printf '%s\\t' \"$type\"; stat -c '%s\\t%Y' -- \"$1\"",
      [this.path(path)],
    )).stdout)
      .toString("utf8").trim().split("\t");
    const type = output[0] ?? "";
    return {
      isFile: type === "f",
      isDirectory: type === "d",
      isSymbolicLink: type === "l",
      size: Number(output[1]),
      mtime: new Date(Number(output[2]) * 1_000),
    };
  }

  async readdir(path: string): Promise<string[]> {
    const output = (await this.required("find \"$1\" -mindepth 1 -maxdepth 1 -printf '%f\\0'", [this.path(path)])).stdout;
    return Buffer.from(output).toString("utf8").split("\0").filter(Boolean);
  }

  async exists(path: string): Promise<boolean> {
    return (await this.container("test -e \"$1\" || test -L \"$1\"", [this.path(path)])).exitCode === 0;
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    await this.required(options?.recursive ? "mkdir -p -- \"$1\"" : "mkdir -- \"$1\"", [this.path(path)]);
  }

  async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
    const flags = `${options?.recursive ? "r" : ""}${options?.force ? "f" : ""}`;
    await this.required(`rm ${flags === "" ? "" : `-${flags} `}-- "$1"`, [this.path(path)]);
  }

  async exec(
    command: string,
    options?: { cwd?: string; env?: Record<string, string>; timeoutMs?: number; signal?: AbortSignal },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const result = await this.container(command, [], options);
    return { stdout: Buffer.from(result.stdout).toString("utf8"), stderr: result.stderr, exitCode: result.exitCode };
  }
}

export const reviewerDockerSandbox = (options: {
  readonly root: string;
  readonly cwd: string;
  readonly image: string;
  readonly executable?: string;
}): SandboxFactory => ({
  async createSessionEnv({ id }) {
    const session = `ambient-review-${createHash("sha256").update(id).digest("hex").slice(0, 16)}`;
    const hostRoot = join(options.root, session);
    await mkdir(hostRoot, { recursive: true, mode: 0o700 });
    // ponytail: one ephemeral container per operation keeps PR code isolated without a
    // daemon SDK or long-lived container lifecycle. Use a provider adapter if startup
    // overhead becomes material.
    return createSandboxSessionEnv(
      new DockerSandboxApi(options.executable ?? "docker", options.image, hostRoot, options.cwd, session),
      options.cwd,
    );
  },
});
