import {
  createSession,
  fileStore,
  isOnline,
  isTerminal,
  qrAuth,
  type ConversationSyncBatch,
  type HistoryChat,
  type HistoryContact,
  type IncomingMessage,
  type Outbound,
  type SendOptions,
  type SessionStore,
  type Status,
  type Update,
  type WaIdentity,
  type WhatsAppSession,
} from "whatsappd";
import type { Logger } from "pino";

import type { ConversationArchive } from "@ambient-agent/engine/intake/conversation-archive.ts";
import {
  conversationArrival,
  conversationMutationFingerprint,
  conversationMutationScope,
  conversationSent,
  smokeCanaryArrival,
  conversationUpdate,
} from "@ambient-agent/engine/intake/conversation-event.ts";
import {
  libsqlStore,
  tenantCredentialDatabaseFromEnvironment,
  type TenantCredentialEnvironment,
} from "./tenant-credentials.ts";

export interface PairingProgress {
  readonly method: "qr" | "pairing_code";
  readonly qr?: string;
  readonly code?: string;
  readonly expiresAt: number;
}

export interface PairingCallbacks {
  readonly onPairing?: (progress: PairingProgress) => void;
  readonly onStatus?: (status: Status) => void;
}

export interface AuthenticatedAccount {
  readonly jid: string;
  readonly pushName?: string;
  readonly phoneE164?: string;
}

export interface ChatCandidate {
  readonly jid: string;
  readonly name: string;
  readonly kind: "group" | "direct";
  readonly lastActivityAt?: number;
}

export interface WhatsAppAccountSetup {
  authenticate(callbacks: PairingCallbacks, signal?: AbortSignal): Promise<AuthenticatedAccount>;
  synchronizedChats(signal?: AbortSignal): Promise<readonly ChatCandidate[]>;
}

export interface ManagedWhatsAppAccount extends WhatsAppAccountSetup {
  session(): WhatsAppSession;
  /** Resolves only after provider sync completion and every queued archive batch write. */
  initialArchiveReady?(signal?: AbortSignal): Promise<void>;
  /** Send the live smoke stimulus, then admit that exact provider-acknowledged message as the canary input. */
  sendSmokeCanary?(chatId: string, text: string): Promise<{ readonly messageId: string }>;
  stop(): Promise<void>;
}

export interface CreateWhatsAppAccountOptions {
  readonly storeDirectory: string;
  readonly archive: Pick<ConversationArchive, "append">;
  /** App-owned child logger injected through whatsappd's public seam (ADR 0016). */
  readonly logger?: Logger;
  readonly sessionFactory?: (store: SessionStore) => WhatsAppSession;
  readonly environment?: TenantCredentialEnvironment;
  readonly now?: () => number;
  readonly syncTimeoutMillis?: number;
}

export class WhatsAppAccountError extends Error {
  override readonly name = "WhatsAppAccountError";

  constructor(
    readonly code: "cancelled" | "timeout" | "logged_out" | "suspended" | "start_failed" | "not_authenticated",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

const abortCode = (signal: AbortSignal | undefined): "cancelled" | "timeout" =>
  signal?.reason instanceof DOMException && signal.reason.name === "TimeoutError" ? "timeout" : "cancelled";

const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) {
    const code = abortCode(signal);
    throw new WhatsAppAccountError(
      code,
      code === "timeout" ? "WhatsApp authentication timed out." : "WhatsApp authentication was cancelled.",
      { cause: signal.reason },
    );
  }
};

const accountIdentity = (identity: WaIdentity | undefined): AuthenticatedAccount => {
  if (identity === undefined) {
    throw new WhatsAppAccountError("start_failed", "WhatsApp reached online without an account identity.");
  }
  return {
    jid: identity.jid,
    ...(identity.pushName === undefined ? {} : { pushName: identity.pushName }),
    ...(identity.phoneE164 === undefined ? {} : { phoneE164: identity.phoneE164 }),
  };
};

const candidateName = (chat: HistoryChat, contacts: ReadonlyMap<string, HistoryContact>): string =>
  chat.subject?.trim() || contacts.get(chat.id)?.displayName?.trim() || chat.id;

export const createWhatsAppAccount = (options: CreateWhatsAppAccountOptions): ManagedWhatsAppAccount => {
  const createStore = (): SessionStore => {
    const tenantDatabase = tenantCredentialDatabaseFromEnvironment(options.environment ?? process.env);
    return tenantDatabase === undefined ? fileStore(options.storeDirectory) : libsqlStore(tenantDatabase);
  };
  const store = createStore();
  const session =
    options.sessionFactory?.(store) ??
    createSession({
      store,
      auth: qrAuth(),
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    });
  const chats = new Map<string, HistoryChat>();
  const contacts = new Map<string, HistoryContact>();
  const now = options.now ?? Date.now;
  let authenticated: AuthenticatedAccount | undefined;
  let authentication: Promise<AuthenticatedAccount> | undefined;
  const messageSubscribers = new Set<(message: IncomingMessage) => void | Promise<void>>();
  const updateSubscribers = new Set<(update: Update) => void | Promise<void>>();
  const syncSubscribers = new Set<(batch: ConversationSyncBatch) => void | Promise<void>>();
  const initialSyncWaiters = new Set<(error?: WhatsAppAccountError) => void>();
  const archiveReadyWaiters = new Set<(error?: WhatsAppAccountError) => void>();
  const pendingMutationEchoes = new Map<string, Array<{ readonly expiresAt: number; readonly scope: string }>>();
  const mutationEchoTtlMs = 60_000;
  let initialSyncObserved = false;
  let initialArchiveReady = false;
  let onlineObserved = false;
  let archiveQueue = Promise.resolve();

  const settleInitialArchive = (): void => {
    // `online` is whatsappd's settled-and-ready signal: it fires only after the authenticated
    // sync sub-state (draining → syncing) completes on a first link, and immediately on a
    // reconnect where history sync is skipped because the store already holds it. Requiring a
    // conversation-sync batch on top of it hung every restart — a reconnect emits no batch, so
    // the runtime waited 60s and failed on a healthy session. The online handler chains this
    // through archiveQueue, so any batch delivered before online is durably written first.
    if (!onlineObserved || initialArchiveReady) return;
    initialArchiveReady = true;
    for (const settle of archiveReadyWaiters) settle();
    archiveReadyWaiters.clear();
  };

  const prunePendingMutationEchoes = (observedAt: number): void => {
    for (const [fingerprint, pending] of pendingMutationEchoes) {
      const current = pending.filter(({ expiresAt }) => expiresAt >= observedAt);
      if (current.length === 0) pendingMutationEchoes.delete(fingerprint);
      else pendingMutationEchoes.set(fingerprint, current);
    }
  };

  const invalidatePendingMutationScope = (scope: string): void => {
    for (const [fingerprint, pending] of pendingMutationEchoes) {
      const current = pending.filter((candidate) => candidate.scope !== scope);
      if (current.length === 0) pendingMutationEchoes.delete(fingerprint);
      else pendingMutationEchoes.set(fingerprint, current);
    }
  };

  const mergeSync = (batch: ConversationSyncBatch): void => {
    for (const contact of batch.contacts) contacts.set(contact.id, contact);
    for (const chat of batch.chats) chats.set(chat.id, chat);
    for (const message of batch.messages) {
      if (message.kind !== "unsupported" || message.rawType !== "reactionMessage") {
        options.archive.append(conversationArrival(message));
      }
    }
  };
  const ingestMessage = async (message: IncomingMessage): Promise<void> => {
    // whatsappd also exposes reactionMessage through onUpdate; do not admit its
    // unsupported message envelope as a second conversation event.
    if (message.kind === "unsupported" && message.rawType === "reactionMessage") return;
    const inserted = options.archive.append(conversationArrival(message));
    if (!inserted) return;
    for (const subscriber of messageSubscribers) await subscriber(message);
  };
  const unsubscribeMessage = session.onMessage(ingestMessage);
  const unsubscribeUpdate = session.onUpdate(async (update) => {
    const event = conversationUpdate(update);
    const fingerprint = event.kind === "receipt" ? undefined : conversationMutationFingerprint(event);
    prunePendingMutationEchoes(now());
    const pending = fingerprint === undefined ? [] : (pendingMutationEchoes.get(fingerprint) ?? []);
    if (pending.length > 0 && fingerprint !== undefined) {
      pending.shift();
      if (pending.length === 0) pendingMutationEchoes.delete(fingerprint);
      else pendingMutationEchoes.set(fingerprint, pending);
    } else {
      if (fingerprint !== undefined) pendingMutationEchoes.delete(fingerprint);
      options.archive.append(event);
      if (event.kind !== "receipt") invalidatePendingMutationScope(conversationMutationScope(event));
    }
    for (const subscriber of updateSubscribers) await subscriber(update);
  });
  const unsubscribeSync = session.onConversationSync((batch) => {
    archiveQueue = archiveQueue.then(async () => {
      mergeSync(batch);
      initialSyncObserved = true;
      for (const settle of initialSyncWaiters) settle();
      initialSyncWaiters.clear();
      for (const subscriber of syncSubscribers) await subscriber(batch);
      settleInitialArchive();
    });
  });
  const unsubscribeArchiveReady = typeof session.onStatus === "function" ? session.onStatus((status) => {
    if (status.phase !== "online") return;
    onlineObserved = true;
    void archiveQueue.then(settleInitialArchive);
  }) : () => undefined;

  const waitForInitialSync = async (signal?: AbortSignal): Promise<void> => {
    if (initialSyncObserved) return;
    const timeout = AbortSignal.timeout(options.syncTimeoutMillis ?? 60_000);
    const waitSignal = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (error?: WhatsAppAccountError): void => {
        if (settled) return;
        settled = true;
        initialSyncWaiters.delete(settle);
        waitSignal.removeEventListener("abort", onAbort);
        if (error === undefined) resolve();
        else reject(error);
      };
      const onAbort = (): void => {
        const code = abortCode(waitSignal);
        settle(
          new WhatsAppAccountError(
            code,
            code === "timeout" ? "WhatsApp conversation sync timed out." : "WhatsApp conversation sync was cancelled.",
            { cause: waitSignal.reason },
          ),
        );
      };
      initialSyncWaiters.add(settle);
      if (initialSyncObserved) settle();
      else if (waitSignal.aborted) onAbort();
      else waitSignal.addEventListener("abort", onAbort, { once: true });
    });
  };
  const waitForInitialArchive = async (signal?: AbortSignal): Promise<void> => {
    if (initialArchiveReady) return;
    const timeout = AbortSignal.timeout(options.syncTimeoutMillis ?? 60_000);
    const waitSignal = signal === undefined ? timeout : AbortSignal.any([signal, timeout]);
    await new Promise<void>((resolve, reject) => {
      const settle = (error?: WhatsAppAccountError): void => {
        archiveReadyWaiters.delete(settle);
        waitSignal.removeEventListener("abort", onAbort);
        if (error === undefined) resolve();
        else reject(error);
      };
      const onAbort = () => settle(new WhatsAppAccountError(abortCode(waitSignal), "WhatsApp initial archive did not become ready.", { cause: waitSignal.reason }));
      archiveReadyWaiters.add(settle);
      if (initialArchiveReady) settle();
      else if (waitSignal.aborted) onAbort();
      else waitSignal.addEventListener("abort", onAbort, { once: true });
    });
  };

  const managedSession = new Proxy(session, {
    get(target, property) {
      if (property === "onMessage") {
        return (subscriber: (message: IncomingMessage) => void | Promise<void>) => {
          messageSubscribers.add(subscriber);
          return () => messageSubscribers.delete(subscriber);
        };
      }
      if (property === "onUpdate") {
        return (subscriber: (update: Update) => void | Promise<void>) => {
          updateSubscribers.add(subscriber);
          return () => updateSubscribers.delete(subscriber);
        };
      }
      if (property === "onConversationSync") {
        return (subscriber: (batch: ConversationSyncBatch) => void | Promise<void>) => {
          syncSubscribers.add(subscriber);
          return () => syncSubscribers.delete(subscriber);
        };
      }
      if (property === "send") {
        return async (chatId: string, content: Outbound, sendOptions?: SendOptions) => {
          const ref = await target.send(chatId, content, sendOptions);
          const sentAt = now();
          prunePendingMutationEchoes(sentAt);
          const event = conversationSent(ref, content, accountIdentity(target.identity()).jid, sentAt);
          options.archive.append(event);
          if (event.kind !== "arrival" && event.kind !== "receipt") {
            const fingerprint = conversationMutationFingerprint(event);
            const pending = pendingMutationEchoes.get(fingerprint) ?? [];
            pending.push({ expiresAt: sentAt + mutationEchoTtlMs, scope: conversationMutationScope(event) });
            pendingMutationEchoes.set(fingerprint, pending);
          }
          return ref;
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  const authenticate = async (callbacks: PairingCallbacks, signal?: AbortSignal): Promise<AuthenticatedAccount> => {
    throwIfAborted(signal);
    if (authenticated !== undefined) return authenticated;
    if (authentication !== undefined) return await authentication;

    authentication = new Promise<AuthenticatedAccount>((resolve, reject) => {
      let settled = false;
      const settle = (result: { readonly account: AuthenticatedAccount } | { readonly error: unknown }): void => {
        if (settled) return;
        settled = true;
        unsubscribeStatus();
        signal?.removeEventListener("abort", onAbort);
        if ("account" in result) {
          authenticated = result.account;
          resolve(result.account);
        } else {
          reject(result.error);
        }
      };
      const onAbort = (): void => {
        void session.stop();
        const code = abortCode(signal);
        settle({
          error: new WhatsAppAccountError(
            code,
            code === "timeout" ? "WhatsApp authentication timed out." : "WhatsApp authentication was cancelled.",
            {
              cause: signal?.reason,
            },
          ),
        });
      };
      const unsubscribeStatus = session.onStatus((status) => {
        callbacks.onStatus?.(status);
        if (status.phase === "pairing" && status.pairing.step === "challenge_live") {
          callbacks.onPairing?.({
            method: status.pairing.method,
            ...(status.pairing.qr === undefined ? {} : { qr: status.pairing.qr }),
            ...(status.pairing.code === undefined ? {} : { code: status.pairing.code }),
            expiresAt: status.pairing.expiresAt,
          });
        }
        if (isOnline(status)) {
          settle({ account: accountIdentity(session.identity()) });
        } else if (isTerminal(status)) {
          const code = status.phase === "logged_out" ? "logged_out" : "suspended";
          settle({ error: new WhatsAppAccountError(code, `WhatsApp authentication ended in ${status.phase}.`) });
        }
      });
      signal?.addEventListener("abort", onAbort, { once: true });
      void session.start().catch((cause: unknown) => {
        settle({
          error: new WhatsAppAccountError("start_failed", "WhatsApp authentication could not start.", { cause }),
        });
      });
    }).finally(() => {
      if (authenticated === undefined) authentication = undefined;
    });
    return await authentication;
  };

  return {
    authenticate,
    synchronizedChats: async (signal) => {
      throwIfAborted(signal);
      if (authenticated === undefined) {
        throw new WhatsAppAccountError("not_authenticated", "Authenticate WhatsApp before discovering chats.");
      }
      await waitForInitialSync(signal);
      return [...chats.values()]
        .map(
          (chat): ChatCandidate => ({
            jid: chat.id,
            name: candidateName(chat, contacts),
            kind: chat.isGroup ? "group" : "direct",
            ...(chat.lastMessageAt === undefined ? {} : { lastActivityAt: chat.lastMessageAt }),
          }),
        )
        .sort(
          (left, right) =>
            (right.lastActivityAt ?? 0) - (left.lastActivityAt ?? 0) ||
            left.name.localeCompare(right.name) ||
            left.jid.localeCompare(right.jid),
        );
    },
    session: () => {
      if (authenticated === undefined) {
        throw new WhatsAppAccountError("not_authenticated", "Authenticate WhatsApp before starting participation.");
      }
      return managedSession;
    },
    initialArchiveReady: waitForInitialArchive,
    sendSmokeCanary: async (chatId, text) => {
      if (authenticated === undefined) {
        throw new WhatsAppAccountError("not_authenticated", "Authenticate WhatsApp before sending a smoke canary.");
      }
      const message = await session.send(chatId, { text });
      const acknowledged = {
        id: message.id,
        chatId,
        from: authenticated.jid,
        ...(authenticated.pushName === undefined ? {} : { pushName: authenticated.pushName }),
        fromMe: true,
        timestamp: now(),
        live: false,
        isGroup: chatId.endsWith("@g.us"),
        kind: "text",
        text,
        reply: async (content, sendOptions) =>
          await session.send(chatId, typeof content === "string" ? { text: content } : content, sendOptions),
      } satisfies IncomingMessage;
      const inserted = options.archive.append(smokeCanaryArrival(acknowledged));
      if (!inserted) throw new Error(`The provider-acknowledged smoke message ${message.id} was already archived.`);
      const admitted = { ...acknowledged, fromMe: false, live: true } satisfies IncomingMessage;
      for (const subscriber of messageSubscribers) await subscriber(admitted);
      return { messageId: message.id };
    },
    stop: async () => {
      for (const settle of initialSyncWaiters) {
        settle(new WhatsAppAccountError("cancelled", "WhatsApp stopped before conversation sync completed."));
      }
      initialSyncWaiters.clear();
      for (const settle of archiveReadyWaiters) settle(new WhatsAppAccountError("cancelled", "WhatsApp stopped before the initial archive became ready."));
      archiveReadyWaiters.clear();
      unsubscribeArchiveReady();
      unsubscribeSync();
      unsubscribeUpdate();
      unsubscribeMessage();
      syncSubscribers.clear();
      updateSubscribers.clear();
      messageSubscribers.clear();
      pendingMutationEchoes.clear();
      await session.stop();
    },
  };
};
