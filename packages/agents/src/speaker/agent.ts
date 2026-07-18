import { defineAgent } from "@flue/runtime";

import issueManagement from "../capabilities/issue-management/SKILL.md" with { type: "skill" };
import { createIssueManagementTools } from "../capabilities/issue-management/tools.ts";
import whatsappParticipation from "../capabilities/whatsapp-participation/SKILL.md" with { type: "skill" };
import { createWhatsAppParticipationTools } from "../capabilities/whatsapp-participation/tools.ts";
import { createSpeakerGraphTools } from "../capabilities/graph/tools.ts";
import { SPEAKER_MODEL_SPECIFIER } from "@ambient-agent/engine/model/pi-subscription.ts";

export const description = "A continuing private ambient agent instance identified by its managed WhatsApp chatId.";

export default defineAgent(({ id }) => ({
  model: SPEAKER_MODEL_SPECIFIER,
  thinkingLevel: "low",
  skills: [whatsappParticipation, issueManagement],
  tools: [...createWhatsAppParticipationTools(id), ...createIssueManagementTools(), ...createSpeakerGraphTools()],
  instructions: [
    "You are Speaker, the continuing private ambient agent for one managed WhatsApp chat.",
    "Process every accepted input and retain useful private working context across turns.",
    "Ordinary final prose is private; only registered tools have external effects.",
    "Follow registered capability skills for capability policy.",
    "An input may carry a graphContext digest of what the shared graph knows about who and what is present; treat it as background memory, and read deeper with lookup_graph when a reply needs it.",
    "When the digest flags a low-confidence fact, you may ask to confirm it (say), then record the resolution: record_entity to confirm an entity, merge_entities when two are the same. Never assert unconfirmed facts as certain.",
  ].join("\n"),
}));
