import * as prompts from "@clack/prompts";

import type { DeviceCodeCallbacks } from "@ambient-agent/core/model/chatgpt-authentication.ts";
import type { FirstRunPrompts, SetupReview } from "../setup/first-run.js";
import { renderQr } from "@ambient-agent/core/shared/qr.ts";
import type { CliOutput } from "./program.js";

export type SetupPrompts = FirstRunPrompts;

const requiredPrompt = async (label: string, prompt: () => Promise<string | symbol>): Promise<string> => {
  const value = await prompt();
  if (prompts.isCancel(value)) {
    prompts.cancel("Setup cancelled.");
    throw new Error("Setup cancelled.");
  }
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} is required.`);
  return trimmed;
};

const promptValue = async <Value>(prompt: Promise<Value | symbol>): Promise<Value> => {
  const value = await prompt;
  if (prompts.isCancel(value)) {
    prompts.cancel("Setup cancelled.");
    throw new Error("Setup cancelled.");
  }
  return value;
};

export const defaultSetupPrompts: SetupPrompts = {
  selectChat: async (candidates) =>
    await promptValue(
      prompts.autocomplete({
        message: "Search the synchronized WhatsApp chats",
        options: candidates.map((candidate) => ({
          value: candidate.jid,
          label: candidate.name,
          hint: [
            candidate.kind,
            candidate.lastActivityAt === undefined
              ? undefined
              : `active ${new Date(candidate.lastActivityAt).toISOString()}`,
            candidate.jid,
          ]
            .filter(Boolean)
            .join(" · "),
        })),
        maxItems: 10,
      }),
    ),
  repository: (discovered) =>
    requiredPrompt("Repository", () =>
      prompts.text({
        message: "Default GitHub repository",
        placeholder: "owner/repository",
        ...(discovered === undefined ? {} : { initialValue: discovered }),
      }),
    ),
  githubCredential: async (discovered) => {
    if (discovered !== undefined) {
      const reuse = await promptValue(
        prompts.confirm({
          message: `Use the GitHub credential from ${discovered.source}?`,
          initialValue: true,
        }),
      );
      if (reuse) return discovered;
    }
    const token = await requiredPrompt("GitHub token", () =>
      prompts.password({
        message: "Fine-grained GitHub personal access token",
        mask: "*",
      }),
    );
    return { token, source: "secure prompt" };
  },
  review: async (review: SetupReview) => {
    prompts.note(
      [
        `Data directory: ${review.dataDirectory}`,
        `ChatGPT: ${review.chatGptCredentialSource}`,
        `WhatsApp: ${review.whatsappCredentialSource}`,
        `Managed chat: ${review.chat.name} (${review.chat.kind}, ${review.chat.jid})`,
        `GitHub repository: ${review.repository}`,
        `GitHub credential: ${review.githubCredentialSource}`,
      ].join("\n"),
      "Review Ambient Agent setup",
    );
    return await promptValue(prompts.confirm({ message: "Create this managed installation?", initialValue: true }));
  },
  validationError: (_field, message) => prompts.log.error(message),
};

export const createDeviceCodeCallbacks = (output: CliOutput): DeviceCodeCallbacks => ({
  onDeviceCode: (info) => {
    output.stdout(`Open ${info.verificationUri} and enter code ${info.userCode}.\n`);
    if (info.expiresInSeconds !== undefined) {
      output.stdout(`The device code expires in ${info.expiresInSeconds} seconds.\n`);
    }
  },
  onProgress: ({ phase }) => {
    output.stdout(phase === "waiting" ? "Waiting for ChatGPT authorization...\n" : "ChatGPT authorization complete.\n");
  },
});

export const createWhatsAppCallbacks = (output: CliOutput) => ({
  onPairing: (pairing: { readonly qr?: string; readonly code?: string }) => {
    if (pairing.qr !== undefined) {
      renderQr(pairing.qr, output.stdout);
    } else if (pairing.code !== undefined) {
      output.stdout(`Enter WhatsApp pairing code ${pairing.code}.\n`);
    }
  },
});
