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
import { makeChatGate } from "./chat-gate.ts";
import * as Coalescer from "./coalescer.ts";
import { configLayer } from "./config.ts";
import { describeModel } from "./model.ts";
import { aiVoice } from "./voice.ts";
import { botIdsOf, openSession, whatsappEventSource, whatsappOutbound } from "./whatsapp.ts";
import { githubWorker } from "./worker.ts";

try {
  process.loadEnvFile();
} catch {
  // No .env — use the ambient environment as-is.
}

const STORE_DIR = process.env.WHATSAPP_STORE_DIR ?? "./.wa-auth";

// The chat gate — fail closed (see chat-gate.ts, shared with the in-process gateway).
const gate = makeChatGate({
  groupIds: process.env.WHATSAPP_GROUP_IDS ?? process.env.WHATSAPP_GROUP_ID,
  allowAnyGroup: process.env.WHATSAPP_ALLOW_ANY_GROUP,
  allowDm: process.env.WHATSAPP_ALLOW_DM,
});

// The voice's persona for this chat: a bug-intake assistant for non-technical QA
// testers of an iOS app. It gathers the details a good bug report needs, then
// delegates to the GitHub worker to file the issue and reports the link back.
const QA_PERSONA = `You're the bug-intake assistant in a WhatsApp group where non-technical QA testers report problems with an iOS app. They don't use GitHub — you file the reports for them.
- When someone describes a problem, gather what a good bug report needs with SHORT, friendly questions: steps to reproduce, what they expected vs. what actually happened, their device + iOS version, and how often it happens. Ask only for what's missing — don't interrogate, and don't ask for things they clearly already gave.
- Once you have enough (or the bug is obvious), call delegate with a clear, structured bug report: a one-line title, then a body with **Steps to reproduce**, **Expected**, **Actual**, **Device/iOS**, and **Frequency**. Then reply with the filed issue's number and link.
- Keep replies short and human — this is a chat, not a form.
- Stay quiet during off-topic chatter. You don't need to be @-mentioned to help.`;

const program = Effect.gen(function* () {
  if (!gate.hasTarget) {
    yield* Console.warn(
      "⚠️  No chat target set — the bot will stay silent. Set WHATSAPP_GROUP_ID=<jid@g.us> " +
        "(or WHATSAPP_ALLOW_DM=true) and re-run.",
    );
  }
  yield* Console.log(describeModel());
  yield* Console.log(`connecting to WhatsApp (store: ${STORE_DIR})…`);

  const session = yield* openSession(STORE_DIR);
  // The bot's identities to match @-mentions against: its phone-number JID plus,
  // in a LID-addressed group, its `@lid` JID (from WHATSAPP_BOT_LID — see botIdsOf).
  const botIds = botIdsOf(session, process.env.WHATSAPP_BOT_LID);
  yield* Console.log(`online as ${botIds.join(" / ")} — watching ${gate.describe()}\n`);

  const services = Layer.mergeAll(
    aiVoice(QA_PERSONA).pipe(Layer.provideMerge(Layer.merge(whatsappOutbound(session), githubWorker))),
    configLayer({ botIds }),
    whatsappEventSource(session, gate.allowed),
  );

  // Runs until the process is killed; the scope's finalizers stop the session.
  yield* Coalescer.run.pipe(Effect.provide(services));
});

Effect.runPromise(Effect.scoped(program)).catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
