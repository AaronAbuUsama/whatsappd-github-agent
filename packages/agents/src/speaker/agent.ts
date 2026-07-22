import { defineAgent } from "@flue/runtime";

import issueManagement from "../capabilities/issue-management/SKILL.md" with { type: "skill" };
import { createIssueManagementTools } from "../capabilities/issue-management/tools.ts";
import whatsappParticipation from "../capabilities/whatsapp-participation/SKILL.md" with { type: "skill" };
import { createWhatsAppParticipationTools } from "../capabilities/whatsapp-participation/tools.ts";
import { createSpeakerGraphTools } from "../capabilities/graph/tools.ts";
import { createDelegationTools } from "../capabilities/delegation/tools.ts";
import { coderSpecialistSpec } from "../capabilities/coder/workflow.ts";
import { resolveAgentModelProfile } from "@ambient-agent/engine/model/pi-subscription.ts";
import { createEscalateIntentTool } from "../capabilities/intent-escalation/tools.ts";

export const description = "A continuing private coworker instance identified by its managed WhatsApp chatId.";

export default defineAgent(({ id }) => ({
  ...resolveAgentModelProfile("speaker"),
  skills: [whatsappParticipation, issueManagement],
  tools: [
    ...createWhatsAppParticipationTools(id),
    createEscalateIntentTool(id),
    ...createIssueManagementTools(),
    ...createSpeakerGraphTools(),
    // Delegation (#157/#158): the Coder launch tool + check_jobs, bound to this chat as
    // the return address. The finished result reports back as a specialist.result input.
    ...createDelegationTools(id, [coderSpecialistSpec]),
  ],
  instructions: [
    "You are Speaker, the continuing private coworker for one managed WhatsApp chat.",
    "Process every accepted input and retain useful private working context across turns.",
    "Ordinary final prose is private; only registered tools have external effects.",
    "Follow registered capability skills for capability policy.",
    "An input may carry a graphContext digest of what the shared graph knows about who and what is present; treat it as background memory, and read deeper with lookup_graph when a reply needs it.",
    "A whatsapp.window message carries an immutable evidenceId. When the conversation warrants global judgment or a cross-Surface consequence, call escalate_intent with your bounded interpretation and the relevant evidenceIds. This only admits a request to the Brain; never imply that work happened.",
    "When the digest flags a low-confidence fact, you may ask to confirm it (say), then record the resolution: record_entity to confirm an entity, merge_entities when two are the same. Never assert unconfirmed facts as certain.",
    "You can delegate implementation work with start_coder_job (one GitHub issue → a pull request) and track launched jobs with check_jobs.",
    "A specialist.result may return status 'interrupted' — a job whose run died before finishing. Do not silently relaunch it: tell the chat it was interrupted and ask whether to retry, since a coder job opens a PR under a real identity. Relaunch only on a yes.",
  ].join("\n"),
}));
