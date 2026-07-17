import type { DispatchReceipt } from "@flue/runtime";

import type { ConversationWindow } from "../coalescer/events.js";
import { getLogger } from "../logging/logging.js";
import { errorMessage } from "../shared/errors.js";
import { retry as retryOperation, type RetryPolicy } from "../shared/retry.js";
import type { ManagedChatInbox } from "./managed-chat-inbox.js";

export interface DispatchRetryPolicy extends RetryPolicy {}

export const defaultDispatchRetryPolicy: DispatchRetryPolicy = {
  attempts: 3,
  delayMs: (attempt) => attempt * 1_000,
};

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
  try {
    receipt = await retryOperation(dispatch, retry, (cause, attempt, attempts) => {
      getLogger("intake").warn(
        {
          operatorEvent: "agent.retrying",
          detail: `dispatch attempt ${attempt + 1} of ${attempts}`,
          windowId: window.id,
          chatId: window.chatId,
          attempt,
          reason: errorMessage(cause),
        },
        "Retrying Ambience dispatch",
      );
    });
  } catch (cause) {
    const reason = errorMessage(cause);
    try {
      inbox.markFailed(window.id, reason);
    } catch (ledgerCause) {
      throw new AggregateError(
        [cause, ledgerCause],
        `Flue dispatch failed and the failed state could not be recorded for ${window.id}.`,
      );
    }
    getLogger("intake").error(
      {
        operatorEvent: "agent.failed",
        detail: reason,
        windowId: window.id,
        chatId: window.chatId,
        attempt: Math.max(1, retry.attempts),
        reason,
      },
      "Flue dispatch failed; the Window settled as failed",
    );
    throw cause;
  }
  try {
    inbox.markDone(window.id, receipt);
  } catch (cause) {
    // Dispatch succeeded; the Window stays pending and startup re-dispatches it.
    getLogger("intake").error(
      { windowId: window.id, chatId: window.chatId, dispatchId: receipt.dispatchId, reason: errorMessage(cause) },
      "Window done-write failed; startup will re-dispatch it",
    );
  }
};
