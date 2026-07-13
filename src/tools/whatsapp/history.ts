import { defineTool } from "@flue/runtime";
import * as v from "valibot";

import { getWhatsAppHistory, type StoredWhatsAppMessage } from "../../host/whatsapp-history.js";

const nonEmptyString = v.pipe(v.string(), v.minLength(1));
const historyMessageSchema = v.object({
  id: nonEmptyString,
  chatId: nonEmptyString,
  direction: v.union([v.literal("inbound"), v.literal("outbound")]),
  senderId: v.optional(nonEmptyString),
  senderName: v.optional(nonEmptyString),
  kind: nonEmptyString,
  text: v.string(),
  timestamp: v.pipe(v.number(), v.finite()),
});
const historyOutputSchema = v.object({
  messages: v.array(historyMessageSchema),
  context: v.string(),
});

const format = (messages: readonly StoredWhatsAppMessage[]): string =>
  messages
    .map((message) => {
      const author = message.direction === "outbound" ? "Ambience" : (message.senderName ?? message.senderId ?? "participant");
      return `${new Date(message.timestamp).toISOString()} ${author}: ${message.text}`;
    })
    .join("\n");

export const createReadWhatsAppThreadTool = (chatId: string) =>
  defineTool({
    name: "whatsapp_read_thread",
    description: "Read recent messages from this Ambience instance's WhatsApp chat, oldest to newest.",
    input: v.object({
      limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100))),
    }),
    output: historyOutputSchema,
    run: ({ input }) => {
      const messages = getWhatsAppHistory().readThread(chatId, input.limit ?? 30);
      return { messages: [...messages], context: format(messages) };
    },
  });

export const createSearchWhatsAppHistoryTool = (chatId: string) =>
  defineTool({
    name: "whatsapp_search",
    description: "Search message text in this Ambience instance's WhatsApp chat only.",
    input: v.object({ query: nonEmptyString }),
    output: historyOutputSchema,
    run: ({ input }) => {
      const messages = getWhatsAppHistory().search(chatId, input.query);
      return { messages: [...messages], context: format(messages) };
    },
  });
