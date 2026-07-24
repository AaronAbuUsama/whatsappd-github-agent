/** Group JIDs end in `@g.us`; DM JIDs end in `@s.whatsapp.net`. Case-insensitive: the Surface registry
 *  lowercases every chat id, so a group JID must be detected regardless of casing (else a `Group@G.US`
 *  slips past the DM-path group guard and gets opened as a direct binding). */
export const isGroupJid = (chatId: string): boolean => chatId.toLowerCase().endsWith("@g.us");
