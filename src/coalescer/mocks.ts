/**
 * Mock Layers for the Coalescer's event source and Ambience-admission seam.
 * They are `Ref`-backed so timing tests can inspect exactly what fired.
 */
import { Layer, Queue, Ref, Stream } from "effect";
import type { ConversationWindow, IncomingMessage } from "./events.ts";
import { AmbienceDoorway, EventSource } from "./ports.ts";

// ── EventSource: a Stream fed from a Queue the test controls ─────────────────

export const queueEventSource = (queue: Queue.Dequeue<IncomingMessage>): Layer.Layer<EventSource> =>
  Layer.succeed(EventSource, { events: Stream.fromQueue(queue) });

// ── Ambience doorway: record every admission (for timing tests) ─────────────
// The pure timing behaviour is observable here — one entry per Coalescer fire,
// with the buffered window and the reason.

export const recordingAmbienceDoorway = (
  turns: Ref.Ref<readonly ConversationWindow[]>,
): Layer.Layer<AmbienceDoorway> =>
  Layer.succeed(AmbienceDoorway, {
    admit: (window) => Ref.update(turns, (t) => [...t, window]),
  });
