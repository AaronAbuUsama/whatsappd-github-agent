import type { StoredWhatsAppMessage } from "./jobs.ts";

export const formatWhatsAppHistory = (messages: readonly StoredWhatsAppMessage[]): string =>
  messages
    .map((message) => {
      const at = new Date(message.timestamp).toISOString();
      const speaker = message.direction === "outbound" ? "you" : (message.senderName ?? message.senderId ?? "unknown");
      const body = message.text === "" ? `[${message.kind}]` : message.text;
      return `${at} ${speaker}: ${body}`;
    })
    .join("\n");
