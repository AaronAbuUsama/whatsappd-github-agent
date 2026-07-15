import { createConversationArchive, type ConversationArchive } from "../intake/conversation-archive.js";
import { installPreparedManagedData, type InstallManagedDataResult } from "../managed/installation.js";
import { managedPaths, type ManagedPathEnvironment, type ManagedPaths } from "../managed/paths.js";
import type { ChatGptAuthentication, DeviceCodeCallbacks } from "../model/chatgpt-authentication.js";
import type { ChatCandidate, ManagedWhatsAppAccount, PairingCallbacks } from "../whatsapp/account.js";
import { normalizeGitHubRepository, type DiscoveredGitHubCredential } from "./github.js";

export interface SetupReview {
  readonly dataDirectory: string;
  readonly chat: Pick<ChatCandidate, "jid" | "name" | "kind">;
  readonly repository: string;
  readonly chatGptCredentialSource: "existing managed credential" | "fresh device authorization";
  readonly whatsappCredentialSource: "existing managed session" | "fresh pairing";
  readonly githubCredentialSource: string;
}

export interface FirstRunPrompts {
  selectChat(candidates: readonly ChatCandidate[]): Promise<string>;
  repository(discovered?: string): Promise<string>;
  githubCredential(discovered?: DiscoveredGitHubCredential): Promise<DiscoveredGitHubCredential>;
  review(review: SetupReview): Promise<boolean>;
  validationError(field: "chat" | "repository" | "github", message: string): void;
}

type ChatGptSetup = Pick<ChatGptAuthentication, "inspect" | "authenticate">;

export interface FirstRunServices {
  readonly chatGptFor: (paths: ManagedPaths) => ChatGptSetup;
  readonly whatsappFor: (paths: ManagedPaths, archive: ConversationArchive) => ManagedWhatsAppAccount;
  readonly discoverRepository: () => Promise<string | undefined>;
  readonly discoverCredential: () => Promise<DiscoveredGitHubCredential | undefined>;
  readonly verifyGitHub: (token: string, repository: string, signal?: AbortSignal) => Promise<string>;
}

export interface ScriptedFirstRunValues {
  readonly chat?: string;
  readonly repository?: string;
  readonly githubCredential?: DiscoveredGitHubCredential;
}

export interface RunFirstRunSetupInput extends ManagedPathEnvironment {
  readonly interactive: boolean;
  readonly services: FirstRunServices;
  readonly prompts: FirstRunPrompts;
  readonly scripted?: ScriptedFirstRunValues;
  readonly chatGptCallbacks: DeviceCodeCallbacks;
  readonly whatsappCallbacks: PairingCallbacks;
  readonly signal?: AbortSignal;
}

const supportedChat = (jid: string): boolean => /^[^@\s]+@(g\.us|s\.whatsapp\.net)$/.test(jid);

const selectChat = async (
  candidates: readonly ChatCandidate[],
  input: RunFirstRunSetupInput,
): Promise<ChatCandidate> => {
  const supported = candidates.filter(({ jid }) => supportedChat(jid));
  if (supported.length === 0)
    throw new Error("The connected WhatsApp account did not synchronize any supported chats.");
  if (!input.interactive) {
    const scripted = input.scripted?.chat;
    if (!scripted) throw new Error("Non-interactive setup requires --chat from the authenticated account sync result.");
    const selected = supported.find(({ jid }) => jid === scripted);
    if (!selected)
      throw new Error("The scripted WhatsApp chat was not found in the authenticated account sync result.");
    return selected;
  }
  for (;;) {
    const jid = await input.prompts.selectChat(supported);
    const selected = supported.find((candidate) => candidate.jid === jid);
    if (selected) return selected;
    input.prompts.validationError("chat", "Choose a chat from the authenticated account sync result.");
  }
};

const resolveGitHub = async (
  input: RunFirstRunSetupInput,
): Promise<{ readonly repository: string; readonly credential: DiscoveredGitHubCredential }> => {
  let discoveredRepository = input.scripted?.repository ?? (await input.services.discoverRepository());
  const discoveredCredential = input.scripted?.githubCredential ?? (await input.services.discoverCredential());
  for (;;) {
    const raw = input.interactive ? await input.prompts.repository(discoveredRepository) : discoveredRepository;
    let repository: string;
    try {
      if (!raw) throw new Error("No repository was supplied or safely discovered.");
      repository = normalizeGitHubRepository(raw);
    } catch {
      if (!input.interactive) {
        throw new Error("Non-interactive setup requires --repository or one unambiguous GitHub origin.");
      }
      input.prompts.validationError("repository", "Enter a GitHub repository in owner/repository form.");
      discoveredRepository = undefined;
      continue;
    }

    const credential = input.interactive
      ? await input.prompts.githubCredential(discoveredCredential)
      : discoveredCredential;
    if (!credential?.token.trim()) {
      if (!input.interactive) {
        throw new Error("Non-interactive setup requires an explicit valid GitHub credential source.");
      }
      input.prompts.validationError("github", "Enter or choose a non-empty GitHub credential.");
      discoveredRepository = repository;
      continue;
    }
    try {
      const verified = await input.services.verifyGitHub(credential.token, repository, input.signal);
      return { repository: normalizeGitHubRepository(verified), credential };
    } catch {
      if (input.signal?.aborted) {
        const reason = input.signal.reason;
        const timedOut =
          reason instanceof Error && (reason.name === "TimeoutError" || /timeout|timed out/i.test(reason.message));
        throw new Error(timedOut ? "GitHub verification timed out." : "GitHub verification was cancelled.");
      }
      if (!input.interactive) {
        throw new Error(`GitHub authentication or repository access could not be verified for ${repository}.`);
      }
      input.prompts.validationError(
        "github",
        `GitHub authentication or repository access could not be verified for ${repository}.`,
      );
      discoveredRepository = repository;
    }
  }
};

export const runFirstRunSetup = async (input: RunFirstRunSetupInput): Promise<InstallManagedDataResult> => {
  const target = managedPaths(input);
  return await installPreparedManagedData({
    ...input,
    prepare: async (paths) => {
      const chatGpt = input.services.chatGptFor(paths);
      const chatGptStatus = await chatGpt.inspect();
      if (!input.interactive && chatGptStatus.state !== "ready") {
        throw new Error("Non-interactive setup requires an existing valid managed ChatGPT credential.");
      }
      if (chatGptStatus.state !== "ready") {
        await chatGpt.authenticate(input.chatGptCallbacks, input.signal);
      }

      const archive = createConversationArchive(paths.applicationDatabase);
      let account: ManagedWhatsAppAccount | undefined;
      let paired = false;
      const pairingAbort = new AbortController();
      const pairingSignal =
        input.signal === undefined ? pairingAbort.signal : AbortSignal.any([input.signal, pairingAbort.signal]);
      let selected: ChatCandidate;
      try {
        account = input.services.whatsappFor(paths, archive);
        await account.authenticate(
          {
            ...input.whatsappCallbacks,
            onPairing: (progress) => {
              paired = true;
              if (!input.interactive) pairingAbort.abort(new Error("fresh pairing required"));
              else input.whatsappCallbacks.onPairing?.(progress);
            },
          },
          pairingSignal,
        );
        if (!input.interactive && paired) {
          throw new Error("Non-interactive setup requires an existing valid managed WhatsApp session.");
        }
        selected = await selectChat(await account.synchronizedChats(input.signal), input);
      } catch (cause) {
        if (!input.interactive && paired) {
          throw new Error("Non-interactive setup requires an existing valid managed WhatsApp session.");
        }
        throw cause;
      } finally {
        try {
          await account?.stop();
        } finally {
          archive.close();
        }
      }

      const github = await resolveGitHub(input);
      const review: SetupReview = {
        dataDirectory: target.root,
        chat: { jid: selected.jid, name: selected.name, kind: selected.kind },
        repository: github.repository,
        chatGptCredentialSource:
          chatGptStatus.state === "ready" ? "existing managed credential" : "fresh device authorization",
        whatsappCredentialSource: paired ? "fresh pairing" : "existing managed session",
        githubCredentialSource: github.credential.source,
      };
      const approved = await input.prompts.review(review);
      if (input.signal?.aborted) {
        throw new Error("Setup was cancelled or timed out before promotion; no files changed.");
      }
      if (!approved) {
        throw new Error("Setup cancelled before promotion; no files changed.");
      }
      return {
        managedChats: [selected.jid],
        defaultRepository: github.repository,
        githubToken: github.credential.token,
      };
    },
  });
};
