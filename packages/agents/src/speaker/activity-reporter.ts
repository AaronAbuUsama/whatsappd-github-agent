import { observe } from "@flue/runtime";
import type { Logger } from "pino";

import type { SpeakerObserver, SpeakerSpokeEvent } from "./observer.ts";
import { createDispatchCorrelator } from "@ambient-agent/engine/dispatch/dispatch-correlator.ts";
import { getLogger } from "@ambient-agent/engine/logging/logging.ts";

interface DispatchReceiptLike {
  readonly dispatchId: string;
}

interface DispatchInputLike {
  readonly type: string;
  readonly windowId?: string;
  readonly chatId?: string;
  readonly messages?: readonly unknown[];
}

export interface AgentDispatchContext {
  readonly windowId: string;
  readonly chatId: string;
  readonly messageCount: number;
}

export type AgentDispatchResolver = (dispatchId: string) => AgentDispatchContext | undefined;
type ActivityLogger = Pick<Logger, "info" | "error">;

/**
 * Speaker's vocabulary over the engine's DispatchCorrelator: turns correlated
 * lifecycle events into SpeakerObserver notifications and operator log lines.
 * Correlation, buffering, and restart recovery live in the engine.
 */
export const createAgentActivityReporter = (logger?: ActivityLogger, initialResolver?: AgentDispatchResolver) => {
  const spoken = new Set<string>();
  const subscribers = new Set<SpeakerObserver>();
  const activityLog = (): ActivityLogger => logger ?? getLogger("agent");
  const notify = <Method extends keyof SpeakerObserver>(method: Method, event: Parameters<SpeakerObserver[Method]>[0]) => {
    for (const subscriber of subscribers) {
      try {
        (subscriber[method] as (value: typeof event) => void)(event);
      } catch {
        // Observer diagnostics must never change the agent lifecycle they observe.
      }
    }
  };

  const observer: SpeakerObserver = {
    windowDispatched(event): void {
      activityLog().info({ operatorEvent: "agent.processing", ...event }, "Speaker processing a WhatsApp Window");
      notify("windowDispatched", event);
    },
    spoke(event): void {
      spoken.add(event.dispatchId);
      // ponytail: insertion-order trim replaces the old eviction hook; raise if >200 concurrent dispatches ever speak.
      while (spoken.size > 200) spoken.delete(spoken.values().next().value as string);
      activityLog().info({ operatorEvent: "agent.say", ...event }, "Speaker said a WhatsApp message");
      notify("spoke", event);
    },
    settledSilent(event): void {
      activityLog().info(
        { operatorEvent: "agent.settled_silent", ...event },
        "Speaker settled without saying a WhatsApp message",
      );
      notify("settledSilent", event);
    },
    settledFailed(event): void {
      activityLog().error(
        { operatorEvent: "agent.failed", detail: event.error, ...event },
        "Speaker processing failed",
      );
      notify("settledFailed", event);
    },
  };

  const correlator = createDispatchCorrelator<AgentDispatchContext>({
    keyOf: ({ chatId }) => chatId,
    ...(initialResolver === undefined ? {} : { resolver: initialResolver }),
  });

  correlator.subscribe((event, context, dispatchId) => {
    const correlation = { windowId: context.windowId, chatId: context.chatId, dispatchId };
    switch (event.kind) {
      case "dispatched":
        observer.windowDispatched({ dispatchId, ...context });
        return;
      case "failed":
        observer.settledFailed({ ...correlation, error: event.error });
        spoken.delete(dispatchId);
        return;
      case "completed": {
        const operationCorrelation = { ...correlation, operationId: event.operationId };
        if (event.finalText !== undefined) {
          activityLog().info(
            { operatorEvent: "agent.final", text: event.finalText, ...operationCorrelation },
            "Speaker produced its private final output",
          );
        }
        activityLog().info(
          { operatorEvent: "agent.completed", durationMs: event.durationMs, ...operationCorrelation },
          "Speaker processing completed",
        );
        if (!spoken.has(dispatchId)) observer.settledSilent(correlation);
        spoken.delete(dispatchId);
        return;
      }
      case "settled":
        if (!spoken.has(dispatchId)) observer.settledSilent(correlation);
        spoken.delete(dispatchId);
        return;
    }
  });

  return {
    ...observer,
    subscribe(subscriber: SpeakerObserver): () => void {
      subscribers.add(subscriber);
      return () => subscribers.delete(subscriber);
    },
    accepted(receipt: DispatchReceiptLike, input: DispatchInputLike): void {
      correlator.accepted(
        receipt.dispatchId,
        input.type !== "whatsapp.window" || input.windowId === undefined || input.chatId === undefined
          ? null
          : { windowId: input.windowId, chatId: input.chatId, messageCount: input.messages?.length ?? 0 },
      );
    },
    observed: correlator.ingest,
    recoverWith: correlator.recoverWith,
    spokeForChat(chatId: string, text: string, messageId?: string): boolean {
      const dispatchId = correlator.activeDispatchFor(chatId);
      if (dispatchId === undefined) return false;
      const event: SpeakerSpokeEvent = { chatId, dispatchId, text, ...(messageId === undefined ? {} : { messageId }) };
      observer.spoke(event);
      return true;
    },
  };
};

/**
 * The shared reporter for the running application. Importing this module wires
 * it into Flue's observation stream — every code path that can dispatch imports
 * it (via dispatch.ts), so there is no install step to forget.
 */
export const speakerActivity = createAgentActivityReporter();
observe(speakerActivity.observed);
