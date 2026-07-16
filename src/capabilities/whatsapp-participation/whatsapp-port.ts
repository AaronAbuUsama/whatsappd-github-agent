import type { ProjectedConversationMessage } from "../../intake/conversation-archive.ts";

export type WhatsAppDeliveryResult =
  | { readonly delivery: "sent"; readonly messageId: string }
  | { readonly delivery: "failed" | "unknown"; readonly deliveryError: string };

export type WhatsAppTypingResult =
  | { readonly typing: "cleared" }
  | { readonly typing: "unknown"; readonly typingError: string };

export type WhatsAppSayResult = WhatsAppDeliveryResult & WhatsAppTypingResult;

export const withTypingResult = (delivery: WhatsAppDeliveryResult, typingError?: string): WhatsAppSayResult =>
  typingError === undefined ? { ...delivery, typing: "cleared" } : { ...delivery, typing: "unknown", typingError };

export interface WhatsAppSayPort {
  /** Own the full typing/send/finalization attempt and report observed state without retrying. */
  readonly say: (chatId: string, text: string, replyTo?: string) => Promise<WhatsAppSayResult>;
}

export interface WhatsAppReactPort {
  /** Add one reaction to a referenced message without retrying an uncertain provider outcome. */
  readonly react: (chatId: string, messageId: string, emoji: string) => Promise<WhatsAppSayResult>;
}

export interface WhatsAppOutboundPort extends WhatsAppSayPort, WhatsAppReactPort {}

export interface WhatsAppHistoryPort {
  readThread(chatId: string, limit?: number): readonly ProjectedConversationMessage[];
  search(chatId: string, query: string, limit?: number): readonly ProjectedConversationMessage[];
}

export interface WhatsAppMessageLookupPort {
  messageState(chatId: string, messageId: string): ProjectedConversationMessage | undefined;
}

export interface WhatsAppParticipationPort extends WhatsAppOutboundPort, WhatsAppHistoryPort {}

const WHATSAPP_PARTICIPATION_PORT = Symbol.for("ambient-agent.whatsapp-participation-port");
const participationGlobal = globalThis as typeof globalThis & {
  [WHATSAPP_PARTICIPATION_PORT]?: WhatsAppParticipationPort;
};

export const configureWhatsAppParticipationPort = (port: WhatsAppParticipationPort): void => {
  participationGlobal[WHATSAPP_PARTICIPATION_PORT] = port;
};

export const getWhatsAppParticipationPort = (): WhatsAppParticipationPort => {
  const port = participationGlobal[WHATSAPP_PARTICIPATION_PORT];
  if (port === undefined) {
    throw new Error("The WhatsApp Participation port is not configured for Ambience.");
  }
  return port;
};
