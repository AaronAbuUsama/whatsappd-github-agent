/**
 * The doorway voice — the `Conversationalist` that fires the Coalescer's window
 * into the real Eve voice session over the loopback doorway (issue #6, building
 * on #4's proven `eve/client` loopback and #5's config).
 *
 * This is the ONLY thing that changes on the fire path: it drops in behind the
 * existing `Conversationalist` port, so the Coalescer / buffer / config / events
 * / ports / whatsapp seams stay byte-for-byte unchanged. Where the hand-rolled
 * `aiVoice` (voice.ts) ran its own `streamText` tool loop, the doorway voice
 * hands the window to the Eve agent through its HTTP front door and lets Eve run
 * the loop, own the durable per-chat session, and compact.
 *
 * Two design decisions carry this file:
 *
 *  1. **Resume by `SessionState`, not by `chatId` alone (the #4 correction).**
 *     `eve/client` mints a fresh, memoryless session for a bare `chatId` on every
 *     cold call — resume is keyed by the persisted `SessionState` (which carries
 *     the `sessionId`). So the gateway holds a `chatId → SessionState` store and
 *     rebuilds the session from it each turn, capturing `session.state` afterward
 *     so the next turn resumes the *same* session (spike strategy 2 — proven to
 *     carry memory). `SessionStore` is an interface; an in-memory `Map` serves
 *     issue #6, and #8 swaps in the durable SQLite store with no caller change.
 *
 *  2. **`say`-only delivery, by construction (decision G5).** The voice is a
 *     participant, not a reply-bot: its final model text is private working
 *     memory. The gateway delivers ONLY the `say` tool-call inputs it harvests
 *     from the turn's events; the assistant prose (`result.message`) is never
 *     touched for delivery. Silence needs no machinery — the model calls no `say`,
 *     `harvestSays` returns nothing, and the group hears nothing. This makes
 *     "assistant prose leaked / nothing said" impossible at the delivery seam,
 *     not merely discouraged by the prompt.
 */
import { Effect, Layer } from "effect";
import type { Client, HandleMessageStreamEvent, MessageResult, SessionState } from "eve/client";
import type { ConversationWindow, FireReason } from "./events.ts";
import { Conversationalist, ConversationError, Outbound } from "./ports.ts";

/**
 * Per-chat resume cursor: `chatId → SessionState`. Holding the `SessionState`
 * (not a bare token) is what makes resume actually resume — see the file header.
 * The in-memory implementation remains useful to tests and standalone callers;
 * the gateway injects #8's SQLite-backed store so sessions survive a restart,
 * without the doorway voice changing.
 *
 * Deliberately a plain injected interface, NOT a Coalescer `Context.Tag` port
 * (contrast `ports.ts`): `SessionStore` and `VoiceModel` are internal to how the
 * voice is *constructed*, not seams the Coalescer itself depends on — the Coalescer
 * still sees only the `Conversationalist`/`Outbound` tags. Constructor injection is
 * already the swap seam (#9 passes a durable impl; the harness passes a scripted
 * `VoiceModel`), so a tag/Layer would add wiring without buying more.
 */
export interface SessionStore {
  /** The resume cursor for a chat, or `undefined` for a chat we've never woken. */
  readonly get: (chatId: string) => SessionState | undefined;
  /** Persist the latest cursor (captured from `session.state` after each turn). */
  readonly set: (chatId: string, state: SessionState) => void;
  /** Serialize the full read -> turn -> write cycle for one chat. */
  readonly runExclusive: <T>(chatId: string, task: () => Promise<T>) => Promise<T>;
}

export const keyedSessionLock = () => {
  const tails = new Map<string, Promise<void>>();
  return async <T>(chatId: string, task: () => Promise<T>): Promise<T> => {
    const previous = tails.get(chatId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    tails.set(chatId, tail);
    await previous;
    try {
      return await task();
    } finally {
      release();
      if (tails.get(chatId) === tail) tails.delete(chatId);
    }
  };
};

/** In-memory `chatId → SessionState` store for tests and non-gateway callers. */
export const memorySessionStore = (): SessionStore => {
  const states = new Map<string, SessionState>();
  const runExclusive = keyedSessionLock();
  return {
    get: (chatId) => states.get(chatId),
    set: (chatId, state) => {
      states.set(chatId, state);
    },
    runExclusive,
  };
};

/**
 * Pull every `say` line out of a turn's event stream, in call order. This is the
 * whole say-only contract: we read the model's `say` tool-call *inputs* (not its
 * prose) and nothing else becomes group output.
 *
 * Tool calls can arrive incrementally across `actions.requested` events and must
 * be correlated by `callId` (per eve's protocol note), so we group by `callId` and
 * keep the LATEST non-empty `input.text` for each — a growing/streamed input must
 * not let an early partial win over the complete line. Delivery order is first-seen.
 */
export const harvestSays = (events: readonly HandleMessageStreamEvent[]): readonly string[] => {
  const order: string[] = [];
  const textByCall = new Map<string, string>();
  for (const event of events) {
    if (event.type !== "actions.requested") continue;
    for (const action of event.data.actions) {
      if (action.kind !== "tool-call" || action.toolName !== "say") continue;
      const text = action.input["text"];
      if (typeof text !== "string" || text.length === 0) continue;
      if (!textByCall.has(action.callId)) order.push(action.callId);
      textByCall.set(action.callId, text); // last complete input wins
    }
  }
  return order.map((callId) => textByCall.get(callId)!);
};

/** The part of an Eve turn the doorway voice consumes. `message` (the private prose) is
 * carried deliberately so it's visible that we hold it and still never deliver it. */
export interface VoiceTurnResult {
  readonly events: readonly HandleMessageStreamEvent[];
  /** The model's final prose — private working memory; NEVER delivered to the group. */
  readonly message?: string;
  readonly status: MessageResult["status"];
}

/**
 * The seam between the doorway voice and the Eve server. The real implementation
 * (`eveVoiceModel`) is the loopback `eve/client`; tests inject a scripted one to
 * drive the say-only contract without a live server.
 */
export interface VoiceModel {
  readonly turn: (
    chatId: string,
    message: string,
    reason: FireReason,
    signal?: AbortSignal,
  ) => Promise<VoiceTurnResult>;
}

/** One line telling the model why it woke — ephemeral per-turn context, not persisted. */
const noteFor = (reason: FireReason): string =>
  reason === "mention"
    ? "You were just @-mentioned — respond now."
    : reason === "quote-reply"
      ? "Someone just replied to one of your messages — respond now."
      : "No one addressed you directly — say something only if you can genuinely help; otherwise stay silent.";

/**
 * The real voice model: open-or-resume this chat's durable Eve session over the
 * loopback doorway, send the window, and — critically — capture `session.state`
 * so the next turn resumes the SAME session (the #4 finding). The reason rides in
 * `clientContext` (ephemeral, not written to session history).
 */
export const eveVoiceModel = (client: Client, store: SessionStore): VoiceModel => ({
  turn: (chatId, message, reason, signal) =>
    store.runExclusive(chatId, async () => {
      const session = client.session(store.get(chatId));
      const response = await session.send({ message, clientContext: noteFor(reason), signal });
      // A newly-created session receives its id as soon as the POST returns,
      // before its tool-call stream is consumed. Bind it now so tools can
      // securely resolve ctx.session.id -> chatId even on the first turn.
      store.set(chatId, {
        ...session.state,
        sessionId: response.sessionId ?? session.state.sessionId,
        continuationToken: response.continuationToken ?? session.state.continuationToken,
      });
      const result = await response.result();
      // Persist the resume cursor (now carrying the sessionId) BEFORE returning, so a
      // memoryless fresh session can never be minted for this chat on the next turn.
      const bound = store.get(chatId);
      store.set(chatId, {
        ...bound,
        ...session.state,
        sessionId: session.state.sessionId ?? bound?.sessionId,
      });
      return { events: result.events, message: result.message, status: result.status };
    }),
});

/** Render a buffered window as the turn's user message: one `sender: text` line per message. */
const renderWindow = (window: ConversationWindow): string =>
  window.messages.map((m) => `${m.pushName ?? m.from}: ${m.text}`).join("\n");

/**
 * The doorway voice as a `Conversationalist` Layer. Depends only on `Outbound`
 * (the group surface) and the injected `VoiceModel` — never on Eve directly, so
 * it stays swappable and testable. A turn: render the window → run the Eve turn
 * over the doorway → deliver ONLY the harvested `say` lines. A failed turn
 * becomes a `ConversationError`, which the Coalescer already swallows-and-logs so
 * one bad turn can't wedge the chat.
 */
export const doorwayVoice = (model: VoiceModel): Layer.Layer<Conversationalist, never, Outbound> =>
  Layer.effect(
    Conversationalist,
    Effect.gen(function* () {
      const outbound = yield* Outbound;
      return {
        turn: (window: ConversationWindow) =>
          Effect.gen(function* () {
            const chatId = window.chatId;
            const addressed = window.reason !== "debounce";
            yield* Effect.logInfo(
              `🗣️  voice turn — ${addressed ? `addressed (${window.reason})` : "ambient"}, ${window.messages.length} msg → ${chatId}`,
            );

            const result = yield* Effect.tryPromise({
              try: (signal) => model.turn(chatId, renderWindow(window), window.reason, signal),
              catch: (cause) => new ConversationError({ cause }),
              // Log the real cause loudly; the Effect logger carries it as structured context.
            }).pipe(Effect.tapError((err) => Effect.logError(`❌ voice turn failed → ${chatId}`, err.cause)));

            // Deliver ONLY what the model chose to `say`. Its prose (result.message) is
            // deliberately never delivered — say is the sole channel to the group.
            const says = harvestSays(result.events);
            for (const text of says) {
              yield* outbound.reply(chatId, text);
            }
            yield* Effect.logInfo(
              `${says.length > 0 ? `💬 said ${says.length}` : "🤫 chose to stay silent"} → ${chatId}`,
            );
          }),
      };
    }),
  );
