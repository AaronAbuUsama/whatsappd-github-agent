import type { FlueObservation } from "@flue/runtime";
import { describe, expect, it } from "vite-plus/test";

import { createAgentActivityReporter } from "../../src/logging/agent-activity-reporter.ts";

interface Entry {
  readonly level: "info" | "error";
  readonly fields: Record<string, unknown>;
  readonly message: string;
}

const captureLogger = (): { readonly entries: Entry[]; readonly logger: any } => {
  const entries: Entry[] = [];
  return {
    entries,
    logger: {
      info: (fields: Record<string, unknown>, message: string) => entries.push({ level: "info", fields, message }),
      error: (fields: Record<string, unknown>, message: string) => entries.push({ level: "error", fields, message }),
    },
  };
};

const operation = (overrides: Partial<FlueObservation>): FlueObservation =>
  ({
    v: 3,
    eventIndex: 2,
    timestamp: new Date().toISOString(),
    type: "operation",
    instanceId: "chat@g.us",
    dispatchId: "dispatch-1",
    operationId: "operation-1",
    operationKind: "prompt",
    durationMs: 4_300,
    isError: false,
    ...overrides,
  }) as FlueObservation;

const operationStart = (): FlueObservation =>
  ({
    v: 3,
    eventIndex: 1,
    timestamp: new Date().toISOString(),
    type: "operation_start",
    instanceId: "chat@g.us",
    dispatchId: "dispatch-1",
    operationId: "operation-1",
    operationKind: "prompt",
  }) as FlueObservation;

describe("agent activity reporter", () => {
  it("reports an accepted WhatsApp window, its private final, and completion", () => {
    const { entries, logger } = captureLogger();
    const reporter = createAgentActivityReporter(logger);

    reporter.accepted(
      { dispatchId: "dispatch-1" },
      {
        type: "whatsapp.window",
        windowId: "window-1",
        chatId: "chat@g.us",
        messages: [{ id: "message-1" }, { id: "message-2" }],
      },
    );
    expect(entries).toEqual([]);
    reporter.observed(operationStart());
    reporter.observed(
      operation({ agentOutput: { type: "text", text: "Replied to Lavin with the available repository.", finishReason: "stop" } }),
    );

    expect(entries.map(({ fields }) => fields.operatorEvent)).toEqual([
      "agent.processing",
      "agent.final",
      "agent.completed",
    ]);
    expect(entries[0]?.fields).toMatchObject({ messageCount: 2, windowId: "window-1", dispatchId: "dispatch-1" });
    expect(entries[1]?.fields).toMatchObject({ text: "Replied to Lavin with the available repository." });
    expect(entries[2]?.fields).toMatchObject({ durationMs: 4_300 });
  });

  it("ignores tool and thinking observations", () => {
    const { entries, logger } = captureLogger();
    const reporter = createAgentActivityReporter(logger);
    reporter.accepted(
      { dispatchId: "dispatch-1" },
      { type: "whatsapp.window", windowId: "window-1", chatId: "chat@g.us", messages: [{ id: "message-1" }] },
    );

    reporter.observed({ type: "thinking_end", dispatchId: "dispatch-1" } as FlueObservation);
    reporter.observed({ type: "tool", dispatchId: "dispatch-1" } as FlueObservation);

    expect(entries).toEqual([]);
  });

  it("reports a failed prompt once and forgets the dispatch", () => {
    const { entries, logger } = captureLogger();
    const reporter = createAgentActivityReporter(logger);
    reporter.accepted(
      { dispatchId: "dispatch-1" },
      { type: "whatsapp.window", windowId: "window-1", chatId: "chat@g.us", messages: [{ id: "message-1" }] },
    );

    reporter.observed(operationStart());
    const failed = operation({ isError: true, error: new Error("model unavailable") });
    reporter.observed(failed);
    reporter.observed(failed);

    expect(entries.map(({ fields }) => fields.operatorEvent)).toEqual(["agent.processing", "agent.failed"]);
    expect(entries[1]).toMatchObject({ level: "error", fields: { detail: "model unavailable" } });
  });

  it("does not report non-WhatsApp dispatches", () => {
    const { entries, logger } = captureLogger();
    const reporter = createAgentActivityReporter(logger);
    reporter.accepted(
      { dispatchId: "dispatch-1" },
      { type: "github.issue.opened", chatId: "chat@g.us" },
    );

    reporter.observed(operation({}));
    expect(entries).toEqual([]);
  });

  it("forgets early observations after identifying a non-WhatsApp dispatch", () => {
    const { entries, logger } = captureLogger();
    const reporter = createAgentActivityReporter(logger);

    reporter.observed(operationStart());
    reporter.accepted(
      { dispatchId: "dispatch-1" },
      { type: "github.issue.opened", chatId: "chat@g.us" },
    );
    reporter.observed(operation({}));

    expect(entries).toEqual([]);
  });

  it("replays lifecycle observations that race ahead of the dispatch receipt", () => {
    const { entries, logger } = captureLogger();
    const reporter = createAgentActivityReporter(logger);

    reporter.observed(operationStart());
    reporter.observed(
      operation({ agentOutput: { type: "text", text: "Private final", finishReason: "stop" } }),
    );
    reporter.observed(
      operation({ agentOutput: { type: "text", text: "Duplicate final", finishReason: "stop" } }),
    );
    expect(entries).toEqual([]);

    reporter.accepted(
      { dispatchId: "dispatch-1" },
      {
        type: "whatsapp.window",
        windowId: "window-1",
        chatId: "chat@g.us",
        messages: [{ id: "message-1" }, { id: "message-2" }],
      },
    );

    expect(entries.map(({ fields }) => fields.operatorEvent)).toEqual([
      "agent.processing",
      "agent.final",
      "agent.completed",
    ]);
  });

  it("resolves recovered dispatches without a process-local acceptance", () => {
    const { entries, logger } = captureLogger();
    const reporter = createAgentActivityReporter(logger, (dispatchId) =>
      dispatchId === "dispatch-1"
        ? { windowId: "window-1", chatId: "chat@g.us", messageCount: 3 }
        : undefined,
    );

    reporter.observed(operationStart());
    reporter.observed(
      operation({ agentOutput: { type: "text", text: "Recovered final", finishReason: "stop" } }),
    );

    expect(entries.map(({ fields }) => fields.operatorEvent)).toEqual([
      "agent.processing",
      "agent.final",
      "agent.completed",
    ]);
    expect(entries[0]?.fields.messageCount).toBe(3);
  });

});
