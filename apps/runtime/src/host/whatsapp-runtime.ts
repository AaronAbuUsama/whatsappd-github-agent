import { Cause, Effect, Exit, Fiber, Layer, type Scope } from "effect";
import type { MessageRef, WhatsAppSession } from "whatsappd";

import { makeSpeakerWindowDispatcher, type DispatchSpeaker } from "@ambient-agent/agents/speaker/dispatch.ts";
import type { SpeakerDispatchEvent, SpeakerObserver } from "@ambient-agent/agents/speaker/observer.ts";
import {
  configureWhatsAppParticipationPort,
  type WhatsAppHistoryPort,
  type WhatsAppMessageLookupPort,
  type WhatsAppOutboundPort,
  type WhatsAppDeliveryResult,
  withTypingResult,
} from "@ambient-agent/agents/capabilities/whatsapp-participation/whatsapp-port.ts";
import { makeManagedChatGate, type ChatGate } from "@ambient-agent/engine/coalescer/chat-gate.ts";
import * as Coalescer from "@ambient-agent/engine/coalescer/coalescer.ts";
import { configLayer, type CoalescerConfigValues } from "@ambient-agent/engine/coalescer/config.ts";
import { botIdsOf, whatsappEventSource } from "@ambient-agent/engine/coalescer/whatsapp.ts";
import { createConversationArchive } from "@ambient-agent/engine/intake/conversation-archive.ts";
import {
  createManagedChatInbox,
  managedChatWindowStore,
  type ManagedChatInbox,
} from "@ambient-agent/engine/intake/managed-chat-inbox.ts";
import { speakerActivity } from "@ambient-agent/agents/speaker/activity-reporter.ts";
import { effectLoggerLayer, getLogger, upstreamWhatsAppLogger } from "@ambient-agent/engine/logging/logging.ts";
import type { TenantCredentialEnvironment } from "@ambient-agent/installation/tenant-credentials.ts";
import type { WhatsAppRuntimeStatus } from "@ambient-agent/installation/runtime-health.ts";
import { errorMessage } from "@ambient-agent/engine/shared/errors.ts";
import { renderQr } from "@ambient-agent/installation/qr.ts";
import { isGroupJid } from "@ambient-agent/engine/shared/whatsapp-jid.ts";
import {
  createWhatsAppAccount,
  WhatsAppAccountError,
  type ChatCandidate,
} from "@ambient-agent/installation/whatsapp-account.ts";

const isKnownTransportRejection = (message: string): boolean => /^not online \(phase: [^)]+\)$/.test(message);
const deliveryFailure = (
  cause: unknown,
): { readonly delivery: "failed" | "unknown"; readonly deliveryError: string } => {
  const deliveryError = errorMessage(cause);
  return { delivery: isKnownTransportRejection(deliveryError) ? "failed" : "unknown", deliveryError };
};
const TYPING_LEAD_MS = 750;

/** The sole real implementation behind Speaker's outbound participation tools. */
export const createWhatsAppHost = (
  session: WhatsAppSession,
  lookupMessage: (chatId: string, messageId: string) => MessageRef | undefined,
): WhatsAppOutboundPort => ({
  say: async (chatId, text, replyTo) => {
    const log = getLogger("whatsapp");
    const quote = replyTo === undefined ? undefined : lookupMessage(chatId, replyTo);
    if (replyTo !== undefined && quote === undefined) {
      return withTypingResult({
        delivery: "failed",
        deliveryError: `WhatsApp message ${replyTo} is not available in ${chatId}.`,
      });
    }
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
        const message = await session.send(chatId, { text }, quote === undefined ? undefined : { quote });
        delivery = { delivery: "sent", messageId: message.id };
        if (!speakerActivity.spokeForChat(chatId, text, message.id)) {
          log.info(
            { operatorEvent: "agent.say", text, chatId, messageId: message.id },
            "Speaker said a WhatsApp message",
          );
        }
      } catch (cause) {
        delivery = deliveryFailure(cause);
        log.error({ chatId, error: delivery.deliveryError }, `WhatsApp reply delivery ${delivery.delivery}`);
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
      return {
        delivery: "failed",
        deliveryError: `WhatsApp message ${messageId} is not available in ${chatId}.`,
      };
    }
    try {
      const message = await session.send(chatId, { react: { to: target, emoji } });
      getLogger("whatsapp").info(
        { operatorEvent: "agent.react", emoji, chatId, targetMessageId: messageId },
        "Speaker reacted to a WhatsApp message",
      );
      return { delivery: "sent", messageId: message.id };
    } catch (cause) {
      const delivery = deliveryFailure(cause);
      getLogger("whatsapp").error(
        { chatId, error: delivery.deliveryError },
        `WhatsApp reaction delivery ${delivery.delivery}`,
      );
      return delivery;
    }
  },
});

export interface WhatsAppSessionRuntimeOptions {
  readonly gate: ChatGate;
  readonly history: WhatsAppHistoryPort & WhatsAppMessageLookupPort;
  readonly inbox: ManagedChatInbox;
  readonly dispatch?: DispatchSpeaker;
  readonly coalescer?: Partial<CoalescerConfigValues>;
  readonly botLid?: string;
  /**
   * Invoked once, synchronously, right after the WhatsApp participation port is wired —
   * the seam the delegation boot sweep hangs on, so its `interrupted` notifications can
   * actually be voiced (the Speaker's `say` needs the port). Errors are the callback's own.
   */
  readonly afterParticipationReady?: () => void;
}

/** Shared production/test seam: one full-fidelity whatsappd session -> retained Coalescer -> Speaker dispatch. */
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
          ...(isGroupJid(message.chatId) && message.senderId !== undefined ? { participant: message.senderId } : {}),
        };
  });
  configureWhatsAppParticipationPort({
    say: outbound.say,
    react: outbound.react,
    readThread: (chatId, limit) => options.history.readThread(chatId, limit),
    search: (chatId, query, limit) => options.history.search(chatId, query, limit),
  });
  options.afterParticipationReady?.();
  const botIds = botIdsOf(session, options.botLid);
  return Coalescer.run.pipe(
    Effect.provide(
      Layer.mergeAll(
        whatsappEventSource(session, options.gate.allowed, {
          replay: () => options.inbox.unwindowed(),
          accepted: (event) => options.inbox.pending(event),
        }),
        makeSpeakerWindowDispatcher(options.inbox, options.dispatch),
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
  readonly synchronizedChats: () => Promise<readonly ChatCandidate[]>;
  readonly smokeCanary: (
    nonce: string,
    timeoutMillis: number,
  ) => Promise<{
    readonly chatId: string;
    readonly text: string;
    readonly stages: readonly ["admission", "dispatch", "settled-silent"];
  }>;
}

export type WhatsAppSmokeCanaryStatus = 400 | 409 | 503 | 504;

export class WhatsAppSmokeCanaryError extends Error {
  override readonly name = "WhatsAppSmokeCanaryError";

  constructor(
    readonly status: WhatsAppSmokeCanaryStatus,
    message: string,
  ) {
    super(message);
  }
}

export interface WhatsAppRuntimeOptions {
  readonly storeDirectory: string;
  readonly applicationDatabase: string;
  readonly managedChats: readonly string[];
  readonly environment?: TenantCredentialEnvironment;
  readonly canaryChat?: string;
  readonly botLid?: string;
  /** Test seams only: a fake session and a captured exit instead of process.exit. */
  readonly sessionFactory?: () => WhatsAppSession;
  readonly exit?: (code: number) => void;
  readonly dispatch?: DispatchSpeaker;
  readonly coalescer?: Partial<CoalescerConfigValues>;
  readonly observeActivity?: (observer: SpeakerObserver) => () => void;
  /** Run once after the participation port is wired — e.g. the delegation boot sweep. */
  readonly afterParticipationReady?: () => void;
}

export const startWhatsAppRuntime = (options: WhatsAppRuntimeOptions): WhatsAppRuntimeControl => {
  const storeDir = options.storeDirectory;
  const gate = makeManagedChatGate(options.managedChats);
  const archive = createConversationArchive(options.applicationDatabase);
  const inbox = createManagedChatInbox(archive, { allowed: gate.allowed });
  speakerActivity.recoverWith((dispatchId) => {
    const window = inbox.windowForDispatch(dispatchId);
    return window === undefined
      ? undefined
      : { windowId: window.id, chatId: window.chatId, messageCount: window.messages.length };
  });
  let activeCanary: { readonly chatId: string; readonly text: string } | undefined;
  const account = createWhatsAppAccount({
    storeDirectory: storeDir,
    archive: inbox.recorder,
    logger: upstreamWhatsAppLogger(),
    ...(options.environment === undefined ? {} : { environment: options.environment }),
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
          setRuntimeStatus({ phase: "pairing", chatTarget: gate.describe(), pairing });
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
        "Speaker WhatsApp online",
      ),
    );
    yield* runWhatsAppSession(session, {
      gate,
      history: archive,
      inbox,
      botLid: options.botLid,
      ...(options.dispatch === undefined ? {} : { dispatch: options.dispatch }),
      ...(options.coalescer === undefined ? {} : { coalescer: options.coalescer }),
      ...(options.afterParticipationReady === undefined
        ? {}
        : { afterParticipationReady: options.afterParticipationReady }),
    });
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
    synchronizedChats: async () => await account.synchronizedChats(),
    smokeCanary: async (nonce, timeoutMillis) => {
      const chatId = options.canaryChat;
      if (chatId === undefined) {
        throw new WhatsAppSmokeCanaryError(409, "No dedicated smoke canary group is configured.");
      }
      if (!options.managedChats.some((managed) => managed.toLowerCase() === chatId.toLowerCase())) {
        throw new WhatsAppSmokeCanaryError(400, "The configured smoke canary group is not a Managed Chat.");
      }
      if (activeCanary !== undefined) {
        throw new WhatsAppSmokeCanaryError(409, "A live smoke canary is already running.");
      }
      const text = `SMOKE ${nonce} — ignore`;
      activeCanary = { chatId, text };
      let dispatchId: string | undefined;
      let providerMessageId: string | undefined;
      const observedDispatches: SpeakerDispatchEvent[] = [];
      const observedTerminal = new Map<string, "silent" | Error>();
      let finishLifecycle: ((result: "silent" | Error) => void) | undefined;
      const correlateDispatch = (event: SpeakerDispatchEvent): void => {
        if (providerMessageId === undefined || dispatchId !== undefined) return;
        const window = inbox.window(event.windowId);
        if (window?.messages.some((message) => message.id === providerMessageId)) {
          dispatchId = event.dispatchId;
          const terminal = observedTerminal.get(event.dispatchId);
          if (terminal !== undefined) finishLifecycle?.(terminal);
        }
      };
      let unsubscribe: () => void = () => undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const lifecycle = new Promise<void>((resolve, reject) => {
          const finish = (result: "silent" | Error): void => {
            if (timer !== undefined) clearTimeout(timer);
            if (result === "silent") resolve();
            else reject(result);
          };
          finishLifecycle = finish;
          const terminal = (candidateDispatchId: string, result: "silent" | Error): void => {
            observedTerminal.set(candidateDispatchId, result);
            if (candidateDispatchId === dispatchId) finish(result);
          };
          unsubscribe = (options.observeActivity ?? speakerActivity.subscribe)({
            windowDispatched: (event) => {
              observedDispatches.push(event);
              correlateDispatch(event);
            },
            spoke: (event) => {
              terminal(
                event.dispatchId,
                new WhatsAppSmokeCanaryError(504, "The SMOKE canary spoke instead of settling silent."),
              );
            },
            settledSilent: (event) => {
              terminal(event.dispatchId, "silent");
            },
            settledFailed: (event) => {
              terminal(event.dispatchId, new WhatsAppSmokeCanaryError(504, "The SMOKE canary dispatch failed."));
            },
          });
          timer = setTimeout(
            () =>
              finish(
                new WhatsAppSmokeCanaryError(
                  504,
                  "The SMOKE canary timed out before admission, dispatch, and silent settlement.",
                ),
              ),
            timeoutMillis,
          );
        });
        void lifecycle.catch(() => undefined);
        if (account.sendSmokeCanary === undefined) {
          throw new WhatsAppSmokeCanaryError(503, "The WhatsApp account cannot send smoke canaries.");
        }
        providerMessageId = (await account.sendSmokeCanary(chatId, text)).messageId;
        for (const event of observedDispatches) correlateDispatch(event);
        await lifecycle;
        if (dispatchId === undefined) {
          throw new WhatsAppSmokeCanaryError(504, "The SMOKE canary settled without a correlated dispatch.");
        }
        return { chatId, text, stages: ["admission", "dispatch", "settled-silent"] };
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        unsubscribe();
        activeCanary = undefined;
      }
    },
    stop: async () => {
      stopping = true;
      await Effect.runPromise(Fiber.interrupt(fiber));
      setRuntimeStatus({ phase: "stopped", chatTarget: gate.describe() });
    },
  };
};
