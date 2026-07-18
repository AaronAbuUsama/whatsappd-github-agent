import type {
  ConversationEdit,
  ConversationReaction,
  ConversationRevocation,
} from "../intake/conversation-event.ts";

/**
 * The Coalescer's inbound message shape.
 *
 * This mirrors — deliberately, field for field — the *full-fidelity* event
 * whatsappd emits in-process from `WhatsAppSession.onMessage`. The production
 * mapper in `whatsapp.ts` flattens that message into this application record
 * into one record and keep the two addressing fields — `context.mentions` and
 * `context.quoted` (`update-Bi5ZPUjP.d.mts:14-22`). Those are the immediate-fire
 * signal, so the production mapper retains them without an intermediate wire format.
 */

/** One inbound WhatsApp message, flattened from `{ref, message}`. */
export interface IncomingMessage {
  readonly id: string;
  /** JID: `xxx@g.us` (group) or `xxx@s.whatsapp.net` (DM). */
  readonly chatId: string;
  /** Sender JID (equals `chatId` for DMs, participant JID for groups). */
  readonly from: string;
  /** WhatsApp display name (proto `pushName`), when present. */
  readonly pushName?: string;
  /** Plain-text body; `""` for non-text kinds (mirrors the channel's `textOf`). */
  readonly text: string;
  /**
   * Epoch **milliseconds**. The real adapter multiplies `InboundMessage.timestamp`
   * (proto seconds) by 1000; we standardise on ms so buffer-age math is in one unit.
   */
  readonly timestamp: number;
  readonly isGroup: boolean;
  /** The bot's own messages — filtered out before the loop ever sees them. */
  readonly fromMe: boolean;
  /** `false` = history backfill (`messages.upsert` "append") — filtered out. */
  readonly live: boolean;
  /** `context.mentions ?? []` — the @-mention JIDs on this message. */
  readonly mentions: readonly string[];
  /** `context.quoted?.from` — the JID of the sender being quote-replied. */
  readonly quotedFrom?: string;
}

export type ConversationUpdate = ConversationEdit | ConversationReaction | ConversationRevocation;
export type CoalescerEvent = IncomingMessage | ConversationUpdate;

export const isConversationUpdate = (event: CoalescerEvent): event is ConversationUpdate => "kind" in event;

/** The `conversation_events`/`managed_chat_inbox` identity of a Coalescer event. */
export const coalescerEventId = (event: CoalescerEvent): string =>
  isConversationUpdate(event) ? event.id : `arrival:${event.chatId}:${event.id}`;

/** Why the Coalescer fired: an ambient burst settled, or the bot was addressed. */
export type FireReason = "debounce" | "maximum-wait" | "capacity" | "mention" | "quote-reply";

/**
 * The window dispatched to Speaker on each flush: messages and updates buffered
 * since the last dispatch, plus why it fired. This is the Coalescer's entire output.
 */
export interface ConversationWindow {
  readonly id: string;
  readonly chatId: string;
  readonly messages: readonly IncomingMessage[];
  readonly updates: readonly ConversationUpdate[];
  readonly reason: FireReason;
}

export type ConversationWindowDraft = Omit<ConversationWindow, "id">;

export const windowContents = (
  events: readonly CoalescerEvent[],
): Pick<ConversationWindow, "messages" | "updates"> => ({
  messages: events.filter((event): event is IncomingMessage => !isConversationUpdate(event)),
  updates: events.filter(isConversationUpdate),
});

/**
 * Does this message directly address the bot — an @-mention or a quote-reply of
 * one of the bot's messages? This is the *only* condition that skips the
 * debounce and fires immediately. It needs the high-fidelity `mentions` /
 * `quotedFrom` fields. `botIds` is the set of JIDs that
 * mean "the bot" (phone-number and/or `@lid` form) — a match on any one counts.
 */
export const addressesBot = (msg: IncomingMessage, botIds: readonly string[]): boolean =>
  msg.mentions.some((jid) => botIds.includes(jid)) || (msg.quotedFrom !== undefined && botIds.includes(msg.quotedFrom));

/** The fire reason for an addressing message (mention takes precedence over quote). */
export const reasonOf = (msg: IncomingMessage, botIds: readonly string[]): FireReason =>
  msg.mentions.some((jid) => botIds.includes(jid)) ? "mention" : "quote-reply";
