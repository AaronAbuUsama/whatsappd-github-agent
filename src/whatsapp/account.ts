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
  type Status,
  type Update,
  type WaIdentity,
  type WhatsAppSession,
} from "whatsappd";

import type { ConversationArchive } from "../intake/conversation-archive.ts";
import {
  conversationArrival,
  conversationMutationFingerprint,
  conversationMutationScope,
  conversationSent,
  conversationUpdate,
} from "../intake/conversation-event.ts";

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
  stop(): Promise<void>;
}

export interface CreateWhatsAppAccountOptions {
  readonly storeDirectory: string;
  readonly archive: ConversationArchive;
  readonly sessionFactory?: () => WhatsAppSession;
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
  const session =
    options.sessionFactory?.() ??
    createSession({
      store: fileStore(options.storeDirectory),
      auth: qrAuth(),
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
  const pendingMutationEchoes = new Map<string, Array<{ readonly expiresAt: number; readonly scope: string }>>();
  const mutationEchoTtlMs = 60_000;
  let initialSyncObserved = false;

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
    for (const message of batch.messages) options.archive.append(conversationArrival(message));
  };
  const unsubscribeMessage = session.onMessage(async (message) => {
    options.archive.append(conversationArrival(message));
    for (const subscriber of messageSubscribers) await subscriber(message);
  });
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
  const unsubscribeSync = session.onConversationSync(async (batch) => {
    mergeSync(batch);
    initialSyncObserved = true;
    for (const settle of initialSyncWaiters) settle();
    initialSyncWaiters.clear();
    for (const subscriber of syncSubscribers) await subscriber(batch);
  });

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
    stop: async () => {
      for (const settle of initialSyncWaiters) {
        settle(new WhatsAppAccountError("cancelled", "WhatsApp stopped before conversation sync completed."));
      }
      initialSyncWaiters.clear();
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
