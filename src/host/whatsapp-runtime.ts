import { createRequire } from "node:module";

import { Cause, Effect, Exit, Fiber, Layer, type Scope } from "effect";
import type { WhatsAppSession } from "whatsappd";

import { makeAmbienceWindowDispatcher, type DispatchAmbience } from "../ambience/dispatch.js";
import {
  configureWhatsAppParticipationPort,
  type WhatsAppHistoryPort,
  type WhatsAppSayPort,
  type WhatsAppSayResult,
} from "../capabilities/whatsapp-participation/whatsapp-port.js";
import { makeManagedChatGate, type ChatGate } from "../coalescer/chat-gate.js";
import * as Coalescer from "../coalescer/coalescer.js";
import { configLayer, type CoalescerConfigValues } from "../coalescer/config.js";
import { botIdsOf, whatsappEventSource } from "../coalescer/whatsapp.js";
import { createConversationArchive } from "../intake/conversation-archive.js";
import { createManagedChatInbox, managedChatWindowStore, type ManagedChatInbox } from "../intake/managed-chat-inbox.js";
import { effectLoggerLayer, getLogger, upstreamWhatsAppLogger } from "../logging/logging.js";
import { createWhatsAppAccount, WhatsAppAccountError } from "../whatsapp/account.js";

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
export const createWhatsAppHost = (session: WhatsAppSession): WhatsAppSayPort => ({
  say: async (chatId, text) => {
    const log = getLogger("whatsapp");
    try {
      await session.setTyping(chatId, true);
    } catch (cause) {
      log.warn({ chatId, error: errorMessage(cause) }, "Typing-on failed before a WhatsApp reply");
    }

    let delivery: DeliveryReceipt;
    try {
      const message = await session.send(chatId, { text });
      delivery = { delivery: "sent", messageId: message.id };
      log.info({ chatId, messageId: message.id }, "WhatsApp reply sent");
    } catch (cause) {
      const deliveryError = errorMessage(cause);
      const outcome = isKnownPreSendFailure(deliveryError) ? "failed" : "unknown";
      delivery = { delivery: outcome, deliveryError };
      log.error({ chatId, error: deliveryError }, `WhatsApp reply delivery ${outcome}`);
    }

    let typingError: string | undefined;
    try {
      await session.setTyping(chatId, false);
      log.debug({ chatId }, "WhatsApp typing indicator cleared");
    } catch (cause) {
      typingError = errorMessage(cause);
      log.warn({ chatId, error: typingError }, "WhatsApp typing indicator state is unknown");
    }
    return combineReceipt(delivery, typingError);
  },
});

export interface WhatsAppSessionRuntimeOptions {
  readonly gate: ChatGate;
  readonly history: WhatsAppHistoryPort;
  readonly inbox: ManagedChatInbox;
  readonly dispatch?: DispatchAmbience;
  readonly coalescer?: Partial<CoalescerConfigValues>;
  readonly botLid?: string;
}

/** Shared production/test seam: one full-fidelity whatsappd session -> retained Coalescer -> Ambience dispatch. */
export const runWhatsAppSession = (
  session: WhatsAppSession,
  options: WhatsAppSessionRuntimeOptions,
): Effect.Effect<void, never, Scope.Scope> => {
  const sayPort = createWhatsAppHost(session);
  configureWhatsAppParticipationPort({
    say: sayPort.say,
    readThread: (chatId, limit) => options.history.readThread(chatId, limit),
    search: (chatId, query, limit) => options.history.search(chatId, query, limit),
  });
  const botIds = botIdsOf(session, options.botLid);
  return Coalescer.run.pipe(
    Effect.provide(
      Layer.mergeAll(
        whatsappEventSource(session, options.gate.allowed, {
          replay: () => options.inbox.unwindowed(),
          accepted: (message) => options.inbox.pendingArrival(message.chatId, message.id),
        }),
        makeAmbienceWindowDispatcher(options.inbox, options.dispatch),
        managedChatWindowStore(options.inbox),
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

export interface WhatsAppRuntimeOptions {
  readonly storeDirectory: string;
  readonly applicationDatabase: string;
  readonly managedChats: readonly string[];
  readonly botLid?: string;
  /** Test seams only: a fake session and a captured exit instead of process.exit. */
  readonly sessionFactory?: () => WhatsAppSession;
  readonly exit?: (code: number) => void;
}

export const startWhatsAppRuntime = (options: WhatsAppRuntimeOptions): WhatsAppRuntimeControl => {
  const storeDir = options.storeDirectory;
  const gate = makeManagedChatGate(options.managedChats);
  const archive = createConversationArchive(options.applicationDatabase);
  const inbox = createManagedChatInbox(archive, { allowed: gate.allowed });
  const account = createWhatsAppAccount({
    storeDirectory: storeDir,
    archive: inbox.recorder,
    logger: upstreamWhatsAppLogger(),
    ...(options.sessionFactory === undefined ? {} : { sessionFactory: options.sessionFactory }),
  });
  const log = getLogger("whatsapp");
  status = { phase: "starting", chatTarget: gate.describe() };
  let stopping = false;

  const program = Effect.gen(function* () {
    yield* Effect.addFinalizer(() => Effect.sync(() => archive.close()));
    yield* Effect.addFinalizer(() => Effect.promise(() => account.stop()));
    if (!gate.hasTarget) {
      yield* Effect.logWarning("No managed WhatsApp chat is configured; ingress remains fail-closed.");
    }
    yield* Effect.promise(() =>
      account.authenticate({
        onPairing: (pairing) => {
          if (pairing.qr !== undefined) {
            const qr = createRequire(import.meta.url)("qrcode-terminal") as {
              generate(value: string, options: { readonly small: boolean }): void;
            };
            qr.generate(pairing.qr, { small: true });
          } else if (pairing.code !== undefined) {
            // Pairing UX, not a log record: the user must see the code, and it must not land in log files.
            process.stdout.write(`WhatsApp pairing code: ${pairing.code}\n`);
          }
        },
      }),
    );
    const session = account.session();
    const botIds = botIdsOf(session, options.botLid);
    status = { phase: "online", chatTarget: gate.describe(), botIds };
    yield* Effect.logInfo(`Ambience WhatsApp online as ${botIds.join(" / ")} — watching ${gate.describe()}`);
    yield* runWhatsAppSession(session, { gate, history: archive, inbox, botLid: options.botLid });
  });

  const fiber = Effect.runFork(Effect.scoped(program).pipe(Effect.provide(effectLoggerLayer(log))));
  void Effect.runPromise(Fiber.await(fiber)).then((exit) => {
    if (Exit.isFailure(exit) && !stopping) {
      status = { phase: "failed", chatTarget: gate.describe(), error: String(exit.cause) };
      log.error({ cause: String(exit.cause) }, "WhatsApp runtime failed");
      const loggedOut = exit.cause.reasons
        .filter(Cause.isDieReason)
        .some(({ defect }) => defect instanceof WhatsAppAccountError && defect.code === "logged_out");
      if (loggedOut) {
        // whatsappd clears its store on terminal logged_out; the session is unrecoverable
        // in-process. Exit cleanly (finalizers already ran) and point at the guided repair.
        process.stderr.write(
          "WhatsApp authentication ended in logged_out and the session store is no longer usable.\n" +
            "Run ambient-agent repair whatsapp to pair again; configuration, credentials, and history are preserved.\n",
        );
        (options.exit ?? process.exit)(1);
      }
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
