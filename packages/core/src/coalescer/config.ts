/**
 * Coalescer tuning — feel-critical constants that will be tuned live, so they
 * are a DI service (a `Context.Service`), never literals. Override the Layer per
 * deployment or per test; the defaults below are sane starting points.
 *
 * Decision D2 in `docs/COALESCER-DESIGN.md`.
 */
import { Context, Duration, Layer } from "effect";

export interface CoalescerConfigValues {
  /** Quiet window after which an ambient burst is considered settled. */
  readonly debounceWindow: Duration.Duration;
  /**
   * Hard cap on how long a burst may keep accumulating before it fires anyway.
   * The quiet window (`debounceWindow`) resets on every message, so a nonstop
   * chat would never settle; this cap makes the loop a throttle — fire when the
   * chat goes quiet OR when `maxWait` has elapsed since the burst's first
   * message, whichever comes first. Must be ≥ `debounceWindow` to have any effect.
   */
  readonly maxWait: Duration.Duration;
  /** Maximum messages in one Window. Reaching it segments rather than evicts. */
  readonly maxWindowMessages: number;
  /**
   * Every JID that means "the bot" — used to detect @-mentions and quote-replies of
   * it. WhatsApp addresses an account by two schemes (phone-number `@s.whatsapp.net`
   * AND a per-chat `@lid`), and a mention can arrive under EITHER, so this is a set,
   * not one string. A message addresses the bot if it mentions/quotes any of these.
   */
  readonly botIds: readonly string[];
}

export class CoalescerConfig extends Context.Service<CoalescerConfig, CoalescerConfigValues>()("CoalescerConfig") {}

/** Sane defaults: debounce a few seconds, cap a burst at ~10s, segment at 10 messages. */
const defaultConfig: CoalescerConfigValues = {
  debounceWindow: Duration.seconds(3),
  maxWait: Duration.seconds(10),
  maxWindowMessages: 10,
  botIds: ["bot@s.whatsapp.net"],
};

/**
 * Build a config Layer, overriding any defaults you name. `configLayer({})` is
 * the plain defaults; `configLayer({ debounceWindow: Duration.seconds(5) })`
 * tweaks one knob. This is the only config surface callers need.
 */
export const configLayer = (overrides: Partial<CoalescerConfigValues> = {}): Layer.Layer<CoalescerConfig, never> =>
  Layer.succeed(CoalescerConfig, { ...defaultConfig, ...overrides });
