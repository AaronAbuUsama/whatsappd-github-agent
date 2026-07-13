/**
 * The Coalescer — the timing layer with no model.
 *
 * One actor fiber per `chatId`, each draining its own `Queue<IncomingMessage>`.
 * The flush rule is a throttle with a settle window: "take the next message, but
 * give up after `min(debounceWindow, timeLeftUntilCap)`" (`Queue.take` raced
 * against a virtual sleep via `timeoutOption`). The `debounceWindow` leg restarts
 * every iteration — "one settle timer that resets on each new message" — so light
 * traffic fires ~one window later and a burst coalesces into one fire at its end.
 * The `maxWait` cap is measured from the burst's first message and does NOT reset,
 * so a nonstop chat still fires roughly every `maxWait` instead of being starved
 * forever by a perpetually-resetting timer. An @-mention / quote-reply of the bot
 * skips the wait and flushes immediately. See `docs/COALESCER-DESIGN.md` §2.
 *
 * Everything time-based routes through the Effect `Clock`, so under `TestClock`
 * the whole thing runs in virtual time with zero real sleeps.
 */
import { Clock, Context, Duration, Effect, HashMap, Option, Queue, Ref, type Scope, Stream } from "effect";
import { appendBounded, type BufferBounds } from "./buffer.ts";
import { addressesBot, type ConversationWindow, type FireReason, type IncomingMessage, reasonOf } from "./events.ts";
import { CoalescerConfig, type CoalescerConfigValues } from "./config.ts";
import { AmbienceDoorway, EventSource } from "./ports.ts";

type AmbienceDoorwayService = Context.Tag.Service<typeof AmbienceDoorway>;

/**
 * Admit the buffered window to Ambience. A failed admission must not kill the
 * chat's actor loop — one bad input should never wedge the chat. We swallow-and-log
 * both typed failures (`catchAll`) *and* defects (`catchAllDefect`, e.g. an
 * admission implementation throwing), but deliberately let interruption through
 * untouched so scope shutdown still tears the loop down cleanly. Empty windows
 * never fire (a config edge, e.g. `maxBufferMessages: 0`) — there is nothing to say.
 */
const logAdmissionError = (window: ConversationWindow) => (cause: unknown) =>
  Effect.logError(`Ambience admission failed for ${window.chatId}`).pipe(
    Effect.annotateLogs({ cause: String(cause) }),
  );

const fire = (
  doorway: AmbienceDoorwayService,
  window: ConversationWindow,
): Effect.Effect<void> =>
  window.messages.length === 0
    ? Effect.void
    : doorway.admit(window).pipe(
        Effect.catchAll(logAdmissionError(window)),
        Effect.catchAllDefect(logAdmissionError(window)),
      );

/**
 * Build the per-chat actor loop for a given config + Ambience doorway. Returns a function
 * that, given a chat's queue, runs its debounce loop forever.
 */
const makeChatLoop = (config: CoalescerConfigValues, doorway: AmbienceDoorwayService) => {
  const bounds: BufferBounds = {
    maxBufferMessages: config.maxBufferMessages,
    maxBufferAgeMillis: config.maxBufferAgeMillis,
  };
  const maxWaitMillis = Duration.toMillis(config.maxWait);

  return (chatId: string, queue: Queue.Dequeue<IncomingMessage>): Effect.Effect<never> => {
    // Admit the buffered window to Ambience, then go cold for the next burst.
    const fireAndReset = (messages: readonly IncomingMessage[], reason: FireReason): Effect.Effect<never> =>
      fire(doorway, { chatId, messages, reason }).pipe(Effect.zipRight(cold));

    // A message landed: buffer it, and either flush now (bot addressed) or keep
    // waiting. `burstStart` is the clock time of the burst's first message — the
    // cap is measured from it and carried unchanged through the whole burst.
    const onMessage = (
      buffer: readonly IncomingMessage[],
      burstStart: number,
      msg: IncomingMessage,
    ): Effect.Effect<never> => {
      const next = appendBounded(buffer, msg, bounds);
      return addressesBot(msg, config.botIds)
        ? fireAndReset(next, reasonOf(msg, config.botIds))
        : warm(next, burstStart);
    };

    // Cold: no buffered messages. Block indefinitely for the burst's first message,
    // stamping `burstStart` from the clock the instant it arrives.
    const cold: Effect.Effect<never> = Queue.take(queue).pipe(
      Effect.flatMap((msg) => Clock.currentTimeMillis.pipe(Effect.flatMap((now) => onMessage([], now, msg)))),
    );

    // Warm: a burst is accumulating. Wait for the next message, but give up when the
    // chat goes quiet (`debounceWindow`) OR the cap elapses (`maxWait` since
    // `burstStart`), whichever comes first — then fire and start a fresh burst.
    const warm = (buffer: readonly IncomingMessage[], burstStart: number): Effect.Effect<never> =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) => {
          const capLeft = Math.max(0, burstStart + maxWaitMillis - now);
          const wait = Duration.min(config.debounceWindow, Duration.millis(capLeft));
          return Queue.take(queue).pipe(
            Effect.timeoutOption(wait),
            Effect.flatMap(
              Option.match({
                onNone: () => fireAndReset(buffer, "debounce"),
                onSome: (msg) => onMessage(buffer, burstStart, msg),
              }),
            ),
          );
        }),
      );

    return cold;
  };
};

/**
 * Run the Coalescer: drain the inbound stream, route each message to its chat's
 * actor (lazily creating the queue + fiber on first sight of a `chatId`), and
 * let each actor's debounce loop decide when to admit a window to Ambience.
 *
 * Blocks until the source stream ends, so callers fork it. Chat-actor fibers are
 * `forkScoped` — they live until the enclosing `Scope` closes, giving clean
 * shutdown. The router drains sequentially, so lazy queue creation never races.
 */
export const run: Effect.Effect<
  void,
  never,
  EventSource | AmbienceDoorway | CoalescerConfig | Scope.Scope
> = Effect.gen(function* () {
  const { events } = yield* EventSource;
  const config = yield* CoalescerConfig;
  const doorway = yield* AmbienceDoorway;
  const chatLoop = makeChatLoop(config, doorway);
  const registry = yield* Ref.make(HashMap.empty<string, Queue.Queue<IncomingMessage>>());

  const routeTo = (msg: IncomingMessage): Effect.Effect<void, never, Scope.Scope> =>
    Effect.gen(function* () {
      const existing = HashMap.get(yield* Ref.get(registry), msg.chatId);
      if (Option.isSome(existing)) {
        yield* Queue.offer(existing.value, msg);
        return;
      }
      const queue = yield* Queue.unbounded<IncomingMessage>();
      yield* Ref.update(registry, HashMap.set(msg.chatId, queue));
      yield* Effect.forkScoped(chatLoop(msg.chatId, queue));
      yield* Queue.offer(queue, msg);
    });

  yield* events.pipe(
    // fromMe = the bot's own messages; live=false = history backfill. Neither drives the loop.
    Stream.filter((m) => m.live && !m.fromMe),
    Stream.runForEach(routeTo),
  );
});
