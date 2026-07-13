/**
 * The real WhatsApp seams (Rung 2) — `EventSource` + `Outbound` over an
 * in-process whatsappd session, plus the session bootstrap.
 *
 * Why in-process (not the HTTP sidecar in src/index.ts): the sidecar's wire
 * format drops `contextInfo.mentionedJid` / quoted, but `addressesBot` needs
 * them. whatsappd's `session.onMessage` keeps the full `context`, which
 * `events.ts` mirrors field-for-field — so this mapper is a straight copy.
 *
 * These Layers just swap in behind the same `EventSource`/`Outbound` ports the
 * mocks satisfy; the Coalescer and voice don't change. The session is created
 * as a scoped resource: it's stopped and unsubscribed when the scope closes.
 */
import { createRequire } from "node:module";
import { Data, Effect, Layer, Queue, Runtime, type Scope, Stream } from "effect";
import {
  createSession,
  fileStore,
  type IncomingMessage as WaMessage,
  isOnline,
  isTerminal,
  qrAuth,
  type WhatsAppSession,
} from "whatsappd";
import type { IncomingMessage } from "./events.ts";
import { EventSource, Outbound } from "./ports.ts";

// qrcode-terminal ships no types and is a transitive dep of whatsappd; require it
// so a first-run pairing prints a scannable QR without adding a typed import.
const qr = createRequire(import.meta.url)("qrcode-terminal") as {
  generate(text: string, opts?: { small?: boolean }): void;
};

export class WhatsAppError extends Data.TaggedError("WhatsAppError")<{ readonly cause: unknown }> {}

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

/** `HH:MM:SS` for readable traffic logs. */
const stamp = (): string => new Date().toTimeString().slice(0, 8);

/** Log one inbound message as it arrives off the wire, with why-it-was-ignored tags. */
const logInbound = (msg: WaMessage, allowed: boolean): void => {
  const tags = [
    msg.fromMe ? "self" : null,
    !msg.live ? "history" : null,
    !allowed ? "ignored" : null,
    msg.context?.quoted ? "quote" : null,
  ].filter(Boolean);
  const who = msg.pushName ?? msg.from;
  // Show raw mention JIDs so a mention-that-should-address-the-bot but doesn't is visible.
  const mentions = msg.context?.mentions?.length ? `  mentions=${JSON.stringify(msg.context.mentions)}` : "";
  console.log(
    `[${stamp()}] 📥 ${who} in ${msg.chatId}: ${JSON.stringify(textOf(msg))}${tags.length ? `  [${tags.join(",")}]` : ""}${mentions}`,
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
 * Create the session, connect, and resolve once it's genuinely online (so
 * `identity()` is readable). Prints a QR on first-run pairing; fails if the
 * connection reaches a terminal state (e.g. logged out) without coming online.
 * Scoped: the session is stopped and its listener removed on scope close.
 */
export interface SessionPreparation {
  readonly session: WhatsAppSession;
  readonly finalize?: () => void;
}

export const openSession = (
  storeDir: string,
  prepare: (session: WhatsAppSession) => SessionPreparation = (session) => ({ session }),
): Effect.Effect<WhatsAppSession, WhatsAppError, Scope.Scope> =>
  Effect.gen(function* () {
    // Preparation runs while the session is inert. The gateway uses this hook
    // to subscribe durable history capture before start() emits initial sync.
    const prepared = prepare(createSession({ store: fileStore(storeDir), auth: qrAuth() }));
    const session = prepared.session;
    if (prepared.finalize !== undefined) yield* Effect.addFinalizer(() => Effect.sync(prepared.finalize!));
    yield* Effect.addFinalizer(() => Effect.promise(() => session.stop()).pipe(Effect.ignore));

    // Log status transitions + render a QR on first-run pairing, for the session's lifetime.
    const logUnsub = session.onStatus((status) => {
      if (
        status.phase === "pairing" &&
        status.pairing.step === "challenge_live" &&
        status.pairing.method === "qr" &&
        status.pairing.qr
      ) {
        console.log("\n📱 Link a device: WhatsApp → Settings → Linked devices → Link a device, then scan:\n");
        qr.generate(status.pairing.qr, { small: true });
      } else {
        console.log(`[wa] ${status.phase}`);
      }
    });
    yield* Effect.addFinalizer(() => Effect.sync(() => logUnsub()));

    // Connect and settle once genuinely online (so identity() is readable), or fail
    // on a terminal status. start() is fired here, NOT awaited separately — it doesn't
    // resolve until well after online, so we settle on the status callback instead.
    yield* Effect.async<void, WhatsAppError>((resume) => {
      const unsub = session.onStatus((status) => {
        if (isOnline(status)) {
          unsub();
          resume(Effect.void);
        } else if (isTerminal(status)) {
          unsub();
          resume(Effect.fail(new WhatsAppError({ cause: `connection ${status.phase}` })));
        }
      });
      session.start().catch((cause: unknown) => {
        unsub();
        resume(Effect.fail(new WhatsAppError({ cause })));
      });
      return Effect.sync(() => unsub());
    });

    return session;
  });

/**
 * The connected account's own JID — the botId `addressesBot` matches against.
 * `identity().jid` carries a `:<device>` suffix (e.g. `2294…:16@s.whatsapp.net`)
 * that WhatsApp @-mention JIDs do NOT, so strip it or mentions never match.
 */
export const botIdOf = (session: WhatsAppSession): string =>
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

/**
 * EventSource over `session.onMessage`. Messages are pushed onto an unbounded
 * queue (WhatsApp's inbound rate is low) and surfaced as a Stream; `allow` gates
 * which chats reach the loop, since the voice replies for real. The listener is
 * removed on scope close.
 */
export const whatsappEventSource = (
  session: WhatsAppSession,
  allow: (chatId: string, isGroup: boolean) => boolean,
): Layer.Layer<EventSource> =>
  Layer.scoped(
    EventSource,
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<IncomingMessage>();
      const runtime = yield* Effect.runtime<never>();
      const unsub = session.onMessage((msg) => {
        const allowed = allow(msg.chatId, msg.isGroup);
        logInbound(msg, allowed);
        if (!allowed) return;
        // Unbounded offer never suspends, so runSync keeps arrival order.
        Runtime.runSync(runtime)(Queue.offer(queue, toIncoming(msg)));
      });
      yield* Effect.addFinalizer(() => Effect.sync(() => unsub()));
      return { events: Stream.fromQueue(queue) };
    }),
  );

/** Outbound over `session.send` / `session.setTyping`. Send/typing failures are
 * logged, not raised — a dropped reply must not wedge the chat's loop. */
export const whatsappOutbound = (session: WhatsAppSession): Layer.Layer<Outbound> =>
  Layer.succeed(Outbound, {
    reply: (chatId, text) =>
      Effect.sync(() => console.log(`[${stamp()}] 📤 → ${chatId}: ${JSON.stringify(text)}`)).pipe(
        Effect.zipRight(Effect.tryPromise(() => session.send(chatId, { text }))),
        Effect.asVoid,
        Effect.catchAll((cause) => Effect.sync(() => console.error(`[${stamp()}] ⚠️  send failed → ${chatId}: ${String(cause)}`))),
      ),
    setTyping: (chatId, on) =>
      Effect.tryPromise(() => session.setTyping(chatId, on)).pipe(
        Effect.tap(() => Effect.sync(() => console.log(`[${stamp()}] ⌨️  typing ${on ? "on" : "off"} — ${chatId}`))),
        Effect.ignore,
      ),
  });
