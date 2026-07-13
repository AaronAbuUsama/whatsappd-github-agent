import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { IncomingMessage } from "../../src/coalescer/events.ts";
import type { FakeWhatsAppEvent } from "../../src/host/fake-whatsapp-host.ts";

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

async function historyText(chatId: string): Promise<string> {
  const response = await fetch(`${origin}/agents/ambience/${chatId}?view=history`);
  if (!response.ok) return "";
  const history = (await response.json()) as {
    messages: Array<{ role: string; parts: Array<{ type: string; text?: string }> }>;
  };
  return history.messages
    .flatMap((message) => message.parts.filter((part) => part.type === "text").map((part) => part.text ?? ""))
    .join("\n");
}

async function waitFor(predicate: () => Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

let messageSequence = 0;
async function coalescerMessage(
  chatId: string,
  text: string,
  overrides: Partial<IncomingMessage> = {},
): Promise<void> {
  const n = ++messageSequence;
  const input: IncomingMessage = {
    id: `fixture-${n}`,
    chatId,
    from: "alice@s.whatsapp.net",
    pushName: "Alice",
    text,
    timestamp: n * 1_000,
    isGroup: true,
    fromMe: false,
    live: true,
    mentions: [],
    ...overrides,
  };
  const response = await fetch(`${origin}/test/coalescer`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  expect(response.status, await response.text()).toBe(202);
}

async function whatsappEvents(): Promise<readonly FakeWhatsAppEvent[]> {
  const response = await fetch(`${origin}/test/whatsapp/events`);
  expect(response.status).toBe(200);
  return (await response.json()) as FakeWhatsAppEvent[];
}

async function resetWhatsApp(): Promise<void> {
  const response = await fetch(`${origin}/test/whatsapp/events`, { method: "DELETE" });
  expect(response.status).toBe(204);
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

  it("processes and persists an ambient coalesced input without speech", async () => {
    const chatId = "silent-27@g.us";
    await resetWhatsApp();

    await coalescerMessage(chatId, "QUIET_CONTEXT_MARKER");
    await waitFor(async () => (await historyText(chatId)).includes("Private ambient context retained"), "silent turn");

    expect(await whatsappEvents()).toEqual([]);
    const history = await historyText(chatId);
    expect(history).toContain("QUIET_CONTEXT_MARKER");
    expect(history).toContain("Private ambient context retained without speaking.");
  });

  it("delivers exactly one explicit say and never forwards private final prose", async () => {
    const chatId = "speech-27@g.us";
    await resetWhatsApp();

    await coalescerMessage(chatId, "SPEAK_ONCE", { mentions: ["bot@s.whatsapp.net"] });
    await waitFor(
      async () =>
        (await whatsappEvents()).length === 3 &&
        (await historyText(chatId)).includes("Private speech outcome retained"),
      "successful fake WhatsApp turn settlement",
    );

    const events = await whatsappEvents();
    expect(events).toEqual([
      { kind: "typing", chatId, on: true },
      { kind: "send", chatId, text: "one explicit outbound", outcome: "sent", messageId: "fake-message-1" },
      { kind: "typing", chatId, on: false },
    ]);
    const history = await historyText(chatId);
    expect(history).toContain("Private speech outcome retained for the next Ambience turn.");
    expect(JSON.stringify(events)).not.toContain("Private speech outcome");
  });

  it("finalizes typing and does not retry when a send outcome is unknown", async () => {
    const chatId = "failure-27@g.us";
    await resetWhatsApp();
    const fail = await fetch(`${origin}/test/whatsapp/fail-next-send`, { method: "POST" });
    expect(fail.status).toBe(204);

    await coalescerMessage(chatId, "FAIL_SEND", { mentions: ["bot@s.whatsapp.net"] });
    await waitFor(
      async () =>
        (await whatsappEvents()).length === 3 &&
        (await historyText(chatId)).includes("Private speech outcome retained"),
      "unknown fake WhatsApp outcome settlement",
    );

    expect(await whatsappEvents()).toEqual([
      { kind: "typing", chatId, on: true },
      { kind: "send", chatId, text: "uncertain outbound", outcome: "unknown", error: "provider outcome unknown" },
      { kind: "typing", chatId, on: false },
    ]);
  });

  it("isolates chat instances while retaining sequential context and order within one chat", async () => {
    const chatA = "ordered-a-27@g.us";
    const chatB = "isolated-b-27@g.us";

    await coalescerMessage(chatA, "A_FIRST");
    await waitFor(
      async () => (await historyText(chatA)).includes("Private ambient context retained without speaking."),
      "chat A first turn settlement",
    );
    await coalescerMessage(chatB, "B_ONLY");
    await waitFor(
      async () => (await historyText(chatB)).includes("Chat B remained isolated from Chat A."),
      "chat B turn settlement",
    );
    await coalescerMessage(chatA, "A_SECOND");
    await waitFor(
      async () => (await historyText(chatA)).includes("Chat A retained its first window in context."),
      "chat A second turn settlement",
    );

    const a = await historyText(chatA);
    const b = await historyText(chatB);
    expect(a.indexOf("A_FIRST")).toBeLessThan(a.indexOf("A_SECOND"));
    expect(a).toContain("Chat A retained its first window in context.");
    expect(a).not.toContain("B_ONLY");
    expect(b).toContain("B_ONLY");
    expect(b).toContain("Chat B remained isolated from Chat A.");
    expect(b).not.toContain("A_FIRST");
    expect(b).not.toContain("A_SECOND");
  });
});
