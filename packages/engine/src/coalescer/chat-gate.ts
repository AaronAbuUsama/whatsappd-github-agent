/**
 * The chat gate — which chats the bot is allowed to engage — shared by every
 * production whatsappd runtime so the fail-closed policy lives in one place: an
 * unset target silences Speaker rather than dispatching every chat on the account.
 * Speaker may engage on relevance (not just mentions), so this gate is a real
 * access-control decision applied before any message reaches the Coalescer.
 */

export interface ChatGate {
  /** Whether a chat may reach the loop. */
  readonly allowed: (chatId: string, isGroup: boolean) => boolean;
  /** Whether any target is configured at all (false ⇒ the bot stays fully silent). */
  readonly hasTarget: boolean;
  /** Human-readable one-liner of what's being watched, for the startup log. */
  readonly describe: () => string;
  /**
   * Live-reload the managed set in place (#179). The internal Set is mutated, not replaced, so every
   * captured `allowed` predicate the Coalescer and inbox already hold reads the new targets — adding
   * a chat engages the gate with no restart and no re-wiring.
   */
  readonly reload: (chatIds: readonly string[]) => void;
}

/** Typed managed configuration: exact group or direct-chat JIDs, with no broad DM escape hatch. */
export const makeManagedChatGate = (chatIds: readonly string[]): ChatGate => {
  const managed = new Set<string>();
  const load = (ids: readonly string[]): void => {
    managed.clear();
    for (const id of ids) {
      const normalized = id.trim().toLowerCase();
      if (normalized) managed.add(normalized);
    }
  };
  load(chatIds);
  return {
    allowed: (chatId) => managed.has(chatId.toLowerCase()),
    // A getter, not a captured boolean: the fail-closed "no target" state must track live reloads too.
    get hasTarget() {
      return managed.size > 0;
    },
    describe: () => (managed.size > 0 ? [...managed].join(", ") : "nothing"),
    reload: (ids) => load(ids),
  };
};
