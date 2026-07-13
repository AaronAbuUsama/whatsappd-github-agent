/**
 * The gateway — whatsappd + Coalescer, hosted INSIDE the `eve start` process
 * (issue #6). This is the real thing the #4 R2 spike stood in for: one process
 * serves the Eve agent over HTTP and, in the same process, runs the always-on
 * WhatsApp connection whose coalesced windows fire back into the agent over the
 * loopback doorway.
 *
 * Flow, all in one process:
 *
 *   WhatsApp ⇄ whatsappd session ─(onMessage)→ Coalescer ─(fire)→ doorway voice
 *     → eve/client loopback POST → Eve voice session (durable, per-chat)
 *     → `say` tool calls harvested → whatsappd session.send → WhatsApp
 *
 * The doorway voice resumes each chat's session by `SessionState` (see
 * doorway.ts / the #4 finding), and delivers ONLY the model's `say` output. The
 * `chatId → SessionState` store shares the durable SQLite database with the
 * non-blocking jobs queue, so both pending work and its report-back cursor
 * survive a restart.
 *
 * Reuses the coalescer's real WhatsApp seams (`openSession`, `whatsappEventSource`,
 * `whatsappOutbound`, `botIdsOf`) and its config/run — unchanged — exactly as
 * `src/coalescer/live.ts` wires them for the standalone `pnpm run live` harness.
 * The only substitution is the voice: the doorway voice instead of the hand-rolled
 * `aiVoice`.
 */
import { Duration, Effect, Layer, Schedule } from "effect";
import { Client } from "eve/client";
import { GatewayStore } from "./lib/jobs.ts";
import { persistWhatsAppMessages } from "./lib/whatsapp-messages.ts";
import { makeChatGate } from "../src/coalescer/chat-gate.ts";
import * as Coalescer from "../src/coalescer/coalescer.ts";
import { configLayer } from "../src/coalescer/config.ts";
import { doorwayVoice, eveVoiceModel } from "../src/coalescer/doorway.ts";
import { eveJobLoopback, jobRunner } from "../src/gateway/job-runner.ts";
import { botIdsOf, openSession, whatsappEventSource, whatsappOutbound } from "../src/coalescer/whatsapp.ts";

const STORE_DIR = process.env.WHATSAPP_STORE_DIR ?? "./.wa-auth";

// The chat gate — which chats the bot engages. Fail closed (see chat-gate.ts).
const gate = makeChatGate({
  groupIds: process.env.WHATSAPP_GROUP_IDS ?? process.env.WHATSAPP_GROUP_ID,
  allowAnyGroup: process.env.WHATSAPP_ALLOW_ANY_GROUP,
  allowDm: process.env.WHATSAPP_ALLOW_DM,
});

/** The loopback host for the doorway — the app's own HTTP front door (#4). */
const loopbackHost = (): string => {
  const port = process.env.PORT ?? process.env.NITRO_PORT ?? "3000";
  return process.env.EVE_URL ?? `http://127.0.0.1:${port}`;
};

/**
 * Block until our own HTTP server accepts connections (setup can fire before the
 * listener is ready): retry `client.health()` up to 40 times, 250ms apart.
 * Succeeds `void` once healthy; fails if the server never comes up.
 */
const waitForHealth = (client: Client): Effect.Effect<void, Error> =>
  Effect.tryPromise({ try: () => client.health(), catch: () => new Error("server not healthy yet") }).pipe(
    Effect.retry(Schedule.intersect(Schedule.spaced(Duration.millis(250)), Schedule.recurs(39))),
    Effect.asVoid,
  );

/**
 * Launch the gateway. Detached (not awaited) from `instrumentation.setup`, this
 * models the always-on connection, not per-request work. Runs until the process
 * exits; the coalescer's scope finalizers stop the WhatsApp session on shutdown.
 */
export async function startGateway(agentName: string): Promise<void> {
  const host = loopbackHost();
  const client = new Client({ host });
  const store = new GatewayStore();
  store.reclaimRunning();
  const model = eveVoiceModel(client, store);

  const program = Effect.gen(function* () {
    yield* Effect.addFinalizer(() => Effect.sync(() => store.close()));
    yield* waitForHealth(client).pipe(
      Effect.tapError(() => Effect.logError(`server did not become healthy at ${host}; WhatsApp not started`)),
    );
    yield* Effect.logInfo(`server healthy at ${host} (agent=${agentName}); connecting to WhatsApp…`);
    if (!gate.hasTarget) {
      yield* Effect.logWarning(
        "No chat target set — the bot will stay silent. Set WHATSAPP_GROUP_ID=<jid@g.us> " +
          "(or WHATSAPP_ALLOW_DM=true) and restart.",
      );
    }

    const session = yield* openSession(STORE_DIR, (rawSession) => {
      const persisted = persistWhatsAppMessages(rawSession, store);
      return { session: persisted.session, finalize: persisted.unsubscribe };
    });
    // The bot's identities for @-mention/quote matching: its phone-number JID plus,
    // in a LID-addressed group, its @lid JID (WHATSAPP_BOT_LID) — see botIdsOf.
    const botIds = botIdsOf(session, process.env.WHATSAPP_BOT_LID);
    yield* Effect.logInfo(`online as ${botIds.join(" / ")} — watching ${gate.describe()}`);

    const jobLoopback = eveJobLoopback(client, async (chatId, text) => {
      await session.send(chatId, { text });
    });
    yield* Effect.forkScoped(jobRunner(store, jobLoopback));
    yield* Effect.logInfo("non-blocking delegation runner started");

    const services = Layer.mergeAll(
      doorwayVoice(model).pipe(Layer.provide(whatsappOutbound(session))),
      configLayer({ botIds }),
      whatsappEventSource(session, gate.allowed),
    );

    // Runs until the process is killed; the scope's finalizers stop the session.
    yield* Coalescer.run.pipe(Effect.provide(services));
  });

  // Boundary safety net: the program logs its own failures via Effect; this only
  // catches a defect that escaped the runtime so the detached task can't crash silently.
  await Effect.runPromise(Effect.scoped(program)).catch((err: unknown) => {
    console.error("[gateway] crashed:", err instanceof Error ? (err.stack ?? err.message) : err);
  });
}
