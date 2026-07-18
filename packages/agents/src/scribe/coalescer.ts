/**
 * The Scribe's own coalescer, at the `dispatchSpeaker` funnel (#149).
 *
 * Flue serializes the Scribe's admissions but never collapses N queued admissions
 * into one turn, so per-input dispatch would be one LLM call per message. This
 * debounces: sibling inputs for a chat accumulate and dispatch as ONE combined
 * extraction turn per quiet-period-or-cap. It reuses the coalescer's `debounceActor`
 * over already-composed inputs (a different layer & element type from the raw
 * WhatsApp coalescer) with much laggier knobs and NO immediate-fire predicate.
 *
 * Failure isolation (#141 D2): `offer` is called after the Speaker's receipt, never
 * awaited, and can never throw — a Scribe failure cannot re-run or re-deliver the
 * Speaker's turn. There is no durability ledger; a crash drops ≤ one `maxWait` and
 * the graph is tentative and self-healing.
 */
import { dispatch } from "@flue/runtime";
import { Effect, HashMap, Option, Queue, Ref, type Scope, Stream } from "effect";

import { debounceActor, type DebounceParams } from "@ambient-agent/engine/coalescer/debounce-actor.ts";
import type { SpeakerInput } from "@ambient-agent/engine/inputs.ts";
import scribe from "./agent.ts";
import { scribeBatchInput, type ScribeOffer } from "./input.ts";
import { scribeCoalescerConfig } from "./config.ts";

/** Why a batch fired. Unused downstream (extraction is uniform) but keeps the actor typed. */
type ScribeFireReason = "debounce" | "maximum-wait" | "capacity";

export type DispatchScribeBatch = (id: string, inputs: readonly SpeakerInput[]) => Promise<unknown>;

export interface ScribeCoalescerOptions {
  /** Override any laggy default knob. */
  readonly config?: Partial<DebounceParams>;
  /** Injected for tests; defaults to dispatching the Scribe agent with the batched inputs. */
  readonly dispatchBatch?: DispatchScribeBatch;
}

export interface ScribeCoalescer {
  /** Offer one funnel input to the Scribe. Detached, best-effort, never throws. */
  readonly offer: (offer: ScribeOffer) => void;
  /** The router fiber; the default instance forks it lazily. Exposed for tests. */
  readonly run: Effect.Effect<void>;
}

const defaultDispatchBatch: DispatchScribeBatch = (id, inputs) =>
  dispatch(scribe, { id, input: scribeBatchInput(inputs) });

export const createScribeCoalescer = (options: ScribeCoalescerOptions = {}): ScribeCoalescer => {
  const params = scribeCoalescerConfig(options.config);
  const dispatchBatch = options.dispatchBatch ?? defaultDispatchBatch;
  // Created eagerly so `offer` can enqueue synchronously (a plain data structure,
  // safe to use from the plain-async funnel and across the forked router fiber).
  const mailbox = Effect.runSync(Queue.unbounded<ScribeOffer>());

  // A failed extraction turn logs and the chat continues — the graph self-heals.
  const swallow = (id: string) => (cause: unknown): Effect.Effect<void> =>
    Effect.logError(`Scribe extraction failed for ${id}; the graph is tentative and self-heals`).pipe(
      Effect.annotateLogs({ cause: String(cause) }),
    );

  const scribeLoop = (id: string) =>
    debounceActor<ScribeOffer, ScribeFireReason>(params, {
      reasons: { debounce: "debounce", maxWait: "maximum-wait", capacity: "capacity" },
      flush: (buffer) =>
        Effect.tryPromise({
          try: () => dispatchBatch(id, buffer.map((entry) => entry.input)),
          catch: (cause) => cause,
        }).pipe(Effect.asVoid, Effect.catch(swallow(id)), Effect.catchDefect(swallow(id))),
    });

  const run = Effect.scoped(
    Effect.gen(function* () {
      const registry = yield* Ref.make(HashMap.empty<string, Queue.Queue<ScribeOffer>>());
      const routeTo = (entry: ScribeOffer): Effect.Effect<void, never, Scope.Scope> =>
        Effect.gen(function* () {
          const existing = HashMap.get(yield* Ref.get(registry), entry.id);
          if (Option.isSome(existing)) {
            yield* Queue.offer(existing.value, entry);
            return;
          }
          const queue = yield* Queue.unbounded<ScribeOffer>();
          yield* Ref.update(registry, HashMap.set(entry.id, queue));
          yield* Effect.forkScoped(scribeLoop(entry.id)(queue));
          yield* Queue.offer(queue, entry);
        });
      yield* Stream.fromQueue(mailbox).pipe(Stream.runForEach(routeTo));
    }),
  );

  return {
    offer: (entry) => {
      try {
        Queue.offerUnsafe(mailbox, entry);
      } catch {
        // Best-effort: the Scribe fan-out must never surface into the Speaker's path.
      }
    },
    run,
  };
};

let defaultInstance: ScribeCoalescer | undefined;
let started = false;

/**
 * The process-wide Scribe coalescer used by the funnel. The router fiber starts on
 * the first `offer` (nothing to run until the funnel fans out) on the default runtime.
 */
export const scribeCoalescer: Pick<ScribeCoalescer, "offer"> = {
  offer: (entry) => {
    try {
      if (defaultInstance === undefined) defaultInstance = createScribeCoalescer();
      if (!started) {
        started = true;
        Effect.runFork(defaultInstance.run);
      }
      defaultInstance.offer(entry);
    } catch {
      // Best-effort: a Scribe fan-out failure can never re-run or re-deliver the Speaker.
    }
  },
};
