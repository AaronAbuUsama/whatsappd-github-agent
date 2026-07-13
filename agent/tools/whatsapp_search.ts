import { defineTool } from "eve/tools";
import { z } from "zod";
import { formatWhatsAppHistory } from "../lib/whatsapp-history.ts";
import { GatewayStore } from "../lib/jobs.ts";

export default defineTool({
  description:
    "Search older messages in this current WhatsApp chat. Use this when someone asks what was said earlier " +
    "about a topic. The chat is securely derived from this voice session; you cannot choose another chat.",
  inputSchema: z.object({
    query: z.string().min(1).describe("A word or exact phrase to find in this chat's stored message text."),
  }),
  execute({ query }, ctx) {
    const store = new GatewayStore();
    try {
      const chatId = store.chatIdForVoiceSession(ctx.session.id);
      if (chatId === undefined) throw new Error("No verified current WhatsApp chat is mapped to this voice session");
      const messages = store.searchMessages(chatId, query);
      return { messages, context: formatWhatsAppHistory(messages) };
    } finally {
      store.close();
    }
  },
});
