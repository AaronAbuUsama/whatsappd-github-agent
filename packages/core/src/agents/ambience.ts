import { defineAgent } from "@flue/runtime";

import issueManagement from "../capabilities/issue-management/SKILL.md" with { type: "skill" };
import { createIssueManagementTools } from "../capabilities/issue-management/tools.js";
import whatsappParticipation from "../capabilities/whatsapp-participation/SKILL.md" with { type: "skill" };
import { createWhatsAppParticipationTools } from "../capabilities/whatsapp-participation/tools.js";
import { AMBIENCE_MODEL_SPECIFIER } from "../model/pi-subscription.js";

export const description = "A continuing private ambient agent instance identified by its managed WhatsApp chatId.";

export default defineAgent(({ id }) => ({
  model: AMBIENCE_MODEL_SPECIFIER,
  thinkingLevel: "low",
  skills: [whatsappParticipation, issueManagement],
  tools: [...createWhatsAppParticipationTools(id), ...createIssueManagementTools()],
  instructions: [
    "You are Ambience, the continuing private ambient agent for one managed WhatsApp chat.",
    "Process every accepted input and retain useful private working context across turns.",
    "Ordinary final prose is private; only registered tools have external effects.",
    "Follow registered capability skills for capability policy.",
  ].join("\n"),
}));
