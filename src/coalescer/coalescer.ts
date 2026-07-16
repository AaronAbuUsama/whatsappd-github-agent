/**
 * The Coalescer — the timing layer with no model.
 *
 * One actor fiber per `chatId`, each draining its own `Queue<CoalescerEvent>`.
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
import { Clock, Duration, Effect, HashMap, Option, Queue, Ref, type Scope, Stream } from "effect";
import {
  addressesBot,
  type CoalescerEvent,
  type ConversationWindow,
  type ConversationWindowDraft,
  type FireReason,
  isConversationUpdate,
  reasonOf,
  windowContents,
} from "./events.ts";
import { CoalescerConfig, type CoalescerConfigValues } from "./config.ts";
import { EventSource, WindowDispatcher, WindowStore, type WindowStoreService } from "./ports.ts";

type WindowDispatcherService = {
  readonly dispatch: (window: ConversationWindow) => Effect.Effect<void, unknown>;
};

const continueAfterDispatchError =
  (window: ConversationWindow) =>
  (cause: unknown): Effect.Effect<void> =>
    Effect.logError(`Ambience dispatch failed for ${window.chatId}; the batch settled and the chat continues`).pipe(
      Effect.annotateLogs({ cause: String(cause), windowId: window.id }),
    );

const stopAfterStoreError =
  (chatId: string) =>
  (cause: unknown): Effect.Effect<never> =>
    Effect.logError(`Managed Chat Window persistence failed for ${chatId}; the chat is fail-stopped`).pipe(
      Effect.annotateLogs({ cause: String(cause) }),
      Effect.andThen(Effect.never),
    );

const stopAfterReplayReadError = (cause: unknown): Effect.Effect<never> =>
  Effect.logError("Managed Chat Window replay read failed; intake is fail-stopped").pipe(
    Effect.annotateLogs({ cause: String(cause) }),
    Effect.andThen(Effect.never),
  );

const fire = (dispatcher: WindowDispatcherService, window: ConversationWindow): Effect.Effect<void> =>
  window.messages.length + window.updates.length === 0
    ? Effect.void
    : dispatcher
        .dispatch(window)
        .pipe(Effect.catch(continueAfterDispatchError(window)), Effect.catchDefect(continueAfterDispatchError(window)));

/**
 * Build the per-chat actor loop for a given config + window dispatcher. Returns a function
 * that, given a chat's queue, runs its debounce loop forever.
 */
const makeChatLoop = (
  config: CoalescerConfigValues,
  dispatcher: WindowDispatcherService,
  store: WindowStoreService,
) => {
  const maxWaitMillis = Duration.toMillis(config.maxWait);
  const debounceMillis = Duration.toMillis(config.debounceWindow);
  const capacity = Math.max(1, config.maxWindowMessages);

  return (chatId: string, queue: Queue.Dequeue<CoalescerEvent>): Effect.Effect<never> => {
    // Dispatch the buffered window to Ambience, then go cold for the next burst.
    const fireAndReset = (events: readonly CoalescerEvent[], reason: FireReason): Effect.Effect<never> => {
      const draft: ConversationWindowDraft = { chatId, ...windowContents(events), reason };
      return store.create(draft).pipe(
        Effect.catch(stopAfterStoreError(chatId)),
        Effect.catchDefect(stopAfterStoreError(chatId)),
        Effect.flatMap((window) => fire(dispatcher, window)),
        Effect.andThen(cold),
      );
    };

    // An event landed: buffer it, and either flush now (bot addressed) or keep
    // waiting. `burstStart` is the clock time of the burst's first event — the
    // cap is measured from it and carried unchanged through the whole burst.
    const onEvent = (
      buffer: readonly CoalescerEvent[],
      burstStart: number,
      event: CoalescerEvent,
    ): Effect.Effect<never> => {
      const next = [...buffer, event];
      return isConversationUpdate(event)
        ? warm(next, burstStart)
        : addressesBot(event, config.botIds)
          ? fireAndReset(next, reasonOf(event, config.botIds))
          : windowContents(next).messages.length >= capacity
          ? fireAndReset(next, "capacity")
          : warm(next, burstStart);
    };

    // Cold: no buffered events. Block indefinitely for the burst's first event,
    // stamping `burstStart` from the clock the instant it arrives.
    const cold: Effect.Effect<never> = Queue.take(queue).pipe(
      Effect.flatMap((event) => Clock.currentTimeMillis.pipe(Effect.flatMap((now) => onEvent([], now, event)))),
    );

    // Warm: a burst is accumulating. Wait for the next event, but give up when the
    // chat goes quiet (`debounceWindow`) OR the cap elapses (`maxWait` since
    // `burstStart`), whichever comes first — then fire and start a fresh burst.
    const warm = (buffer: readonly CoalescerEvent[], burstStart: number): Effect.Effect<never> =>
      Clock.currentTimeMillis.pipe(
        Effect.flatMap((now) => {
          const capLeft = Math.max(0, burstStart + maxWaitMillis - now);
          const wait = Duration.min(config.debounceWindow, Duration.millis(capLeft));
          return Queue.take(queue).pipe(
            Effect.timeoutOption(wait),
            Effect.flatMap(
              Option.match({
                onNone: () => fireAndReset(buffer, capLeft <= debounceMillis ? "maximum-wait" : "debounce"),
                onSome: (event) => onEvent(buffer, burstStart, event),
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
 * let each actor's debounce loop decide when to dispatch a window to Ambience.
 *
 * Blocks until the source stream ends, so callers fork it. Chat-actor fibers are
 * `forkScoped` — they live until the enclosing `Scope` closes, giving clean
 * shutdown. The router drains sequentially, so lazy queue creation never races.
 */
export const run: Effect.Effect<
  void,
  never,
  EventSource | WindowDispatcher | WindowStore | CoalescerConfig | Scope.Scope
> = Effect.gen(function* () {
  const { events } = yield* EventSource;
  const config = yield* CoalescerConfig;
  const dispatcher = yield* WindowDispatcher;
  const store = yield* WindowStore;
  const chatLoop = makeChatLoop(config, dispatcher, store);
  const registry = yield* Ref.make(HashMap.empty<string, Queue.Queue<CoalescerEvent>>());

  const routeTo = (event: CoalescerEvent): Effect.Effect<void, never, Scope.Scope> =>
    Effect.gen(function* () {
      const existing = HashMap.get(yield* Ref.get(registry), event.chatId);
      if (Option.isSome(existing)) {
        yield* Queue.offer(existing.value, event);
        return;
      }
      const queue = yield* Queue.unbounded<CoalescerEvent>();
      yield* Ref.update(registry, HashMap.set(event.chatId, queue));
      yield* Effect.forkScoped(chatLoop(event.chatId, queue));
      yield* Queue.offer(queue, event);
    });

  const pending = yield* store.pendingWindows.pipe(
    Effect.catch(stopAfterReplayReadError),
    Effect.catchDefect(stopAfterReplayReadError),
  );
  const windowsByChat = new Map<string, ConversationWindow[]>();
  for (const window of pending) {
    const windows = windowsByChat.get(window.chatId) ?? [];
    windows.push(window);
    windowsByChat.set(window.chatId, windows);
  }

  // A failed replay logs and the chat continues with its next Window (ADR 0014).
  const replayChat = (windows: readonly ConversationWindow[], index = 0): Effect.Effect<void> => {
    const window = windows[index];
    if (window === undefined) return Effect.void;
    return fire(dispatcher, window).pipe(Effect.andThen(replayChat(windows, index + 1)));
  };

  yield* Effect.forEach(windowsByChat.values(), (windows) => replayChat(windows), {
    concurrency: "unbounded",
    discard: true,
  });

  yield* events.pipe(
    // fromMe = the bot's own messages; live=false = history backfill. Neither drives the loop.
    Stream.filter((event) => isConversationUpdate(event) || (event.live && !event.fromMe)),
    Stream.runForEach(routeTo),
  );
});
