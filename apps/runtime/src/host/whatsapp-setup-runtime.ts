import { errorMessage } from "@ambient-agent/engine/shared/errors.ts";
import { upstreamWhatsAppLogger } from "@ambient-agent/engine/logging/logging.ts";
import {
  createConversationArchive,
  type ConversationArchive,
} from "@ambient-agent/engine/intake/conversation-archive.ts";
import type { TenantCredentialEnvironment } from "@ambient-agent/installation/tenant-credentials.ts";
import type { WhatsAppRuntimeStatus } from "@ambient-agent/installation/runtime-health.ts";
import { createWhatsAppAccount, type ManagedWhatsAppAccount } from "@ambient-agent/installation/whatsapp-account.ts";

export interface WhatsAppSetupRuntimeOptions {
  readonly storeDirectory: string;
  readonly applicationDatabase: string;
  readonly credentialEnvironment: Required<TenantCredentialEnvironment>;
}

export interface WhatsAppSetupRuntime {
  readonly status: () => WhatsAppRuntimeStatus;
  readonly synchronizedChats: ManagedWhatsAppAccount["synchronizedChats"];
  readonly stop: () => Promise<void>;
}

interface WhatsAppSetupRuntimeServices {
  readonly createAccount: typeof createWhatsAppAccount;
  readonly createArchive: typeof createConversationArchive;
}

/**
 * Own one WhatsApp account for setup only. Observed events still reach the
 * Conversation Archive, but there is no Managed Chat inbox, Coalescer, Speaker,
 * GitHub/model composition, or stdout pairing UI.
 */
export const startWhatsAppSetupRuntime = (
  options: WhatsAppSetupRuntimeOptions,
  services: WhatsAppSetupRuntimeServices = {
    createAccount: createWhatsAppAccount,
    createArchive: createConversationArchive,
  },
): WhatsAppSetupRuntime => {
  let status: WhatsAppRuntimeStatus = { phase: "starting" };
  let stopping = false;
  const archive: ConversationArchive = services.createArchive(options.applicationDatabase);
  let account: ManagedWhatsAppAccount;
  try {
    account = services.createAccount({
      storeDirectory: options.storeDirectory,
      environment: options.credentialEnvironment,
      logger: upstreamWhatsAppLogger(),
      archive,
    });
  } catch (cause) {
    archive.close();
    throw cause;
  }
  let cleanup: Promise<void> | undefined;
  const cleanupResources = (): Promise<void> => {
    cleanup ??= (async () => {
      try {
        await account.stop();
      } finally {
        archive.close();
      }
    })();
    return cleanup;
  };
  const authentication = Promise.resolve()
    .then(
      async () =>
        await account.authenticate({
          onPairing: (pairing) => {
            if (!stopping) status = { phase: "pairing", pairing };
          },
        }),
    )
    .then(() => {
      if (!stopping) status = { phase: "online" };
    })
    .catch(async (cause: unknown) => {
      if (stopping) return;
      let error = errorMessage(cause);
      try {
        await cleanupResources();
      } catch (cleanupCause) {
        error = `${error}; setup cleanup failed: ${errorMessage(cleanupCause)}`;
      }
      if (!stopping) status = { phase: "failed", error };
    });
  void authentication;

  return {
    status: () => structuredClone(status),
    synchronizedChats: async (signal) => await account.synchronizedChats(signal),
    stop: async () => {
      stopping = true;
      try {
        await cleanupResources();
      } finally {
        status = { phase: "stopped" };
      }
    },
  };
};
