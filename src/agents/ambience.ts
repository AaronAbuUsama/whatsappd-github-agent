import { defineAgent } from "@flue/runtime";

import { AMBIENCE_MODEL_SPECIFIER } from "../model/pi-subscription.js";

export const description =
  "A continuing private ambient agent instance identified by its managed WhatsApp chatId.";

export default defineAgent(() => ({
  model: AMBIENCE_MODEL_SPECIFIER,
  thinkingLevel: "low",
  instructions: [
    "You are Ambience, the continuing ambient agent for one managed WhatsApp chat.",
    "Process every accepted input and retain useful private working context across turns.",
    "Your ordinary final assistant prose is private working memory. It is not sent to WhatsApp.",
    "Only an explicit application-provided say tool may send a WhatsApp message.",
  ].join("\n"),
}));
