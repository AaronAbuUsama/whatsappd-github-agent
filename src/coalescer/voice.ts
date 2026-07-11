/**
 * The voice (Agent 1) — a real, model-backed `Conversationalist`, as PLAIN
 * EFFECT wrapping the AI SDK. NOT an Eve agent: Eve can only start a session
 * from a "doorway" (an HTTP route / WS handler / scheduled job), and our caller
 * is a background timer (the Coalescer), which can't reach past that doorway.
 * The voice also doesn't NEED Eve — it only ever sees a recent window, not full
 * history, so Eve's durable cross-session memory would go unused. So the whole
 * hot path stays one Effect graph and the doorway problem evaporates. See
 * `docs/planning/COALESCER-VOICE-HANDOFF.md` §2.4–2.5.
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
 * `experimental_chatgpt()` bills the local ChatGPT/Codex login and so is
 * LOCAL-DEV ONLY — it fails in deployment (no Codex creds there). Branch on env
 * before shipping.
 */
import { Effect, Layer, Runtime } from "effect";
import { stepCountIs, streamText, tool } from "ai";
import { experimental_chatgpt } from "eve/models/openai";
import { z } from "zod";
import type { ConversationWindow } from "./events.ts";
import { Conversationalist, ConversationError, Outbound, Worker } from "./ports.ts";

const PERSONA = `You're a regular member of this WhatsApp group.
- Chime in WHENEVER you can genuinely help — someone's stuck, a bug/PR/issue comes up, a question you can answer.
- Do NOT wait to be @-mentioned. Being addressed just means "definitely answer now."
- Stay quiet during pure social chatter — silence is normal. To stay silent, just don't call reply.
- For real GitHub work, call delegate() then reply() to narrate what came back.`;

/**
 * Render the buffered window as a plain transcript plus a one-line note on how
 * the loop woke us (addressed → answer now; ambient → jump in only if useful),
 * so the model has the same context a human scrolling up would.
 */
const renderWindow = (window: ConversationWindow): string => {
  const transcript = window.messages.map((m) => `${m.pushName ?? m.from}: ${m.text}`).join("\n");
  const note =
    window.reason === "mention"
      ? "You were just @-mentioned — answer now."
      : window.reason === "quote-reply"
        ? "Someone just replied to one of your messages — answer now."
        : "No one addressed you directly — jump in only if you can genuinely help; otherwise stay silent.";
  return `Recent messages in the group:\n${transcript}\n\n(${note})`;
};

export const aiVoice: Layer.Layer<Conversationalist, never, Outbound | Worker> = Layer.effect(
  Conversationalist,
  Effect.gen(function* () {
    const outbound = yield* Outbound;
    const worker = yield* Worker;
    // Build the model once — it's pure allocation (credentials are read lazily, per
    // request), so there's nothing per-turn to gain by rebuilding it. This is also the
    // natural place to branch on env for a deployed model (experimental_chatgpt is
    // local-dev only; see the header note).
    const model = experimental_chatgpt();
    return {
      turn: (window) =>
        // Run each tool's Effect on the turn fiber's OWN runtime (not a bare, detached
        // `Effect.runPromise`) so log context and — the load-bearing part — interruption
        // propagate into an in-flight tool, e.g. a long blocking `worker.delegate` that
        // must be torn down when the loop's scope closes. Same runtime-capture seam
        // repl.ts uses to bridge stdin into the running program.
        Effect.runtime<never>().pipe(
          Effect.flatMap((runtime) =>
            Effect.tryPromise({
              try: async (signal) => {
                const run = <A>(eff: Effect.Effect<A>): Promise<A> => Runtime.runPromise(runtime)(eff, { signal });
                const chatId = window.chatId;
                let streamError: unknown;
                const result = streamText({
                  model,
                  system: PERSONA,
                  prompt: renderWindow(window),
                  stopWhen: stepCountIs(6),
                  abortSignal: signal,
                  // consumeStream() swallows+logs stream errors by default; capture the real
                  // cause here and rethrow below so the failure reaches `catch`, not the console.
                  onError: ({ error }) => {
                    streamError = error;
                  },
                  tools: {
                    reply: tool({
                      description: "Say something in the group.",
                      inputSchema: z.object({ text: z.string() }),
                      execute: ({ text }) => run(outbound.reply(chatId, text)),
                    }),
                    set_typing: tool({
                      description: "Show typing while you work.",
                      inputSchema: z.object({ on: z.boolean() }),
                      execute: ({ on }) => run(outbound.setTyping(chatId, on)),
                    }),
                    delegate: tool({
                      description: "Hand real GitHub work to the Worker; returns its result to narrate.",
                      inputSchema: z.object({ instruction: z.string() }),
                      // Never let a Worker failure reject the tool mid-turn: fold it into a
                      // result the model can narrate, exactly as the stub's delegateAndNarrate does.
                      execute: ({ instruction }) =>
                        run(
                          worker.delegate({ chatId, instruction }).pipe(
                            Effect.catchAll((err) => Effect.succeed({ summary: `couldn't do that: ${String(err)}` })),
                          ),
                        ),
                    }),
                  },
                });
                await result.consumeStream({ onError: () => {} });
                if (streamError !== undefined) throw streamError;
              },
              catch: (cause) => new ConversationError({ cause }),
            }),
          ),
        ),
    };
  }),
);
