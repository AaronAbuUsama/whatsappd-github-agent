import { existsSync } from "node:fs";

import type { DispatchReceipt } from "@flue/runtime";
import type { ConversationRecord, ConversationStreamStore } from "@flue/runtime/adapter";
import { sqlite } from "@flue/runtime/node";

import type { ConversationWindow } from "../coalescer/events.js";
import type { ManagedChatInbox, WindowAdmission } from "./managed-chat-inbox.js";

export interface AdmissionEvidenceSource {
  readonly find: (window: ConversationWindow) => Promise<DispatchReceipt | undefined>;
}

export type ReconciliationResult =
  | {
      readonly status: "unresolved";
      readonly admission: Extract<WindowAdmission, { readonly status: "uncertain" }>;
    }
  | {
      readonly status: "admitted";
      readonly admission: Extract<WindowAdmission, { readonly status: "admitted" }>;
    };

const errorMessage = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));

/**
 * Cross the application-to-Flue seam once. Any failure after dispatching is
 * durable is ambiguous: record Uncertain and let the caller fail-stop this
 * chat. If the receipt write itself fails, make one safe application-state
 * transition to Uncertain; if storage is unavailable too, dispatching remains
 * durable and the next process start performs that conservative transition.
 */
export const admitWindow = async (
  inbox: ManagedChatInbox,
  window: ConversationWindow,
  dispatch: () => Promise<DispatchReceipt>,
): Promise<void> => {
  const attempt = inbox.beginAdmission(window.id);
  let receipt: DispatchReceipt;
  try {
    receipt = await dispatch();
  } catch (cause) {
    try {
      inbox.markUncertain(window.id, attempt.attemptId, errorMessage(cause));
    } catch (ledgerCause) {
      throw new AggregateError(
        [cause, ledgerCause],
        `Flue dispatch failed and the Uncertain state could not be recorded for ${window.id}.`,
      );
    }
    throw cause;
  }
  try {
    inbox.markAdmitted(window.id, attempt.attemptId, receipt);
  } catch (cause) {
    const reason = `Flue returned dispatch ${receipt.dispatchId}, but its admission receipt could not be recorded: ${errorMessage(cause)}`;
    try {
      inbox.markUncertain(window.id, attempt.attemptId, reason);
    } catch (ledgerCause) {
      throw new AggregateError(
        [cause, ledgerCause],
        `Flue accepted Window ${window.id}, but neither its receipt nor Uncertain state could be recorded.`,
      );
    }
    throw cause;
  }
};

const dispatchReceiptFrom = (record: ConversationRecord, window: ConversationWindow): DispatchReceipt | undefined => {
  if (record.type !== "signal" || record.signalType !== "dispatch_input") return undefined;
  if (record.attributes?.agent !== "ambience" || record.attributes.id !== window.chatId) return undefined;
  if (
    typeof record.dispatchId !== "string" ||
    !record.dispatchId ||
    record.attributes.dispatchId !== record.dispatchId
  ) {
    return undefined;
  }
  const acceptedAt = record.attributes.acceptedAt;
  if (typeof acceptedAt !== "string" || !Number.isFinite(Date.parse(acceptedAt))) return undefined;
  try {
    const input = JSON.parse(record.content) as Record<string, unknown>;
    if (input.type !== "whatsapp.window" || input.windowId !== window.id || input.chatId !== window.chatId) {
      return undefined;
    }
  } catch {
    return undefined;
  }
  return { dispatchId: record.dispatchId, acceptedAt };
};

/** Read Flue's public canonical stream without mutating it. */
export const findFlueAdmissionReceipt = async (
  store: ConversationStreamStore,
  window: ConversationWindow,
  maxRecords = 100_000,
): Promise<DispatchReceipt | undefined> => {
  const path = `agents/ambience/${window.chatId}`;
  let offset = "-1";
  const receipts = new Map<string, DispatchReceipt>();
  let recordsRead = 0;
  while (true) {
    const page = await store.read(path, { offset, limit: 1_000 });
    for (const batch of page.batches) {
      for (const record of batch.records) {
        recordsRead += 1;
        if (recordsRead > maxRecords) {
          throw new Error(`Flue admission reconciliation exceeded its ${maxRecords}-record read bound.`);
        }
        const receipt = dispatchReceiptFrom(record, window);
        if (receipt !== undefined) receipts.set(`${receipt.dispatchId}\0${receipt.acceptedAt}`, receipt);
      }
    }
    if (page.upToDate) break;
    if (page.nextOffset === offset) throw new Error(`Flue canonical history did not advance while reading ${path}.`);
    offset = page.nextOffset;
  }
  if (receipts.size > 1) {
    throw new Error(`Flue canonical history contains multiple admission receipts for Window ${window.id}.`);
  }
  return receipts.values().next().value;
};

/**
 * Open a separate adapter handle and read canonical evidence only. Missing
 * storage or an absent Window is inconclusive, never evidence for retry.
 */
export const createFlueAdmissionEvidenceSource = (databasePath: string): AdmissionEvidenceSource => ({
  find: async (window) => {
    if (!existsSync(databasePath)) return undefined;
    const adapter = sqlite(databasePath);
    try {
      const stores = await adapter.connect();
      return await findFlueAdmissionReceipt(stores.conversationStreamStore, window);
    } finally {
      await adapter.close?.();
    }
  },
});

export const reconcileUncertainAdmission = async (
  inbox: ManagedChatInbox,
  windowId: string,
  evidence: AdmissionEvidenceSource,
): Promise<ReconciliationResult> => {
  const admission = inbox.admission(windowId);
  if (admission?.status !== "uncertain") {
    throw new Error(`Managed Chat Window ${windowId} is not Uncertain.`);
  }
  const window = inbox.window(windowId);
  if (window === undefined) throw new Error(`Managed Chat Window ${windowId} does not exist.`);
  const receipt = await evidence.find(window);
  if (receipt === undefined) return { status: "unresolved", admission };
  const reconciled = inbox.reconcileAdmission(windowId, receipt);
  if (reconciled.status !== "admitted") throw new Error(`Managed Chat Window ${windowId} was not reconciled.`);
  return { status: "admitted", admission: reconciled };
};
