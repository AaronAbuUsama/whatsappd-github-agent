import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const fixtureRoot = join(repoRoot, "tests/fixtures/ambience");
const tempRoot = mkdtempSync(join(tmpdir(), "ambience-flue-"));
const buildRoot = mkdtempSync(join(fixtureRoot, ".test-build-"));
const outputRoot = join(buildRoot, "dist");
const databasePath = join(tempRoot, "flue.db");

let server: ChildProcessWithoutNullStreams | undefined;
let origin: string;

async function unusedPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const listener = createServer();
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", () => {
      const address = listener.address();
      if (!address || typeof address === "string") {
        reject(new Error("Failed to allocate a test port"));
        return;
      }
      listener.close((error) => (error ? reject(error) : resolve(address.port)));
    });
  });
}

async function waitForServer(url: string, process: ChildProcessWithoutNullStreams) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (process.exitCode !== null) {
      throw new Error(`Flue fixture exited before readiness with ${process.exitCode}`);
    }
    try {
      const response = await fetch(`${url}/health`);
      if (response.ok) return;
    } catch {
      // The listener is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("Timed out waiting for the Flue fixture server");
}

async function prompt(chatId: string, message: string) {
  const response = await fetch(`${origin}/agents/ambience/${chatId}?wait=result`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message }),
  });
  expect(response.status, await response.text()).toBe(200);
}

beforeAll(async () => {
  const build = spawn(
    "pnpm",
    ["exec", "flue", "build", "--target", "node", "--root", fixtureRoot, "--output", outputRoot],
    { cwd: repoRoot, env: process.env, stdio: "pipe" },
  );
  const buildOutput: Buffer[] = [];
  build.stdout.on("data", (chunk) => buildOutput.push(chunk));
  build.stderr.on("data", (chunk) => buildOutput.push(chunk));
  const buildExit = await new Promise<number | null>((resolve) => build.once("close", resolve));
  expect(buildExit, Buffer.concat(buildOutput).toString()).toBe(0);
  expect(existsSync(join(outputRoot, "server.mjs"))).toBe(true);

  const port = await unusedPort();
  origin = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [join(outputRoot, "server.mjs")], {
    cwd: fixtureRoot,
    env: {
      ...process.env,
      FLUE_DB_PATH: databasePath,
      OPENAI_API_KEY: "",
      PORT: String(port),
    },
    stdio: "pipe",
  });
  await waitForServer(origin, server);
}, 60_000);

afterAll(async () => {
  if (server && server.exitCode === null) {
    server.kill("SIGTERM");
    await new Promise((resolve) => server?.once("close", resolve));
  }
  rmSync(buildRoot, { recursive: true, force: true });
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("persisted Ambience doorway", () => {
  it("keeps ordinary final prose private in one canonical chat history", async () => {
    const chatId = "120363000000000000@g.us";

    await prompt(chatId, "first coalesced input");
    await prompt(chatId, "second coalesced input");

    const response = await fetch(`${origin}/agents/ambience/${chatId}?view=history`);
    expect(response.status).toBe(200);
    const history = (await response.json()) as {
      messages: Array<{ role: string; parts: Array<{ type: string; text?: string }> }>;
    };
    const visibleMessages = history.messages.map((message) => ({
      role: message.role,
      text: message.parts
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join(""),
    }));

    expect(visibleMessages).toEqual([
      { role: "user", text: "first coalesced input" },
      { role: "assistant", text: "private working note one" },
      { role: "user", text: "second coalesced input" },
      { role: "assistant", text: "private working note two" },
    ]);
  });
});
