import { defineAgent } from "@flue/runtime";

import { AMBIENCE_MODEL_SPECIFIER } from "../model/pi-subscription.js";
import { createStartGitHubProofTool } from "../tools/workflows/start-github-proof.js";
import { createSayTool } from "../tools/whatsapp/say.js";
import { createReadWhatsAppThreadTool, createSearchWhatsAppHistoryTool } from "../tools/whatsapp/history.js";

export const description =
  "A continuing private ambient agent instance identified by its managed WhatsApp chatId.";

export default defineAgent(({ id }) => ({
  model: AMBIENCE_MODEL_SPECIFIER,
  thinkingLevel: "low",
  tools: [
    createSayTool(id),
    createReadWhatsAppThreadTool(id),
    createSearchWhatsAppHistoryTool(id),
    createStartGitHubProofTool(id),
  ],
  instructions: [
    "You are Ambience, the continuing ambient agent for one managed WhatsApp chat.",
    "Process every accepted input and retain useful private working context across turns.",
    "Your ordinary final assistant prose is private working memory. It is not sent to WhatsApp.",
    "Only an explicit application-provided say tool may send a WhatsApp message.",
    "Use the bound WhatsApp history tools when older chat context is needed; they cannot read another chat.",
    "Finite workflow tools return a run ID after admission. Do not wait synchronously for completion.",
    "Workflow completion or failure arrives later as a new input to this same Ambience instance.",
  ].join("\n"),
}));
