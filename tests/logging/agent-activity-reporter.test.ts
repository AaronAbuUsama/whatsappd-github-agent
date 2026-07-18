import type { FlueObservation } from "@flue/runtime";
import { describe, expect, it } from "vite-plus/test";

import { createAgentActivityReporter } from "../../packages/agents/src/speaker/activity-reporter.ts";

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

const operationStart = (overrides: Partial<FlueObservation> = {}): FlueObservation =>
  ({
    v: 3,
    eventIndex: 1,
    timestamp: new Date().toISOString(),
    type: "operation_start",
    instanceId: "chat@g.us",
    dispatchId: "dispatch-1",
    operationId: "operation-1",
    operationKind: "prompt",
    ...overrides,
  }) as FlueObservation;

const settled = (
  outcome: "completed" | "failed" | "aborted" = "completed",
  error?: { readonly message: string },
): FlueObservation =>
  ({
    v: 3,
    eventIndex: 3,
    timestamp: new Date().toISOString(),
    type: "submission_settled",
    instanceId: "chat@g.us",
    dispatchId: "dispatch-1",
    submissionId: "submission-1",
    outcome,
    ...(error === undefined ? {} : { error }),
  }) as FlueObservation;

describe("agent activity reporter", () => {
  it("exposes the observer lifecycle to a bounded live-canary subscriber", () => {
    const { logger } = captureLogger();
    const reporter = createAgentActivityReporter(logger);
    const stages: string[] = [];
    const unsubscribe = reporter.subscribe({
      windowDispatched: () => stages.push("dispatch"),
      spoke: () => stages.push("spoke"),
      settledSilent: () => stages.push("settled-silent"),
      settledFailed: () => stages.push("failed"),
    });

    reporter.accepted(
      { dispatchId: "dispatch-1" },
      { type: "whatsapp.window", windowId: "window-1", chatId: "chat@g.us", messages: [{ id: "message-1" }] },
    );
    reporter.observed(operation({}));
    unsubscribe();
    reporter.accepted(
      { dispatchId: "dispatch-2" },
      { type: "whatsapp.window", windowId: "window-2", chatId: "chat@g.us", messages: [{ id: "message-2" }] },
    );

    expect(stages).toEqual(["dispatch", "settled-silent"]);
  });

  it("reports a dispatched WhatsApp window and its silent settlement", () => {
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
    expect(entries.map(({ fields }) => fields.operatorEvent)).toEqual(["agent.processing"]);
    reporter.observed(operationStart());
    reporter.observed(
      operation({
        agentOutput: { type: "text", text: "Replied to Lavin with the available repository.", finishReason: "stop" },
      }),
    );

    expect(entries.map(({ fields }) => fields.operatorEvent)).toEqual([
      "agent.processing",
      "agent.final",
      "agent.completed",
      "agent.settled_silent",
    ]);
    expect(entries[0]?.fields).toMatchObject({ messageCount: 2, windowId: "window-1", dispatchId: "dispatch-1" });
    expect(entries[1]?.fields).toMatchObject({ text: "Replied to Lavin with the available repository." });
    expect(entries[2]?.fields).toMatchObject({ durationMs: 4_300 });
    expect(entries[3]?.fields).toMatchObject({ windowId: "window-1", chatId: "chat@g.us", dispatchId: "dispatch-1" });
  });

  it("correlates speech by dispatchId and does not report a speaking window as silent", () => {
    const { entries, logger } = captureLogger();
    const reporter = createAgentActivityReporter(logger);
    reporter.accepted(
      { dispatchId: "dispatch-1" },
      { type: "whatsapp.window", windowId: "window-1", chatId: "chat@g.us", messages: [{ id: "message-1" }] },
    );

    reporter.spoke({ chatId: "chat@g.us", dispatchId: "dispatch-1", text: "A visible reply" });
    reporter.observed(operation({}));

    expect(entries.map(({ fields }) => fields.operatorEvent)).toEqual([
      "agent.processing",
      "agent.say",
      "agent.completed",
    ]);
    expect(entries[1]?.fields).toMatchObject({
      chatId: "chat@g.us",
      dispatchId: "dispatch-1",
      text: "A visible reply",
    });
  });

  it("attributes speech to the processing window when another window is already queued for the chat", () => {
    const { entries, logger } = captureLogger();
    const reporter = createAgentActivityReporter(logger);
    reporter.accepted(
      { dispatchId: "dispatch-1" },
      { type: "whatsapp.window", windowId: "window-1", chatId: "chat@g.us", messages: [{ id: "message-1" }] },
    );
    reporter.accepted(
      { dispatchId: "dispatch-2" },
      { type: "whatsapp.window", windowId: "window-2", chatId: "chat@g.us", messages: [{ id: "message-2" }] },
    );

    reporter.observed(operationStart({ dispatchId: "dispatch-1" }));
    expect(reporter.spokeForChat("chat@g.us", "First window reply")).toBe(true);
    reporter.observed(operation({ dispatchId: "dispatch-1" }));

    expect(entries.find(({ fields }) => fields.operatorEvent === "agent.say")?.fields).toMatchObject({
      dispatchId: "dispatch-1",
      text: "First window reply",
    });
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

    expect(entries.map(({ fields }) => fields.operatorEvent)).toEqual(["agent.processing"]);
  });

  it("reports a failed settlement once and forgets the dispatch", () => {
    const { entries, logger } = captureLogger();
    const reporter = createAgentActivityReporter(logger);
    reporter.accepted(
      { dispatchId: "dispatch-1" },
      { type: "whatsapp.window", windowId: "window-1", chatId: "chat@g.us", messages: [{ id: "message-1" }] },
    );

    reporter.observed(operationStart());
    const failed = operation({ isError: true, error: new Error("model unavailable") });
    reporter.observed(failed);
    const failedSettlement = settled("failed", { message: "model unavailable" });
    reporter.observed(failedSettlement);
    reporter.observed(failedSettlement);

    expect(entries.map(({ fields }) => fields.operatorEvent)).toEqual(["agent.processing", "agent.failed"]);
    expect(entries[1]).toMatchObject({ level: "error", fields: { detail: "model unavailable" } });
  });

  it("does not report non-WhatsApp dispatches", () => {
    const { entries, logger } = captureLogger();
    const reporter = createAgentActivityReporter(logger);
    reporter.accepted({ dispatchId: "dispatch-1" }, { type: "github.issue.opened", chatId: "chat@g.us" });

    reporter.observed(operation({}));
    expect(entries).toEqual([]);
  });

  it("forgets early observations after identifying a non-WhatsApp dispatch", () => {
    const { entries, logger } = captureLogger();
    const reporter = createAgentActivityReporter(logger);

    reporter.observed(operationStart());
    reporter.accepted({ dispatchId: "dispatch-1" }, { type: "github.issue.opened", chatId: "chat@g.us" });
    reporter.observed(operation({}));

    expect(entries).toEqual([]);
  });

  it("replays lifecycle observations that race ahead of the dispatch receipt", () => {
    const { entries, logger } = captureLogger();
    const reporter = createAgentActivityReporter(logger);

    reporter.observed(operationStart());
    reporter.observed(operation({ agentOutput: { type: "text", text: "Private final", finishReason: "stop" } }));
    reporter.observed(operation({ agentOutput: { type: "text", text: "Duplicate final", finishReason: "stop" } }));
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
      "agent.settled_silent",
    ]);
  });

  it("resolves recovered dispatches without a process-local acceptance", () => {
    const { entries, logger } = captureLogger();
    const reporter = createAgentActivityReporter(logger, (dispatchId) =>
      dispatchId === "dispatch-1" ? { windowId: "window-1", chatId: "chat@g.us", messageCount: 3 } : undefined,
    );

    reporter.observed(operationStart());
    reporter.observed(operation({ agentOutput: { type: "text", text: "Recovered final", finishReason: "stop" } }));

    expect(entries.map(({ fields }) => fields.operatorEvent)).toEqual([
      "agent.processing",
      "agent.final",
      "agent.completed",
      "agent.settled_silent",
    ]);
    expect(entries[0]?.fields.messageCount).toBe(3);
  });

  it("uses recovery-only submission settlement when no prompt operation completes", () => {
    const { entries, logger } = captureLogger();
    const reporter = createAgentActivityReporter(logger, (dispatchId) =>
      dispatchId === "dispatch-1" ? { windowId: "window-1", chatId: "chat@g.us", messageCount: 1 } : undefined,
    );

    reporter.observed(settled());

    expect(entries.map(({ fields }) => fields.operatorEvent)).toEqual([
      "agent.processing",
      "agent.settled_silent",
    ]);
  });
});
