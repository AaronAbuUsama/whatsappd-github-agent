/**
 * The Coalescer's ports — every boundary to the outside world is a `Context.Tag`
 * service, so each is a swappable Layer. This is the Effect-to-Flue admission
 * seam and the test seams, in one place.
 *
 * Decisions D1/D3/D4 in `docs/COALESCER-DESIGN.md`.
 */
import { Context, Data, type Effect, type Stream } from "effect";
import type { ConversationWindow, IncomingMessage } from "./events.ts";

// ── Ambience doorway ────────────────────────────────────────────────────────
// The Coalescer's sole output. Production provides the Ambience doorway, which
// admits every accepted window to the continuing Flue agent keyed by chatId.

export class AmbienceAdmissionError extends Data.TaggedError("AmbienceAdmissionError")<{
  readonly cause: unknown;
}> {}

export class AmbienceDoorway extends Context.Tag("AmbienceDoorway")<
  AmbienceDoorway,
  {
    /** Admit one accepted buffered window to the continuing Ambience instance. */
    readonly admit: (window: ConversationWindow) => Effect.Effect<void, AmbienceAdmissionError>;
  }
>() {}

// ── EventSource (inbound stream) ────────────────────────────────────────────
// The raw per-chat event firehose. Mock: a `Stream` fed from a test `Queue`,
// driven under `TestClock`. Real: the in-process whatsappd subscription.

export class EventSource extends Context.Tag("EventSource")<
  EventSource,
  {
    readonly events: Stream.Stream<IncomingMessage>;
  }
>() {}
