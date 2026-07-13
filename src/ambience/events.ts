import type { ConversationWindow } from "../coalescer/events.ts";
import * as v from "valibot";

const nonEmptyString = v.pipe(v.string(), v.minLength(1));

export const whatsappWindowInputSchema = v.object({
  type: v.literal("whatsapp.window"),
  chatId: nonEmptyString,
  reason: v.union([v.literal("debounce"), v.literal("mention"), v.literal("quote-reply")]),
  messages: v.array(
    v.object({
      id: nonEmptyString,
      chatId: nonEmptyString,
      from: nonEmptyString,
      pushName: v.optional(v.string()),
      text: v.string(),
      timestamp: v.pipe(v.number(), v.finite()),
      isGroup: v.boolean(),
      fromMe: v.boolean(),
      live: v.boolean(),
      mentions: v.array(nonEmptyString),
      quotedFrom: v.optional(nonEmptyString),
    }),
  ),
});

export type WhatsAppWindowInput = v.InferOutput<typeof whatsappWindowInputSchema>;

export type AmbienceInput = WhatsAppWindowInput;

export const whatsappWindowInput = (window: ConversationWindow): WhatsAppWindowInput =>
  v.parse(whatsappWindowInputSchema, {
    type: "whatsapp.window",
    chatId: window.chatId,
    reason: window.reason,
    messages: window.messages,
  });
