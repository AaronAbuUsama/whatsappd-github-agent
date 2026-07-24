/**
 * The Scribe's own coalescer, at the `dispatchSpeaker` funnel (#149).
 *
 * Flue serializes the Scribe's admissions but never collapses N queued admissions
 * into one turn, so per-input dispatch would be one LLM call per message. This
 * debounces: sibling inputs across Surfaces accumulate and dispatch as ONE combined
 * extraction turn per quiet-period-or-cap. It reuses the coalescer's `debounceActor`
 * over already-composed inputs (a different layer & element type from the raw
 * WhatsApp coalescer) with much laggier knobs and NO immediate-fire predicate.
 *
 * Failure isolation (#141 D2): `offer` is called independently of Speaker admission.
 * Production persists it by immutable evidence before waking this timer; the Speaker
 * catches admission failure and continues. A crash may lose only the timer wake, never
 * the observation, and startup drains the same durable frontier as Historical Replay.
 */
import { randomUUID } from "node:crypto";
import { dispatch } from "@flue/runtime";
import { Effect, Fiber, Queue, Semaphore } from "effect";

import { debounceActor, type DebounceParams } from "@ambient-agent/engine/coalescer/debounce-actor.ts";
import type { ScribeInbox } from "@ambient-agent/engine/scribe/inbox.ts";
import scribe from "./agent.ts";
import { scribeBatchInput, scribeObservations, type ScribeBatchInput, type ScribeOffer } from "./input.ts";
import { scribeCoalescerConfig } from "./config.ts";
import { withScribeAttemptContext } from "./attempt-context.ts";
import { drainScribeInbox, type ScribeDrainOptions } from "./durable-clock.ts";

/** Why a batch fired. Unused downstream (extraction is uniform) but keeps the actor typed. */
type ScribeFireReason = "debounce" | "maximum-wait" | "capacity";

export type DispatchScribeBatch = (attemptId: string, batch: ScribeBatchInput) => Promise<unknown>;

export interface ScribeCoalescerOptions {
  /** Override any laggy default knob. */
  readonly config?: Partial<DebounceParams>;
  /** Maximum model attempts in flight; later Batches wait without sharing model state. */
  readonly maxConcurrentAttempts?: number;
  /** Injected for tests; defaults to dispatching the Scribe agent with the batched inputs. */
  readonly dispatchBatch?: DispatchScribeBatch;
  /** Application-owned durable admission and retry frontier. */
  readonly inbox?: ScribeInbox;
  readonly onProposalDelta?: ScribeDrainOptions["onProposalDelta"];
}

export interface ScribeCoalescer {
  /** Durably offer one funnel input, then wake the detached global drain. */
  readonly offer: (offer: ScribeOffer) => void;
  /** The router fiber; the default instance forks it lazily. Exposed for tests. */
  readonly run: Effect.Effect<void>;
}

const defaultDispatchBatch: DispatchScribeBatch = (attemptId, batch) =>
  dispatch(scribe, { id: attemptId, input: batch });

let runtimeDispatchBatch: DispatchScribeBatch | undefined;
const productionAttempts = Semaphore.makeUnsafe(4);

/**
 * Production binds Flue's terminal-result direct-agent API here. The runtime `dispatch`
 * fallback exists for isolated tests, but it settles at admission and therefore cannot
 * measure model concurrency.
 */
export const configureScribeAttemptDispatch = (dispatchBatch: DispatchScribeBatch): (() => void) => {
  const previous = runtimeDispatchBatch;
  runtimeDispatchBatch = dispatchBatch;
  return () => {
    if (runtimeDispatchBatch === dispatchBatch) runtimeDispatchBatch = previous;
  };
};

/** One process-wide execution gate shared by live ingestion and Historical Replay. */
export const dispatchScribeAttempt = (attemptId: string, batch: ScribeBatchInput): Promise<unknown> =>
  Effect.runPromise(
    productionAttempts.withPermits(1)(
      Effect.tryPromise({
        try: () =>
          withScribeAttemptContext(
            attemptId,
            {
              author: { kind: "scribe", id: "scribe" },
              evidenceIds: batch.evidenceIds,
              batchId: batch.batchId,
            },
            () => (runtimeDispatchBatch ?? defaultDispatchBatch)(attemptId, batch),
          ),
        catch: (cause) => cause,
      }),
    ),
  );

export const createScribeCoalescer = (options: ScribeCoalescerOptions = {}): ScribeCoalescer => {
  const params = scribeCoalescerConfig(options.config);
  const dispatchBatch = options.dispatchBatch ?? dispatchScribeAttempt;
  const attempts = Semaphore.makeUnsafe(Math.max(1, options.maxConcurrentAttempts ?? 4));
  // Created eagerly so `offer` can enqueue synchronously (a plain data structure,
  // safe to use from the plain-async funnel and across the forked router fiber).
  const mailbox = Effect.runSync(Queue.unbounded<ScribeOffer>());

  const durableDrain = (): Promise<unknown> =>
    drainScribeInbox(options.inbox!, dispatchBatch, { onProposalDelta: options.onProposalDelta });

  const swallow =
    (attemptId: string, batchId: string) =>
    (cause: unknown): Effect.Effect<void> =>
      Effect.logError(`Scribe extraction failed for ${batchId}; the durable Batch remains pending`).pipe(
        Effect.annotateLogs({ cause: String(cause), attemptId, batchId }),
      );

  const scribeLoop = debounceActor<ScribeOffer, ScribeFireReason>(params, {
    reasons: { debounce: "debounce", maxWait: "maximum-wait", capacity: "capacity" },
    flush: (buffer) => {
      if (options.inbox !== undefined) {
        const drain = Effect.tryPromise({ try: durableDrain, catch: (cause) => cause }).pipe(
          Effect.asVoid,
          Effect.catch((cause) =>
            Effect.logError("Scribe durable drain failed; unfinished Batches remain pending").pipe(
              Effect.annotateLogs({ cause: String(cause) }),
            ),
          ),
        );
        return Effect.forkDetach(drain).pipe(Effect.asVoid);
      }
      const attemptId = `scribe-attempt:${randomUUID()}`;
      const batch = scribeBatchInput(buffer.map((entry) => entry.input));
      const attempt = attempts.withPermits(1)(
        Effect.tryPromise({
          try: () => dispatchBatch(attemptId, batch),
          catch: (cause) => cause,
        }).pipe(
          Effect.asVoid,
          Effect.catch(swallow(attemptId, batch.batchId)),
          Effect.catchDefect(swallow(attemptId, batch.batchId)),
        ),
      );
      return Effect.forkDetach(attempt).pipe(Effect.asVoid);
    },
  });

  const run =
    options.inbox === undefined
      ? scribeLoop(mailbox)
      : Effect.gen(function* () {
          yield* Effect.forkDetach(
            Effect.tryPromise({ try: durableDrain, catch: (cause) => cause }).pipe(
              Effect.asVoid,
              Effect.catch((cause) =>
                Effect.logError("Scribe startup recovery failed; unfinished Batches remain pending").pipe(
                  Effect.annotateLogs({ cause: String(cause) }),
                ),
              ),
            ),
          );
          yield* scribeLoop(mailbox);
        });

  return {
    offer: (entry) => {
      try {
        options.inbox?.admit(scribeObservations([entry], "live"));
        Queue.offerUnsafe(mailbox, entry);
      } catch (cause) {
        if (options.inbox !== undefined) throw cause;
        // The in-memory test seam remains best-effort.
      }
    },
    run,
  };
};

let defaultInstance: ScribeCoalescer | undefined;
let started = false;
let defaultFiber: Fiber.Fiber<void, never> | undefined;
let runtimeInbox: ScribeInbox | undefined;
let runtimeOnProposalDelta: ScribeDrainOptions["onProposalDelta"];

export const configureScribeInbox = (
  inbox: ScribeInbox,
  onProposalDelta?: ScribeDrainOptions["onProposalDelta"],
): (() => void) => {
  const previous = runtimeInbox;
  const previousOnProposalDelta = runtimeOnProposalDelta;
  runtimeInbox = inbox;
  runtimeOnProposalDelta = onProposalDelta;
  if (defaultFiber !== undefined) Effect.runFork(Fiber.interrupt(defaultFiber));
  defaultInstance = createScribeCoalescer({
    inbox,
    ...(onProposalDelta === undefined ? {} : { onProposalDelta }),
  });
  started = false;
  void drainScribeInbox(
    inbox,
    dispatchScribeAttempt,
    onProposalDelta === undefined ? {} : { onProposalDelta },
  ).catch((cause) => {
    console.error("[scribe] startup recovery failed; unfinished Batches remain pending", cause);
  });
  return () => {
    if (runtimeInbox === inbox) {
      if (defaultFiber !== undefined) Effect.runFork(Fiber.interrupt(defaultFiber));
      defaultFiber = undefined;
      defaultInstance = undefined;
      started = false;
      runtimeInbox = previous;
      runtimeOnProposalDelta = previousOnProposalDelta;
    }
  };
};

/**
 * The process-wide Scribe coalescer used by the funnel. The router fiber starts on
 * the first `offer` (nothing to run until the funnel fans out) on the default runtime.
 */
export const scribeCoalescer: Pick<ScribeCoalescer, "offer"> = {
  offer: (entry) => {
    try {
      if (defaultInstance === undefined) {
        defaultInstance = createScribeCoalescer({ inbox: runtimeInbox, onProposalDelta: runtimeOnProposalDelta });
      }
      if (!started) {
        started = true;
        defaultFiber = Effect.runFork(defaultInstance.run);
      }
      defaultInstance.offer(entry);
    } catch (cause) {
      if (runtimeInbox !== undefined) throw cause;
      // The legacy in-memory test seam remains best-effort.
    }
  },
};
