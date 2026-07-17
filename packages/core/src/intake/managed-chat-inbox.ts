import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import {
  coalescerEventId,
  type CoalescerEvent,
  type ConversationUpdate,
  type ConversationWindow,
  type ConversationWindowDraft,
  type FireReason,
  type IncomingMessage,
  windowContents,
} from "../coalescer/events.js";
import { Effect, Layer } from "effect";
import { WindowStore, WindowStoreError } from "../coalescer/ports.js";
import { isGroupJid } from "../shared/whatsapp-jid.js";
import type { ConversationArchive } from "./conversation-archive.js";
import type {
  ConversationArrival,
  ConversationArrivalPayload,
  ConversationEdit,
  ConversationEvent,
  ConversationReaction,
  ConversationRevocation,
} from "./conversation-event.js";

interface InboxEventRow {
  event_id: string;
  kind: ConversationEvent["kind"];
  provider_message_id: string;
  chat_id: string;
  sender_id: string;
  sender_name: string | null;
  direction: "inbound" | "outbound";
  occurred_at_ms: number;
  payload_json: string;
}

interface WindowRow {
  window_id: string;
  chat_id: string;
  reason: FireReason;
}

interface AssignmentRow {
  event_id: string;
  window_id: string | null;
}

interface AdmissionRow {
  window_id: string;
  status: "pending" | "done" | "failed";
  dispatch_id: string | null;
  accepted_at: string | null;
  reason: string | null;
}

/**
 * A Window's delivery is an at-least-once wake (ADR 0014): `pending` until one
 * dispatch attempt sequence settles it as `done` or, after bounded retries,
 * `failed`. Failure is terminal and log-only; startup re-dispatches everything
 * still `pending`.
 */
export type WindowAdmission =
  | { readonly status: "pending"; readonly windowId: string }
  | {
      readonly status: "done";
      readonly windowId: string;
      readonly dispatchId: string;
      readonly acceptedAt: string;
    }
  | { readonly status: "failed"; readonly windowId: string; readonly reason: string };

export interface WindowAdmissionReceipt {
  readonly dispatchId: string;
  readonly acceptedAt: string;
}

export interface ManagedChatRecorder {
  append(event: ConversationEvent): boolean;
}

export interface ManagedChatInbox {
  readonly recorder: ManagedChatRecorder;
  unwindowed(): readonly CoalescerEvent[];
  pending(event: CoalescerEvent): CoalescerEvent | undefined;
  pendingWindows(): readonly ConversationWindow[];
  window(windowId: string): ConversationWindow | undefined;
  windowForDispatch(dispatchId: string): ConversationWindow | undefined;
  createWindow(draft: ConversationWindowDraft): ConversationWindow;
  admissions(status?: WindowAdmission["status"]): readonly WindowAdmission[];
  markDone(windowId: string, receipt: WindowAdmissionReceipt): void;
  markFailed(windowId: string, reason: string): void;
}

export interface CreateManagedChatInboxOptions {
  readonly allowed: (chatId: string, isGroup: boolean) => boolean;
  readonly createId?: () => string;
  readonly now?: () => number;
}

const decodeIncoming = (row: InboxEventRow): IncomingMessage => {
  const payload = JSON.parse(row.payload_json) as ConversationArrivalPayload;
  const applicationCanary = payload.applicationAdmission === "smoke-canary";
  return {
    id: row.provider_message_id,
    chatId: row.chat_id,
    from: row.sender_id,
    ...(row.sender_name === null ? {} : { pushName: row.sender_name }),
    text: payload.text,
    timestamp: row.occurred_at_ms,
    isGroup: payload.isGroup,
    fromMe: applicationCanary ? false : row.direction === "outbound",
    live: applicationCanary ? true : payload.live,
    mentions: payload.context?.mentions ?? [],
    ...(payload.context?.quoted?.from === undefined ? {} : { quotedFrom: payload.context.quoted.from }),
  };
};

const decodeUpdate = (row: InboxEventRow): ConversationUpdate => {
  const base = {
    id: row.event_id,
    providerMessageId: row.provider_message_id,
    chatId: row.chat_id,
    ...(row.sender_id === null ? {} : { senderId: row.sender_id }),
    ...(row.sender_name === null ? {} : { senderName: row.sender_name }),
    direction: row.direction,
    occurredAt: row.occurred_at_ms,
  } as const;
  switch (row.kind) {
    case "edit":
      return { ...base, kind: "edit", payload: JSON.parse(row.payload_json) as ConversationEdit["payload"] };
    case "reaction":
      return { ...base, kind: "reaction", payload: JSON.parse(row.payload_json) as ConversationReaction["payload"] };
    case "revocation":
      return {
        ...base,
        kind: "revocation",
        payload: JSON.parse(row.payload_json) as ConversationRevocation["payload"],
      };
    case "arrival":
    case "receipt":
      throw new Error(`Managed Chat Inbox row ${row.event_id} has kind "${row.kind}", which is never windowed.`);
  }
};

const decodeCoalescerEvent = (row: InboxEventRow): CoalescerEvent =>
  row.kind === "arrival" ? decodeIncoming(row) : decodeUpdate(row);

const acceptedArrival = (
  event: ConversationEvent,
  allowed: CreateManagedChatInboxOptions["allowed"],
): event is ConversationArrival =>
  event.kind === "arrival" &&
  ((event.direction === "inbound" && event.payload.live) ||
    (event.direction === "outbound" && event.payload.applicationAdmission === "smoke-canary")) &&
  allowed(event.chatId, event.payload.isGroup);

const acceptedUpdate = (
  event: ConversationEvent,
  allowed: CreateManagedChatInboxOptions["allowed"],
): event is ConversationUpdate =>
  event.kind !== "arrival" && event.kind !== "receipt" && allowed(event.chatId, isGroupJid(event.chatId));

const admissionTable = `
  CREATE TABLE managed_chat_admissions (
    window_id TEXT PRIMARY KEY,
    status TEXT NOT NULL CHECK (status IN ('pending', 'done', 'failed')),
    dispatch_id TEXT,
    accepted_at TEXT,
    reason TEXT,
    updated_at_ms INTEGER NOT NULL,
    FOREIGN KEY (window_id) REFERENCES managed_chat_windows(window_id),
    CHECK (
      (status = 'pending' AND dispatch_id IS NULL AND accepted_at IS NULL AND reason IS NULL)
      OR (status = 'done' AND dispatch_id IS NOT NULL AND accepted_at IS NOT NULL AND reason IS NULL)
      OR (status = 'failed' AND dispatch_id IS NULL AND accepted_at IS NULL AND reason IS NOT NULL)
    )
  ) STRICT
`;

/**
 * One-way migration from the five-state admission machine (ADR 0006) to the
 * two-outcome ledger (ADR 0014): admitted→done, abandoned→failed, and
 * pending/dispatching/uncertain→pending so a repaired runtime re-dispatches
 * them — a duplicate wake is tolerated by design.
 */
const ensureAdmissionSchema = (database: DatabaseSync): void => {
  const existing = database
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'managed_chat_admissions'")
    .get() as { readonly sql: string } | undefined;
  if (existing === undefined) {
    database.exec(admissionTable);
  } else if (!existing.sql.includes("'done'")) {
    database.exec(`
      DROP INDEX IF EXISTS managed_chat_admissions_status_idx;
      ALTER TABLE managed_chat_admissions RENAME TO managed_chat_admissions_legacy;
      ${admissionTable};
      INSERT INTO managed_chat_admissions
        (window_id, status, dispatch_id, accepted_at, reason, updated_at_ms)
      SELECT window_id,
             CASE status WHEN 'admitted' THEN 'done' WHEN 'abandoned' THEN 'failed' ELSE 'pending' END,
             CASE WHEN status = 'admitted' THEN dispatch_id END,
             CASE WHEN status = 'admitted' THEN accepted_at END,
             CASE WHEN status = 'abandoned' THEN reason END,
             updated_at_ms
        FROM managed_chat_admissions_legacy;
      DROP TABLE managed_chat_admissions_legacy;
      DROP TABLE IF EXISTS managed_chat_admission_resolutions;
      DROP TABLE IF EXISTS managed_chat_admission_examinations;
    `);
  }
  database.exec(`
    CREATE INDEX IF NOT EXISTS managed_chat_admissions_status_idx
      ON managed_chat_admissions(status, updated_at_ms, window_id);
    CREATE UNIQUE INDEX IF NOT EXISTS managed_chat_admissions_dispatch_idx
      ON managed_chat_admissions(dispatch_id) WHERE dispatch_id IS NOT NULL;
  `);
};

/** Read-only pending/failed batch counts for `status`; never migrates or writes. */
export const inspectWindowDeliveryCounts = (databasePath: string): { pending: number; failed: number } => {
  if (databasePath !== ":memory:" && !existsSync(databasePath)) return { pending: 0, failed: 0 };
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const tableExists =
      database
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'managed_chat_admissions'")
        .get() !== undefined;
    if (!tableExists) return { pending: 0, failed: 0 };
    const count = (status: string): number =>
      Number(
        (
          database.prepare("SELECT COUNT(*) AS count FROM managed_chat_admissions WHERE status = ?").get(status) as {
            readonly count: number;
          }
        ).count,
      );
    return { pending: count("pending"), failed: count("failed") };
  } finally {
    database.close();
  }
};

export const createManagedChatInbox = (
  archive: ConversationArchive,
  options: CreateManagedChatInboxOptions,
): ManagedChatInbox => {
  const createId = options.createId ?? randomUUID;
  const now = options.now ?? Date.now;
  archive.transaction(({ database }) => {
    database.exec(`
      CREATE TABLE IF NOT EXISTS managed_chat_windows (
        window_id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        reason TEXT NOT NULL CHECK (reason IN ('debounce', 'maximum-wait', 'capacity', 'mention', 'quote-reply')),
        created_at_ms INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS managed_chat_windows_created_idx
        ON managed_chat_windows(created_at_ms, window_id);
      CREATE TABLE IF NOT EXISTS managed_chat_inbox (
        inbox_sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        chat_id TEXT NOT NULL,
        window_id TEXT,
        accepted_at_ms INTEGER NOT NULL,
        FOREIGN KEY (event_id) REFERENCES conversation_events(event_id),
        FOREIGN KEY (window_id) REFERENCES managed_chat_windows(window_id)
      );
      CREATE INDEX IF NOT EXISTS managed_chat_inbox_pending_idx
        ON managed_chat_inbox(window_id, inbox_sequence);
      CREATE INDEX IF NOT EXISTS managed_chat_inbox_chat_idx
        ON managed_chat_inbox(chat_id, inbox_sequence);
    `);
    ensureAdmissionSchema(database);
    // Windows predating the admission ledger have no row at all; backfill them
    // as pending so startup re-dispatches them (ADR 0014 duplicate-wake).
    database
      .prepare(`
        INSERT INTO managed_chat_admissions (window_id, status, updated_at_ms)
        SELECT w.window_id, 'pending', ?
          FROM managed_chat_windows w
          LEFT JOIN managed_chat_admissions a ON a.window_id = w.window_id
         WHERE a.window_id IS NULL
      `)
      .run(now());
  });

  const selectInbox = (database: DatabaseSync, where: string): readonly InboxEventRow[] =>
    database
      .prepare(`
      SELECT e.event_id, e.kind, e.provider_message_id, e.chat_id, e.sender_id, e.sender_name,
             e.direction, e.occurred_at_ms, e.payload_json
        FROM managed_chat_inbox i
        JOIN conversation_events e ON e.event_id = i.event_id
       ${where}
       ORDER BY i.inbox_sequence
    `)
      .all() as unknown as InboxEventRow[];

  const readWindow = (database: DatabaseSync, windowId: string): ConversationWindow => {
    const row = database
      .prepare("SELECT window_id, chat_id, reason FROM managed_chat_windows WHERE window_id = ?")
      .get(windowId) as unknown as WindowRow | undefined;
    if (row === undefined) throw new Error(`Managed Chat Window ${windowId} does not exist.`);
    const events = database
      .prepare(`
      SELECT e.event_id, e.kind, e.provider_message_id, e.chat_id, e.sender_id, e.sender_name,
             e.direction, e.occurred_at_ms, e.payload_json
        FROM managed_chat_inbox i
        JOIN conversation_events e ON e.event_id = i.event_id
       WHERE i.window_id = ?
       ORDER BY i.inbox_sequence
    `)
      .all(windowId) as unknown as InboxEventRow[];
    return {
      id: row.window_id,
      chatId: row.chat_id,
      reason: row.reason,
      ...windowContents(events.map(decodeCoalescerEvent)),
    };
  };

  const decodeAdmission = (row: AdmissionRow): WindowAdmission => {
    switch (row.status) {
      case "pending":
        return { status: "pending", windowId: row.window_id };
      case "done":
        return {
          status: "done",
          windowId: row.window_id,
          dispatchId: row.dispatch_id!,
          acceptedAt: row.accepted_at!,
        };
      case "failed":
        return { status: "failed", windowId: row.window_id, reason: row.reason! };
    }
  };

  const readAdmission = (database: DatabaseSync, windowId: string): WindowAdmission | undefined => {
    const row = database
      .prepare(`
        SELECT window_id, status, dispatch_id, accepted_at, reason
          FROM managed_chat_admissions
         WHERE window_id = ?
      `)
      .get(windowId) as unknown as AdmissionRow | undefined;
    return row === undefined ? undefined : decodeAdmission(row);
  };

  const assertReceipt = (receipt: WindowAdmissionReceipt): void => {
    if (!receipt.dispatchId.trim()) throw new Error("A Flue admission receipt requires a dispatchId.");
    if (!receipt.acceptedAt.trim() || !Number.isFinite(Date.parse(receipt.acceptedAt))) {
      throw new Error("A Flue admission receipt requires a valid acceptedAt timestamp.");
    }
  };

  const transitionFailed = (database: DatabaseSync, windowId: string, target: WindowAdmission["status"]): Error =>
    new Error(
      `Managed Chat Window ${windowId} cannot transition to ${target} from ${readAdmission(database, windowId)?.status ?? "missing"}.`,
    );

  return {
    recorder: {
      append: (event) =>
        archive.transaction((transaction) => {
          const inserted = transaction.append(event);
          if (inserted && (acceptedArrival(event, options.allowed) || acceptedUpdate(event, options.allowed))) {
            transaction.database
              .prepare(`
            INSERT INTO managed_chat_inbox (event_id, chat_id, accepted_at_ms)
            VALUES (?, ?, ?)
          `)
              .run(event.id, event.chatId, now());
          }
          return inserted;
        }),
    },
    unwindowed: () =>
      archive.transaction(({ database }) => selectInbox(database, "WHERE i.window_id IS NULL").map(decodeCoalescerEvent)),
    pending: (event) =>
      archive.transaction(({ database }) => {
        const row = database
          .prepare(`
            SELECT e.event_id, e.kind, e.provider_message_id, e.chat_id, e.sender_id, e.sender_name,
                   e.direction, e.occurred_at_ms, e.payload_json
              FROM managed_chat_inbox i
              JOIN conversation_events e ON e.event_id = i.event_id
             WHERE i.event_id = ? AND i.window_id IS NULL
          `)
          .get(coalescerEventId(event)) as unknown as InboxEventRow | undefined;
        return row === undefined ? undefined : decodeCoalescerEvent(row);
      }),
    pendingWindows: () =>
      archive.transaction(({ database }) => {
        const rows = database
          .prepare(`
            SELECT w.window_id, w.chat_id, w.reason
              FROM managed_chat_windows w
              JOIN managed_chat_inbox i ON i.window_id = w.window_id
              JOIN managed_chat_admissions a ON a.window_id = w.window_id
             WHERE a.status = 'pending'
             GROUP BY w.rowid
             ORDER BY MIN(i.inbox_sequence), w.rowid
          `)
          .all() as unknown as WindowRow[];
        return rows.map(({ window_id }) => readWindow(database, window_id));
      }),
    window: (windowId) =>
      archive.transaction(({ database }) => {
        const exists = database
          .prepare("SELECT 1 AS present FROM managed_chat_windows WHERE window_id = ?")
          .get(windowId);
        return exists === undefined ? undefined : readWindow(database, windowId);
      }),
    windowForDispatch: (dispatchId) =>
      archive.transaction(({ database }) => {
        const row = database
          .prepare("SELECT window_id FROM managed_chat_admissions WHERE dispatch_id = ? AND status = 'done'")
          .get(dispatchId) as { readonly window_id: string } | undefined;
        return row === undefined ? undefined : readWindow(database, row.window_id);
      }),
    createWindow: (draft) => {
      const events: readonly CoalescerEvent[] = [...draft.messages, ...draft.updates];
      if (events.length === 0) throw new Error("A Managed Chat Window must contain at least one event.");
      if (events.some(({ chatId }) => chatId !== draft.chatId)) {
        throw new Error("A Managed Chat Window cannot mix chats.");
      }
      const eventIds = events.map(coalescerEventId);
      return archive.transaction(({ database }) => {
        const selectAssignment = database.prepare(
          "SELECT event_id, window_id FROM managed_chat_inbox WHERE event_id = ?",
        );
        const assignments = eventIds.map(
          (eventId) => selectAssignment.get(eventId) as unknown as AssignmentRow | undefined,
        );
        if (assignments.some((assignment) => assignment === undefined)) {
          throw new Error("A Managed Chat Window may contain only accepted Inbox events.");
        }
        const assigned = new Set(assignments.map((assignment) => assignment!.window_id).filter(Boolean));
        if (assigned.size === 1 && assignments.every((assignment) => assignment!.window_id !== null)) {
          const existing = readWindow(database, [...assigned][0]!);
          const existingEventIds = [...existing.messages, ...existing.updates].map(coalescerEventId);
          const expected = new Set(eventIds);
          if (
            existingEventIds.length === eventIds.length &&
            existingEventIds.every((id) => expected.has(id))
          ) {
            return existing;
          }
          throw new Error("A Managed Chat event already belongs to a different Window assignment.");
        }
        if (assigned.size > 0) throw new Error("A Managed Chat event cannot belong to more than one Window.");

        const oldestPending = database
          .prepare(`
            SELECT event_id FROM managed_chat_inbox
             WHERE chat_id = ? AND window_id IS NULL
             ORDER BY inbox_sequence
             LIMIT ?
          `)
          .all(draft.chatId, eventIds.length) as unknown as Array<{ readonly event_id: string }>;
        const included = new Set(eventIds);
        if (oldestPending.length !== eventIds.length || oldestPending.some(({ event_id }) => !included.has(event_id))) {
          throw new Error("A Managed Chat Window must claim the oldest pending events in observed order.");
        }

        const windowId = createId();
        database
          .prepare(`
          INSERT INTO managed_chat_windows (window_id, chat_id, reason, created_at_ms)
          VALUES (?, ?, ?, ?)
        `)
          .run(windowId, draft.chatId, draft.reason, now());
        database
          .prepare(`
            INSERT INTO managed_chat_admissions (window_id, status, updated_at_ms)
            VALUES (?, 'pending', ?)
          `)
          .run(windowId, now());
        const assign = database.prepare(`
          UPDATE managed_chat_inbox SET window_id = ?
           WHERE event_id = ? AND chat_id = ? AND window_id IS NULL
        `);
        for (const { event_id: eventId } of oldestPending) {
          const result = assign.run(windowId, eventId, draft.chatId);
          if (result.changes !== 1) throw new Error("Managed Chat Window assignment lost an accepted event.");
        }
        return { id: windowId, ...draft };
      });
    },
    admissions: (status) =>
      archive.transaction(({ database }) => {
        const rows = database
          .prepare(`
            SELECT window_id, status, dispatch_id, accepted_at, reason
              FROM managed_chat_admissions
             WHERE (? IS NULL OR status = ?)
             ORDER BY updated_at_ms, rowid
          `)
          .all(status ?? null, status ?? null) as unknown as AdmissionRow[];
        return rows.map(decodeAdmission);
      }),
    markDone: (windowId, receipt) => {
      assertReceipt(receipt);
      archive.transaction(({ database }) => {
        const result = database
          .prepare(`
            UPDATE managed_chat_admissions
               SET status = 'done', dispatch_id = ?, accepted_at = ?, updated_at_ms = ?
             WHERE window_id = ? AND status = 'pending'
          `)
          .run(receipt.dispatchId, receipt.acceptedAt, now(), windowId);
        if (result.changes !== 1) throw transitionFailed(database, windowId, "done");
      });
    },
    markFailed: (windowId, reason) => {
      const normalizedReason = reason.trim();
      if (!normalizedReason) throw new Error("A failed Window delivery requires a reason.");
      archive.transaction(({ database }) => {
        const result = database
          .prepare(`
            UPDATE managed_chat_admissions
               SET status = 'failed', reason = ?, updated_at_ms = ?
             WHERE window_id = ? AND status = 'pending'
          `)
          .run(normalizedReason, now(), windowId);
        if (result.changes !== 1) throw transitionFailed(database, windowId, "failed");
      });
    },
  };
};

export const managedChatWindowStore = (inbox: ManagedChatInbox): Layer.Layer<WindowStore, never> =>
  Layer.succeed(WindowStore, {
    pendingWindows: Effect.try({
      try: () => inbox.pendingWindows(),
      catch: (cause) => new WindowStoreError({ cause }),
    }),
    create: (draft) =>
      Effect.try({
        try: () => inbox.createWindow(draft),
        catch: (cause) => new WindowStoreError({ cause }),
      }),
  });
