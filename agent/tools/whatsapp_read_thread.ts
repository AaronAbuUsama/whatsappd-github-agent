import { defineTool } from "eve/tools";
import { z } from "zod";
import { formatWhatsAppHistory } from "../lib/whatsapp-history.ts";
import { GatewayStore } from "../lib/jobs.ts";

export default defineTool({
  description:
    "Read recent messages from this current WhatsApp chat, returned oldest-to-newest for conversational context. " +
    "The chat is securely derived from this voice session; you cannot choose another chat.",
  inputSchema: z.object({
    limit: z.number().int().min(1).max(100).default(30).describe("How many of the most recent messages to read."),
  }),
  execute({ limit }, ctx) {
    const store = new GatewayStore();
    try {
      const chatId = store.chatIdForVoiceSession(ctx.session.id);
      if (chatId === undefined) throw new Error("No verified current WhatsApp chat is mapped to this voice session");
      const messages = store.readThread(chatId, limit);
      return { messages, context: formatWhatsAppHistory(messages) };
    } finally {
      store.close();
    }
  },
});
