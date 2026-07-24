import { Cause, Effect, Exit, Fiber, Layer, type Scope } from "effect";
import type { MessageRef, WhatsAppSession } from "whatsappd";

import {
  configureHistoricalReplayGate,
  dispatchSpeaker,
  makeSpeakerWindowDispatcher,
  type DispatchSpeaker,
} from "@ambient-agent/agents/speaker/dispatch.ts";
import { configureIntentEscalationRuntime } from "@ambient-agent/agents/capabilities/intent-escalation/runtime.ts";
import { configureDirectiveDeliveryRuntime } from "@ambient-agent/agents/capabilities/directive-delivery/runtime.ts";
import { configureDelegationRuntime } from "@ambient-agent/agents/capabilities/delegation/runtime.ts";
import { reconcileSpecialistWorkAtBoot } from "@ambient-agent/agents/capabilities/delegation/bridge.ts";
import { recoverPendingSpecialistLaunches } from "@ambient-agent/agents/capabilities/delegation/tools.ts";
import { coderSpecialistSpec } from "@ambient-agent/agents/capabilities/coder/workflow.ts";
import { reviewerSpecialistSpec } from "@ambient-agent/agents/capabilities/reviewer/workflow.ts";
import { wakeBrain } from "@ambient-agent/agents/brain/dispatch.ts";
import {
  configureBrainEffectsRuntime,
  recoverPendingIssueFilings,
  recoverPendingPrompts,
} from "@ambient-agent/agents/brain/effects-runtime.ts";
import { createIssueFiler } from "@ambient-agent/agents/brain/issue-filing.ts";
import { getIssueManagementRuntime } from "@ambient-agent/agents/capabilities/issue-management/runtime.ts";
import { configureScribeInbox } from "@ambient-agent/agents/scribe/coalescer.ts";
import { getRun, invoke } from "@flue/runtime";
import historicalReplayWorkflow from "../workflows/historical-replay.ts";
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
import { createBrainInbox } from "@ambient-agent/engine/brain/inbox.ts";
import { configureGitHubUpInbox } from "@ambient-agent/engine/github/up-inbox.ts";
import { createHistoricalReplayStore } from "@ambient-agent/engine/intake/historical-replay.ts";
import { createScribeInbox } from "@ambient-agent/engine/scribe/inbox.ts";
import {
  createManagedChatInbox,
  managedChatWindowStore,
  type ManagedChatInbox,
} from "@ambient-agent/engine/intake/managed-chat-inbox.ts";
import { speakerActivity } from "@ambient-agent/agents/speaker/activity-reporter.ts";
import { effectLoggerLayer, getLogger, upstreamWhatsAppLogger } from "@ambient-agent/engine/logging/logging.ts";
import type { WhatsAppRuntimeStatus } from "@ambient-agent/installation/runtime-health.ts";
import { errorMessage } from "@ambient-agent/engine/shared/errors.ts";
import { renderQr } from "@ambient-agent/installation/qr.ts";
import { isGroupJid } from "@ambient-agent/engine/shared/whatsapp-jid.ts";
import { createSurfaceRegistry } from "@ambient-agent/engine/surfaces/registry.ts";
import { createSurfaceDeliveryStore } from "@ambient-agent/engine/surfaces/delivery.ts";
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
  readonly afterParticipationReady?: () => void | Promise<void>;
}

/** Shared production/test seam: one full-fidelity whatsappd session -> retained Coalescer -> Speaker dispatch. */
export const runWhatsAppSession = (
  session: WhatsAppSession,
  options: WhatsAppSessionRuntimeOptions,
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
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
    yield* Effect.sync(() =>
      configureWhatsAppParticipationPort({
        say: outbound.say,
        react: outbound.react,
        readThread: (chatId, limit) => options.history.readThread(chatId, limit),
        search: (chatId, query, limit) => options.history.search(chatId, query, limit),
      }),
    );
    if (options.afterParticipationReady !== undefined) {
      yield* Effect.promise(() => Promise.resolve(options.afterParticipationReady!()));
    }
    const botIds = botIdsOf(session, options.botLid);
    yield* Coalescer.run.pipe(
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
  });

const WHATSAPP_RUNTIME_STATUS = Symbol.for("ambient-agent.whatsapp-runtime-status");
const runtimeGlobal = globalThis as typeof globalThis & { [WHATSAPP_RUNTIME_STATUS]?: WhatsAppRuntimeStatus };
const runtimeStatus = (): WhatsAppRuntimeStatus => (runtimeGlobal[WHATSAPP_RUNTIME_STATUS] ??= { phase: "disabled" });
const setRuntimeStatus = (status: WhatsAppRuntimeStatus): void => {
  runtimeGlobal[WHATSAPP_RUNTIME_STATUS] = status;
};
export const getWhatsAppRuntimeStatus = (): WhatsAppRuntimeStatus => structuredClone(runtimeStatus());

export interface WhatsAppRuntimeControl {
  readonly stop: () => Promise<void>;
  /**
   * Live-reload the managed-chat authorization gate in place (#179): the newly added chats engage the
   * gate with no restart and the WhatsApp stream is untouched. Only the authorization Set changes —
   * the session, model, and port are restart-only and are never reached from here.
   */
  readonly reloadManagedChats: (chatIds: readonly string[]) => void;
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
  const surfaces = createSurfaceRegistry(options.applicationDatabase);
  const brainInbox = createBrainInbox(options.applicationDatabase, {
    providerChatIdForSurface: (surfaceId) => surfaces.activeBinding(surfaceId)?.providerChatId,
  });
  // GitHub events flow UP into the single Brain up-inbox (§4). Admission is the durable step and is
  // always safe. Waking the Brain is gated on `brainReady`: dispatching a Batch before the Brain's
  // Effects/participation runtime exists would mark the Batch dispatched, then fail its tools, and the
  // wake-guard would never re-dispatch it — a wedge. Until ready, admitted events wait for the boot
  // sweep in afterParticipationReady (which wakes once everything is configured); after ready, each
  // admission wakes directly.
  let brainReady = false;
  // Flipped false when this runtime tears down (fiber failure, reconnect, logged_out) while the HTTP app
  // may keep serving. Without it the port's captured brainInbox is a finalized SQLite handle: admit would
  // throw, the ingress would settle 'failed' → 200, and the delivery would be lost with no retry. Deferring
  // (undefined → 503) lets GitHub redeliver to the next live runtime instead.
  let brainAlive = true;
  configureGitHubUpInbox(async (event) => {
    if (!brainAlive) return undefined;
    const admitted = brainInbox.admitGitHubEvent(event);
    if (brainReady) {
      void wakeBrain(brainInbox).catch((cause) =>
        getLogger("github").error({ event: "github.up-inbox.wake-failed", error: errorMessage(cause) }, "wake"),
      );
    }
    return { id: admitted.id, admittedAt: admitted.admittedAt };
  });
  const deliveries = createSurfaceDeliveryStore(options.applicationDatabase, {
    providerChatIdForSurface: (surfaceId) => surfaces.activeBinding(surfaceId)?.providerChatId,
  });
  configureDirectiveDeliveryRuntime({ deliveries });
  const historicalReplay = createHistoricalReplayStore(options.applicationDatabase);
  configureHistoricalReplayGate(historicalReplay);
  const scribeInbox = createScribeInbox(options.applicationDatabase, { recoverInterruptedAttempts: true });
  const restoreScribeInbox = configureScribeInbox(scribeInbox, async (draft) => {
    brainInbox.admitKnowledgeDelta(draft);
    await wakeBrain(brainInbox);
  });
  const inbox = createManagedChatInbox(archive, { allowed: gate.allowed });
  speakerActivity.recoverWith((dispatchId) => {
    const window = inbox.windowForDispatch(dispatchId);
    return window === undefined
      ? undefined
      : { windowId: window.id, chatId: window.chatId, messageCount: window.messages.length };
  });
  speakerActivity.recoverDirectivesWith((dispatchId) => deliveries.directiveForDispatch(dispatchId));
  let activeCanary: { readonly chatId: string; readonly text: string } | undefined;
  // Set once the account authenticates; a live gate reload needs it to activate a new chat's Surface
  // (#179). Undefined until online, so a reload before pairing only opens the gate — as intended.
  let authenticatedJid: string | undefined;
  const account = createWhatsAppAccount({
    storeDirectory: storeDir,
    archive: inbox.recorder,
    logger: upstreamWhatsAppLogger(),
    ...(options.sessionFactory === undefined ? {} : { sessionFactory: options.sessionFactory }),
  });
  const log = getLogger("whatsapp");
  const unsubscribeDirectiveOutcomes = speakerActivity.subscribeDirectives({
    dispatched: () => undefined,
    settledWithoutSay: ({ directiveId }) => {
      try {
        deliveries.settleWithoutSay(directiveId, "Speaker completed without calling say_directive.");
      } catch (cause) {
        log.error({ directiveId, error: errorMessage(cause) }, "Failed to persist settled-without-Saying Outcome");
      }
    },
    settledFailed: ({ directiveId, error }) => {
      try {
        deliveries.failWithoutSay(directiveId, error);
      } catch (cause) {
        log.error({ directiveId, error: errorMessage(cause) }, "Failed to persist failed Directive Outcome");
      }
    },
  });
  setRuntimeStatus({ phase: "starting", chatTarget: gate.describe() });
  let stopping = false;

  const program = Effect.gen(function* () {
    yield* Effect.addFinalizer(() => Effect.sync(() => archive.close()));
    yield* Effect.addFinalizer(() => Effect.sync(() => surfaces.close()));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        // Stop the up-inbox port before the handle is finalized, so a webhook in flight during teardown
        // defers (503) rather than throwing on a closed SQLite handle and being lost.
        brainAlive = false;
        brainInbox.close();
      }),
    );
    yield* Effect.addFinalizer(() => Effect.sync(() => deliveries.close()));
    yield* Effect.addFinalizer(() => Effect.sync(unsubscribeDirectiveOutcomes));
    yield* Effect.addFinalizer(() => Effect.sync(() => historicalReplay.close()));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        restoreScribeInbox();
        scribeInbox.close();
      }),
    );
    yield* Effect.addFinalizer(() => Effect.promise(() => account.stop()));
    if (!gate.hasTarget) {
      yield* Effect.logWarning("No managed WhatsApp chat is configured; ingress remains fail-closed.");
    }
    const authenticatedAccount = yield* Effect.promise(() =>
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
    authenticatedJid = authenticatedAccount.jid;
    yield* Effect.sync(() => surfaces.activateConfigured(authenticatedAccount.jid, options.managedChats));
    yield* Effect.sync(() =>
      configureIntentEscalationRuntime({
        inbox: brainInbox,
        surfaceIdForSpeaker: (speakerId) => surfaces.activeSurface(authenticatedAccount.jid, speakerId)?.id,
        wake: () => wakeBrain(brainInbox),
      }),
    );
    yield* Effect.sync(() =>
      configureBrainEffectsRuntime({
        inbox: brainInbox,
        wake: () => wakeBrain(brainInbox),
        // Resolved lazily at file time: composeSpeaker configures the issue-management runtime
        // process-global at app boot, well before any Batch files an issue.
        fileIssue: (request, effectId) => createIssueFiler(getIssueManagementRuntime())(request, effectId),
        // Bridge a Graph thread's chatId → its active Surface id, so the Brain can notify the Surface
        // that works_on a GitHub event's repository (§4 affirmative routing).
        resolveSurfaceForChat: (providerChatId) =>
          surfaces.activeSurface(authenticatedAccount.jid, providerChatId)?.id,
        deliverPrompt: (effect) => {
          const binding = surfaces.activeBinding(effect.directive.surfaceId);
          if (binding === undefined) {
            throw new Error(`Surface ${effect.directive.surfaceId} has no active provider binding.`);
          }
          return (options.dispatch ?? dispatchSpeaker)({
            id: binding.providerChatId,
            input: {
              type: "brain.directive",
              directive: {
                ...effect.directive,
                brief: { ...effect.directive.brief, evidenceIds: [...effect.directive.brief.evidenceIds] },
              },
            },
          });
        },
      }),
    );
    yield* Effect.sync(() =>
      configureDelegationRuntime({
        inbox: brainInbox,
        wake: () => wakeBrain(brainInbox),
        providerChatIdForSurface: (surfaceId) => surfaces.activeBinding(surfaceId)?.providerChatId,
      }),
    );
    if (account.initialArchiveReady !== undefined && options.sessionFactory === undefined) {
      yield* Effect.promise(() => account.initialArchiveReady!());
      for (const state of historicalReplay.states()) {
        if (!options.managedChats.includes(state.chatId)) historicalReplay.disable(state.chatId);
      }
      for (const chatId of options.managedChats) {
        const state = historicalReplay.get(chatId);
        if (state === undefined) historicalReplay.admit(chatId);
        else if (state.mode === "disabled") historicalReplay.retry(chatId);
      }
      historicalReplay.captureSnapshots();
      while (historicalReplay.nextBatch() === undefined && historicalReplay.advance() > 0) {
        // Empty Surface snapshots cross snapshot -> tail -> live without a Flue run.
      }
      if (historicalReplay.states().some(({ mode }) => mode === "catching_up")) {
        const { runId } = yield* Effect.promise(() => invoke(historicalReplayWorkflow, { input: {} }));
        historicalReplay.setRunId(runId);
      }
    }
    const session = account.session();
    const botIds = botIdsOf(session, options.botLid);
    setRuntimeStatus({
      phase: "online",
      accountJid: authenticatedAccount.jid,
      chatTarget: gate.describe(),
      botIds,
    });
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
      afterParticipationReady: async () => {
        await recoverPendingPrompts();
        await recoverPendingIssueFilings();
        // Reconcile prior-process accepted work FIRST: those runs cannot still be executing, so an
        // active/missing record is a genuine interrupt. Only then re-invoke launches that were
        // pending (reserved but never Flue-admitted) at crash time — re-invoking them makes their
        // runs active in THIS process, and reconciling after would wrongly interrupt live work whose
        // real result the admit guard (bridge.ts) would then silently drop.
        await reconcileSpecialistWorkAtBoot({ inbox: brainInbox, wake: () => wakeBrain(brainInbox), getRun });
        await recoverPendingSpecialistLaunches([coderSpecialistSpec, reviewerSpecialistSpec]);
        // Everything the Brain's tools need is now configured. Open the GitHub up-inbox wake gate, then
        // sweep — this dispatches any event admitted during boot, and future admissions wake directly.
        brainReady = true;
        await wakeBrain(brainInbox);
        await options.afterParticipationReady?.();
      },
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
    reloadManagedChats: (chatIds) => {
      gate.reload(chatIds);
      // Additively register a Surface for each authorized chat so a newly-allowed chat can escalate
      // an intent and reach an active Surface — not merely pass the gate (#179). Idempotent for chats
      // that already have one; never retires others. A no-op until the account is authenticated.
      if (authenticatedJid !== undefined) {
        for (const chatId of chatIds) surfaces.activate(authenticatedJid, chatId);
      }
    },
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
