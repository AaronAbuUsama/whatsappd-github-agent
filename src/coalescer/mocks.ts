/**
 * Mock Layers for the Coalescer's event source and window-dispatch seam.
 * They are `Ref`-backed so timing tests can inspect exactly what fired.
 */
import { Effect, Layer, Queue, Ref, Stream } from "effect";
import type { ConversationWindow, IncomingMessage } from "./events.ts";
import { EventSource, WindowDispatcher, WindowStore } from "./ports.ts";

// ── EventSource: a Stream fed from a Queue the test controls ─────────────────

export const queueEventSource = (queue: Queue.Dequeue<IncomingMessage>): Layer.Layer<EventSource, never> =>
  Layer.succeed(EventSource, { events: Stream.fromQueue(queue) });

// ── Window dispatcher: record every dispatch (for timing tests) ───────────────
// The pure timing behaviour is observable here — one entry per Coalescer fire,
// with the buffered window and the reason.

export const recordingWindowDispatcher = (
  turns: Ref.Ref<readonly ConversationWindow[]>,
): Layer.Layer<WindowDispatcher, never> =>
  Layer.succeed(WindowDispatcher, {
    dispatch: (window) => Ref.update(turns, (t) => [...t, window]),
  });

export const inMemoryWindowStore = (): Layer.Layer<WindowStore, never> => {
  let sequence = 0;
  const windows: ConversationWindow[] = [];
  return Layer.succeed(WindowStore, {
    pendingWindows: Effect.sync(() => [...windows]),
    create: (draft) =>
      Effect.sync(() => {
        const window = { id: `window-${++sequence}`, ...draft };
        windows.push(window);
        return window;
      }),
  });
};
