import { Writable } from "node:stream";

export type OperatorEvent =
  | "agent.online"
  | "chat.received"
  | "agent.processing"
  | "agent.say"
  | "agent.settled_silent"
  | "agent.final"
  | "agent.completed"
  | "agent.retrying"
  | "agent.failed";

export interface OperatorLogRecord {
  readonly time?: number;
  readonly level: number;
  readonly operatorEvent?: OperatorEvent;
  readonly actor?: string;
  readonly detail?: string;
  readonly text?: string;
  readonly messageCount?: number;
  readonly durationMs?: number;
  readonly subsystem?: string;
  readonly msg?: string;
  readonly err?: unknown;
  readonly error?: unknown;
  readonly reason?: unknown;
  readonly cause?: unknown;
  readonly [key: string]: unknown;
}

interface RenderOptions {
  readonly colorize: boolean;
  readonly maxLength?: number;
}

const ANSI = {
  reset: "\u001B[0m",
  dim: "\u001B[2m",
  cyan: "\u001B[36m",
  yellow: "\u001B[33m",
  blue: "\u001B[34m",
  magenta: "\u001B[35m",
  green: "\u001B[32m",
  red: "\u001B[31m",
} as const;

const paint = (value: string, color: keyof typeof ANSI, enabled: boolean): string =>
  enabled ? `${ANSI[color]}${value}${ANSI.reset}` : value;

const stripTerminalControls = (value: string): string => {
  let clean = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 27) {
      const introducer = value.charCodeAt(index + 1);
      if (introducer === 91) {
        index += 2;
        while (index < value.length && (value.charCodeAt(index) < 64 || value.charCodeAt(index) > 126)) index += 1;
      } else if (introducer === 93) {
        index += 2;
        while (index < value.length) {
          if (value.charCodeAt(index) === 7) break;
          if (value.charCodeAt(index) === 27 && value.charCodeAt(index + 1) === 92) {
            index += 1;
            break;
          }
          index += 1;
        }
      }
      continue;
    }
    const isBidirectionalControl =
      code === 0x200e || code === 0x200f || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
    clean += code < 32 || (code >= 127 && code <= 159) || isBidirectionalControl ? " " : value[index];
  }
  return clean;
};

const oneLine = (value: unknown): string =>
  stripTerminalControls(String(value ?? ""))
    .replace(/\s+/g, " ")
    .trim();

const actorName = (value: unknown): string => oneLine(value).replaceAll("[", "").replaceAll("]", "");

const timeFormatter = new Intl.DateTimeFormat("en-US", {
  hour: "numeric",
  minute: "2-digit",
  second: "2-digit",
  hour12: true,
});

const formatTime = (time: number | undefined): string => timeFormatter.format(new Date(time ?? Date.now()));

const formatDuration = (durationMs: number | undefined): string => {
  const milliseconds = durationMs ?? 0;
  if (milliseconds < 1_000) return `${milliseconds}ms`;
  return `${Number((milliseconds / 1_000).toFixed(1))}s`;
};

const semanticBody = (record: OperatorLogRecord): { readonly color: keyof typeof ANSI; readonly body: string } => {
  const actor = actorName(record.actor) || "AGENT";
  switch (record.operatorEvent) {
    case "agent.online":
      return { color: "green", body: `◆ [AGENT] Online: ${oneLine(record.detail)}` };
    case "chat.received":
      return { color: "cyan", body: `← [${actor}] ${oneLine(record.text)}` };
    case "agent.processing": {
      const count = record.messageCount ?? 0;
      return { color: "yellow", body: `▶ [AGENT] Processing: ${count} ${count === 1 ? "message" : "messages"}` };
    }
    case "agent.say":
      return { color: "blue", body: `→ [AGENT] Response: ${oneLine(record.text)}` };
    case "agent.settled_silent":
      return { color: "dim", body: "— settled silent" };
    case "agent.final":
      return { color: "magenta", body: `◇ [AGENT] Final: ${oneLine(record.text)}` };
    case "agent.completed":
      return { color: "green", body: `✓ [AGENT] Completed: ${formatDuration(record.durationMs)}` };
    case "agent.retrying":
      return {
        color: "yellow",
        body: `↻ [AGENT] Retrying: ${oneLine(record.detail)}${record.reason ? `: ${oneLine(record.reason)}` : ""}`,
      };
    case "agent.failed":
      return { color: "red", body: `× [AGENT] Failed: ${oneLine(record.detail)}` };
    default:
      return genericBody(record);
  }
};

const errorDetail = (record: OperatorLogRecord): string => {
  for (const candidate of [record.detail, record.error, record.reason, record.cause]) {
    if (typeof candidate === "string" || typeof candidate === "number") return oneLine(candidate);
  }
  if (record.err instanceof Error) return oneLine(record.err.message);
  if (typeof record.err === "object" && record.err !== null && "message" in record.err) {
    return oneLine((record.err as { readonly message?: unknown }).message);
  }
  return "";
};

const genericBody = (record: OperatorLogRecord): { readonly color: keyof typeof ANSI; readonly body: string } => {
  const isError = record.level >= 50;
  const isWarning = record.level >= 40;
  const glyph = isError ? "×" : isWarning ? "!" : "›";
  const color = isError ? "red" : isWarning ? "yellow" : "dim";
  const message = oneLine(record.msg) || "Log event";
  const detail = errorDetail(record);
  return {
    color,
    body: `${glyph} [AGENT] ${message}${detail && detail !== message ? `: ${detail}` : ""}`,
  };
};

export const renderOperatorRecord = (record: OperatorLogRecord, options: RenderOptions): string => {
  const plainTime = formatTime(record.time);
  const { body, color } = semanticBody(record);
  const maxLength = options.maxLength ?? 240;
  const availableBodyLength = Math.max(1, maxLength - plainTime.length - 2);
  const clippedBody = body.length > availableBodyLength ? `${body.slice(0, availableBodyLength - 1)}…` : body;
  return `${paint(plainTime, "dim", options.colorize)}  ${paint(clippedBody, color, options.colorize)}`;
};

export const createOperatorConsoleSink = (destination: NodeJS.WritableStream, options: RenderOptions): Writable => {
  let buffered = "";
  const writeLine = (line: string): void => {
    if (line.length === 0) return;
    try {
      const record = JSON.parse(line) as OperatorLogRecord;
      destination.write(`${renderOperatorRecord(record, options)}\n`);
    } catch {
      destination.write(`${oneLine(line)}\n`);
    }
  };

  return new Writable({
    write(chunk: Buffer, _encoding, callback) {
      buffered += chunk.toString();
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) writeLine(line);
      callback();
    },
    final(callback) {
      writeLine(buffered);
      callback();
    },
  });
};
