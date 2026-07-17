import { chmod, cp, lstat, opendir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

import { createConversationArchive, type ConversationArchive } from "@ambient-agent/core/intake/conversation-archive.ts";
import { installPreparedManagedData, type InstallManagedDataResult } from "@ambient-agent/core/managed/installation.ts";
import { managedPaths, type ManagedPathEnvironment, type ManagedPaths } from "@ambient-agent/core/managed/paths.ts";
import type { ChatGptAuthentication, DeviceCodeCallbacks } from "@ambient-agent/core/model/chatgpt-authentication.ts";
import {
  WhatsAppAccountError,
  type ChatCandidate,
  type ManagedWhatsAppAccount,
  type PairingCallbacks,
} from "@ambient-agent/core/whatsapp/account.ts";
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
  readonly allowFreshChatGptAuthentication?: boolean;
  readonly whatsappStoreSource?: string;
  readonly services: FirstRunServices;
  readonly prompts: FirstRunPrompts;
  readonly scripted?: ScriptedFirstRunValues;
  readonly chatGptCallbacks: DeviceCodeCallbacks;
  readonly whatsappCallbacks: PairingCallbacks;
  readonly signal?: AbortSignal;
}

const secureImportedWhatsAppStore = async (directory: string): Promise<void> => {
  const entries = await opendir(directory);
  for await (const entry of entries) {
    const path = join(directory, entry.name);
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
      throw new Error("The WhatsApp store may contain only directories and regular files.");
    }
    if (stat.isDirectory()) {
      await secureImportedWhatsAppStore(path);
      await chmod(path, 0o700);
    } else {
      await chmod(path, 0o600);
    }
  }
};

const importWhatsAppStore = async (source: string, destination: string): Promise<void> => {
  const sourceStat = await lstat(source);
  if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) {
    throw new Error("The WhatsApp store source must be a regular directory.");
  }
  const [canonicalSource, canonicalDestination] = await Promise.all([realpath(source), realpath(destination)]);
  const contains = (parent: string, child: string): boolean => {
    const path = relative(parent, child);
    return path === "" || (!isAbsolute(path) && path !== ".." && !path.startsWith(`..${sep}`));
  };
  if (contains(canonicalSource, canonicalDestination) || contains(canonicalDestination, canonicalSource)) {
    throw new Error("The WhatsApp store source and managed staging directory must not overlap.");
  }
  const entries = await opendir(source);
  for await (const entry of entries) {
    await cp(join(source, entry.name), join(destination, entry.name), {
      recursive: true,
      force: false,
      errorOnExist: true,
      filter: async (path) => {
        const stat = await lstat(path);
        if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
          throw new Error("The WhatsApp store may contain only directories and regular files.");
        }
        return true;
      },
    });
  }
  await secureImportedWhatsAppStore(destination);
  await chmod(destination, 0o700);
};

const supportedChat = (jid: string): boolean => /^[^@\s]+@(g\.us|s\.whatsapp\.net)$/.test(jid);

const selectChat = async (
  candidates: readonly ChatCandidate[],
  input: RunFirstRunSetupInput,
  allowImportedFallback: boolean,
): Promise<ChatCandidate> => {
  const supported = candidates.filter(({ jid }) => supportedChat(jid));
  if (supported.length === 0) {
    const importedChat = allowImportedFallback ? input.scripted?.chat : undefined;
    if (importedChat !== undefined && supportedChat(importedChat)) {
      return {
        jid: importedChat,
        name: importedChat,
        kind: importedChat.endsWith("@g.us") ? "group" : "direct",
      };
    }
    throw new Error("The connected WhatsApp account did not synchronize any supported chats.");
  }
  const scripted = input.scripted?.chat;
  if (scripted !== undefined) {
    const selected = supported.find(({ jid }) => jid === scripted);
    if (!selected)
      throw new Error("The scripted WhatsApp chat was not found in the authenticated account sync result.");
    return selected;
  }
  if (!input.interactive) {
    throw new Error("Non-interactive setup requires --chat from the authenticated account sync result.");
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
      if (input.whatsappStoreSource !== undefined) {
        await importWhatsAppStore(input.whatsappStoreSource, paths.whatsapp);
      }
      const chatGpt = input.services.chatGptFor(paths);
      const chatGptStatus = await chatGpt.inspect();
      if (!input.interactive && !input.allowFreshChatGptAuthentication && chatGptStatus.state !== "ready") {
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
        let candidates: readonly ChatCandidate[];
        try {
          candidates = await account.synchronizedChats(input.signal);
        } catch (cause) {
          const mayUseImportedChat =
            !paired &&
            input.whatsappStoreSource !== undefined &&
            input.scripted?.chat !== undefined &&
            cause instanceof WhatsAppAccountError &&
            cause.code === "timeout";
          if (!mayUseImportedChat) throw cause;
          candidates = [];
        }
        selected = await selectChat(candidates, input, !paired && input.whatsappStoreSource !== undefined);
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
      const approved = input.interactive ? await input.prompts.review(review) : true;
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
