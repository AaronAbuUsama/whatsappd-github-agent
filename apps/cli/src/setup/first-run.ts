import { chmod, cp, lstat, opendir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

import { createConversationArchive, type ConversationArchive } from "@ambient-agent/engine/intake/conversation-archive.ts";
import { installPreparedManagedData, type InstallManagedDataResult } from "@ambient-agent/installation/installation.ts";
import { managedPaths, type ManagedPathEnvironment, type ManagedPaths } from "@ambient-agent/installation/paths.ts";
import type { ChatGptAuthentication, DeviceCodeCallbacks } from "@ambient-agent/engine/model/chatgpt-authentication.ts";
import {
  WhatsAppAccountError,
  type ChatCandidate,
  type ManagedWhatsAppAccount,
  type PairingCallbacks,
} from "@ambient-agent/installation/whatsapp-account.ts";
import {
  subscriptionModelChoice,
  type GitHubAppReference,
  type GitHubAppTriple,
  type GitHubAppTriples,
  type ManagedModelChoice,
} from "@ambient-agent/installation/schema.ts";
import { SUBSCRIPTION_PROVIDER_ID } from "@ambient-agent/engine/model/pi-subscription.ts";
import { normalizeGitHubRepository } from "./github.ts";

/** The single line the review shows for the guided three-App paste; carries no secret material. */
export const GUIDED_GITHUB_APP_SOURCE = "guided GitHub App paste";

export interface SetupReview {
  readonly dataDirectory: string;
  readonly chat: Pick<ChatCandidate, "jid" | "name" | "kind">;
  readonly repository: string;
  /** How model auth was satisfied. Never a key value — only its provenance. */
  readonly chatGptCredentialSource:
    | "existing managed credential"
    | "fresh device authorization"
    | "pasted API key";
  /** The chosen provider, shown so the operator confirms which one the key was pasted for. */
  readonly modelProvider?: string;
  readonly whatsappCredentialSource: "existing managed session" | "fresh pairing";
  readonly githubCredentialSource: string;
}

export interface FirstRunPrompts {
  selectChat(candidates: readonly ChatCandidate[]): Promise<string>;
  repository(discovered?: string): Promise<string>;
  /** Guided paste of the three App triples; the implementation prints each App's checklist. */
  githubApps(repository: string): Promise<GitHubAppTriples>;
  /** Guided paste of a single App triple — the rotation path (`config --github-app <ref>`). */
  githubApp(reference: GitHubAppReference, repository: string): Promise<GitHubAppTriple>;
  /** Guided paste of the model API key, at first run or via `config --model-provider <id>`. */
  modelApiKey?(provider: string): Promise<string>;
  /** First-run auth choice (C1): the subscription device flow, or a pasted API key. */
  modelAuthMode?(): Promise<"subscription" | "api-key">;
  /** Pick one model from the provider's catalog; applied to every agent role. */
  selectModel?(provider: string, modelIds: readonly string[]): Promise<string>;
  /** Pick one reasoning level; applied to every agent role. */
  selectThinkingLevel?(levels: readonly string[]): Promise<string>;
  review(review: SetupReview): Promise<boolean>;
  validationError(field: "chat" | "repository" | "github", message: string): void;
}

type ChatGptSetup = Pick<ChatGptAuthentication, "inspect" | "authenticate">;

export interface FirstRunServices {
  readonly chatGptFor: (paths: ManagedPaths) => ChatGptSetup;
  readonly whatsappFor: (paths: ManagedPaths, archive: ConversationArchive) => ManagedWhatsAppAccount;
  readonly discoverRepository: () => Promise<string | undefined>;
  readonly verifyGitHub: (credential: GitHubAppTriple, repository: string, signal?: AbortSignal) => Promise<string>;
}

export interface ScriptedFirstRunValues {
  readonly chat?: string;
  readonly repository?: string;
  readonly githubApps?: GitHubAppTriples;
}

export interface RunFirstRunSetupInput extends ManagedPathEnvironment {
  readonly interactive: boolean;
  readonly allowFreshChatGptAuthentication?: boolean;
  /**
   * The model auth chosen for this install. Absent means the subscription provider and the
   * ChatGPT device flow — the historical behaviour. Naming an API-key provider skips that
   * flow entirely and pastes a key instead (decision 5: neither mode is required).
   */
  readonly modelChoice?: ManagedModelChoice;
  readonly modelCredentialStorage?: "managed-file" | "tenant-database";
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
): Promise<{ readonly repository: string; readonly triples: GitHubAppTriples }> => {
  let discoveredRepository = input.scripted?.repository ?? (await input.services.discoverRepository());
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

    // --github-apps-file wins whenever it was supplied. Asking interactively instead made the
    // flag unreachable on the only path that pairs WhatsApp, and the guided paste cannot carry a
    // PEM anyway: its prompt is single-line, so a pasted multi-line key silently becomes its
    // last line. An operator who brought the triples in a file must never be asked for them.
    const triples = input.scripted?.githubApps ?? (input.interactive ? await input.prompts.githubApps(repository) : undefined);
    if (triples === undefined) {
      // Non-interactive setup has no guided paste; the triples must be supplied up front.
      throw new Error("Non-interactive setup requires the three GitHub App triples.");
    }
    try {
      // The Planner App is the runtime's own identity, so its installation is the one that
      // must prove repository access before promotion (the Coder/Reviewer are verified lazily).
      const verified = await input.services.verifyGitHub(triples.planner, repository, input.signal);
      return { repository: normalizeGitHubRepository(verified), triples };
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
      // Model auth is an API key OR a subscription, and neither is required. Only the
      // subscription provider runs the ChatGPT device flow; an API-key provider pastes a
      // key and never touches it, so a box with no subscription can still complete setup.
      const modelChoice = input.modelChoice ?? subscriptionModelChoice;
      const apiKeyProvider = modelChoice.provider !== SUBSCRIPTION_PROVIDER_ID;
      let modelApiKey: string | undefined;
      let modelSource: SetupReview["chatGptCredentialSource"];
      if (apiKeyProvider) {
        if (!input.interactive || input.prompts.modelApiKey === undefined) {
          throw new Error(
            `Setting up the ${modelChoice.provider} model provider requires the interactive guided key paste.`,
          );
        }
        modelApiKey = await input.prompts.modelApiKey(modelChoice.provider);
        modelSource = "pasted API key";
      } else {
        const chatGpt = input.services.chatGptFor(paths);
        const chatGptStatus = await chatGpt.inspect();
        if (!input.interactive && !input.allowFreshChatGptAuthentication && chatGptStatus.state !== "ready") {
          throw new Error("Non-interactive setup requires an existing valid managed ChatGPT credential.");
        }
        if (chatGptStatus.state !== "ready") {
          await chatGpt.authenticate(input.chatGptCallbacks, input.signal);
        }
        modelSource =
          chatGptStatus.state === "ready" ? "existing managed credential" : "fresh device authorization";
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
        chatGptCredentialSource: modelSource,
        modelProvider: modelChoice.provider,
        whatsappCredentialSource: paired ? "fresh pairing" : "existing managed session",
        githubCredentialSource: GUIDED_GITHUB_APP_SOURCE,
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
        githubApps: github.triples,
        model: { ...modelChoice, ...(modelApiKey === undefined ? {} : { apiKey: modelApiKey }) },
      };
    },
  });
};
