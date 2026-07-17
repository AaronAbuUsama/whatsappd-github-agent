import { observe, type FlueObservation } from "@flue/runtime";
import type { Logger } from "pino";

import type { AmbienceObserver, AmbienceSpokeEvent } from "../ambience/observer.js";
import { getLogger } from "./logging.js";

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

interface ExpiringContext {
  readonly context: AgentDispatchContext;
  readonly expiresAt: number;
}

interface BufferedObservations {
  readonly events: FlueObservation[];
  readonly expiresAt: number;
}

const MAX_TRACKED_DISPATCHES = 100;
const TRACKING_TTL_MS = 24 * 60 * 60 * 1_000;

const errorMessage = (value: unknown): string => {
  if (value instanceof Error) return value.message;
  if (typeof value === "object" && value !== null && "message" in value) {
    return String((value as { readonly message?: unknown }).message ?? "Agent processing failed");
  }
  if (typeof value === "string" || typeof value === "number") return String(value);
  return "Agent processing failed";
};

const dropOldest = <T>(entries: Map<string, T>): void => {
  while (entries.size >= MAX_TRACKED_DISPATCHES) {
    const oldest = entries.keys().next().value as string | undefined;
    if (oldest === undefined) return;
    entries.delete(oldest);
  }
};

/**
 * Correlates Flue's public prompt-operation lifecycle with WhatsApp Windows.
 * A prompt operation is the normal settlement signal; submission_settled is
 * emitted only when Flue recovery settles interrupted durable work.
 */
export const createAgentActivityReporter = (logger?: ActivityLogger, initialResolver?: AgentDispatchResolver) => {
  const active = new Map<string, ExpiringContext>();
  const early = new Map<string, BufferedObservations>();
  const settled = new Map<string, number>();
  const ignored = new Map<string, number>();
  const announced = new Set<string>();
  const spoken = new Set<string>();
  const processingByChat = new Map<string, string>();
  const subscribers = new Set<AmbienceObserver>();
  let resolver = initialResolver;
  const activityLog = (): ActivityLogger => logger ?? getLogger("agent");
  const notify = <Method extends keyof AmbienceObserver>(method: Method, event: Parameters<AmbienceObserver[Method]>[0]) => {
    for (const subscriber of subscribers) {
      try {
        (subscriber[method] as (value: typeof event) => void)(event);
      } catch {
        // Observer diagnostics must never change the agent lifecycle they observe.
      }
    }
  };

  const observer: AmbienceObserver = {
    windowDispatched(event): void {
      announced.add(event.dispatchId);
      activityLog().info({ operatorEvent: "agent.processing", ...event }, "Ambience processing a WhatsApp Window");
      notify("windowDispatched", event);
    },
    spoke(event): void {
      spoken.add(event.dispatchId);
      activityLog().info({ operatorEvent: "agent.say", ...event }, "Ambience said a WhatsApp message");
      notify("spoke", event);
    },
    settledSilent(event): void {
      activityLog().info(
        { operatorEvent: "agent.settled_silent", ...event },
        "Ambience settled without saying a WhatsApp message",
      );
      notify("settledSilent", event);
    },
    settledFailed(event): void {
      activityLog().error(
        { operatorEvent: "agent.failed", detail: event.error, ...event },
        "Ambience processing failed",
      );
      notify("settledFailed", event);
    },
  };

  const forget = (dispatchId: string): void => {
    const context = active.get(dispatchId)?.context;
    active.delete(dispatchId);
    announced.delete(dispatchId);
    spoken.delete(dispatchId);
    if (context !== undefined && processingByChat.get(context.chatId) === dispatchId) {
      processingByChat.delete(context.chatId);
    }
  };

  const markSettled = (dispatchId: string): void => {
    forget(dispatchId);
    dropOldest(settled);
    settled.set(dispatchId, Date.now() + TRACKING_TTL_MS);
  };

  const prune = (): void => {
    const now = Date.now();
    for (const [dispatchId, entry] of active) if (entry.expiresAt <= now) forget(dispatchId);
    for (const [dispatchId, entry] of early) if (entry.expiresAt <= now) early.delete(dispatchId);
    for (const [dispatchId, expiresAt] of settled) if (expiresAt <= now) settled.delete(dispatchId);
    for (const [dispatchId, expiresAt] of ignored) if (expiresAt <= now) ignored.delete(dispatchId);
  };

  const remember = (dispatchId: string, context: AgentDispatchContext): void => {
    while (active.size >= MAX_TRACKED_DISPATCHES) {
      const oldest = active.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      forget(oldest);
    }
    active.set(dispatchId, { context, expiresAt: Date.now() + TRACKING_TTL_MS });
  };

  const announce = (dispatchId: string, context: AgentDispatchContext): void => {
    if (announced.has(dispatchId)) return;
    observer.windowDispatched({ dispatchId, ...context });
  };

  const resolve = (dispatchId: string): AgentDispatchContext | undefined => {
    const remembered = active.get(dispatchId)?.context;
    if (remembered !== undefined) return remembered;
    let recovered: AgentDispatchContext | undefined;
    try {
      recovered = resolver?.(dispatchId);
    } catch {
      // The WhatsApp archive may be between runtime instances; retain the
      // observation so the next configured resolver can recover it.
      return undefined;
    }
    if (recovered !== undefined) remember(dispatchId, recovered);
    return recovered;
  };

  const report = (event: FlueObservation, context: AgentDispatchContext): void => {
    const dispatchId = event.dispatchId!;
    if (event.type === "operation_start") {
      processingByChat.set(context.chatId, dispatchId);
      announce(dispatchId, context);
      return;
    }

    const correlation = { windowId: context.windowId, chatId: context.chatId, dispatchId };
    if (event.type === "submission_settled") {
      announce(dispatchId, context);
      if (event.outcome === "completed") {
        if (!spoken.has(dispatchId)) observer.settledSilent(correlation);
      } else {
        observer.settledFailed({
          ...correlation,
          error: event.error?.message ?? `Agent processing ${event.outcome}`,
        });
      }
      markSettled(dispatchId);
      return;
    }

    if (event.type !== "operation") return;

    const operationCorrelation = { ...correlation, operationId: event.operationId };
    if (event.isError) {
      observer.settledFailed({ ...correlation, error: errorMessage(event.error) });
      markSettled(dispatchId);
      return;
    }
    if (event.agentOutput?.type === "text" && event.agentOutput.text.trim() !== "") {
      activityLog().info(
        { operatorEvent: "agent.final", text: event.agentOutput.text, ...operationCorrelation },
        "Ambience produced its private final output",
      );
    }
    activityLog().info(
      { operatorEvent: "agent.completed", durationMs: event.durationMs, ...operationCorrelation },
      "Ambience processing completed",
    );
    if (!spoken.has(dispatchId)) observer.settledSilent(correlation);
    markSettled(dispatchId);
  };

  const replay = (dispatchId: string, context: AgentDispatchContext): void => {
    const buffered = early.get(dispatchId);
    if (buffered === undefined) return;
    early.delete(dispatchId);
    for (const event of buffered.events) {
      if (settled.has(dispatchId)) break;
      report(event, context);
    }
  };

  const observed = (event: FlueObservation): void => {
    const relevant =
      (event.type === "operation_start" && event.operationKind === "prompt") ||
      (event.type === "operation" && event.operationKind === "prompt") ||
      event.type === "submission_settled";
    if (!relevant || event.dispatchId === undefined) return;
    prune();
    if (settled.has(event.dispatchId) || ignored.has(event.dispatchId)) return;
    const context = resolve(event.dispatchId);
    if (context !== undefined) {
      report(event, context);
      return;
    }
    const buffered = early.get(event.dispatchId);
    if (buffered === undefined) {
      dropOldest(early);
      early.set(event.dispatchId, { events: [event], expiresAt: Date.now() + TRACKING_TTL_MS });
    } else {
      if (buffered.events.length < 4) buffered.events.push(event);
    }
  };

  return {
    ...observer,
    subscribe(subscriber: AmbienceObserver): () => void {
      subscribers.add(subscriber);
      return () => subscribers.delete(subscriber);
    },
    accepted(receipt: DispatchReceiptLike, input: DispatchInputLike): void {
      prune();
      if (input.type !== "whatsapp.window" || input.windowId === undefined || input.chatId === undefined) {
        early.delete(receipt.dispatchId);
        dropOldest(ignored);
        ignored.set(receipt.dispatchId, Date.now() + TRACKING_TTL_MS);
        return;
      }
      if (settled.has(receipt.dispatchId)) return;
      const context = {
        windowId: input.windowId,
        chatId: input.chatId,
        messageCount: input.messages?.length ?? 0,
      };
      remember(receipt.dispatchId, context);
      announce(receipt.dispatchId, context);
      replay(receipt.dispatchId, context);
    },
    observed,
    recoverWith(nextResolver: AgentDispatchResolver): void {
      resolver = nextResolver;
      prune();
      for (const dispatchId of early.keys()) {
        const context = resolve(dispatchId);
        if (context !== undefined) replay(dispatchId, context);
      }
    },
    spokeForChat(chatId: string, text: string, messageId?: string): boolean {
      const dispatchId = processingByChat.get(chatId);
      if (dispatchId === undefined || !active.has(dispatchId)) return false;
      const event: AmbienceSpokeEvent = { chatId, dispatchId, text, ...(messageId === undefined ? {} : { messageId }) };
      observer.spoke(event);
      return true;
    },
  };
};

const activityReporter = createAgentActivityReporter();
let observing = false;

/** Install once during application startup, before any dispatch can be admitted. */
export const installAgentActivityReporter = (): void => {
  if (observing) return;
  observe(activityReporter.observed);
  observing = true;
};

export const configureAgentActivityRecovery = (resolver: AgentDispatchResolver): void => {
  activityReporter.recoverWith(resolver);
};

export const reportAcceptedAgentDispatch = (receipt: DispatchReceiptLike, input: DispatchInputLike): void => {
  activityReporter.accepted(receipt, input);
};

export const reportAgentSpoke = (chatId: string, text: string, messageId?: string): boolean =>
  activityReporter.spokeForChat(chatId, text, messageId);

export const observeAgentActivity = (observer: AmbienceObserver): (() => void) => activityReporter.subscribe(observer);
