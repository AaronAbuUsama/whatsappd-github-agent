import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

import type { ReceiptStatus } from "whatsappd";

import type { ConversationDirection, ConversationEvent } from "./conversation-event.ts";

export interface ProjectedConversationMessage {
  readonly id: string;
  readonly chatId: string;
  readonly direction: ConversationDirection;
  readonly senderId?: string;
  readonly senderName?: string;
  readonly kind: string;
  readonly text: string;
  readonly timestamp: number;
}

interface EventRow {
  event_id: string;
  kind: ConversationEvent["kind"];
  provider_message_id: string;
  chat_id: string;
  sender_id: string | null;
  sender_name: string | null;
  direction: ConversationDirection;
  occurred_at_ms: number;
  payload_json: string;
}

interface MessageRow {
  message_id: string;
  chat_id: string;
  direction: ConversationDirection;
  sender_id: string | null;
  sender_name: string | null;
  kind: string;
  text: string;
  timestamp_ms: number;
  revoked: number;
}

interface ReactionRow {
  actor_id: string;
  emoji: string;
}

interface ReceiptRow {
  actor_id: string;
  status: ReceiptStatus;
}

const decodeEvent = (row: EventRow): ConversationEvent => ({
  id: row.event_id,
  kind: row.kind,
  providerMessageId: row.provider_message_id,
  chatId: row.chat_id,
  ...(row.sender_id === null ? {} : { senderId: row.sender_id }),
  ...(row.sender_name === null ? {} : { senderName: row.sender_name }),
  direction: row.direction,
  occurredAt: row.occurred_at_ms,
  payload: JSON.parse(row.payload_json) as ConversationEvent["payload"],
}) as ConversationEvent;

const decodeMessage = (row: MessageRow): ProjectedConversationMessage => ({
  id: row.message_id,
  chatId: row.chat_id,
  direction: row.direction,
  ...(row.sender_id === null ? {} : { senderId: row.sender_id }),
  ...(row.sender_name === null ? {} : { senderName: row.sender_name }),
  kind: row.kind,
  text: row.text,
  timestamp: row.timestamp_ms,
});

export interface ConversationArchive {
  append(event: ConversationEvent): boolean;
  transaction<T>(work: (transaction: ConversationArchiveTransaction) => T): T;
  events(chatId?: string): readonly ConversationEvent[];
  readThread(chatId: string, limit?: number): readonly ProjectedConversationMessage[];
  search(chatId: string, query: string, limit?: number): readonly ProjectedConversationMessage[];
  messageState(chatId: string, messageId: string): (ProjectedConversationMessage & {
    readonly revoked: boolean;
    readonly reactions: readonly { readonly by: string; readonly emoji: string }[];
    readonly receipts: readonly { readonly by: string; readonly status: ReceiptStatus }[];
  }) | undefined;
  close(): void;
}

export interface ConversationArchiveTransaction {
  readonly database: DatabaseSync;
  append(event: ConversationEvent): boolean;
}

const escapeLike = (query: string): string =>
  query.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");

export const createConversationArchive = (databasePath: string): ConversationArchive => {
  mkdirSync(dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS conversation_events (
      event_id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      provider_message_id TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      sender_id TEXT,
      sender_name TEXT,
      direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
      occurred_at_ms INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS conversation_events_chat_time_idx
      ON conversation_events(chat_id, occurred_at_ms, event_id);
    CREATE TABLE IF NOT EXISTS conversation_messages (
      chat_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
      sender_id TEXT,
      sender_name TEXT,
      kind TEXT NOT NULL,
      text TEXT NOT NULL,
      timestamp_ms INTEGER NOT NULL,
      revoked INTEGER NOT NULL DEFAULT 0 CHECK (revoked IN (0, 1)),
      PRIMARY KEY (chat_id, message_id)
    );
    CREATE INDEX IF NOT EXISTS conversation_messages_chat_time_idx
      ON conversation_messages(chat_id, timestamp_ms, message_id);
    CREATE TABLE IF NOT EXISTS conversation_reactions (
      chat_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      emoji TEXT NOT NULL,
      PRIMARY KEY (chat_id, message_id, actor_id)
    );
    CREATE TABLE IF NOT EXISTS conversation_receipts (
      chat_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      actor_id TEXT NOT NULL,
      status TEXT NOT NULL,
      PRIMARY KEY (chat_id, message_id, actor_id)
    );
  `);

  const insertEvent = database.prepare(`
    INSERT OR IGNORE INTO conversation_events
      (event_id, kind, provider_message_id, chat_id, sender_id, sender_name, direction, occurred_at_ms, payload_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const projectArrival = database.prepare(`
    INSERT INTO conversation_messages
      (chat_id, message_id, direction, sender_id, sender_name, kind, text, timestamp_ms, revoked)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
    ON CONFLICT(chat_id, message_id) DO UPDATE SET
      direction = excluded.direction,
      sender_id = COALESCE(excluded.sender_id, conversation_messages.sender_id),
      sender_name = COALESCE(excluded.sender_name, conversation_messages.sender_name),
      kind = excluded.kind,
      text = excluded.text,
      timestamp_ms = MIN(conversation_messages.timestamp_ms, excluded.timestamp_ms),
      revoked = 0
  `);
  const projectEdit = database.prepare(`
    UPDATE conversation_messages SET kind = ?, text = ? WHERE chat_id = ? AND message_id = ?
  `);
  const projectRevocation = database.prepare(`
    UPDATE conversation_messages SET revoked = 1 WHERE chat_id = ? AND message_id = ?
  `);
  const projectReaction = database.prepare(`
    INSERT INTO conversation_reactions (chat_id, message_id, actor_id, emoji)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(chat_id, message_id, actor_id) DO UPDATE SET emoji = excluded.emoji
  `);
  const removeReaction = database.prepare(`
    DELETE FROM conversation_reactions WHERE chat_id = ? AND message_id = ? AND actor_id = ?
  `);
  const projectReceipt = database.prepare(`
    INSERT INTO conversation_receipts (chat_id, message_id, actor_id, status)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(chat_id, message_id, actor_id) DO UPDATE SET status = CASE
      WHEN (CASE excluded.status
        WHEN 'pending' THEN 0 WHEN 'server_ack' THEN 1 WHEN 'delivered' THEN 2
        WHEN 'read' THEN 3 WHEN 'played' THEN 4 WHEN 'error' THEN 5 ELSE -1 END)
        >= (CASE conversation_receipts.status
          WHEN 'pending' THEN 0 WHEN 'server_ack' THEN 1 WHEN 'delivered' THEN 2
          WHEN 'read' THEN 3 WHEN 'played' THEN 4 WHEN 'error' THEN 5 ELSE -1 END)
      THEN excluded.status ELSE conversation_receipts.status END
  `);
  const selectMessageArrival = database.prepare(`
    SELECT * FROM conversation_events
     WHERE chat_id = ? AND provider_message_id = ? AND kind = 'arrival'
     ORDER BY occurred_at_ms, event_id
     LIMIT 1
  `);
  const selectMessageUpdates = database.prepare(`
    SELECT * FROM conversation_events
     WHERE chat_id = ? AND provider_message_id = ? AND kind <> 'arrival'
     ORDER BY CASE WHEN occurred_at_ms = 0 THEN 1 ELSE 0 END, occurred_at_ms, rowid
  `);
  const clearMessageReactions = database.prepare(
    "DELETE FROM conversation_reactions WHERE chat_id = ? AND message_id = ?",
  );
  const clearMessageReceipts = database.prepare(
    "DELETE FROM conversation_receipts WHERE chat_id = ? AND message_id = ?",
  );

  const projectUpdate = (event: Exclude<ConversationEvent, { readonly kind: "arrival" }>): void => {
    switch (event.kind) {
      case "edit":
        projectEdit.run(event.payload.messageKind, event.payload.text, event.chatId, event.providerMessageId);
        break;
      case "revocation":
        projectRevocation.run(event.chatId, event.providerMessageId);
        break;
      case "reaction": {
        const actor = event.payload.by ?? "account";
        if (event.payload.removed) {
          removeReaction.run(event.chatId, event.providerMessageId, actor);
        } else {
          projectReaction.run(event.chatId, event.providerMessageId, actor, event.payload.emoji ?? "");
        }
        break;
      }
      case "receipt":
        projectReceipt.run(
          event.chatId,
          event.providerMessageId,
          event.payload.by ?? "account",
          event.payload.status,
        );
        break;
    }
  };

  const rebuildProjection = (chatId: string, messageId: string): void => {
    const row = selectMessageArrival.get(chatId, messageId) as unknown as EventRow | undefined;
    if (row === undefined) return;
    const arrival = decodeEvent(row);
    if (arrival.kind !== "arrival") return;
    projectArrival.run(
      arrival.chatId,
      arrival.providerMessageId,
      arrival.direction,
      arrival.senderId,
      arrival.senderName ?? null,
      arrival.payload.messageKind,
      arrival.payload.text,
      arrival.occurredAt,
    );
    clearMessageReactions.run(chatId, messageId);
    clearMessageReceipts.run(chatId, messageId);
    for (const updateRow of selectMessageUpdates.all(chatId, messageId) as unknown as EventRow[]) {
      const update = decodeEvent(updateRow);
      if (update.kind !== "arrival") projectUpdate(update);
    }
  };

  const appendWithinTransaction = (event: ConversationEvent): boolean => {
    const inserted = insertEvent.run(
      event.id,
      event.kind,
      event.providerMessageId,
      event.chatId,
      event.senderId ?? null,
      event.senderName ?? null,
      event.direction,
      event.occurredAt,
      JSON.stringify(event.payload),
    );
    if (inserted.changes === 0) return false;
    rebuildProjection(event.chatId, event.providerMessageId);
    return true;
  };

  const transaction = <T>(work: (value: ConversationArchiveTransaction) => T): T => {
    database.exec("BEGIN IMMEDIATE");
    try {
      const result = work({ database, append: appendWithinTransaction });
      database.exec("COMMIT");
      return result;
    } catch (cause) {
      database.exec("ROLLBACK");
      throw cause;
    }
  };

  return {
    append: (event) => transaction(({ append }) => append(event)),
    transaction,
    events: (chatId) => {
      const query = chatId === undefined
        ? "SELECT * FROM conversation_events ORDER BY CASE WHEN occurred_at_ms = 0 THEN 1 ELSE 0 END, occurred_at_ms, rowid"
        : "SELECT * FROM conversation_events WHERE chat_id = ? ORDER BY CASE WHEN occurred_at_ms = 0 THEN 1 ELSE 0 END, occurred_at_ms, rowid";
      const rows = (chatId === undefined ? database.prepare(query).all() : database.prepare(query).all(chatId)) as unknown as EventRow[];
      return rows.map(decodeEvent);
    },
    readThread: (chatId, limit = 30) => {
      const rows = database.prepare(`
        SELECT * FROM (
          SELECT * FROM conversation_messages
           WHERE chat_id = ? AND revoked = 0
           ORDER BY timestamp_ms DESC, message_id DESC
           LIMIT ?
        ) ORDER BY timestamp_ms, message_id
      `).all(chatId, Math.max(1, Math.min(limit, 100))) as unknown as MessageRow[];
      return rows.map(decodeMessage);
    },
    search: (chatId, query, limit = 50) => {
      const rows = database.prepare(`
        SELECT * FROM (
          SELECT * FROM conversation_messages
           WHERE chat_id = ? AND revoked = 0 AND text LIKE ? ESCAPE '\\' COLLATE NOCASE
           ORDER BY timestamp_ms DESC, message_id DESC
           LIMIT ?
        ) ORDER BY timestamp_ms, message_id
      `).all(chatId, `%${escapeLike(query)}%`, Math.max(1, Math.min(limit, 100))) as unknown as MessageRow[];
      return rows.map(decodeMessage);
    },
    messageState: (chatId, messageId) => {
      const row = database.prepare(
        "SELECT * FROM conversation_messages WHERE chat_id = ? AND message_id = ?",
      ).get(chatId, messageId) as unknown as MessageRow | undefined;
      if (row === undefined) return undefined;
      const reactions = database.prepare(`
        SELECT actor_id, emoji FROM conversation_reactions
         WHERE chat_id = ? AND message_id = ? ORDER BY actor_id
      `).all(chatId, messageId) as unknown as ReactionRow[];
      const receipts = database.prepare(`
        SELECT actor_id, status FROM conversation_receipts
         WHERE chat_id = ? AND message_id = ? ORDER BY actor_id
      `).all(chatId, messageId) as unknown as ReceiptRow[];
      return {
        ...decodeMessage(row),
        revoked: row.revoked === 1,
        reactions: reactions.map(({ actor_id, emoji }) => ({ by: actor_id, emoji })),
        receipts: receipts.map(({ actor_id, status }) => ({ by: actor_id, status })),
      };
    },
    close: () => database.close(),
  };
};
