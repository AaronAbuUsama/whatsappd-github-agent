import type { ProjectedConversationMessage } from "../intake/conversation-archive.ts";

export type StoredWhatsAppMessage = ProjectedConversationMessage;

export interface WhatsAppHistory {
  readThread(chatId: string, limit?: number): readonly StoredWhatsAppMessage[];
  search(chatId: string, query: string, limit?: number): readonly StoredWhatsAppMessage[];
}

let configuredHistory: WhatsAppHistory | undefined;

export const configureWhatsAppHistory = (history: WhatsAppHistory): void => {
  configuredHistory = history;
};

export const getWhatsAppHistory = (): WhatsAppHistory => {
  if (!configuredHistory) throw new Error("The Conversation Archive is not configured for Ambience.");
  return configuredHistory;
};
