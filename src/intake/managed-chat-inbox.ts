import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

import type { ConversationWindow, ConversationWindowDraft, FireReason, IncomingMessage } from "../coalescer/events.js";
import { Effect, Layer } from "effect";
import { WindowStore, WindowStoreError } from "../coalescer/ports.js";
import type { ConversationArchive } from "./conversation-archive.js";
import type { ConversationArrival, ConversationArrivalPayload, ConversationEvent } from "./conversation-event.js";

interface InboxEventRow {
  event_id: string;
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

export interface ManagedChatRecorder {
  append(event: ConversationEvent): boolean;
}

export interface ManagedChatInbox {
  readonly recorder: ManagedChatRecorder;
  unwindowed(): readonly IncomingMessage[];
  pendingArrival(chatId: string, messageId: string): IncomingMessage | undefined;
  pendingWindows(): readonly ConversationWindow[];
  createWindow(draft: ConversationWindowDraft): ConversationWindow;
}

export interface CreateManagedChatInboxOptions {
  readonly allowed: (chatId: string, isGroup: boolean) => boolean;
  readonly createId?: () => string;
  readonly now?: () => number;
}

const eventIdOf = (message: IncomingMessage): string => `arrival:${message.chatId}:${message.id}`;

const decodeIncoming = (row: InboxEventRow): IncomingMessage => {
  const payload = JSON.parse(row.payload_json) as ConversationArrivalPayload;
  return {
    id: row.provider_message_id,
    chatId: row.chat_id,
    from: row.sender_id,
    ...(row.sender_name === null ? {} : { pushName: row.sender_name }),
    text: payload.text,
    timestamp: row.occurred_at_ms,
    isGroup: payload.isGroup,
    fromMe: row.direction === "outbound",
    live: payload.live,
    mentions: payload.context?.mentions ?? [],
    ...(payload.context?.quoted?.from === undefined ? {} : { quotedFrom: payload.context.quoted.from }),
  };
};

const acceptedArrival = (
  event: ConversationEvent,
  allowed: CreateManagedChatInboxOptions["allowed"],
): event is ConversationArrival =>
  event.kind === "arrival" &&
  event.direction === "inbound" &&
  event.payload.live &&
  allowed(event.chatId, event.payload.isGroup);

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
  });

  const selectInbox = (database: DatabaseSync, where: string): readonly InboxEventRow[] =>
    database
      .prepare(`
      SELECT e.event_id, e.provider_message_id, e.chat_id, e.sender_id, e.sender_name,
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
    const messages = database
      .prepare(`
      SELECT e.event_id, e.provider_message_id, e.chat_id, e.sender_id, e.sender_name,
             e.direction, e.occurred_at_ms, e.payload_json
        FROM managed_chat_inbox i
        JOIN conversation_events e ON e.event_id = i.event_id
       WHERE i.window_id = ?
       ORDER BY i.inbox_sequence
    `)
      .all(windowId) as unknown as InboxEventRow[];
    return { id: row.window_id, chatId: row.chat_id, reason: row.reason, messages: messages.map(decodeIncoming) };
  };

  return {
    recorder: {
      append: (event) =>
        archive.transaction((transaction) => {
          const inserted = transaction.append(event);
          if (inserted && acceptedArrival(event, options.allowed)) {
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
      archive.transaction(({ database }) => selectInbox(database, "WHERE i.window_id IS NULL").map(decodeIncoming)),
    pendingArrival: (chatId, messageId) =>
      archive.transaction(({ database }) => {
        const row = database
          .prepare(`
            SELECT e.event_id, e.provider_message_id, e.chat_id, e.sender_id, e.sender_name,
                   e.direction, e.occurred_at_ms, e.payload_json
              FROM managed_chat_inbox i
              JOIN conversation_events e ON e.event_id = i.event_id
             WHERE i.event_id = ? AND i.window_id IS NULL
          `)
          .get(`arrival:${chatId}:${messageId}`) as unknown as InboxEventRow | undefined;
        return row === undefined ? undefined : decodeIncoming(row);
      }),
    pendingWindows: () =>
      archive.transaction(({ database }) => {
        const rows = database
          .prepare(`
            SELECT w.window_id, w.chat_id, w.reason
              FROM managed_chat_windows w
              JOIN managed_chat_inbox i ON i.window_id = w.window_id
             GROUP BY w.rowid
             ORDER BY MIN(i.inbox_sequence), w.rowid
          `)
          .all() as unknown as WindowRow[];
        return rows.map(({ window_id }) => readWindow(database, window_id));
      }),
    createWindow: (draft) => {
      if (draft.messages.length === 0) throw new Error("A Managed Chat Window must contain at least one arrival.");
      if (draft.messages.some(({ chatId }) => chatId !== draft.chatId)) {
        throw new Error("A Managed Chat Window cannot mix chats.");
      }
      const eventIds = draft.messages.map(eventIdOf);
      return archive.transaction(({ database }) => {
        const selectAssignment = database.prepare(
          "SELECT event_id, window_id FROM managed_chat_inbox WHERE event_id = ?",
        );
        const assignments = eventIds.map(
          (eventId) => selectAssignment.get(eventId) as unknown as AssignmentRow | undefined,
        );
        if (assignments.some((assignment) => assignment === undefined)) {
          throw new Error("A Managed Chat Window may contain only accepted Inbox arrivals.");
        }
        const assigned = new Set(assignments.map((assignment) => assignment!.window_id).filter(Boolean));
        if (assigned.size === 1 && assignments.every((assignment) => assignment!.window_id !== null)) {
          const existing = readWindow(database, [...assigned][0]!);
          const existingEventIds = existing.messages.map(eventIdOf);
          if (
            existingEventIds.length === eventIds.length &&
            existingEventIds.every((id, index) => id === eventIds[index])
          ) {
            return existing;
          }
          throw new Error("A Managed Chat arrival already belongs to a different Window assignment.");
        }
        if (assigned.size > 0) throw new Error("A Managed Chat arrival cannot belong to more than one Window.");

        const oldestPending = database
          .prepare(`
            SELECT event_id FROM managed_chat_inbox
             WHERE chat_id = ? AND window_id IS NULL
             ORDER BY inbox_sequence
             LIMIT ?
          `)
          .all(draft.chatId, eventIds.length) as unknown as Array<{ readonly event_id: string }>;
        if (
          oldestPending.length !== eventIds.length ||
          oldestPending.some(({ event_id }, index) => event_id !== eventIds[index])
        ) {
          throw new Error("A Managed Chat Window must claim the oldest pending arrivals in observed order.");
        }

        const windowId = createId();
        database
          .prepare(`
          INSERT INTO managed_chat_windows (window_id, chat_id, reason, created_at_ms)
          VALUES (?, ?, ?, ?)
        `)
          .run(windowId, draft.chatId, draft.reason, now());
        const assign = database.prepare(`
          UPDATE managed_chat_inbox SET window_id = ?
           WHERE event_id = ? AND chat_id = ? AND window_id IS NULL
        `);
        for (const eventId of eventIds) {
          const result = assign.run(windowId, eventId, draft.chatId);
          if (result.changes !== 1) throw new Error("Managed Chat Window assignment lost an accepted arrival.");
        }
        return { id: windowId, ...draft };
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
