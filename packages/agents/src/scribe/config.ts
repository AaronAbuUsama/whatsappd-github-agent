/**
 * Scribe coalescer tuning — much laggier than the Speaker's (3s / 10s / 10),
 * because nothing the Scribe extracts is urgent (#149). Feel/eval-tuned later, so
 * they are DI knobs, not literals: override per deployment or per test. Durability
 * is best-effort in-memory (no ledger, #141 D2); a crash drops ≤ one `maxWait`.
 */
import { Duration } from "effect";
import type { DebounceParams } from "@ambient-agent/engine/coalescer/debounce-actor.ts";

export const defaultScribeCoalescerConfig: DebounceParams = {
  debounceWindow: Duration.seconds(30),
  maxWait: Duration.minutes(3),
  cap: 50,
};

/**
 * Resolve the Scribe coalescer parameters, overriding any knob you name.
 * `scribeCoalescerConfig()` is the plain laggy defaults.
 */
export const scribeCoalescerConfig = (overrides: Partial<DebounceParams> = {}): DebounceParams => ({
  ...defaultScribeCoalescerConfig,
  ...overrides,
});
