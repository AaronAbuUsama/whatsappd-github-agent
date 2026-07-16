import { readdirSync, readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";

import { Cause, Effect } from "effect";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  configureLogging,
  createRootLogger,
  effectLoggerLayer,
  getLogger,
  upstreamWhatsAppLogger,
  type Logger,
} from "../../src/logging/logging.ts";

const LOGGING_ROOT = Symbol.for("ambient-agent.logging-root");
const loggingGlobal = globalThis as typeof globalThis & { [LOGGING_ROOT]?: Logger };

interface CapturedSink {
  readonly stream: Writable;
  readonly lines: () => readonly string[];
}

const capture = (): CapturedSink => {
  let buffered = "";
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      buffered += chunk.toString();
      callback();
    },
  });
  return { stream, lines: () => buffered.split("\n").filter((line) => line.length > 0) };
};

const roots: string[] = [];
afterEach(() => {
  delete loggingGlobal[LOGGING_ROOT];
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("default output contract", () => {
  it("renders concise human lines without raw JSON or fiber ids", () => {
    const sink = capture();
    const logger = createRootLogger({ format: "pretty", consoleStream: sink.stream });
    logger.child({ subsystem: "whatsapp" }).info({ chatId: "chat@g.us" }, "WhatsApp reply sent");
    const [line] = sink.lines();
    expect(line).toMatch(/^\d{1,2}:\d{2}:\d{2} [AP]M  › \[AGENT\] WhatsApp reply sent$/);
    expect(line).not.toMatch(/^\{/);
    expect(line).not.toContain("(#");
    expect(line).not.toContain("fiber");
  });

  it("routes semantic records through the flat operator renderer", () => {
    const sink = capture();
    const logger = createRootLogger({ format: "pretty", consoleStream: sink.stream });
    logger.info(
      { operatorEvent: "chat.received", actor: "Lavin UK", text: "What repos do you have access to" },
      "Managed chat message received",
    );

    expect(sink.lines()[0]).toMatch(
      /^\d{1,2}:\d{2}:\d{2} [AP]M  ← \[Lavin UK\] What repos do you have access to$/,
    );
    expect(sink.lines()[0]).not.toContain("operatorEvent");
  });

  it("suppresses debug records, including message bodies, by default", () => {
    const sink = capture();
    const logger = createRootLogger({ format: "pretty", consoleStream: sink.stream });
    logger.debug({ text: "the whole inbound message body" }, "Inbound WhatsApp message");
    logger.info("started");
    expect(sink.lines()).toHaveLength(1);
    expect(sink.lines()[0]).not.toContain("message body");
  });
});

describe("debug mode", () => {
  it("lets debug diagnostics through when the level is debug", () => {
    const sink = capture();
    const logger = createRootLogger({ format: "pretty", level: "debug", consoleStream: sink.stream });
    logger.debug({ chatId: "chat@g.us" }, "Inbound WhatsApp message");
    expect(sink.lines()[0]).toContain("Inbound WhatsApp message");
  });
});

describe("JSON mode", () => {
  it("emits one valid JSON record per line for a service manager", () => {
    const sink = capture();
    const logger = createRootLogger({ format: "json", consoleStream: sink.stream });
    logger.child({ subsystem: "github" }).warn({ deliveryId: "d-1" }, "github.ingress.unsupported");
    const record = JSON.parse(sink.lines()[0]!) as Record<string, unknown>;
    expect(record).toMatchObject({ subsystem: "github", deliveryId: "d-1", msg: "github.ingress.unsupported" });
    expect(typeof record.level).toBe("number");
  });
});

describe("redaction", () => {
  it("censors credential-shaped keys at the root, before any sink", () => {
    const sink = capture();
    const logger = createRootLogger({ format: "json", consoleStream: sink.stream });
    logger.info(
      {
        token: "ghp_secret",
        credential: { webhookSecret: "whsec", refreshToken: "rt" },
        pairing: { qr: "QR-PAYLOAD", pairingCode: "ABCD-1234" },
      },
      "configured",
    );
    const line = sink.lines()[0]!;
    expect(line).not.toContain("ghp_secret");
    expect(line).not.toContain("whsec");
    expect(line).not.toContain("QR-PAYLOAD");
    expect(line).not.toContain("ABCD-1234");
    const record = JSON.parse(line) as { token: string; credential: { webhookSecret: string } };
    expect(record.token).toBe("[Redacted]");
    expect(record.credential.webhookSecret).toBe("[Redacted]");
  });
});

describe("nested cause rendering", () => {
  it("preserves the full error cause chain", () => {
    const sink = capture();
    const logger = createRootLogger({ format: "json", consoleStream: sink.stream });
    const inner = new Error("socket closed mid-dispatch");
    logger.error({ err: new Error("WindowDispatchError", { cause: inner }) }, "dispatch failed");
    const record = JSON.parse(sink.lines()[0]!) as { err: { message: string; cause: { message: string } } };
    expect(record.err.message).toBe("WindowDispatchError");
    expect(record.err.cause.message).toBe("socket closed mid-dispatch");
  });
});

describe("noisy upstream summarization", () => {
  it("shows a repeated whatsappd record once on the console but keeps every record in the file sink", () => {
    const sink = capture();
    const file = capture();
    const logger = createRootLogger({ format: "json", consoleStream: sink.stream }, file.stream);
    const upstream = logger.child({ subsystem: "whatsappd" });
    upstream.warn("failed to sync app state");
    upstream.warn("failed to sync app state");
    upstream.warn("another upstream complaint");
    logger.info("app records are never deduplicated");
    logger.info("app records are never deduplicated");
    expect(sink.lines().filter((line) => line.includes("failed to sync app state"))).toHaveLength(1);
    expect(sink.lines().filter((line) => line.includes("another upstream complaint"))).toHaveLength(1);
    expect(sink.lines().filter((line) => line.includes("never deduplicated"))).toHaveLength(2);
    expect(file.lines().filter((line) => line.includes("failed to sync app state"))).toHaveLength(2);
  });
});

describe("Effect logger bridge", () => {
  it("maps levels, keeps annotations, renders the cause, and drops fiber ids", async () => {
    const sink = capture();
    const logger = createRootLogger({ format: "json", consoleStream: sink.stream });
    const program = Effect.logError("Ambience dispatch failed", Cause.fail(new Error("window w-1 rejected"))).pipe(
      Effect.annotateLogs({ windowId: "w-1", chatId: "chat@g.us" }),
    );
    await Effect.runPromise(program.pipe(Effect.provide(effectLoggerLayer(logger))));
    const record = JSON.parse(sink.lines()[0]!) as Record<string, unknown>;
    expect(record.msg).toBe("Ambience dispatch failed");
    expect(record.windowId).toBe("w-1");
    expect(record.chatId).toBe("chat@g.us");
    expect(String(record.cause)).toContain("window w-1 rejected");
    expect(record.fiberId).toBeUndefined();
    expect(record.level).toBe(50);
  });
});

describe("configured root and managed logs directory", () => {
  it("writes structured JSON records to a rotating file under logs/", async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), "ambient-logging-"));
    roots.push(dataRoot);
    const sink = capture();
    const logsDirectory = join(dataRoot, "logs");
    const logger = await configureLogging({ logsDirectory, format: "json", consoleStream: sink.stream });
    logger.info({ subsystem: "runtime" }, "runtime started");
    logger.flush();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const files = readdirSync(logsDirectory).filter((name) => name.endsWith(".log"));
    expect(files.length).toBeGreaterThan(0);
    const contents = files.map((name) => readFileSync(join(logsDirectory, name), "utf8")).join("");
    expect(contents).toContain("runtime started");
    expect(getLogger()).toBe(logger);
  });

  it("scopes the upstream whatsappd child to warn by default and debug in debug mode", () => {
    loggingGlobal[LOGGING_ROOT] = createRootLogger({ format: "json", consoleStream: capture().stream });
    expect(upstreamWhatsAppLogger().level).toBe("warn");
    loggingGlobal[LOGGING_ROOT] = createRootLogger({ format: "json", level: "debug", consoleStream: capture().stream });
    expect(upstreamWhatsAppLogger().level).toBe("debug");
  });
});
