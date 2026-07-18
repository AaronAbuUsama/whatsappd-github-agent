/**
 * The Coalescer's ports — every boundary to the outside world is a `Context.Service`
 * service, so each is a swappable Layer. This is the Effect-to-Flue dispatch
 * seam and the test seams, in one place.
 *
 * Decisions D1/D3/D4 in `docs/COALESCER-DESIGN.md`.
 */
import { Context, Data, type Effect, type Stream } from "effect";
import type { CoalescerEvent, ConversationWindow, ConversationWindowDraft } from "./events.ts";

// ── Window dispatcher ────────────────────────────────────────────────────────
// The Coalescer's sole output. Production dispatches every accepted window to
// the continuing Flue agent keyed by chatId.

export class WindowDispatchError extends Data.TaggedError("WindowDispatchError")<{
  readonly cause: unknown;
}> {}

export class WindowDispatcher extends Context.Service<
  WindowDispatcher,
  {
    /** Dispatch one accepted buffered window to the continuing Speaker instance. */
    readonly dispatch: (window: ConversationWindow) => Effect.Effect<void, WindowDispatchError>;
  }
>()("WindowDispatcher") {}

export class WindowStoreError extends Data.TaggedError("WindowStoreError")<{
  readonly cause: unknown;
}> {}

export interface WindowStoreService {
  readonly pendingWindows: Effect.Effect<readonly ConversationWindow[], WindowStoreError>;
  readonly create: (draft: ConversationWindowDraft) => Effect.Effect<ConversationWindow, WindowStoreError>;
}

export class WindowStore extends Context.Service<WindowStore, WindowStoreService>()("WindowStore") {}

// ── EventSource (inbound stream) ────────────────────────────────────────────
// The raw per-chat event firehose. Mock: a `Stream` fed from a test `Queue`,
// driven under `TestClock`. Real: the in-process whatsappd subscription.

export class EventSource extends Context.Service<
  EventSource,
  {
    readonly events: Stream.Stream<CoalescerEvent>;
  }
>()("EventSource") {}
