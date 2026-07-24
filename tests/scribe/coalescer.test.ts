/**
 * The Scribe funnel coalescer, under Effect's `TestClock` — virtual time, zero real
 * sleeps. Proves the three guarantees #155 requires: sibling inputs collapse into ONE
 * combined extraction turn (cadence), per-chat isolation, and that a thrown/failed
 * Scribe turn never wedges ingestion or surfaces to the caller (failure isolation).
 */
import { describe, expect, it } from "@effect/vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Duration, Effect, Fiber, Ref } from "effect";
import { TestClock } from "effect/testing";

import {
  configureScribeAttemptDispatch,
  createScribeCoalescer,
  dispatchScribeAttempt,
} from "../../packages/agents/src/scribe/coalescer.ts";
import { scribeBatchInput, scribeBatchWave, type ScribeOffer } from "../../packages/agents/src/scribe/input.ts";
import { scribeAttemptContext } from "../../packages/agents/src/scribe/attempt-context.ts";
import type { SpeakerInput } from "../../packages/engine/src/inputs.ts";
import { createScribeInbox } from "../../packages/engine/src/scribe/inbox.ts";
import { createGraphStore } from "../../packages/engine/src/graph/store.ts";
import { configureGraphStore } from "../../packages/agents/src/capabilities/graph/runtime.ts";

const DEBOUNCE = Duration.millis(30);

const offerFor = (id: string, text: string, timestamp = 1): ScribeOffer => ({
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
        timestamp,
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
      const batches = yield* Ref.make<ReadonlyArray<{ attemptId: string; count: number }>>([]);
      const coalescer = createScribeCoalescer({
        config: { debounceWindow: DEBOUNCE },
        dispatchBatch: (attemptId, batch) =>
          Effect.runPromise(Ref.update(batches, (b) => [...b, { attemptId, count: batch.inputs.length }])),
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
      expect(yield* Ref.get(batches)).toEqual([{ attemptId: expect.stringMatching(/^scribe-attempt:/), count: 3 }]);
    }),
  );

  it.effect("places sibling observations from different chats in one global batch", () =>
    Effect.gen(function* () {
      const batches = yield* Ref.make<
        ReadonlyArray<{
          attemptId: string;
          batchId: string;
          chats: readonly string[];
          evidenceIds: readonly string[];
        }>
      >([]);
      const coalescer = createScribeCoalescer({
        config: { debounceWindow: DEBOUNCE },
        dispatchBatch: (attemptId, batch) =>
          Effect.runPromise(
            Ref.update(batches, (b) => [
              ...b,
              {
                attemptId,
                batchId: batch.batchId,
                chats: batch.inputs.map((input) => (input.type === "whatsapp.window" ? input.chatId : input.type)),
                evidenceIds: batch.evidenceIds,
              },
            ]),
          ),
      });
      yield* Effect.forkScoped(coalescer.run);

      coalescer.offer(offerFor("chat-a@g.us", "a1"));
      coalescer.offer(offerFor("chat-b@g.us", "b1"));
      coalescer.offer(offerFor("chat-b@g.us", "b2"));

      yield* TestClock.adjust(DEBOUNCE);
      expect(yield* Ref.get(batches)).toEqual([
        {
          attemptId: expect.stringMatching(/^scribe-attempt:/),
          batchId: expect.stringMatching(/^scribe-batch:/),
          chats: ["chat-a@g.us", "chat-b@g.us", "chat-b@g.us"],
          evidenceIds: ["arrival:chat-a@g.us:m-a1", "arrival:chat-b@g.us:m-b1", "arrival:chat-b@g.us:m-b2"],
        },
      ]);
    }),
  );

  it.effect("a failed extraction turn never wedges the chat: the next burst still fires", () =>
    Effect.gen(function* () {
      const seen = yield* Ref.make<readonly string[]>([]);
      let calls = 0;
      const coalescer = createScribeCoalescer({
        config: { debounceWindow: DEBOUNCE },
        dispatchBatch: async (_attemptId, batch) => {
          calls += 1;
          if (calls === 1) throw new Error("extraction boom");
          const chatId = batch.inputs[0]?.type === "whatsapp.window" ? batch.inputs[0].chatId : "unknown";
          await Effect.runPromise(Ref.update(seen, (s) => [...s, chatId]));
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

  it.effect("bounds concurrent stateless attempts without serializing the global clock", () =>
    Effect.gen(function* () {
      const releases: Array<() => void> = [];
      let calls = 0;
      let inFlight = 0;
      let maximumInFlight = 0;
      const coalescer = createScribeCoalescer({
        config: { cap: 1 },
        maxConcurrentAttempts: 2,
        dispatchBatch: async () => {
          calls++;
          inFlight++;
          maximumInFlight = Math.max(maximumInFlight, inFlight);
          await new Promise<void>((resolve) => releases.push(resolve));
          inFlight--;
        },
      });
      yield* Effect.forkScoped(coalescer.run);

      coalescer.offer(offerFor("chat-a@g.us", "one"));
      coalescer.offer(offerFor("chat-b@g.us", "two"));
      coalescer.offer(offerFor("chat-c@g.us", "three"));
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      expect(calls).toBe(2);
      expect(maximumInFlight).toBe(2);

      releases.splice(0).forEach((release) => release());
      yield* Effect.promise(async () => {
        for (let attempt = 0; attempt < 20 && calls < 3; attempt++) {
          await new Promise<void>((resolve) => setTimeout(resolve, 1));
        }
      });
      expect(calls).toBe(3);
      releases.splice(0).forEach((release) => release());
    }),
  );

  it("uses one chronological policy and stable evidence identity across chats", () => {
    const late = offerFor("chat-a@g.us", "late", 20).input;
    const early = offerFor("chat-b@g.us", "early", 10).input;
    if (late.type !== "whatsapp.window" || early.type !== "whatsapp.window") throw new Error("test fixture");

    const first = scribeBatchInput([late, early]);
    const replayed = scribeBatchInput([late, early]);
    expect(first.inputs.map((input) => (input.type === "whatsapp.window" ? input.chatId : input.type))).toEqual([
      "chat-b@g.us",
      "chat-a@g.us",
    ]);
    expect(first.evidenceIds).toEqual(["arrival:chat-b@g.us:m-early", "arrival:chat-a@g.us:m-late"]);
    expect(replayed.batchId).toBe(first.batchId);
  });

  it("forms a deterministic bounded concurrent wave from one chronological frontier", () => {
    const inputs = [
      offerFor("chat-a@g.us", "five", 50).input,
      offerFor("chat-b@g.us", "one", 10).input,
      offerFor("chat-c@g.us", "four", 40).input,
      offerFor("chat-a@g.us", "two", 20).input,
      offerFor("chat-b@g.us", "three", 30).input,
    ];
    const wave = scribeBatchWave(inputs, 2);
    expect(wave).toHaveLength(2);
    expect(wave.map(({ inputs }) => inputs.length)).toEqual([3, 2]);
    expect(wave.flatMap(({ evidenceIds }) => evidenceIds)).toEqual([
      "arrival:chat-b@g.us:m-one",
      "arrival:chat-a@g.us:m-two",
      "arrival:chat-b@g.us:m-three",
      "arrival:chat-c@g.us:m-four",
      "arrival:chat-a@g.us:m-five",
    ]);
    expect(scribeBatchWave(inputs, 2).map(({ batchId }) => batchId)).toEqual(wave.map(({ batchId }) => batchId));
  });

  it.effect("uses the runtime terminal-result dispatcher when no test seam overrides it", () =>
    Effect.gen(function* () {
      const seen = yield* Ref.make<readonly string[]>([]);
      const restore = configureScribeAttemptDispatch((attemptId, batch) => {
        expect(scribeAttemptContext(attemptId)).toMatchObject({
          author: { kind: "scribe", id: "scribe" },
          evidenceIds: batch.evidenceIds,
          batchId: batch.batchId,
        });
        return Effect.runPromise(Ref.update(seen, (current) => [...current, attemptId]));
      });
      try {
        const coalescer = createScribeCoalescer({ config: { cap: 1 } });
        yield* Effect.forkScoped(coalescer.run);
        coalescer.offer(offerFor("chat-a@g.us", "bound"));
        yield* Effect.yieldNow;
        yield* Effect.yieldNow;
        expect(yield* Ref.get(seen)).toEqual([expect.stringMatching(/^scribe-attempt:/)]);
      } finally {
        restore();
      }
    }),
  );

  it("shares one four-attempt production gate across every ingestion path", async () => {
    const releases: Array<() => void> = [];
    let inFlight = 0;
    let maximumInFlight = 0;
    const restore = configureScribeAttemptDispatch(async () => {
      inFlight++;
      maximumInFlight = Math.max(maximumInFlight, inFlight);
      await new Promise<void>((resolve) => releases.push(resolve));
      inFlight--;
    });
    try {
      const batch = scribeBatchInput([offerFor("chat-a@g.us", "shared-gate").input]);
      const attempts = Array.from({ length: 5 }, (_, index) => dispatchScribeAttempt(`scribe-attempt:${index}`, batch));
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(inFlight).toBe(4);
      expect(maximumInFlight).toBe(4);
      releases.splice(0).forEach((release) => release());
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      releases.splice(0).forEach((release) => release());
      await Promise.all(attempts);
    } finally {
      restore();
    }
  });

  it("offer never throws, even before the router is running", () => {
    const coalescer = createScribeCoalescer({ dispatchBatch: async () => undefined });
    expect(() => coalescer.offer(offerFor("chat-a@g.us", "x"))).not.toThrow();
  });

  it("recovers an admitted live observation after a crash before the debounce fires", async () => {
    const root = mkdtempSync(join(tmpdir(), "scribe-coalescer-"));
    const path = join(root, "application.sqlite");
    try {
      const firstInbox = createScribeInbox(path);
      const beforeCrash = createScribeCoalescer({ inbox: firstInbox, dispatchBatch: async () => undefined });
      beforeCrash.offer(offerFor("chat-a@g.us", "survives"));
      firstInbox.close();

      const seen: string[][] = [];
      const reopenedInbox = createScribeInbox(path, { recoverInterruptedAttempts: true });
      const recovered = createScribeCoalescer({
        inbox: reopenedInbox,
        dispatchBatch: async (_attemptId, batch) => {
          seen.push([...batch.evidenceIds]);
        },
      });
      const fiber = Effect.runFork(recovered.run);
      for (let attempt = 0; attempt < 50 && seen.length === 0; attempt++) {
        await new Promise<void>((resolve) => setTimeout(resolve, 2));
      }
      expect(seen).toEqual([["arrival:chat-a@g.us:m-survives"]]);
      expect(reopenedInbox.isEvidenceComplete(seen[0]!)).toBe(true);
      await Effect.runPromise(Fiber.interrupt(fiber));
      reopenedInbox.close();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("recomputes the bounded Projection on retry and durably emits the Scribe proposal delta", async () => {
    const graph = createGraphStore(":memory:");
    configureGraphStore(graph);
    const inbox = createScribeInbox(":memory:");
    const versions: string[] = [];
    const deltas: unknown[] = [];
    let calls = 0;
    const coalescer = createScribeCoalescer({
      inbox,
      config: { cap: 1 },
      dispatchBatch: async (_attemptId, batch) => {
        calls++;
        const input = batch.inputs[0];
        versions.push(input?.graphContext?.projectionVersion ?? "missing");
        if (calls === 1) {
          graph.attest({
            context: {
              author: { kind: "scribe", id: "scribe" },
              evidenceIds: batch.evidenceIds,
              batchId: batch.batchId,
            },
            claim: { kind: "entity", input: { type: "topic", properties: { label: "retry knowledge" } } },
          });
          throw new Error("retry after a partial model turn");
        }
      },
      onProposalDelta: (delta) => {
        deltas.push(delta);
      },
    });
    const fiber = Effect.runFork(coalescer.run);
    coalescer.offer(offerFor("chat-a@g.us", "fresh-projection"));
    for (let attempt = 0; attempt < 50 && deltas.length === 0; attempt++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 2));
    }

    expect(versions).toHaveLength(2);
    expect(versions[0]).not.toBe(versions[1]);
    expect(deltas).toEqual([
      expect.objectContaining({
        scribeBatchId: expect.stringMatching(/^scribe-batch:/),
        attestationIds: [expect.stringMatching(/^attestation:/)],
        evidenceIds: ["arrival:chat-a@g.us:m-fresh-projection"],
        projectionVersion: versions[1],
      }),
    ]);
    await Effect.runPromise(Fiber.interrupt(fiber));
    inbox.close();
    graph.close();
    configureGraphStore(createGraphStore(":memory:"));
  });
});
