import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

type EvalFamily = "deterministic" | "live";

const requested = process.argv[2] ?? "both";
if (requested !== "both" && requested !== "deterministic" && requested !== "live") {
  throw new Error(`Unknown eval family ${JSON.stringify(requested)}. Use both, deterministic, or live.`);
}

const families: EvalFamily[] = requested === "both" ? ["deterministic", "live"] : [requested];
const repository = resolve(import.meta.dirname, "..");
const fixtureRoot = join(repository, "tests/fixtures/speaker");
const flue = join(repository, "node_modules/.bin/flue");
const vitest = join(repository, "node_modules/.bin/vitest");
const baselineRun = new Date().toISOString().replaceAll(/[:.]/g, "-");
const experimentName = process.env.BRAINTRUST_EXPERIMENT_NAME ?? `ambient-agent-eval-baseline-${baselineRun}`;
const availablePort = async (): Promise<number> =>
  await new Promise<number>((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate an eval fixture port."));
        return;
      }
      server.close((cause) => (cause === undefined ? resolvePort(address.port) : reject(cause)));
    });
  });

const port =
  process.env.SPEAKER_EVAL_PORT === undefined
    ? await availablePort()
    : Number.parseInt(process.env.SPEAKER_EVAL_PORT, 10);
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("SPEAKER_EVAL_PORT must be an integer from 1 to 65535.");
}
const baseUrl = `http://127.0.0.1:${port}`;

const run = async (command: string, args: string[], env: NodeJS.ProcessEnv): Promise<void> => {
  const child = spawn(command, args, { cwd: repository, env, stdio: "inherit" });
  const exitCode = await new Promise<number | null>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolveExit(code));
  });
  if (exitCode !== 0) throw new Error(`${command} exited with code ${exitCode ?? "signal"}.`);
};

const waitForFixture = async (child: ChildProcess): Promise<void> => {
  let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  child.once("exit", (code, signal) => {
    exit = { code, signal };
  });
  const deadline = Date.now() + 20_000;
  for (;;) {
    if (exit !== undefined) {
      throw new Error(`Eval fixture exited before it became ready (${exit.code ?? exit.signal ?? "unknown"}).`);
    }
    try {
      const response = await fetch(`${baseUrl}/health`);
      if (response.ok) return;
    } catch {
      // The fixture has not bound its port yet.
    }
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for the eval fixture at ${baseUrl}.`);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }
};

const stopFixture = async (child: ChildProcess): Promise<void> => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const signal = (value: NodeJS.Signals): void => {
    if (child.pid !== undefined && process.platform !== "win32") {
      try {
        process.kill(-child.pid, value);
        return;
      } catch {
        // Fall back to the direct child below.
      }
    }
    child.kill(value);
  };
  const waitForExit = async (timeout: number): Promise<boolean> => {
    if (child.exitCode !== null || child.signalCode !== null) return true;
    return await new Promise<boolean>((resolveExit) => {
      const exited = () => {
        clearTimeout(timer);
        resolveExit(true);
      };
      const timer = setTimeout(() => {
        child.removeListener("exit", exited);
        resolveExit(false);
      }, timeout);
      child.once("exit", exited);
    });
  };

  signal("SIGINT");
  if (await waitForExit(5_000)) return;
  signal("SIGTERM");
  if (await waitForExit(3_000)) return;
  signal("SIGKILL");
  if (!(await waitForExit(2_000))) throw new Error("Eval fixture did not exit after SIGKILL.");
};

const runFamily = async (family: EvalFamily): Promise<void> => {
  const live = family === "live";
  if (live && !process.env.SPEAKER_FIXTURE_DATA_DIR) {
    throw new Error(
      "SPEAKER_FIXTURE_DATA_DIR is required for live judged evals; point it at an initialized non-production data directory.",
    );
  }

  const workingDirectory = await mkdtemp(join(tmpdir(), `ambient-agent-evals-${family}-`));
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    APPLICATION_DB_PATH: join(workingDirectory, "application.sqlite"),
    SPEAKER_EVAL_LIVE_MODEL: live ? "true" : "false",
    SPEAKER_FIXTURE_LIVE_MODEL: live ? "true" : "false",
    BRAINTRUST_EXPERIMENT_NAME: experimentName,
    ...(process.env.BRAINTRUST_API_KEY === undefined ? {} : { BRAINTRUST_TRACING: "1" }),
    FLUE_BASE_URL: baseUrl,
    GITHUB_WEBHOOK_SECRET: process.env.GITHUB_WEBHOOK_SECRET ?? "eval-fixture-only-secret",
  };
  const fixture = spawn(flue, ["dev", "--target", "node", "--root", fixtureRoot, "--port", String(port)], {
    cwd: workingDirectory,
    detached: process.platform !== "win32",
    env: environment,
    stdio: "inherit",
  });

  const interrupted = () => {
    if (fixture.pid !== undefined && process.platform !== "win32") process.kill(-fixture.pid, "SIGINT");
    else fixture.kill("SIGINT");
  };
  process.once("SIGINT", interrupted);
  process.once("SIGTERM", interrupted);
  try {
    console.info(`\n[evals] Starting ${family} suite at ${baseUrl}.`);
    await waitForFixture(fixture);
    await run(vitest, ["run", "--config", join(repository, "vitest.evals.config.ts")], environment);
  } finally {
    process.removeListener("SIGINT", interrupted);
    process.removeListener("SIGTERM", interrupted);
    await stopFixture(fixture);
    await rm(workingDirectory, { recursive: true, force: true });
  }
};

for (const family of families) await runFamily(family);
