/**
 * The chat gate — which chats the bot is allowed to engage — shared by every
 * production whatsappd runtime so the fail-closed policy lives in one place: an
 * unset target silences Ambience rather than admitting every chat on the account.
 * Ambience may engage on relevance (not just mentions), so this gate is a real
 * access-control decision applied before any message reaches the Coalescer.
 */

/** The raw env strings the gate reads (kept as strings so callers pass `process.env.*` directly). */
export interface ChatGateEnv {
  /** Comma-separated group JIDs (`WHATSAPP_GROUP_IDS` or the singular `WHATSAPP_GROUP_ID`). */
  readonly groupIds?: string;
  /** `"true"` to accept ANY group when no allow-list is set (not recommended). */
  readonly allowAnyGroup?: string;
  /** `"true"` to also respond to DMs (handy for solo testing pre-group). */
  readonly allowDm?: string;
}

export interface ChatGate {
  /** Whether a chat may reach the loop. */
  readonly allowed: (chatId: string, isGroup: boolean) => boolean;
  /** Whether any target is configured at all (false ⇒ the bot stays fully silent). */
  readonly hasTarget: boolean;
  /** Human-readable one-liner of what's being watched, for the startup log. */
  readonly describe: () => string;
}

/** Comma-separated env value → a Set of trimmed, lower-cased entries. */
const parseSet = (raw: string | undefined): ReadonlySet<string> =>
  new Set((raw ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));

/** Build a chat gate from env. Fail closed: nothing configured ⇒ nothing allowed. */
export const makeChatGate = (env: ChatGateEnv): ChatGate => {
  const groups = parseSet(env.groupIds);
  const allowAnyGroup = env.allowAnyGroup === "true";
  const allowDm = env.allowDm === "true";
  return {
    allowed: (chatId, isGroup) =>
      isGroup ? (groups.size > 0 ? groups.has(chatId.toLowerCase()) : allowAnyGroup) : allowDm,
    hasTarget: groups.size > 0 || allowAnyGroup || allowDm,
    describe: () =>
      groups.size > 0 ? [...groups].join(", ") : allowAnyGroup ? "any group" : allowDm ? "DMs" : "nothing",
  };
};
