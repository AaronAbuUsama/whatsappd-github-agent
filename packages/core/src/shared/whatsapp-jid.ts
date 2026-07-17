/** Group JIDs end in `@g.us`; DM JIDs end in `@s.whatsapp.net`. */
export const isGroupJid = (chatId: string): boolean => chatId.endsWith("@g.us");
