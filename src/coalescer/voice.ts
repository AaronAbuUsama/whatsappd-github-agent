/**
 * The voice (Agent 1) — a real, model-backed `Conversationalist`, as PLAIN
 * EFFECT wrapping the AI SDK. NOT an Eve agent: Eve can only start a session
 * from a "doorway" (an HTTP route / WS handler / scheduled job), and our caller
 * is a background timer (the Coalescer), which can't reach past that doorway.
 * The voice keeps a bounded, in-process per-chat transcript (recent turns incl.
 * its own replies) so it can hold a multi-turn conversation — a lightweight
 * stand-in for Eve's session memory, enough for a rolling window without Eve's
 * durable cross-session store. So the whole hot path stays one Effect graph and
 * the doorway problem evaporates. Whether to bring Eve back for deeper state is
 * relitigated in issue #1. See `docs/planning/COALESCER-VOICE-HANDOFF.md` §2.4–2.5.
 *
 * The model runs the tool loop itself (`ai@7`'s `streamText`, wrapped in
 * `Effect.tryPromise`): each `execute` runs a small Effect against the injected
 * Outbound / Worker services. Silence needs no machinery — the model simply
 * doesn't call `reply`, so nothing is sent.
 *
 * We must STREAM: the Codex backend rejects a non-streaming request outright
 * (`generateText` → 400 `{"detail":"Stream must be set to true"}`). `streamText`
 * drives the same tool loop; we drain it with `consumeStream()` and rethrow any
 * captured stream error so a failed turn becomes a `ConversationError`, never a
 * silent no-op.
 *
 * The model comes from the shared subscription-only policy.
 */
import { Deferred, Duration, Effect, HashMap, Layer, Option, Ref, Runtime } from "effect";
import { type ModelMessage, stepCountIs, streamText, tool } from "ai";
import { z } from "zod";
import { subscriptionModel } from "../model/subscription.ts";
import type { FireReason } from "./events.ts";
import { Conversationalist, ConversationError, Outbound, Worker } from "./ports.ts";

const DEFAULT_PERSONA = `You're a regular member of this WhatsApp group.
- Chime in WHENEVER you can genuinely help — someone's stuck, a bug/PR/issue comes up, a question you can answer.
- Do NOT wait to be @-mentioned. Being addressed just means "definitely answer now."
- Stay quiet during pure social chatter — silence is normal. To stay silent, just don't call reply.
- For real GitHub work, call delegate() then reply() to narrate what came back.`;

/**
 * Appended to every persona. The group is tool-driven: the ONLY channel to the
 * humans is the `reply` tool — assistant prose is drained and discarded, never
 * delivered. Without this, the model answers a clear question in plain text,
 * calls no tool, and the group hears nothing (verified against the Codex
 * backend). Spelling out the contract makes it call `reply`, while still
 * choosing silence (no tool call) on off-topic chatter.
 */
const SPEECH_CONTRACT = `

How the group hears you: they ONLY see messages you send by calling the reply tool. Any text you write outside a tool call is discarded — nobody sees it. So whenever you want to say ANYTHING, you must call reply with that text. If you have nothing to add, call no tools at all — that is how you stay silent.`;

/** `HH:MM:SS`, matching the whatsapp.ts traffic logs so turns interleave readably. */
const stamp = (): string => new Date().toTimeString().slice(0, 8);

/**
 * How many recent transcript messages to keep as per-chat memory (incoming
 * messages + the bot's own replies). Bounds growth; text-only so the window can
 * be sliced anywhere without splitting a tool-call frame. Deeper, durable state
 * is issue #1.
 */
const MAX_HISTORY = 30;

/** A readable one-liner from whatever the model/tool layer threw. AI SDK errors carry the
 * useful text on `.message` (e.g. "The usage limit has been reached"), often wrapped in a
 * RetryError — surface that rather than a stringified object. */
const errText = (cause: unknown): string =>
  cause instanceof Error ? cause.message : typeof cause === "string" ? cause : JSON.stringify(cause);

/** One line telling the model why it woke — addressed → answer now; ambient → only if useful. */
const noteFor = (reason: FireReason): string =>
  reason === "mention"
    ? "You were just @-mentioned — answer now."
    : reason === "quote-reply"
      ? "Someone just replied to one of your messages — answer now."
      : "No one addressed you directly — jump in only if you can genuinely help; otherwise stay silent.";

/**
 * The voice as a `Conversationalist` Layer. `persona` is the system prompt — pass
 * a chat-specific one (e.g. a bug-intake persona for a QA group); it defaults to a
 * general helpful-group-member persona.
 */
export const aiVoice = (persona: string = DEFAULT_PERSONA): Layer.Layer<Conversationalist, never, Outbound | Worker> =>
  Layer.effect(
    Conversationalist,
    Effect.gen(function* () {
      const outbound = yield* Outbound;
      const worker = yield* Worker;
      // Build the model once — it's pure allocation (credentials are read lazily, per
      // request), so there's nothing per-turn to gain by rebuilding it.
      const model = subscriptionModel();
      // Per-chat rolling transcript — the voice's memory across fires. One Coalescer
      // fiber per chat means a chat's turns are sequential, so the read-then-update below
      // never races itself; Ref.update keeps writes for different chats independent.
      const histories = yield* Ref.make(HashMap.empty<string, ModelMessage[]>());
      return {
        turn: (window) =>
          Effect.gen(function* () {
            const chatId = window.chatId;
            const prior = Option.getOrElse(HashMap.get(yield* Ref.get(histories), chatId), () => [] as ModelMessage[]);
            const incoming = window.messages.map(
              (m): ModelMessage => ({ role: "user", content: `${m.pushName ?? m.from}: ${m.text}` }),
            );
            const runtime = yield* Effect.runtime<never>();

            // Typing shows ONLY when the voice actually acts: this latch fires on the first
            // reply/delegate call, so a silent turn never flashes "typing…". Once lit, it's
            // refreshed on a timer (WhatsApp expires it ~25s) and raced against the turn, so
            // it stops the instant the turn ends.
            const acting = yield* Deferred.make<void>();
            const keepTyping = Deferred.await(acting).pipe(
              Effect.zipRight(
                outbound
                  .setTyping(chatId, true)
                  .pipe(Effect.zipRight(Effect.sleep(Duration.seconds(8))), Effect.forever),
              ),
            );

            // Run each tool's Effect on the turn fiber's OWN runtime (not a bare, detached
            // `Effect.runPromise`) so log context and — the load-bearing part — interruption
            // propagate into an in-flight tool, e.g. a long blocking `worker.delegate` that
            // must be torn down when the loop's scope closes.
            const runTurn = Effect.tryPromise({
              try: async (signal) => {
                const run = <A>(eff: Effect.Effect<A>): Promise<A> => Runtime.runPromise(runtime)(eff, { signal });
                // "The voice is acting" — light the typing latch (a no-op once lit), then run the
                // outbound Effect. Both tools go through here, so typing switches on for any action.
                const act = <A>(eff: Effect.Effect<A>): Promise<A> =>
                  run(Deferred.succeed(acting, undefined).pipe(Effect.zipRight(eff)));
                const replies: string[] = [];
                let delegated = false;
                let streamError: unknown;
                const result = streamText({
                  model,
                  // Persona + the reply contract + a one-line note on why we woke. The
                  // conversation itself (incl. the bot's own past replies) rides in `messages`.
                  system: `${persona}${SPEECH_CONTRACT}\n\n(${noteFor(window.reason)})`,
                  messages: [...prior, ...incoming],
                  stopWhen: stepCountIs(6),
                  abortSignal: signal,
                  // consumeStream() swallows+logs stream errors by default; capture the real
                  // cause here and rethrow below so the failure reaches `catch`, not the console.
                  onError: ({ error }) => {
                    streamError = error;
                  },
                  tools: {
                    reply: tool({
                      description: "Say something in the group. This is the ONLY way the group hears you.",
                      inputSchema: z.object({ text: z.string() }),
                      execute: ({ text }) => {
                        replies.push(text);
                        return act(outbound.reply(chatId, text));
                      },
                    }),
                    delegate: tool({
                      description: "Hand real GitHub work to the Worker; returns its result to narrate.",
                      inputSchema: z.object({ instruction: z.string() }),
                      // Never let a Worker failure reject the tool mid-turn: fold it into a
                      // result the model can narrate, exactly as the stub's delegateAndNarrate does.
                      execute: ({ instruction }) => {
                        delegated = true;
                        return act(
                          worker.delegate({ chatId, instruction }).pipe(
                            Effect.catchAll((err) => Effect.succeed({ summary: `couldn't do that: ${String(err)}` })),
                          ),
                        );
                      },
                    }),
                  },
                });
                await result.consumeStream({ onError: () => {} });
                if (streamError !== undefined) throw streamError;
                // Silence is a DECISION — log it as loudly as a reply, so the terminal always
                // shows what the voice CHOSE, never just an absence you have to interpret.
                const spoke = replies.length > 0;
                const decision =
                  delegated && spoke
                    ? "🛠️  delegated + replied"
                    : delegated
                      ? "🛠️  delegated, no reply"
                      : spoke
                        ? "💬 replied"
                        : "🤫 chose to stay silent";
                console.log(`[${stamp()}] ${decision} — ${chatId}`);
                return replies;
              },
              catch: (cause) => new ConversationError({ cause }),
            });

            // Announce the wake-up (eligible + why: addressed vs ambient), run the turn with
            // typing gated on action, and always clear typing on the way out.
            const addressed = window.reason !== "debounce";
            yield* Effect.sync(() =>
              console.log(
                `[${stamp()}] 🗣️  voice turn — ${addressed ? `addressed (${window.reason})` : "ambient"}, ${window.messages.length} msg → ${chatId}`,
              ),
            );
            const replies = yield* Effect.race(runTurn, keepTyping).pipe(
              // A wedged/throttled backend must not hang the chat's loop or leave "typing…"
              // stuck on — time the turn out into a normal ConversationError the Coalescer
              // logs. Generous, so a legitimately long delegate (GitHub work) isn't killed.
              Effect.timeoutFail({
                duration: Duration.seconds(90),
                onTimeout: () => new ConversationError({ cause: "voice turn timed out" }),
              }),
              // Surface the REAL cause loudly (usage limit, auth, backend) — a failed turn must
              // never be a silent gap you have to guess about. The Coalescer logs it too; this
              // is the unmissable, human-readable line right in the traffic log.
              Effect.tapError((err) =>
                Effect.sync(() => console.error(`[${stamp()}] ❌ voice turn failed — ${errText(err.cause)} → ${chatId}`)),
              ),
              Effect.ensuring(outbound.setTyping(chatId, false)),
            );

            // Remember this turn: the incoming messages + what the voice actually said (its
            // own replies, joined into one assistant turn). A silent turn stores just the
            // incoming messages. Bounded to the most recent MAX_HISTORY so it can't grow
            // without limit.
            const spoken: ModelMessage[] = replies.length ? [{ role: "assistant", content: replies.join("\n") }] : [];
            yield* Ref.update(histories, HashMap.set(chatId, [...prior, ...incoming, ...spoken].slice(-MAX_HISTORY)));
          }),
      };
    }),
  );
