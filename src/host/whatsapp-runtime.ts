import { createRequire } from "node:module";
import { join } from "node:path";

import { Effect, Exit, Fiber, Layer, type Scope } from "effect";
import type { WhatsAppSession } from "whatsappd";

import { makeAmbienceWindowDispatcher, type DispatchAmbience } from "../ambience/dispatch.js";
import { makeChatGate, type ChatGate } from "../coalescer/chat-gate.js";
import * as Coalescer from "../coalescer/coalescer.js";
import { configLayer, type CoalescerConfigValues } from "../coalescer/config.js";
import { botIdsOf, whatsappEventSource } from "../coalescer/whatsapp.js";
import { createConversationArchive } from "../intake/conversation-archive.js";
import { createWhatsAppAccount } from "../whatsapp/account.js";
import { configureWhatsAppHistory, type WhatsAppHistory } from "./whatsapp-history.js";
import { configureWhatsAppHost, type WhatsAppHost, type WhatsAppSayResult } from "./whatsapp-host.js";

const errorMessage = (cause: unknown): string => (cause instanceof Error ? cause.message : String(cause));
const isKnownPreSendFailure = (message: string): boolean => /^not online \(phase: [^)]+\)$/.test(message);

type DeliveryReceipt =
  | { readonly delivery: "sent"; readonly messageId: string }
  | { readonly delivery: "failed" | "unknown"; readonly deliveryError: string };

const combineReceipt = (delivery: DeliveryReceipt, typingError?: string): WhatsAppSayResult => {
  if (delivery.delivery === "sent") {
    return typingError === undefined
      ? { ...delivery, typing: "cleared" }
      : { ...delivery, typing: "unknown", typingError };
  }
  return typingError === undefined
    ? { ...delivery, typing: "cleared" }
    : { ...delivery, typing: "unknown", typingError };
};

/** The sole real implementation behind Ambience's `say` tool. It never retries an uncertain provider outcome. */
export const createWhatsAppHost = (session: WhatsAppSession): WhatsAppHost => ({
  say: async (chatId, text) => {
    try {
      await session.setTyping(chatId, true);
    } catch (cause) {
      console.warn(`[ambience] typing-on failed for ${chatId}: ${errorMessage(cause)}`);
    }

    let delivery: DeliveryReceipt;
    try {
      const message = await session.send(chatId, { text });
      delivery = { delivery: "sent", messageId: message.id };
      console.info(JSON.stringify({ event: "whatsapp.say.sent", chatId, messageId: message.id }));
    } catch (cause) {
      const deliveryError = errorMessage(cause);
      const outcome = isKnownPreSendFailure(deliveryError) ? "failed" : "unknown";
      delivery = { delivery: outcome, deliveryError };
      console.error(
        JSON.stringify({
          event: `whatsapp.say.${outcome}`,
          chatId,
          error: deliveryError,
        }),
      );
    }

    let typingError: string | undefined;
    try {
      await session.setTyping(chatId, false);
      console.info(JSON.stringify({ event: "whatsapp.typing.cleared", chatId }));
    } catch (cause) {
      typingError = errorMessage(cause);
      console.error(JSON.stringify({ event: "whatsapp.typing.unknown", chatId, error: typingError }));
    }
    return combineReceipt(delivery, typingError);
  },
});

export interface WhatsAppSessionRuntimeOptions {
  readonly gate: ChatGate;
  readonly history: WhatsAppHistory;
  readonly dispatch?: DispatchAmbience;
  readonly coalescer?: Partial<CoalescerConfigValues>;
  readonly botLid?: string;
}

/** Shared production/test seam: one full-fidelity whatsappd session -> retained Coalescer -> Ambience dispatch. */
export const runWhatsAppSession = (
  session: WhatsAppSession,
  options: WhatsAppSessionRuntimeOptions,
): Effect.Effect<void, never, Scope.Scope> => {
  configureWhatsAppHistory(options.history);
  configureWhatsAppHost(createWhatsAppHost(session));
  const botIds = botIdsOf(session, options.botLid);
  return Coalescer.run.pipe(
    Effect.provide(
      Layer.mergeAll(
        whatsappEventSource(session, options.gate.allowed),
        makeAmbienceWindowDispatcher(options.dispatch),
        configLayer({ ...options.coalescer, botIds }),
      ),
    ),
  );
};

export type WhatsAppRuntimePhase = "disabled" | "starting" | "online" | "failed" | "stopped";
export interface WhatsAppRuntimeStatus {
  readonly phase: WhatsAppRuntimePhase;
  readonly chatTarget?: string;
  readonly botIds?: readonly string[];
  readonly error?: string;
}

let status: WhatsAppRuntimeStatus = { phase: "disabled" };
export const getWhatsAppRuntimeStatus = (): WhatsAppRuntimeStatus => structuredClone(status);

export interface WhatsAppRuntimeControl {
  readonly stop: () => Promise<void>;
}

export const startWhatsAppRuntime = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): WhatsAppRuntimeControl => {
  if (env.AMBIENCE_WHATSAPP !== "1") {
    status = { phase: "disabled" };
    return { stop: async () => undefined };
  }

  const storeDir = env.WHATSAPP_STORE_DIR?.trim() || "./.wa-auth";
  const gate = makeChatGate({
    groupIds: env.WHATSAPP_GROUP_IDS ?? env.WHATSAPP_GROUP_ID,
    allowAnyGroup: env.WHATSAPP_ALLOW_ANY_GROUP,
    allowDm: env.WHATSAPP_ALLOW_DM,
  });
  const applicationDatabase = join(storeDir, "..", "application.sqlite");
  const archive = createConversationArchive(applicationDatabase);
  const account = createWhatsAppAccount({ storeDirectory: storeDir, archive });
  status = { phase: "starting", chatTarget: gate.describe() };
  let stopping = false;

  const program = Effect.gen(function* () {
    yield* Effect.addFinalizer(() => Effect.sync(() => archive.close()));
    yield* Effect.addFinalizer(() => Effect.promise(() => account.stop()));
    if (!gate.hasTarget) {
      yield* Effect.logWarning("No managed WhatsApp chat is configured; ingress remains fail-closed.");
    }
    yield* Effect.promise(() => account.authenticate({
      onPairing: (pairing) => {
        if (pairing.qr !== undefined) {
          const qr = createRequire(import.meta.url)("qrcode-terminal") as {
            generate(value: string, options: { readonly small: boolean }): void;
          };
          qr.generate(pairing.qr, { small: true });
        } else if (pairing.code !== undefined) {
          console.info(`[ambience] WhatsApp pairing code: ${pairing.code}`);
        }
      },
    }));
    const session = account.session();
    const botIds = botIdsOf(session, env.WHATSAPP_BOT_LID);
    status = { phase: "online", chatTarget: gate.describe(), botIds };
    yield* Effect.logInfo(`Ambience WhatsApp online as ${botIds.join(" / ")} — watching ${gate.describe()}`);
    yield* runWhatsAppSession(session, { gate, history: archive, botLid: env.WHATSAPP_BOT_LID });
  });

  const fiber = Effect.runFork(Effect.scoped(program));
  void Effect.runPromise(Fiber.await(fiber)).then((exit) => {
    if (Exit.isFailure(exit) && !stopping) {
      status = { phase: "failed", chatTarget: gate.describe(), error: String(exit.cause) };
      console.error(`[ambience] WhatsApp runtime failed: ${String(exit.cause)}`);
    } else {
      status = { phase: "stopped", chatTarget: gate.describe() };
    }
  });
  return {
    stop: async () => {
      stopping = true;
      await Effect.runPromise(Fiber.interrupt(fiber));
      status = { phase: "stopped", chatTarget: gate.describe() };
    },
  };
};
