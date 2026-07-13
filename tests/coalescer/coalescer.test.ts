/**
 * Deterministic timing tests for the Coalescer, under Effect's `TestClock` —
 * virtual time, zero real sleeps, fully reproducible.
 *
 * Why this is race-free: `TestClock.adjust` first runs `awaitSuspended`, which
 * blocks until every supervised fiber reaches a stable suspended fixed point,
 * and only then advances the clock (see `effect/dist/esm/TestClock.js:238` →
 * `run` → `awaitSuspended`). So each `adjust` waits for a freshly-offered
 * message to propagate source-queue → router → chat actor and for the actor to
 * settle into its debounce wait, before any virtual time passes. `it.scoped`
 * (from `@effect/vitest`) supplies the `TestClock` + the fiber supervisor and a
 * `Scope` for the coalescer's `forkScoped` actors.
 */
import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Layer, Queue, Ref, TestClock } from "effect";
import * as Coalescer from "../../src/coalescer/coalescer.ts";
import { type CoalescerConfigValues, configLayer } from "../../src/coalescer/config.ts";
import type { ConversationWindow, IncomingMessage } from "../../src/coalescer/events.ts";
import { queueEventSource, recordingAmbienceDoorway } from "../../src/coalescer/mocks.ts";
import { AmbienceDoorway } from "../../src/coalescer/ports.ts";

const BOT = "bot@s.whatsapp.net";
const CHAT = "team@g.us";
const WINDOW = Duration.seconds(3);

let seq = 0;
/** Build a synthetic inbound message. `text` and any field can be overridden. */
const mkMsg = (text: string, over: Partial<IncomingMessage> = {}): IncomingMessage => {
  const n = ++seq;
  return {
    id: `m${n}`,
    chatId: CHAT,
    from: "u@s.whatsapp.net",
    pushName: "U",
    text,
    timestamp: n * 1000,
    isGroup: true,
    fromMe: false,
    live: true,
    mentions: [],
    ...over,
  };
};

/** Fork the real Coalescer over a test source + recording Ambience doorway + given config. */
const startRecording = (
  source: Queue.Dequeue<IncomingMessage>,
  turns: Ref.Ref<readonly ConversationWindow[]>,
  cfg: Partial<CoalescerConfigValues> = {},
) =>
  Effect.forkScoped(
    Coalescer.run.pipe(
      Effect.provide(
        Layer.mergeAll(
          queueEventSource(source),
          recordingAmbienceDoorway(turns),
          configLayer({ botIds: [BOT], debounceWindow: WINDOW, ...cfg }),
        ),
      ),
    ),
  );

const texts = (w: ConversationWindow): readonly string[] => w.messages.map((m) => m.text);

describe("Coalescer", () => {
  it.scoped("light traffic: a lone message fires once, after the quiet window settles", () =>
    Effect.gen(function* () {
      const source = yield* Queue.unbounded<IncomingMessage>();
      const turns = yield* Ref.make<readonly ConversationWindow[]>([]);
      yield* startRecording(source, turns);

      yield* Queue.offer(source, mkMsg("hello?"));

      // Before the window elapses: nothing has fired.
      yield* TestClock.adjust(Duration.seconds(2));
      expect(yield* Ref.get(turns)).toHaveLength(0);

      // The window settles → exactly one fire, carrying just that message.
      yield* TestClock.adjust(Duration.seconds(1));
      const t = yield* Ref.get(turns);
      expect(t).toHaveLength(1);
      expect(t[0]!.reason).toBe("debounce");
      expect(texts(t[0]!)).toEqual(["hello?"]);
    }),
  );

  it.scoped("heavy traffic: a burst < window apart coalesces into ONE fire with the whole burst", () =>
    Effect.gen(function* () {
      const source = yield* Queue.unbounded<IncomingMessage>();
      const turns = yield* Ref.make<readonly ConversationWindow[]>([]);
      yield* startRecording(source, turns);

      const burst = ["a", "b", "c", "d", "e"];
      for (const text of burst) {
        yield* Queue.offer(source, mkMsg(text));
        // Each message lands 1s apart — inside the 3s window — so the timer resets
        // and nothing fires mid-burst.
        yield* TestClock.adjust(Duration.seconds(1));
        expect(yield* Ref.get(turns)).toHaveLength(0);
      }

      // Burst settles → a single fire carrying all five, in order.
      yield* TestClock.adjust(WINDOW);
      const t = yield* Ref.get(turns);
      expect(t).toHaveLength(1);
      expect(t[0]!.reason).toBe("debounce");
      expect(texts(t[0]!)).toEqual(burst);
    }),
  );

  it.scoped("cap: a nonstop chat still fires ~every maxWait instead of being starved forever", () =>
    Effect.gen(function* () {
      const source = yield* Queue.unbounded<IncomingMessage>();
      const turns = yield* Ref.make<readonly ConversationWindow[]>([]);
      // debounceWindow 3s, cap 8s: the quiet window never elapses under steady
      // 1s-apart traffic, so only the cap can ever flush this chat.
      yield* startRecording(source, turns, { maxWait: Duration.seconds(8) });

      // Messages at t=0..3, one per second. A lone message would settle at t=3,
      // but the steady traffic keeps resetting the quiet window — nothing fires.
      for (let i = 0; i < 4; i++) {
        yield* Queue.offer(source, mkMsg(`busy ${i}`));
        yield* TestClock.adjust(Duration.seconds(1));
      }
      expect(yield* Ref.get(turns)).toHaveLength(0);

      // Keep it busy through the cap (t=4..7). At t=8 = maxWait the cap forces a
      // single fire carrying the whole pile — this is what pure debounce couldn't do.
      for (let i = 4; i < 8; i++) {
        yield* Queue.offer(source, mkMsg(`busy ${i}`));
        yield* TestClock.adjust(Duration.seconds(1));
      }
      const t = yield* Ref.get(turns);
      expect(t).toHaveLength(1);
      expect(t[0]!.reason).toBe("debounce");
      expect(t[0]!.messages).toHaveLength(8);

      // Still nonstop (t=8..15): a SECOND cap cycle fires ~maxWait after its own
      // first message — the chat gathers again and is not starved after one fire.
      for (let i = 8; i < 16; i++) {
        yield* Queue.offer(source, mkMsg(`busy ${i}`));
        yield* TestClock.adjust(Duration.seconds(1));
      }
      const t2 = yield* Ref.get(turns);
      expect(t2).toHaveLength(2);
      expect(t2[1]!.reason).toBe("debounce");
    }),
  );

  it.scoped("mention: an @-mention of the bot fires immediately, skipping the debounce", () =>
    Effect.gen(function* () {
      const source = yield* Queue.unbounded<IncomingMessage>();
      const turns = yield* Ref.make<readonly ConversationWindow[]>([]);
      yield* startRecording(source, turns);

      yield* Queue.offer(source, mkMsg("@bot look at this", { mentions: [BOT] }));

      // Zero virtual time passes, yet it has already fired — no waiting for the window.
      yield* TestClock.adjust(Duration.zero);
      const t = yield* Ref.get(turns);
      expect(t).toHaveLength(1);
      expect(t[0]!.reason).toBe("mention");
      expect(texts(t[0]!)).toEqual(["@bot look at this"]);
    }),
  );

  it.scoped("quote-reply: a reply to the bot also fires immediately", () =>
    Effect.gen(function* () {
      const source = yield* Queue.unbounded<IncomingMessage>();
      const turns = yield* Ref.make<readonly ConversationWindow[]>([]);
      yield* startRecording(source, turns);

      yield* Queue.offer(source, mkMsg("yes do it", { quotedFrom: BOT }));

      yield* TestClock.adjust(Duration.zero);
      const t = yield* Ref.get(turns);
      expect(t).toHaveLength(1);
      expect(t[0]!.reason).toBe("quote-reply");
    }),
  );

  it.scoped("mention mid-burst flushes the accumulated window immediately (not just the mention)", () =>
    Effect.gen(function* () {
      const source = yield* Queue.unbounded<IncomingMessage>();
      const turns = yield* Ref.make<readonly ConversationWindow[]>([]);
      yield* startRecording(source, turns);

      // Two ambient messages accumulate...
      yield* Queue.offer(source, mkMsg("hmm"));
      yield* TestClock.adjust(Duration.seconds(1));
      yield* Queue.offer(source, mkMsg("wait"));
      yield* TestClock.adjust(Duration.seconds(1));
      expect(yield* Ref.get(turns)).toHaveLength(0);

      // ...then the bot is addressed → immediate flush of all three.
      yield* Queue.offer(source, mkMsg("@bot help", { mentions: [BOT] }));
      yield* TestClock.adjust(Duration.zero);
      const t = yield* Ref.get(turns);
      expect(t).toHaveLength(1);
      expect(t[0]!.reason).toBe("mention");
      expect(texts(t[0]!)).toEqual(["hmm", "wait", "@bot help"]);
    }),
  );

  it.scoped("per-chat isolation: two chats debounce independently", () =>
    Effect.gen(function* () {
      const source = yield* Queue.unbounded<IncomingMessage>();
      const turns = yield* Ref.make<readonly ConversationWindow[]>([]);
      yield* startRecording(source, turns);

      const CHAT_A = "a@g.us";
      const CHAT_B = "b@g.us";

      // A gets an ambient message; B gets a mention — at the same instant.
      yield* Queue.offer(source, mkMsg("ambient in A", { chatId: CHAT_A }));
      yield* Queue.offer(source, mkMsg("@bot in B", { chatId: CHAT_B, mentions: [BOT] }));

      // B (mention) fires immediately; A (ambient) has not fired yet.
      yield* TestClock.adjust(Duration.zero);
      let t = yield* Ref.get(turns);
      expect(t).toHaveLength(1);
      expect(t[0]!.chatId).toBe(CHAT_B);
      expect(t[0]!.reason).toBe("mention");

      // A's window settles → A fires, independently.
      yield* TestClock.adjust(WINDOW);
      t = yield* Ref.get(turns);
      expect(t).toHaveLength(2);
      expect(t[1]!.chatId).toBe(CHAT_A);
      expect(t[1]!.reason).toBe("debounce");
      expect(texts(t[1]!)).toEqual(["ambient in A"]);
    }),
  );

  it.scoped("buffer bound: the fired window is capped to the most-recent N messages", () =>
    Effect.gen(function* () {
      const source = yield* Queue.unbounded<IncomingMessage>();
      const turns = yield* Ref.make<readonly ConversationWindow[]>([]);
      yield* startRecording(source, turns, { maxBufferMessages: 3 });

      // Six messages in one burst (offered back-to-back, no window between them).
      for (const text of ["1", "2", "3", "4", "5", "6"]) {
        yield* Queue.offer(source, mkMsg(text));
      }
      // Settle: one fire, buffer capped to the last 3.
      yield* TestClock.adjust(WINDOW);
      const t = yield* Ref.get(turns);
      expect(t).toHaveLength(1);
      expect(texts(t[0]!)).toEqual(["4", "5", "6"]);
    }),
  );

  it.scoped("history + own messages are filtered before the loop (never fire)", () =>
    Effect.gen(function* () {
      const source = yield* Queue.unbounded<IncomingMessage>();
      const turns = yield* Ref.make<readonly ConversationWindow[]>([]);
      yield* startRecording(source, turns);

      yield* Queue.offer(source, mkMsg("backfill", { live: false }));
      yield* Queue.offer(source, mkMsg("bot's own echo", { fromMe: true, mentions: [BOT] }));

      yield* TestClock.adjust(Duration.minutes(1));
      expect(yield* Ref.get(turns)).toHaveLength(0);
    }),
  );

  it.scoped("resilience: a turn that dies (defect) does not wedge the chat — the next burst still fires", () =>
    Effect.gen(function* () {
      const source = yield* Queue.unbounded<IncomingMessage>();
      const turns = yield* Ref.make<readonly ConversationWindow[]>([]);
      const calls = yield* Ref.make(0);

      // An Ambience doorway that throws (defect, not a typed error) on its first admission.
      const flakyDoorway = Layer.succeed(AmbienceDoorway, {
        admit: (window: ConversationWindow) =>
          Effect.gen(function* () {
            const n = yield* Ref.updateAndGet(calls, (c) => c + 1);
            if (n === 1) return yield* Effect.die(new Error("boom"));
            yield* Ref.update(turns, (t) => [...t, window]);
          }),
      });

      yield* Effect.forkScoped(
        Coalescer.run.pipe(
          Effect.provide(
            Layer.mergeAll(queueEventSource(source), flakyDoorway, configLayer({ botIds: [BOT], debounceWindow: WINDOW })),
          ),
        ),
      );

      // First burst fires → admission dies. The chat's actor must survive it.
      yield* Queue.offer(source, mkMsg("first"));
      yield* TestClock.adjust(WINDOW);
      expect(yield* Ref.get(calls)).toBe(1);
      expect(yield* Ref.get(turns)).toHaveLength(0);

      // Second burst on the SAME chat proves the loop is still alive and debouncing.
      yield* Queue.offer(source, mkMsg("second"));
      yield* TestClock.adjust(WINDOW);
      const t = yield* Ref.get(turns);
      expect(t).toHaveLength(1);
      expect(texts(t[0]!)).toEqual(["second"]);
    }),
  );

});
