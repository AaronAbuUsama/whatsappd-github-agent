import { Cause, Effect, Exit, Fiber, Layer, type Scope } from "effect";
import type { MessageRef, WhatsAppSession } from "whatsappd";

import { makeAmbienceWindowDispatcher, type DispatchAmbience } from "../ambience/dispatch.js";
import {
  configureWhatsAppParticipationPort,
  type WhatsAppHistoryPort,
  type WhatsAppMessageLookupPort,
  type WhatsAppOutboundPort,
  type WhatsAppDeliveryResult,
  withTypingResult,
} from "../capabilities/whatsapp-participation/whatsapp-port.js";
import { makeManagedChatGate, type ChatGate } from "../coalescer/chat-gate.js";
import * as Coalescer from "../coalescer/coalescer.js";
import { configLayer, type CoalescerConfigValues } from "../coalescer/config.js";
import { botIdsOf, whatsappEventSource } from "../coalescer/whatsapp.js";
import { createConversationArchive } from "../intake/conversation-archive.js";
import { createManagedChatInbox, managedChatWindowStore, type ManagedChatInbox } from "../intake/managed-chat-inbox.js";
import { configureAgentActivityRecovery, reportAgentSpoke } from "../logging/agent-activity-reporter.js";
import { effectLoggerLayer, getLogger, upstreamWhatsAppLogger } from "../logging/logging.js";
import type { WhatsAppRuntimeStatus } from "../managed/runtime-health.js";
import { errorMessage } from "../shared/errors.js";
import { renderQr } from "../shared/qr.js";
import { createWhatsAppAccount, WhatsAppAccountError } from "../whatsapp/account.js";

const isKnownPreSendFailure = (message: string): boolean => /^not online \(phase: [^)]+\)$/.test(message);
const TYPING_LEAD_MS = 750;

/** The sole real implementation behind Ambience's outbound participation tools. */
export const createWhatsAppHost = (
  session: WhatsAppSession,
  lookupMessage: (chatId: string, messageId: string) => MessageRef | undefined = () => undefined,
): WhatsAppOutboundPort => ({
  say: async (chatId, text, replyTo) => {
    const log = getLogger("whatsapp");
    let typingStarted = false;
    try {
      await session.setTyping(chatId, true);
      typingStarted = true;
    } catch (cause) {
      log.warn({ chatId, error: errorMessage(cause) }, "Typing-on failed before a WhatsApp reply");
    }

    if (typingStarted) await new Promise((resolve) => setTimeout(resolve, TYPING_LEAD_MS));

    let delivery: WhatsAppDeliveryResult;
    let typingError: string | undefined;
    try {
      try {
        const quote = replyTo === undefined ? undefined : lookupMessage(chatId, replyTo);
        if (replyTo !== undefined && quote === undefined) {
          delivery = {
            delivery: "failed",
            deliveryError: `WhatsApp message ${replyTo} is not available in ${chatId}.`,
          };
        } else {
          const message = await session.send(chatId, { text }, quote === undefined ? undefined : { quote });
          delivery = { delivery: "sent", messageId: message.id };
          if (!reportAgentSpoke(chatId, text, message.id)) {
            log.info(
              { operatorEvent: "agent.say", text, chatId, messageId: message.id },
              "Ambience said a WhatsApp message",
            );
          }
        }
      } catch (cause) {
        const deliveryError = errorMessage(cause);
        const outcome = isKnownPreSendFailure(deliveryError) ? "failed" : "unknown";
        delivery = { delivery: outcome, deliveryError };
        log.error({ chatId, error: deliveryError }, `WhatsApp reply delivery ${outcome}`);
      }
    } finally {
      try {
        await session.setTyping(chatId, false);
        log.debug({ chatId }, "WhatsApp typing indicator cleared");
      } catch (cause) {
        typingError = errorMessage(cause);
        log.warn({ chatId, error: typingError }, "WhatsApp typing indicator state is unknown");
      }
    }
    return withTypingResult(delivery, typingError);
  },
  react: async (chatId, messageId, emoji) => {
    const target = lookupMessage(chatId, messageId);
    if (target === undefined) {
      return withTypingResult({
        delivery: "failed",
        deliveryError: `WhatsApp message ${messageId} is not available in ${chatId}.`,
      });
    }
    try {
      const message = await session.send(chatId, { react: { to: target, emoji } });
      getLogger("whatsapp").info(
        { operatorEvent: "agent.react", emoji, chatId, targetMessageId: messageId },
        "Ambience reacted to a WhatsApp message",
      );
      return withTypingResult({ delivery: "sent", messageId: message.id });
    } catch (cause) {
      const deliveryError = errorMessage(cause);
      const outcome = isKnownPreSendFailure(deliveryError) ? "failed" : "unknown";
      getLogger("whatsapp").error({ chatId, error: deliveryError }, `WhatsApp reaction delivery ${outcome}`);
      return withTypingResult({ delivery: outcome, deliveryError });
    }
  },
});

export interface WhatsAppSessionRuntimeOptions {
  readonly gate: ChatGate;
  readonly history: WhatsAppHistoryPort & WhatsAppMessageLookupPort;
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
  const outbound = createWhatsAppHost(session, (chatId, messageId) => {
    const message = options.history.messageState(chatId, messageId);
    return message === undefined
      ? undefined
      : {
          id: message.id,
          chatId: message.chatId,
          fromMe: message.direction === "outbound",
          ...(message.chatId.endsWith("@g.us") && message.senderId !== undefined
            ? { participant: message.senderId }
            : {}),
        };
  });
  configureWhatsAppParticipationPort({
    say: outbound.say,
    react: outbound.react,
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

const WHATSAPP_RUNTIME_STATUS = Symbol.for("ambient-agent.whatsapp-runtime-status");
const runtimeGlobal = globalThis as typeof globalThis & { [WHATSAPP_RUNTIME_STATUS]?: WhatsAppRuntimeStatus };
const runtimeStatus = (): WhatsAppRuntimeStatus => (runtimeGlobal[WHATSAPP_RUNTIME_STATUS] ??= { phase: "disabled" });
const setRuntimeStatus = (status: WhatsAppRuntimeStatus): void => {
  runtimeGlobal[WHATSAPP_RUNTIME_STATUS] = status;
};
export const getWhatsAppRuntimeStatus = (): WhatsAppRuntimeStatus => structuredClone(runtimeStatus());

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
  configureAgentActivityRecovery((dispatchId) => {
    const window = inbox.windowForDispatch(dispatchId);
    return window === undefined
      ? undefined
      : { windowId: window.id, chatId: window.chatId, messageCount: window.messages.length };
  });
  const account = createWhatsAppAccount({
    storeDirectory: storeDir,
    archive: inbox.recorder,
    logger: upstreamWhatsAppLogger(),
    ...(options.sessionFactory === undefined ? {} : { sessionFactory: options.sessionFactory }),
  });
  const log = getLogger("whatsapp");
  setRuntimeStatus({ phase: "starting", chatTarget: gate.describe() });
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
            renderQr(pairing.qr);
          } else if (pairing.code !== undefined) {
            // Pairing UX, not a log record: the user must see the code, and it must not land in log files.
            process.stdout.write(`WhatsApp pairing code: ${pairing.code}\n`);
          }
        },
      }),
    );
    const session = account.session();
    const botIds = botIdsOf(session, options.botLid);
    setRuntimeStatus({ phase: "online", chatTarget: gate.describe(), botIds });
    yield* Effect.sync(() =>
      log.info(
        {
          operatorEvent: "agent.online",
          detail: "managed chat connected",
          botIds,
          chatTarget: gate.describe(),
        },
        "Ambience WhatsApp online",
      ),
    );
    yield* runWhatsAppSession(session, { gate, history: archive, inbox, botLid: options.botLid });
  });

  const fiber = Effect.runFork(Effect.scoped(program).pipe(Effect.provide(effectLoggerLayer(log))));
  void Effect.runPromise(Fiber.await(fiber)).then((exit) => {
    if (Exit.isFailure(exit) && !stopping) {
      setRuntimeStatus({ phase: "failed", chatTarget: gate.describe(), error: String(exit.cause) });
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
      setRuntimeStatus({ phase: "stopped", chatTarget: gate.describe() });
    }
  });
  return {
    stop: async () => {
      stopping = true;
      await Effect.runPromise(Fiber.interrupt(fiber));
      setRuntimeStatus({ phase: "stopped", chatTarget: gate.describe() });
    },
  };
};
