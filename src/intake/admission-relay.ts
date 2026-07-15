import type { DispatchReceipt } from "@flue/runtime";

import type { ConversationWindow } from "../coalescer/events.js";
import type { ManagedChatInbox } from "./managed-chat-inbox.js";

export interface DispatchRetryPolicy {
  /** Total dispatch attempts before the Window settles as failed. */
  readonly attempts: number;
  /** Backoff before attempt `attempt + 1` (attempt is 1-based). */
  readonly delayMs: (attempt: number) => number;
}

export const defaultDispatchRetryPolicy: DispatchRetryPolicy = {
  attempts: 3,
  delayMs: (attempt) => attempt * 1_000,
};

const errorMessage = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

const sleep = (millis: number): Promise<void> =>
  millis <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, millis));

/**
 * Cross the application-to-Flue seam with at-least-once semantics (ADR 0014).
 * Bounded retries settle the Window as `done` or terminally `failed`; a lost
 * `done` write only logs — the Window stays `pending` and the next startup
 * re-dispatches it, an acceptable duplicate wake.
 */
export const admitWindow = async (
  inbox: ManagedChatInbox,
  window: ConversationWindow,
  dispatch: () => Promise<DispatchReceipt>,
  retry: DispatchRetryPolicy = defaultDispatchRetryPolicy,
): Promise<void> => {
  let receipt: DispatchReceipt;
  for (let attempt = 1; ; attempt += 1) {
    try {
      receipt = await dispatch();
      break;
    } catch (cause) {
      if (attempt >= Math.max(1, retry.attempts)) {
        const reason = errorMessage(cause);
        try {
          inbox.markFailed(window.id, reason);
        } catch (ledgerCause) {
          throw new AggregateError(
            [cause, ledgerCause],
            `Flue dispatch failed and the failed state could not be recorded for ${window.id}.`,
          );
        }
        console.error(
          JSON.stringify({ event: "window.dispatch.failed", windowId: window.id, chatId: window.chatId, attempt, reason }),
        );
        throw cause;
      }
      await sleep(retry.delayMs(attempt));
    }
  }
  try {
    inbox.markDone(window.id, receipt);
  } catch (cause) {
    // Dispatch succeeded; the Window stays pending and startup re-dispatches it.
    console.error(
      JSON.stringify({
        event: "window.done-write.failed",
        windowId: window.id,
        chatId: window.chatId,
        dispatchId: receipt.dispatchId,
        reason: errorMessage(cause),
      }),
    );
  }
};
