import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { InboundMessage, Outbound, SendOptions, WhatsAppSession } from "whatsappd";

export type MessageDirection = "inbound" | "outbound";

export interface StoredWhatsAppMessage {
  readonly id: string;
  readonly chatId: string;
  readonly direction: MessageDirection;
  readonly senderId?: string;
  readonly senderName?: string;
  readonly kind: string;
  readonly text: string;
  readonly timestamp: number;
}

interface MessageRow {
  message_id: string;
  chat_id: string;
  direction: MessageDirection;
  sender_id: string | null;
  sender_name: string | null;
  kind: string;
  text: string;
  timestamp_ms: number;
}

const decodeMessage = (row: MessageRow): StoredWhatsAppMessage => ({
  id: row.message_id,
  chatId: row.chat_id,
  direction: row.direction,
  ...(row.sender_id === null ? {} : { senderId: row.sender_id }),
  ...(row.sender_name === null ? {} : { senderName: row.sender_name }),
  kind: row.kind,
  text: row.text,
  timestamp: row.timestamp_ms,
});

const escapeLike = (query: string): string =>
  query.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_");

export const whatsappHistoryDatabasePath = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): string =>
  env.WHATSAPP_HISTORY_DB?.trim() ||
  env.WA_GATEWAY_DB?.trim() ||
  join(env.WHATSAPP_STORE_DIR?.trim() || ".wa-auth", "gateway.sqlite");

export interface WhatsAppHistory {
  persist(message: StoredWhatsAppMessage): void;
  readThread(chatId: string, limit?: number): readonly StoredWhatsAppMessage[];
  search(chatId: string, query: string, limit?: number): readonly StoredWhatsAppMessage[];
  close(): void;
}

export const createWhatsAppHistory = (databasePath = whatsappHistoryDatabasePath()): WhatsAppHistory => {
  mkdirSync(dirname(databasePath), { recursive: true });
  const database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS messages (
      chat_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
      sender_id TEXT,
      sender_name TEXT,
      kind TEXT NOT NULL,
      text TEXT NOT NULL,
      timestamp_ms INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (chat_id, message_id)
    );
    CREATE INDEX IF NOT EXISTS messages_chat_time_idx ON messages(chat_id, timestamp_ms, message_id);
  `);
  const persist = database.prepare(`
    INSERT INTO messages
      (chat_id, message_id, direction, sender_id, sender_name, kind, text, timestamp_ms, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(chat_id, message_id) DO UPDATE SET
      direction = excluded.direction,
      sender_id = COALESCE(excluded.sender_id, messages.sender_id),
      sender_name = COALESCE(excluded.sender_name, messages.sender_name),
      kind = excluded.kind,
      text = CASE WHEN excluded.text <> '' THEN excluded.text ELSE messages.text END,
      timestamp_ms = MIN(messages.timestamp_ms, excluded.timestamp_ms)
  `);

  return {
    persist: (message) => {
      persist.run(
        message.chatId,
        message.id,
        message.direction,
        message.senderId ?? null,
        message.senderName ?? null,
        message.kind,
        message.text,
        message.timestamp,
      );
    },
    readThread: (chatId, limit = 30) => {
      const rows = database.prepare(`
        SELECT * FROM (
          SELECT * FROM messages
           WHERE chat_id = ?
           ORDER BY timestamp_ms DESC, message_id DESC
           LIMIT ?
        ) ORDER BY timestamp_ms, message_id
      `).all(chatId, Math.max(1, Math.min(limit, 100))) as unknown as MessageRow[];
      return rows.map(decodeMessage);
    },
    search: (chatId, query, limit = 50) => {
      const rows = database.prepare(`
        SELECT * FROM (
          SELECT * FROM messages
           WHERE chat_id = ? AND text LIKE ? ESCAPE '\\' COLLATE NOCASE
           ORDER BY timestamp_ms DESC, message_id DESC
           LIMIT ?
        ) ORDER BY timestamp_ms, message_id
      `).all(chatId, `%${escapeLike(query)}%`, Math.max(1, Math.min(limit, 100))) as unknown as MessageRow[];
      return rows.map(decodeMessage);
    },
    close: () => database.close(),
  };
};

let configuredHistory: WhatsAppHistory | undefined;

export const configureWhatsAppHistory = (history: WhatsAppHistory): void => {
  configuredHistory = history;
};

export const getWhatsAppHistory = (): WhatsAppHistory => {
  if (!configuredHistory) throw new Error("WhatsApp history is not configured for Ambience.");
  return configuredHistory;
};

const inboundText = (message: InboundMessage): string => {
  switch (message.kind) {
    case "text":
      return message.text;
    case "image":
    case "video":
    case "audio":
    case "document":
    case "sticker":
      return message.text ?? "";
    case "location":
      return [message.name, message.address, `${message.lat}, ${message.lng}`].filter(Boolean).join(" — ");
    case "contacts":
      return message.contacts.map(({ name }) => name ?? "contact").join(", ");
    case "poll":
      return `${message.name}: ${message.options.join(", ")}`;
    case "unsupported":
      return `[unsupported: ${message.rawType}]`;
  }
};

const outboundDetails = (content: Outbound): Pick<StoredWhatsAppMessage, "kind" | "text"> => {
  if ("text" in content) return { kind: "text", text: content.text };
  if ("image" in content) return { kind: "image", text: content.caption ?? "" };
  if ("video" in content) return { kind: "video", text: content.caption ?? "" };
  if ("audio" in content) return { kind: "audio", text: "" };
  if ("document" in content) return { kind: "document", text: content.caption ?? content.fileName };
  if ("sticker" in content) return { kind: "sticker", text: "" };
  if ("location" in content) {
    return {
      kind: "location",
      text: [content.location.name, content.location.address, `${content.location.lat}, ${content.location.lng}`]
        .filter(Boolean)
        .join(" — "),
    };
  }
  if ("contacts" in content) return { kind: "contacts", text: content.contacts.displayName ?? "contacts" };
  if ("react" in content) return { kind: "reaction", text: content.react.emoji };
  if ("edit" in content) return { kind: "edit", text: content.edit.text };
  return { kind: "delete", text: "" };
};

/** Decorate the one production session so live, history-sync, send, and echo paths share native-id deduplication. */
export const persistWhatsAppMessages = (
  session: WhatsAppSession,
  history: WhatsAppHistory,
): { readonly session: WhatsAppSession; readonly unsubscribe: () => void } => {
  const persistInbound = (message: InboundMessage): void => {
    try {
      history.persist({
        id: message.id,
        chatId: message.chatId,
        direction: message.fromMe ? "outbound" : "inbound",
        senderId: message.from,
        ...(message.pushName === undefined ? {} : { senderName: message.pushName }),
        kind: message.kind,
        text: inboundText(message),
        timestamp: message.timestamp,
      });
    } catch (cause) {
      console.error(`[ambience] failed to persist WhatsApp message ${message.id} in ${message.chatId}:`, cause);
    }
  };
  const unsubscribeMessage = session.onMessage(persistInbound);
  const unsubscribeSync = session.onConversationSync((batch) => {
    for (const message of batch.messages) persistInbound(message);
  });

  const wrapped = new Proxy(session, {
    get(target, property) {
      if (property === "send") {
        return async (chatId: string, content: Outbound, options?: SendOptions) => {
          const ref = await target.send(chatId, content, options);
          try {
            history.persist({
              id: ref.id,
              chatId: ref.chatId,
              direction: "outbound",
              ...outboundDetails(content),
              timestamp: Date.now(),
            });
          } catch (cause) {
            console.error(`[ambience] sent WhatsApp message ${ref.id} but failed to persist it:`, cause);
          }
          return ref;
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  return {
    session: wrapped,
    unsubscribe: () => {
      unsubscribeSync();
      unsubscribeMessage();
    },
  };
};
