import type { InboundMessage, Outbound, SendOptions, WhatsAppSession } from "whatsappd";
import type { GatewayStore, StoredWhatsAppMessage } from "./jobs.ts";

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

/**
 * Decorate the gateway's one whatsappd session with durable message capture.
 * The native `(chatId, messageId)` key makes sends, echoes, history replay, and
 * reconnect delivery idempotent while leaving the Coalescer buffer untouched.
 */
export const persistWhatsAppMessages = (
  session: WhatsAppSession,
  store: GatewayStore,
): { readonly session: WhatsAppSession; readonly unsubscribe: () => void } => {
  const persistInbound = (message: InboundMessage): void => {
    try {
      store.persistMessage({
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
      console.error(`[gateway] failed to persist WhatsApp message ${message.id} in ${message.chatId}:`, cause);
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
            store.persistMessage({
              id: ref.id,
              chatId: ref.chatId,
              direction: "outbound",
              ...outboundDetails(content),
              timestamp: Date.now(),
            });
          } catch (cause) {
            // WhatsApp already accepted this message. Surface the persistence
            // failure without rejecting the send and triggering a duplicate.
            console.error(`[gateway] sent WhatsApp message ${ref.id} but failed to persist it:`, cause);
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
