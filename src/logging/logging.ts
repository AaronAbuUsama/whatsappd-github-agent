/**
 * The application-owned logging root (ADR 0016).
 *
 * One Pino root carries every runtime voice: application subsystems log
 * through `getLogger(subsystem)`, whatsappd receives a child through its
 * public `SessionConfig.logger` seam via `upstreamWhatsAppLogger`, and
 * Effect's logger is bridged into a child via `effectLoggerLayer`. The root
 * redacts credentials before any sink sees a line, renders concise human
 * lines on the console sink (pretty on a TTY, JSON otherwise), and always
 * writes structured JSON to size-capped rotating files under the managed
 * `logs/` directory once `configureLogging` runs.
 *
 * The root lives on `globalThis` under a `Symbol.for` key — the same pattern
 * as managed runtime dependencies — because the CLI and the generated Flue
 * server are separate bundles sharing one process.
 */
import { join } from "node:path";
import { Writable } from "node:stream";

import { Cause, Logger as EffectLogger, type Layer, References } from "effect";
import type { LogLevel } from "effect/LogLevel";
import { type DestinationStream, type Level, type Logger, multistream, pino, stdSerializers } from "pino";
import roll from "pino-roll";

import { createOperatorConsoleSink } from "./operator-reporter.js";

export type { Logger } from "pino";
export type LogFormat = "pretty" | "json";

export interface LoggingOptions {
  /** Minimum level for every sink. Defaults to `info`. */
  readonly level?: Level;
  /** Console rendering. Defaults to `pretty` on a stderr TTY, `json` otherwise. */
  readonly format?: LogFormat;
  /** Console sink. Defaults to stderr so CLI `--json` stdout stays valid JSON. */
  readonly consoleStream?: NodeJS.WritableStream;
}

/** Credential-shaped keys are censored at the root, before any sink. */
const REDACT_KEYS = [
  "token",
  "webhookSecret",
  "secret",
  "password",
  "authorization",
  "accessToken",
  "refreshToken",
  "idToken",
  "qr",
  "userCode",
  "deviceCode",
  "pairingCode",
];
const REDACT_PATHS = REDACT_KEYS.flatMap((key) => [key, `*.${key}`]);

/**
 * Known-noisy upstream whatsappd records repeat verbatim (app-state sync
 * stacks and the like); the console sink shows each distinct message once.
 * The file sink keeps every record.
 */
// ponytail: unbounded seen-set, repeats dropped without a count; add counting/TTL if operators ask.
const summarizeRepeatedUpstream = (sink: NodeJS.WritableStream): Writable => {
  const seen = new Set<string>();
  return new Writable({
    write(chunk: Buffer, _encoding, callback) {
      try {
        const record = JSON.parse(chunk.toString()) as { readonly subsystem?: string; readonly msg?: string };
        if (record.subsystem === "whatsappd" && record.msg !== undefined) {
          if (seen.has(record.msg)) return callback();
          seen.add(record.msg);
        }
      } catch {
        // Not a JSON line; pass it through untouched.
      }
      sink.write(chunk);
      callback();
    },
  });
};

const consoleSink = (format: LogFormat, destination: NodeJS.WritableStream): NodeJS.WritableStream =>
  format === "pretty"
    ? createOperatorConsoleSink(destination, {
        colorize: destination === process.stderr && process.stderr.isTTY,
      })
    : destination;

/** The composable core: a redacting root over the given sinks, no global state. */
export const createRootLogger = (options: LoggingOptions, fileStream?: DestinationStream): Logger => {
  const level = options.level ?? "info";
  const destination = options.consoleStream ?? process.stderr;
  const format = options.format ?? (process.stderr.isTTY ? "pretty" : "json");
  const streams = [{ stream: summarizeRepeatedUpstream(consoleSink(format, destination)) as DestinationStream, level }];
  if (fileStream !== undefined) streams.push({ stream: fileStream, level });
  return pino(
    {
      level,
      base: undefined,
      redact: { paths: REDACT_PATHS, censor: "[Redacted]" },
      serializers: { err: stdSerializers.errWithCause },
    },
    multistream(streams),
  );
};

const LOGGING_ROOT = Symbol.for("ambient-agent.logging-root");
const loggingGlobal = globalThis as typeof globalThis & { [LOGGING_ROOT]?: Logger };

/**
 * Create the configured root: console sink plus rotating JSON files under
 * `logsDirectory` (10 MiB per file, at most 5 files — bounded retention).
 * Call once at runtime startup, before the subsystems start logging.
 */
export const configureLogging = async (options: LoggingOptions & { readonly logsDirectory: string }): Promise<Logger> => {
  const fileStream = await roll({
    file: join(options.logsDirectory, "ambient-agent"),
    extension: ".log",
    size: "10m",
    limit: { count: 5 },
    mkdir: true,
  });
  const root = createRootLogger(options, fileStream);
  loggingGlobal[LOGGING_ROOT] = root;
  return root;
};

/**
 * The current root, or a lazily created console-only fallback (stderr, info)
 * when `configureLogging` has not run — CLI paths that never start the
 * runtime still log readably without touching the managed data directory.
 */
export const getLogger = (subsystem?: string): Logger => {
  const root = (loggingGlobal[LOGGING_ROOT] ??= createRootLogger({}));
  return subsystem === undefined ? root : root.child({ subsystem });
};

/**
 * The child injected into whatsappd's public `SessionConfig.logger` seam.
 * Upstream traffic is warn-and-above by default; a debug/trace root lets the
 * raw records through as debug diagnostics.
 */
export const upstreamWhatsAppLogger = (): Logger => {
  const root = getLogger();
  const verbose = root.levelVal <= root.levels.values["debug"]!;
  return root.child({ subsystem: "whatsappd" }, verbose ? {} : { level: "warn" });
};

const EFFECT_TO_PINO_LEVEL: Record<Exclude<LogLevel, "None">, Level> = {
  All: "trace",
  Trace: "trace",
  Debug: "debug",
  Info: "info",
  Warn: "warn",
  Error: "error",
  Fatal: "fatal",
};

/**
 * Bridge Effect's logger into a Pino child: annotations become fields, a
 * non-empty cause is rendered with its nested chain, and fiber ids stay out
 * of the output.
 */
export const effectLoggerBridge = (logger: Logger): EffectLogger.Logger<unknown, void> =>
  EffectLogger.make(({ message, logLevel, cause, fiber }) => {
    if (logLevel === "None") return;
    const record: Record<string, unknown> = { ...fiber.getRef(References.CurrentLogAnnotations) };
    if (cause.reasons.length > 0) record.cause = Cause.pretty(cause);
    const text = (Array.isArray(message) ? message : [message]).map(String).join(" ");
    logger[EFFECT_TO_PINO_LEVEL[logLevel]](record, text);
  });

/** Replaces Effect's default logger for a provided program (ADR 0016). */
export const effectLoggerLayer = (logger: Logger): Layer.Layer<never> => EffectLogger.layer([effectLoggerBridge(logger)]);
