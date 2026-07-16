/**
 * The real WhatsApp event source over an in-process whatsappd session.
 *
 * The in-process subscription retains `contextInfo.mentionedJid` and quoted
 * metadata needed by `addressesBot`.
 *
 * The event source swaps in behind the same port the timing tests satisfy. The
 * session is a scoped resource: it is stopped and unsubscribed on scope close.
 */
import { Effect, Layer, Queue, Stream } from "effect";
import { type IncomingMessage as WaMessage, type Update, type WhatsAppSession } from "whatsappd";
import { conversationUpdate } from "../intake/conversation-event.ts";
import { getLogger } from "../logging/logging.ts";
import {
  type CoalescerEvent,
  type ConversationUpdate,
  type IncomingMessage,
  isConversationUpdate,
} from "./events.ts";
import { EventSource } from "./ports.ts";

/** Plain-text body of an inbound message (media captions included; non-text → ""). */
const textOf = (msg: WaMessage): string => {
  switch (msg.kind) {
    case "text":
      return msg.text;
    case "image":
    case "video":
    case "audio":
    case "document":
    case "sticker":
      return msg.text ?? "";
    default:
      return "";
  }
};

/**
 * Report live accepted human messages to the operator feed. Self, history, and
 * ignored traffic remains debug-only diagnostics so the normal feed has no
 * duplicate Say echoes or replay noise (ADR 0016).
 */
const logInbound = (msg: WaMessage, allowed: boolean, accepted: boolean): void => {
  const log = getLogger("whatsapp");
  if (accepted && msg.live && !msg.fromMe) {
    log.info(
      {
        operatorEvent: "chat.received",
        actor: msg.pushName?.trim() || msg.from,
        text: textOf(msg) || `[${msg.kind}]`,
        chatId: msg.chatId,
        messageId: msg.id,
      },
      "Managed chat message received",
    );
    return;
  }
  const tags = [
    msg.fromMe ? "self" : null,
    !msg.live ? "history" : null,
    !allowed ? "ignored" : null,
    allowed && !accepted ? "duplicate" : null,
    msg.context?.quoted ? "quote" : null,
  ].filter(Boolean);
  log.debug(
    {
      chatId: msg.chatId,
      from: msg.pushName ?? msg.from,
      ...(tags.length === 0 ? {} : { tags }),
      // Raw mention JIDs so a mention-that-should-address-the-bot but doesn't is visible.
      ...(msg.context?.mentions?.length ? { mentions: msg.context.mentions } : {}),
      text: textOf(msg),
    },
    "Inbound WhatsApp message",
  );
};

/** whatsappd's inbound shape → the Coalescer's IncomingMessage (timestamp is already ms). */
const toIncoming = (msg: WaMessage): IncomingMessage => ({
  id: msg.id,
  chatId: msg.chatId,
  from: msg.from,
  pushName: msg.pushName,
  text: textOf(msg),
  timestamp: msg.timestamp,
  isGroup: msg.isGroup,
  fromMe: msg.fromMe,
  live: msg.live,
  mentions: msg.context?.mentions ?? [],
  quotedFrom: msg.context?.quoted?.from,
});

/**
 * The connected account's own JID — the botId `addressesBot` matches against.
 * `identity().jid` carries a `:<device>` suffix (e.g. `2294…:16@s.whatsapp.net`)
 * that WhatsApp @-mention JIDs do NOT, so strip it or mentions never match.
 */
const botIdOf = (session: WhatsAppSession): string =>
  (session.identity()?.jid ?? "unknown@s.whatsapp.net").replace(/:\d+(?=@)/, "");

/**
 * Every JID an @-mention of the bot can carry. In a LID-addressed group the mention
 * uses the bot's `@lid` identity, which `identity()` does NOT expose — so it must be
 * supplied out-of-band (env for now; auto-detection later). `rawLid` accepts a bare
 * number (we append `@lid`) or a full `NNN@lid` JID. This keeps all bot-JID shaping —
 * PN device-strip AND LID normalization — in one place, next to `botIdOf`.
 */
export const botIdsOf = (session: WhatsAppSession, rawLid?: string): readonly string[] => {
  const trimmed = rawLid?.trim();
  const lid = trimmed ? (trimmed.includes("@") ? trimmed : `${trimmed}@lid`) : undefined;
  return lid ? [botIdOf(session), lid] : [botIdOf(session)];
};

export interface DurableWhatsAppIntake {
  readonly replay: () => readonly CoalescerEvent[];
  readonly accepted: (event: CoalescerEvent) => CoalescerEvent | undefined;
}

const toUpdate = (update: Update): ConversationUpdate | undefined => {
  const event = conversationUpdate(update);
  return event.kind === "receipt" ? undefined : event;
};

const eventId = (event: CoalescerEvent): string =>
  isConversationUpdate(event) ? event.id : `arrival:${event.chatId}:${event.id}`;

/**
 * EventSource over `session.onMessage` and `session.onUpdate`. Events are pushed
 * onto an unbounded queue (WhatsApp's inbound rate is low) and surfaced as a
 * Stream; `allow` gates which chats reach the loop before Ambience dispatch.
 * Both listeners are removed on scope close.
 */
export const whatsappEventSource = (
  session: WhatsAppSession,
  allow: (chatId: string, isGroup: boolean) => boolean,
  durable?: DurableWhatsAppIntake,
): Layer.Layer<EventSource, never> =>
  Layer.effect(
    EventSource,
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<CoalescerEvent>();
      const unsubMessage = session.onMessage((msg) => {
        const allowed = allow(msg.chatId, msg.isGroup);
        if (!allowed) {
          logInbound(msg, false, false);
          return;
        }
        const mapped = toIncoming(msg);
        const incoming = durable === undefined ? mapped : durable.accepted(mapped);
        logInbound(msg, true, incoming !== undefined);
        if (incoming === undefined) return;
        // Unbounded offer never suspends; the unsafe API preserves callback arrival order.
        Queue.offerUnsafe(queue, incoming);
      });
      const unsubUpdate = session.onUpdate((raw) => {
        const update = toUpdate(raw);
        if (update === undefined || !allow(update.chatId, update.chatId.endsWith("@g.us"))) return;
        const accepted = durable === undefined ? update : durable.accepted(update);
        if (accepted !== undefined) Queue.offerUnsafe(queue, accepted);
      });
      yield* Effect.addFinalizer(() => Effect.sync(() => {
        unsubUpdate();
        unsubMessage();
      }));
      const replay = durable?.replay() ?? [];
      const replayOverlap = new Set(replay.map(eventId));
      const isNotReplayOverlap = (event: CoalescerEvent): boolean => !replayOverlap.delete(eventId(event));
      return {
        events: Stream.concat(
          Stream.fromIterable(replay),
          Stream.fromQueue(queue).pipe(Stream.filter(isNotReplayOverlap)),
        ),
      };
    }),
  );
