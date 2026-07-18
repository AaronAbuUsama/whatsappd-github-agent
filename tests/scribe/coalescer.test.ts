/**
 * The Scribe funnel coalescer, under Effect's `TestClock` — virtual time, zero real
 * sleeps. Proves the three guarantees #155 requires: sibling inputs collapse into ONE
 * combined extraction turn (cadence), per-chat isolation, and that a thrown/failed
 * Scribe turn never wedges the chat or surfaces to the caller (failure isolation).
 */
import { describe, expect, it } from "@effect/vitest";
import { Duration, Effect, Ref } from "effect";
import { TestClock } from "effect/testing";

import { createScribeCoalescer } from "../../packages/agents/src/scribe/coalescer.ts";
import type { ScribeOffer } from "../../packages/agents/src/scribe/input.ts";
import type { SpeakerInput } from "../../packages/engine/src/inputs.ts";

const DEBOUNCE = Duration.millis(30);

const offerFor = (id: string, text: string): ScribeOffer => ({
  id,
  input: {
    type: "whatsapp.window",
    windowId: `w-${text}`,
    chatId: id,
    reason: "debounce",
    messages: [
      {
        id: `m-${text}`,
        chatId: id,
        from: "u@s.whatsapp.net",
        text,
        timestamp: 1,
        isGroup: true,
        fromMe: false,
        live: true,
        mentions: [],
      },
    ],
    updates: [],
  } satisfies SpeakerInput,
});

describe("Scribe coalescer", () => {
  it.effect("collapses a burst of sibling inputs into ONE combined extraction turn", () =>
    Effect.gen(function* () {
      const batches = yield* Ref.make<ReadonlyArray<{ id: string; count: number }>>([]);
      const coalescer = createScribeCoalescer({
        config: { debounceWindow: DEBOUNCE },
        dispatchBatch: (id, inputs) => Effect.runPromise(Ref.update(batches, (b) => [...b, { id, count: inputs.length }])),
      });
      yield* Effect.forkScoped(coalescer.run);

      coalescer.offer(offerFor("chat-a@g.us", "one"));
      coalescer.offer(offerFor("chat-a@g.us", "two"));
      coalescer.offer(offerFor("chat-a@g.us", "three"));

      // Nothing fires before the quiet window settles.
      yield* TestClock.adjust(Duration.millis(20));
      expect(yield* Ref.get(batches)).toEqual([]);

      // Settles → exactly one turn carrying all three inputs.
      yield* TestClock.adjust(DEBOUNCE);
      expect(yield* Ref.get(batches)).toEqual([{ id: "chat-a@g.us", count: 3 }]);
    }),
  );

  it.effect("debounces each chat independently", () =>
    Effect.gen(function* () {
      const batches = yield* Ref.make<ReadonlyArray<{ id: string; count: number }>>([]);
      const coalescer = createScribeCoalescer({
        config: { debounceWindow: DEBOUNCE },
        dispatchBatch: (id, inputs) => Effect.runPromise(Ref.update(batches, (b) => [...b, { id, count: inputs.length }])),
      });
      yield* Effect.forkScoped(coalescer.run);

      coalescer.offer(offerFor("chat-a@g.us", "a1"));
      coalescer.offer(offerFor("chat-b@g.us", "b1"));
      coalescer.offer(offerFor("chat-b@g.us", "b2"));

      yield* TestClock.adjust(DEBOUNCE);
      const fired = yield* Ref.get(batches);
      expect(fired).toHaveLength(2);
      expect([...fired].sort((x, y) => x.id.localeCompare(y.id))).toEqual([
        { id: "chat-a@g.us", count: 1 },
        { id: "chat-b@g.us", count: 2 },
      ]);
    }),
  );

  it.effect("a failed extraction turn never wedges the chat: the next burst still fires", () =>
    Effect.gen(function* () {
      const seen = yield* Ref.make<readonly string[]>([]);
      let calls = 0;
      const coalescer = createScribeCoalescer({
        config: { debounceWindow: DEBOUNCE },
        dispatchBatch: async (id) => {
          calls += 1;
          if (calls === 1) throw new Error("extraction boom");
          await Effect.runPromise(Ref.update(seen, (s) => [...s, id]));
        },
      });
      yield* Effect.forkScoped(coalescer.run);

      coalescer.offer(offerFor("chat-a@g.us", "first"));
      yield* TestClock.adjust(DEBOUNCE);
      expect(calls).toBe(1);
      expect(yield* Ref.get(seen)).toEqual([]);

      // The first turn threw; the chat is not fail-stopped — a later burst fires.
      coalescer.offer(offerFor("chat-a@g.us", "second"));
      yield* TestClock.adjust(DEBOUNCE);
      expect(calls).toBe(2);
      expect(yield* Ref.get(seen)).toEqual(["chat-a@g.us"]);
    }),
  );

  it("offer never throws, even before the router is running", () => {
    const coalescer = createScribeCoalescer({ dispatchBatch: async () => undefined });
    expect(() => coalescer.offer(offerFor("chat-a@g.us", "x"))).not.toThrow();
  });
});
