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
import { type IncomingMessage as WaMessage, type WhatsAppSession } from "whatsappd";
import { getLogger } from "../logging/logging.ts";
import type { IncomingMessage } from "./events.ts";
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
 * Trace one inbound message as it arrives off the wire, with why-it-was-ignored
 * tags. Debug level only — message bodies never reach default output (ADR 0016).
 */
const logInbound = (msg: WaMessage, allowed: boolean): void => {
  const tags = [
    msg.fromMe ? "self" : null,
    !msg.live ? "history" : null,
    !allowed ? "ignored" : null,
    msg.context?.quoted ? "quote" : null,
  ].filter(Boolean);
  getLogger("whatsapp").debug(
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
  readonly replay: () => readonly IncomingMessage[];
  readonly accepted: (message: WaMessage) => IncomingMessage | undefined;
}

/**
 * EventSource over `session.onMessage`. Messages are pushed onto an unbounded
 * queue (WhatsApp's inbound rate is low) and surfaced as a Stream; `allow` gates
 * which chats reach the loop before Ambience dispatch. The listener is
 * removed on scope close.
 */
export const whatsappEventSource = (
  session: WhatsAppSession,
  allow: (chatId: string, isGroup: boolean) => boolean,
  durable?: DurableWhatsAppIntake,
): Layer.Layer<EventSource, never> =>
  Layer.effect(
    EventSource,
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<IncomingMessage>();
      const unsub = session.onMessage((msg) => {
        const allowed = allow(msg.chatId, msg.isGroup);
        logInbound(msg, allowed);
        if (!allowed) return;
        const incoming = durable === undefined ? toIncoming(msg) : durable.accepted(msg);
        if (incoming === undefined) return;
        // Unbounded offer never suspends; the unsafe API preserves callback arrival order.
        Queue.offerUnsafe(queue, incoming);
      });
      yield* Effect.addFinalizer(() => Effect.sync(() => unsub()));
      const replay = durable?.replay() ?? [];
      const replayOverlap = new Set(replay.map((message) => `${message.chatId}\u0000${message.id}`));
      const isNotReplayOverlap = (message: IncomingMessage): boolean => {
        const key = `${message.chatId}\u0000${message.id}`;
        return !replayOverlap.delete(key);
      };
      return {
        events: Stream.concat(
          Stream.fromIterable(replay),
          Stream.fromQueue(queue).pipe(Stream.filter(isNotReplayOverlap)),
        ),
      };
    }),
  );
