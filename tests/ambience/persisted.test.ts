import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHmac } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import type { IncomingMessage } from "../../src/coalescer/events.ts";
import type { FakeGitHubProofEvent } from "../../src/host/fake-github-proof-host.ts";
import type { FakeWhatsAppEvent } from "../../src/host/fake-whatsapp-host.ts";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const fixtureRoot = join(repoRoot, "tests/fixtures/ambience");
const tempRoot = mkdtempSync(join(tmpdir(), "ambience-flue-"));
const buildRoot = mkdtempSync(join(fixtureRoot, ".test-build-"));
const outputRoot = join(buildRoot, "dist");
const databasePath = join(tempRoot, "flue.sqlite");
const githubIngressDatabasePath = join(tempRoot, "github-ingress.db");
const githubWebhookSecret = "fixture-github-webhook-secret";

let server: ChildProcessWithoutNullStreams | undefined;
let origin: string;
let serverOutput = "";

async function stopServer(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
  const current = server;
  if (!current || current.exitCode !== null) return;
  current.kill(signal);
  await new Promise<void>((resolve) => current.once("close", () => resolve()));
  server = undefined;
}

async function startServer(extraEnv: NodeJS.ProcessEnv = {}): Promise<void> {
  const port = await unusedPort();
  origin = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [join(outputRoot, "server.mjs")], {
    cwd: tempRoot,
    env: {
      ...process.env,
      GITHUB_WEBHOOK_SECRET: githubWebhookSecret,
      GITHUB_CHAT_ROUTES: "acme/widgets=github-ingress-29@g.us",
      GITHUB_INGRESS_DB_PATH: githubIngressDatabasePath,
      OPENAI_API_KEY: "",
      PORT: String(port),
      ...extraEnv,
    },
    stdio: "pipe",
  });
  serverOutput = "";
  server.stdout.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });
  server.stderr.on("data", (chunk) => {
    serverOutput += chunk.toString();
  });
  await waitForServer(origin, server);
}

function expireRunningAgentLeases(): void {
  // Simulate the documented 30-second lease expiry directly so the recovery
  // test is state-driven rather than sleeping on a production timeout.
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("UPDATE flue_agent_submissions SET lease_expires_at = 1 WHERE status = 'running'");
  } finally {
    database.close();
  }
}

function inspectAgentSubmissions(chatId: string): unknown[] {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return database
      .prepare(
        `SELECT submission_id, status, attempt_id, input_applied_at, recovery_requested_at,
              started_at, settled_at, error, attempt_count, lease_expires_at
         FROM flue_agent_submissions
        WHERE payload LIKE ?
        ORDER BY sequence`,
      )
      .all(`%${chatId}%`);
  } finally {
    database.close();
  }
}

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

async function admitPrompt(chatId: string, message: string): Promise<void> {
  const response = await fetch(`${origin}/agents/ambience/${chatId}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message }),
  });
  const body = await response.text();
  expect(response.status, body).toBe(202);
  const receipt = JSON.parse(body) as { submissionId?: string };
  expect(receipt.submissionId).toBeTruthy();
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

function githubIssueOpenedPayload(repository = "widgets"): string {
  return JSON.stringify({
    action: "opened",
    installation: { id: 77 },
    repository: {
      id: repository === "widgets" ? 101 : 202,
      name: repository,
      html_url: `https://github.com/acme/${repository}`,
      owner: { login: "acme" },
    },
    issue: {
      number: 29,
      html_url: `https://github.com/acme/${repository}/issues/29`,
      title: "Signed delivery proof",
      state: "open",
    },
    sender: { login: "octocat", id: 1, type: "User" },
  });
}

async function githubDelivery(options: {
  readonly deliveryId: string;
  readonly body: string;
  readonly signature?: string;
  readonly event?: string;
}): Promise<Response> {
  const signature = options.signature ?? createHmac("sha256", githubWebhookSecret).update(options.body).digest("hex");
  return await fetch(`${origin}/channels/github/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": options.event ?? "issues",
      "x-github-delivery": options.deliveryId,
      "x-hub-signature-256": `sha256=${signature}`,
    },
    body: options.body,
  });
}

async function githubIngressRecords(): Promise<readonly Record<string, unknown>[]> {
  const response = await fetch(`${origin}/test/github/ingress`);
  expect(response.status).toBe(200);
  return (await response.json()) as readonly Record<string, unknown>[];
}

async function waitFor(predicate: () => Promise<boolean>, label: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${label}\nReplacement server output:\n${serverOutput}`);
}

let messageSequence = 0;
async function coalescerMessage(chatId: string, text: string, overrides: Partial<IncomingMessage> = {}): Promise<void> {
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

async function githubEvents(): Promise<readonly FakeGitHubProofEvent[]> {
  const response = await fetch(`${origin}/test/github/events`);
  expect(response.status).toBe(200);
  return (await response.json()) as FakeGitHubProofEvent[];
}

async function resetGitHub(): Promise<void> {
  const response = await fetch(`${origin}/test/github/events`, { method: "DELETE" });
  expect(response.status).toBe(204);
}

async function setNextGitHubCreate(mode: "failure" | "timeout-before" | "timeout-after"): Promise<void> {
  const path =
    mode === "failure"
      ? "fail-next-create"
      : `timeout-next-create?afterMutation=${mode === "timeout-after" ? "true" : "false"}`;
  const response = await fetch(`${origin}/test/github/${path}`, {
    method: "POST",
  });
  expect(response.status).toBe(204);
}

async function pendingRecoveryMarkers(): Promise<readonly string[]> {
  const response = await fetch(`${origin}/test/model/recovery-pending`);
  expect(response.status).toBe(200);
  return ((await response.json()) as { markers: string[] }).markers;
}

interface TestRunRecord {
  runId: string;
  workflowName: string;
  status: "active" | "completed" | "errored";
  input?: unknown;
  result?: unknown;
  error?: unknown;
}

async function pendingWorkflowOperations(): Promise<readonly string[]> {
  const response = await fetch(`${origin}/test/workflows/pending`);
  expect(response.status).toBe(200);
  return ((await response.json()) as { operationIds: string[] }).operationIds;
}

async function releaseWorkflow(operationId: string): Promise<void> {
  const response = await fetch(`${origin}/test/workflows/${operationId}/release`, {
    method: "POST",
  });
  expect(response.status, await response.text()).toBe(204);
}

async function getRun(runId: string): Promise<TestRunRecord> {
  const response = await fetch(`${origin}/test/runs/${runId}`);
  if (response.status !== 200) throw new Error(`Run lookup failed with ${response.status}: ${await response.text()}`);
  return (await response.json()) as TestRunRecord;
}

beforeAll(async () => {
  const build = spawn(
    "pnpm",
    ["exec", "flue", "build", "--target", "node", "--root", fixtureRoot, "--output", outputRoot],
    {
      cwd: repoRoot,
      env: { ...process.env, GITHUB_WEBHOOK_SECRET: githubWebhookSecret },
      stdio: "pipe",
    },
  );
  const buildOutput: Buffer[] = [];
  build.stdout.on("data", (chunk) => buildOutput.push(chunk));
  build.stderr.on("data", (chunk) => buildOutput.push(chunk));
  const buildExit = await new Promise<number | null>((resolve) => build.once("close", resolve));
  expect(buildExit, Buffer.concat(buildOutput).toString()).toBe(0);
  expect(existsSync(join(outputRoot, "server.mjs"))).toBe(true);

  await startServer();
}, 60_000);

afterAll(async () => {
  await stopServer();
  rmSync(buildRoot, { recursive: true, force: true });
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("persisted Ambience admission", () => {
  it("verifies, normalizes, deduplicates, and routes GitHub ingress without implying speech", async () => {
    const chatId = "github-ingress-29@g.us";
    const deliveryId = "29-valid-signed-delivery";
    const body = githubIssueOpenedPayload();
    await resetWhatsApp();

    const first = await githubDelivery({ deliveryId, body });
    const firstBody = await first.text();
    expect(first.status, firstBody).toBe(200);
    const firstReceipt = JSON.parse(firstBody) as { status: string; dispatchId: string };
    expect(firstReceipt.status).toBe("dispatched");
    expect(firstReceipt.dispatchId).toBeTruthy();
    await waitFor(
      async () => (await historyText(chatId)).includes("Private verified GitHub delivery processed without speaking."),
      "verified GitHub delivery settlement",
    );

    const duplicate = await githubDelivery({ deliveryId, body });
    const duplicateBody = await duplicate.text();
    expect(duplicate.status, duplicateBody).toBe(200);
    expect(JSON.parse(duplicateBody) as { status: string }).toMatchObject({ status: "duplicate" });

    const history = await historyText(chatId);
    expect(history.match(/github\.issue\.opened/g)).toHaveLength(1);
    expect(history).toContain(deliveryId);
    expect(history).toContain("acme");
    expect(history).toContain("widgets");
    expect(await whatsappEvents()).toEqual([]);
    expect(await githubIngressRecords()).toContainEqual(
      expect.objectContaining({
        deliveryId,
        repository: "acme/widgets",
        chatId,
        ambience: "ambience",
        dispatchId: firstReceipt.dispatchId,
        status: "dispatched",
      }),
    );
    expect(serverOutput).toContain(`"deliveryId":"${deliveryId}"`);
    expect(serverOutput).toContain(`"repository":"acme/widgets"`);
    expect(serverOutput).toContain(`"chatId":"${chatId}"`);
    expect(serverOutput).toContain(`"ambience":"ambience"`);
    expect(serverOutput).toContain(`"dispatchId":"${firstReceipt.dispatchId}"`);
    expect(serverOutput).toContain(`"runId":null`);
  });

  it("rejects an invalid GitHub signature before application processing", async () => {
    const deliveryId = "29-invalid-signature";
    const response = await githubDelivery({
      deliveryId,
      body: githubIssueOpenedPayload(),
      signature: "0".repeat(64),
    });

    expect(response.status).toBe(401);
    expect(await githubIngressRecords()).not.toContainEqual(expect.objectContaining({ deliveryId }));
  });

  it("rejects semantically identical JSON when the signed bytes differ", async () => {
    const deliveryId = "29-byte-altered-signature";
    const signedBody = githubIssueOpenedPayload();
    const signature = createHmac("sha256", githubWebhookSecret).update(signedBody).digest("hex");
    const response = await githubDelivery({
      deliveryId,
      body: `${signedBody}\n`,
      signature,
    });

    expect(response.status).toBe(401);
    expect(await githubIngressRecords()).not.toContainEqual(expect.objectContaining({ deliveryId }));
  });

  it("observes an unconfigured repository without guessing an Ambience destination", async () => {
    const deliveryId = "29-uncorrelated-repository";
    const response = await githubDelivery({
      deliveryId,
      body: githubIssueOpenedPayload("unconfigured"),
    });

    const responseBody = await response.text();
    expect(response.status, responseBody).toBe(200);
    expect(JSON.parse(responseBody)).toMatchObject({
      status: "uncorrelated",
      deliveryId,
      repository: "acme/unconfigured",
    });
    expect(await historyText("github-ingress-29@g.us")).not.toContain(deliveryId);
    expect(await githubIngressRecords()).toContainEqual(
      expect.objectContaining({
        deliveryId,
        repository: "acme/unconfigured",
        status: "uncorrelated",
      }),
    );
  });

  it("records a verified unsupported GitHub event without dispatching it", async () => {
    const deliveryId = "29-unsupported-event";
    const body = JSON.stringify({
      ref: "refs/heads/main",
      repository: { full_name: "acme/widgets" },
    });
    const response = await githubDelivery({ deliveryId, body, event: "push" });

    const responseBody = await response.text();
    expect(response.status, responseBody).toBe(200);
    expect(JSON.parse(responseBody)).toMatchObject({ status: "unsupported", deliveryId });
    expect(await historyText("github-ingress-29@g.us")).not.toContain(deliveryId);
    expect(await githubIngressRecords()).toContainEqual(
      expect.objectContaining({ deliveryId, eventName: "push", status: "unsupported" }),
    );
  });

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
      {
        kind: "send",
        chatId,
        text: "one explicit outbound",
        outcome: "sent",
        messageId: "fake-message-1",
      },
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
      {
        kind: "send",
        chatId,
        text: "uncertain outbound",
        outcome: "unknown",
        error: "provider outcome unknown",
      },
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

  it("admits the bounded GitHub workflow, stays responsive, then processes observed completion", async () => {
    const chatId = "github-success-30@g.us";
    await resetGitHub();

    await coalescerMessage(chatId, "START_GITHUB_PROOF", { mentions: ["bot@s.whatsapp.net"] });
    await waitFor(
      async () =>
        (await pendingWorkflowOperations()).length === 1 &&
        (await historyText(chatId)).includes("Private workflow admission settled with runId"),
      "successful workflow admission and initiating turn settlement",
    );

    const admittedHistory = await historyText(chatId);
    const runId = admittedHistory.match(/Private workflow admission settled with runId ([^\s.]+)\./)?.[1];
    expect(runId).toBeDefined();
    const [operationId] = await pendingWorkflowOperations();
    expect(operationId).toBeDefined();
    await expect(getRun(runId!)).resolves.toMatchObject({
      runId,
      workflowName: "github-proof",
      status: "active",
      input: { chatId, operationId, repository: { owner: "acme", repo: "widgets" } },
    });

    await coalescerMessage(chatId, "WHILE_WORKFLOW_HELD");
    await waitFor(
      async () =>
        (await historyText(chatId)).includes("Private Ambience turn settled while the workflow remained active."),
      "another Ambience turn while workflow is active",
    );
    await expect(getRun(runId!)).resolves.toMatchObject({ status: "active" });

    await releaseWorkflow(operationId!);
    await waitFor(
      async () =>
        (await historyText(chatId)).includes(
          "Private GitHub workflow completion input processed by the same Ambience instance.",
        ) && (await getRun(runId!)).status === "completed",
      "validated workflow completion input and terminal run record",
    );

    const finalHistory = await historyText(chatId);
    expect(finalHistory.match(/workflow\.completed/g)).toHaveLength(1);
    await expect(getRun(runId!)).resolves.toMatchObject({
      status: "completed",
      result: {
        status: "completed",
        chatId,
        operationId,
        repository: { owner: "acme", repo: "widgets" },
        creation: "confirmed",
        closure: "confirmed",
        issue: { number: 1, state: "closed", url: "https://github.com/acme/widgets/issues/1" },
      },
    });
    expect(await githubEvents()).toEqual([
      { kind: "create", repository: "acme/widgets", operationId, outcome: "created", number: 1 },
      { kind: "get", repository: "acme/widgets", number: 1, state: "open" },
      { kind: "close", repository: "acme/widgets", number: 1, outcome: "closed" },
      { kind: "get", repository: "acme/widgets", number: 1, state: "closed" },
    ]);
  });

  it("turns deterministic GitHub failure into one normalized same-chat failure input", async () => {
    const chatId = "github-failure-30@g.us";
    await resetGitHub();
    await setNextGitHubCreate("failure");

    await coalescerMessage(chatId, "START_GITHUB_PROOF", { mentions: ["bot@s.whatsapp.net"] });
    await waitFor(
      async () =>
        (await pendingWorkflowOperations()).length === 1 &&
        (await historyText(chatId)).includes("Private workflow admission settled with runId"),
      "failing workflow admission and initiating turn settlement",
    );

    const admittedHistory = await historyText(chatId);
    const runId = admittedHistory.match(/Private workflow admission settled with runId ([^\s.]+)\./)?.[1];
    expect(runId).toBeDefined();
    const [operationId] = await pendingWorkflowOperations();
    expect(operationId).toBeDefined();

    await releaseWorkflow(operationId!);
    await waitFor(
      async () =>
        (await historyText(chatId)).includes(
          "Private GitHub workflow failure input processed by the same Ambience instance.",
        ) && (await getRun(runId!)).status === "errored",
      "normalized workflow failure input and terminal run record",
    );

    const finalHistory = await historyText(chatId);
    expect(finalHistory.match(/workflow\.failed/g)).toHaveLength(1);
    expect(finalHistory).not.toContain("secret stack");
    await expect(getRun(runId!)).resolves.toMatchObject({
      status: "errored",
      error: expect.objectContaining({ message: "GitHub rejected the mutation" }),
    });
    expect((await githubEvents()).filter((event) => event.kind === "create")).toHaveLength(1);
  });

  it("returns one uncertain input when a timed-out create cannot be observed and never retries", async () => {
    const chatId = "github-uncertain-30@g.us";
    await resetGitHub();
    await setNextGitHubCreate("timeout-before");

    await coalescerMessage(chatId, "START_GITHUB_PROOF", { mentions: ["bot@s.whatsapp.net"] });
    await waitFor(
      async () =>
        (await pendingWorkflowOperations()).length === 1 &&
        (await historyText(chatId)).includes("Private workflow admission settled with runId"),
      "uncertain GitHub workflow admission",
    );
    const admittedHistory = await historyText(chatId);
    const runId = admittedHistory.match(/Private workflow admission settled with runId ([^\s.]+)\./)?.[1];
    expect(runId).toBeDefined();
    const [operationId] = await pendingWorkflowOperations();
    expect(operationId).toBeDefined();

    await releaseWorkflow(operationId!);
    await waitFor(
      async () =>
        (await historyText(chatId)).includes(
          "Private GitHub workflow uncertainty input processed by the same Ambience instance.",
        ) && (await getRun(runId!)).status === "completed",
      "uncertain GitHub workflow result",
    );

    const finalHistory = await historyText(chatId);
    expect(finalHistory.match(/workflow\.uncertain/g)).toHaveLength(1);
    await expect(getRun(runId!)).resolves.toMatchObject({
      status: "completed",
      result: {
        status: "uncertain",
        operationId,
        phase: "create",
      },
    });
    const events = await githubEvents();
    expect(events.filter((event) => event.kind === "create")).toHaveLength(1);
    expect(events.filter((event) => event.kind === "find")).toHaveLength(1);
    expect(events.filter((event) => event.kind === "close")).toHaveLength(0);
  });
});

describe("restart and uncertainty boundaries", () => {
  it("recovers an input admitted through the production Agent route into the same canonical chat", async () => {
    const chatId = "restart-agent-32@g.us";
    const marker = "accepted-input-32";
    await stopServer();
    await startServer({ AMBIENCE_FIXTURE_HOLD_AGENT_RECOVERY: "true" });

    await admitPrompt(chatId, `HOLD_AGENT_FOR_RESTART:${marker}`);
    await waitFor(
      async () => (await pendingRecoveryMarkers()).includes(marker),
      "the accepted Ambience input to enter its provider call",
    );
    expect(await historyText(chatId)).not.toContain(`Recovered canonical context for ${marker}.`);

    await stopServer("SIGKILL");
    expireRunningAgentLeases();
    await startServer();
    // The generated Node target materializes an agent instance on ingress;
    // this later window wakes the same ordered queue and must remain behind
    // the recovered submission.
    await admitPrompt(chatId, "RECOVERY_WAKE_AFTER_RESTART");
    try {
      await waitFor(
        async () => (await historyText(chatId)).includes(`Recovered canonical context for ${marker}.`),
        "Flue to recover the interrupted Ambience submission",
      );
    } catch (error) {
      throw new Error(
        `${(error as Error).message}\nSubmission rows:\n${JSON.stringify(inspectAgentSubmissions(chatId), null, 2)}`,
        { cause: error },
      );
    }

    const recovered = await historyText(chatId);
    expect(recovered).toContain(`HOLD_AGENT_FOR_RESTART:${marker}`);
    expect(recovered).toContain(`Recovered canonical context for ${marker}.`);
    expect(recovered).not.toContain(`Canonical context was lost for ${marker}.`);
  }, 60_000);

  it("keeps an interrupted finite workflow inspectable without replaying it", async () => {
    const chatId = "restart-workflow-32@g.us";
    await resetGitHub();

    await coalescerMessage(chatId, "START_GITHUB_PROOF", { mentions: ["bot@s.whatsapp.net"] });
    await waitFor(
      async () =>
        (await pendingWorkflowOperations()).length === 1 &&
        (await historyText(chatId)).includes("Private workflow admission settled with runId"),
      "workflow admission before process interruption",
    );
    const admittedHistory = await historyText(chatId);
    const runId = admittedHistory.match(/Private workflow admission settled with runId ([^\s.]+)\./)?.[1];
    expect(runId).toBeDefined();
    await expect(getRun(runId!)).resolves.toMatchObject({ status: "active" });

    await stopServer("SIGKILL");
    await startServer();

    await expect(getRun(runId!)).resolves.toMatchObject({
      runId,
      workflowName: "github-proof",
      status: "active",
      input: { chatId, repository: { owner: "acme", repo: "widgets" } },
    });
    const recoveredHistory = await historyText(chatId);
    expect(recoveredHistory).toContain("Private workflow admission settled with runId");
    expect(recoveredHistory).not.toContain("workflow.completed");
    expect(recoveredHistory).not.toContain("workflow.failed");
    expect(await pendingWorkflowOperations()).toEqual([]);
    expect(await githubEvents()).toEqual([]);
  }, 30_000);

  it("reconciles a timeout by marker once and never replays the observed mutation after restart", async () => {
    const chatId = "restart-reconciled-32@g.us";
    await resetGitHub();
    await setNextGitHubCreate("timeout-after");

    await coalescerMessage(chatId, "START_GITHUB_PROOF", { mentions: ["bot@s.whatsapp.net"] });
    await waitFor(
      async () =>
        (await pendingWorkflowOperations()).length === 1 &&
        (await historyText(chatId)).includes("Private workflow admission settled with runId"),
      "reconciled workflow admission",
    );
    const admittedHistory = await historyText(chatId);
    const runId = admittedHistory.match(/Private workflow admission settled with runId ([^\s.]+)\./)?.[1];
    expect(runId).toBeDefined();
    const [operationId] = await pendingWorkflowOperations();
    expect(operationId).toBeDefined();

    await releaseWorkflow(operationId!);
    await waitFor(
      async () =>
        (await getRun(runId!)).status === "completed" &&
        (await historyText(chatId)).includes("Private GitHub workflow completion input processed"),
      "marker-reconciled workflow completion",
    );
    await expect(getRun(runId!)).resolves.toMatchObject({
      status: "completed",
      result: {
        status: "completed",
        operationId,
        creation: "reconciled",
        closure: "confirmed",
        issue: { number: 1, state: "closed" },
      },
    });
    expect(await githubEvents()).toEqual([
      { kind: "create", repository: "acme/widgets", operationId, outcome: "unknown" },
      { kind: "find", repository: "acme/widgets", operationId, matches: [1] },
      { kind: "get", repository: "acme/widgets", number: 1, state: "open" },
      { kind: "close", repository: "acme/widgets", number: 1, outcome: "closed" },
      { kind: "get", repository: "acme/widgets", number: 1, state: "closed" },
    ]);

    await stopServer("SIGKILL");
    await startServer();
    await expect(getRun(runId!)).resolves.toMatchObject({
      status: "completed",
      result: { operationId, creation: "reconciled", issue: { number: 1, state: "closed" } },
    });
    expect(await githubEvents()).toEqual([]);
  }, 30_000);
});
