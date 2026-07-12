/**
 * Rung 2 — the voice in a REAL WhatsApp chat (`pnpm run live`).
 *
 * Wires the real Coalescer + real model-backed voice to a live whatsappd
 * session: real messages in, real replies out. Only the Worker is still a stub
 * (an honest placeholder) — swapping it for the real `agent/` GitHub agent is
 * Rung 2b (the one Eve doorway). The voice bills the local Codex login, so this
 * is local-dev only, exactly like the REPL.
 *
 * SAFETY: the voice replies for real and engages on relevance, not just when
 * @-mentioned, so a chat gate is mandatory — set WHATSAPP_GROUP_ID (or _IDS) to
 * your test group, or WHATSAPP_ALLOW_DM=true for a solo DM. With nothing set the
 * bot stays fully silent (fail closed).
 *
 * First run prints a QR to link the device; creds persist under WHATSAPP_STORE_DIR
 * (default ./.wa-auth), shared with the `pnpm whatsapp` sidecar.
 */
import { Console, Effect, Layer } from "effect";
import * as Coalescer from "./coalescer.ts";
import { configLayer } from "./config.ts";
import { Worker } from "./ports.ts";
import { aiVoice } from "./voice.ts";
import { botIdOf, openSession, whatsappEventSource, whatsappOutbound } from "./whatsapp.ts";

try {
  process.loadEnvFile();
} catch {
  // No .env — use the ambient environment as-is.
}

const STORE_DIR = process.env.WHATSAPP_STORE_DIR ?? "./.wa-auth";

// Chat gate — mirrors agent/channels/whatsapp.ts. Fail closed: an unset target
// silences the bot rather than turning it loose on every chat the number is in.
const parseSet = (raw: string | undefined): ReadonlySet<string> =>
  new Set((raw ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
const GROUPS = parseSet(process.env.WHATSAPP_GROUP_IDS ?? process.env.WHATSAPP_GROUP_ID);
const ALLOW_ANY_GROUP = process.env.WHATSAPP_ALLOW_ANY_GROUP === "true";
const ALLOW_DM = process.env.WHATSAPP_ALLOW_DM === "true";

const chatAllowed = (chatId: string, isGroup: boolean): boolean =>
  isGroup ? (GROUPS.size > 0 ? GROUPS.has(chatId.toLowerCase()) : ALLOW_ANY_GROUP) : ALLOW_DM;

// Worker: honest stub until Rung 2b wires the real agent/ GitHub agent. It does
// no GitHub work; it logs the hand-off and tells the voice what it *would* do, so
// a live test never claims work it didn't do.
const stubWorker = Layer.succeed(Worker, {
  delegate: (task) =>
    Effect.sync(() => console.log(`🛠️  delegate → ${task.instruction}`)).pipe(
      Effect.as({ summary: `(worker not wired yet — would handle: ${task.instruction})` }),
    ),
});

const program = Effect.gen(function* () {
  if (GROUPS.size === 0 && !ALLOW_ANY_GROUP && !ALLOW_DM) {
    yield* Console.warn(
      "⚠️  No chat target set — the bot will stay silent. Set WHATSAPP_GROUP_ID=<jid@g.us> " +
        "(or WHATSAPP_ALLOW_DM=true) and re-run.",
    );
  }
  yield* Console.log(`connecting to WhatsApp (store: ${STORE_DIR})…`);

  const session = yield* openSession(STORE_DIR);
  const botId = botIdOf(session);
  yield* Console.log(
    `online as ${botId} — watching ${
      GROUPS.size > 0 ? [...GROUPS].join(", ") : ALLOW_ANY_GROUP ? "any group" : ALLOW_DM ? "DMs" : "nothing"
    }\n`,
  );

  const services = Layer.mergeAll(
    aiVoice.pipe(Layer.provideMerge(Layer.merge(whatsappOutbound(session), stubWorker))),
    configLayer({ botId }),
    whatsappEventSource(session, chatAllowed),
  );

  // Runs until the process is killed; the scope's finalizers stop the session.
  yield* Coalescer.run.pipe(Effect.provide(services));
});

Effect.runPromise(Effect.scoped(program)).catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
