import { describe, expect, it } from "vite-plus/test";

import {
  renderOperatorRecord,
  type OperatorLogRecord,
} from "../../src/logging/operator-reporter.ts";

const at = (hour: number, minute: number, second: number): number =>
  new Date(2026, 6, 16, hour, minute, second).getTime();

describe("operator reporter", () => {
  it("renders the locked flat activity feed", () => {
    const records: OperatorLogRecord[] = [
      { time: at(14, 1, 1), level: 30, operatorEvent: "agent.online", detail: "managed chat connected" },
      { time: at(14, 1, 32), level: 30, operatorEvent: "chat.received", actor: "Lavin UK", text: "Gm" },
      { time: at(14, 1, 40), level: 30, operatorEvent: "chat.received", actor: "Lavin UK", text: "Yaga" },
      { time: at(14, 2, 6), level: 30, operatorEvent: "chat.received", actor: "Lavin UK", text: "Hmmmm" },
      {
        time: at(14, 2, 16),
        level: 30,
        operatorEvent: "chat.received",
        actor: "Lavin UK",
        text: "What repos do you have access to",
      },
      { time: at(14, 2, 19), level: 30, operatorEvent: "agent.processing", messageCount: 4 },
      {
        time: at(14, 2, 23),
        level: 30,
        operatorEvent: "agent.say",
        text: "I can access the whatsappd-github-agent repository.",
      },
      {
        time: at(14, 2, 23),
        level: 30,
        operatorEvent: "agent.final",
        text: "Replied to Lavin with the available repository.",
      },
      { time: at(14, 2, 23), level: 30, operatorEvent: "agent.completed", durationMs: 4_300 },
    ];

    expect(records.map((record) => renderOperatorRecord(record, { colorize: false }))).toEqual([
      "2:01:01 PM  ◆ [AGENT] Online: managed chat connected",
      "2:01:32 PM  ← [Lavin UK] Gm",
      "2:01:40 PM  ← [Lavin UK] Yaga",
      "2:02:06 PM  ← [Lavin UK] Hmmmm",
      "2:02:16 PM  ← [Lavin UK] What repos do you have access to",
      "2:02:19 PM  ▶ [AGENT] Processing: 4 messages",
      "2:02:23 PM  → [AGENT] Response: I can access the whatsappd-github-agent repository.",
      "2:02:23 PM  ◇ [AGENT] Final: Replied to Lavin with the available repository.",
      "2:02:23 PM  ✓ [AGENT] Completed: 4.3s",
    ]);
  });

  it("flattens generic failures instead of printing nested JSON", () => {
    const line = renderOperatorRecord(
      {
        time: at(14, 1, 36),
        level: 50,
        subsystem: "intake",
        msg: "Ambience admission failed; the chat is fail-stopped",
        err: { message: "WindowDispatchError", cause: { message: "socket closed" } },
        windowId: "31b52c63-59f1-4fca-9fad-8def717c33ee",
      },
      { colorize: false },
    );

    expect(line).toBe(
      "2:01:36 PM  × [AGENT] Ambience admission failed; the chat is fail-stopped: WindowDispatchError",
    );
    expect(line).not.toMatch(/[{}]/);
    expect(line.split("\n")).toHaveLength(1);
  });

  it("collapses multiline message content onto one terminal line", () => {
    expect(
      renderOperatorRecord(
        {
          time: at(14, 1, 32),
          level: 30,
          operatorEvent: "chat.received",
          actor: "Lavin UK",
          text: "First line\nsecond line",
        },
        { colorize: false },
      ),
    ).toBe("2:01:32 PM  ← [Lavin UK] First line second line");
  });

  it("strips terminal control sequences from chat content", () => {
    expect(
      renderOperatorRecord(
        {
          time: at(14, 1, 32),
          level: 30,
          operatorEvent: "chat.received",
          actor: "[Lavin UK]",
          text: "hello\u001B[31m red\u001B[0m\rspoof",
        },
        { colorize: false },
      ),
    ).toBe("2:01:32 PM  ← [Lavin UK] hello red spoof");
  });

  it("preserves content after ST-terminated OSC controls", () => {
    expect(
      renderOperatorRecord(
        {
          time: at(14, 1, 32),
          level: 30,
          operatorEvent: "chat.received",
          actor: "Lavin UK",
          text: "before \u001B]8;;https://example.com\u001B\\linked\u001B]8;;\u001B\\ after",
        },
        { colorize: false },
      ),
    ).toBe("2:01:32 PM  ← [Lavin UK] before linked after");
  });

  it("strips bidirectional override characters from untrusted content", () => {
    expect(
      renderOperatorRecord(
        {
          time: at(14, 1, 32),
          level: 30,
          operatorEvent: "chat.received",
          actor: "Lavin\u202E UK",
          text: "hello \u2066spoof\u2069",
        },
        { colorize: false },
      ),
    ).toBe("2:01:32 PM  ← [Lavin UK] hello spoof");
  });

  it("shows scalar error and reason fields without subsystem labels", () => {
    expect(
      renderOperatorRecord(
        {
          time: at(14, 1, 36),
          level: 50,
          subsystem: "whatsappd",
          msg: "WhatsApp reply delivery unknown",
          error: "provider outcome unknown",
        },
        { colorize: false },
      ),
    ).toBe("2:01:36 PM  × [AGENT] WhatsApp reply delivery unknown: provider outcome unknown");
    expect(
      renderOperatorRecord(
        {
          time: at(14, 1, 37),
          level: 40,
          subsystem: "intake",
          msg: "Retrying dispatch",
          reason: "Flue unavailable",
        },
        { colorize: false },
      ),
    ).toBe("2:01:37 PM  ! [AGENT] Retrying dispatch: Flue unavailable");
  });

  it("includes the retry reason in the semantic one-line event", () => {
    expect(
      renderOperatorRecord(
        {
          time: at(14, 1, 37),
          level: 40,
          operatorEvent: "agent.retrying",
          detail: "dispatch attempt 2 of 3",
          reason: "Flue unavailable",
        },
        { colorize: false },
      ),
    ).toBe("2:01:37 PM  ↻ [AGENT] Retrying: dispatch attempt 2 of 3: Flue unavailable");
  });

  it("caps exceptionally long events to two typical terminal lines", () => {
    const rendered = renderOperatorRecord(
      {
        time: at(14, 1, 32),
        level: 30,
        operatorEvent: "chat.received",
        actor: "Lavin UK",
        text: "x".repeat(500),
      },
      { colorize: false },
    );

    expect(rendered.length).toBe(240);
    expect(rendered.endsWith("…")).toBe(true);
  });
});
