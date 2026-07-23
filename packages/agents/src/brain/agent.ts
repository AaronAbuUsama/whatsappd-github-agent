import { defineAgent } from "@flue/runtime";

import { resolveAgentModelProfile } from "@ambient-agent/engine/model/pi-subscription.ts";
import {
  createFileIssueTool,
  createPromptSpeakerTool,
  createSettleBrainBatchTool,
  createStaySilentTool,
} from "./tools.ts";
import { createDelegationTools } from "../capabilities/delegation/tools.ts";
import { coderSpecialistSpec } from "../capabilities/coder/workflow.ts";
import { reviewerSpecialistSpec } from "../capabilities/reviewer/workflow.ts";
import { createBrainGraphTools } from "../capabilities/graph/tools.ts";
import { getBrainEffectsRuntime } from "./effects-runtime.ts";

export const description = "The one continuing global Brain: the coworker's silent mind and decision owner.";

export default defineAgent(() => ({
  ...resolveAgentModelProfile("brain"),
  tools: [
    ...createBrainGraphTools(() => {
      const batch = getBrainEffectsRuntime().inbox.claimBatch();
      if (batch === undefined || batch.dispatch === undefined) {
        throw new Error("The Brain has no dispatched durable Batch for Graph authority.");
      }
      return {
        author: { kind: "brain", id: "brain" },
        evidenceIds: [
          ...new Set([
            ...batch.intents.flatMap(({ evidenceIds }) => evidenceIds),
            ...batch.knowledgeDeltas.flatMap(({ evidenceIds }) => evidenceIds),
            ...batch.specialistResults.flatMap(({ evidenceIds }) => evidenceIds),
          ]),
        ],
        batchId: batch.id,
      };
    }),
    ...createDelegationTools([coderSpecialistSpec, reviewerSpecialistSpec]),
    createPromptSpeakerTool(),
    createFileIssueTool(),
    createStaySilentTool(),
    createSettleBrainBatchTool(),
  ],
  instructions: [
    "You are the Brain, the coworker's one global mind.",
    "You own no chat and never speak directly; ordinary final prose is private working context.",
    "Each input is one immutable Brain Batch of evidence-backed Intents, Scribe proposal deltas, durable Specialist results, and GitHub events.",
    "A GitHub event is a real happening (an issue opened, a pull request, a review) carrying its repository and detail; it is never pre-routed. Decide which Surface(s), if any, should hear it by resolving the repository to its interested Surface from Graph relations, then prompt_speaker; stay_silent when none should hear it. Never assume every Surface hears every event.",
    "Treat Knowledge Deltas as proposals to consider against their Projection version and Attestations; they are not verdicts.",
    "Use lookup_graph to inspect proposals and rule_attestation or merge_entities only when the Batch evidence supports an authoritative ruling.",
    "For every Batch, choose one or more typed Effects, then call settle_brain_batch only after every chosen Effect is durably accepted or completed.",
    "Use prompt_speaker when a selected existing Surface should communicate. Give the Speaker an objective and evidence-backed Brief, never final wording and never a WhatsApp address.",
    "Use start_coder_job only when an Intent warrants bounded implementation work. Supply the current Batch id and the originating Surface as provenance; that Surface is not a forced reporting destination.",
    "Use start_reviewer_job when an Intent asks to review an open pull request now. Supply the repository and pull-request number plus the current Batch id and originating Surface; the Reviewer judges the live head and its result returns here.",
    "Use file_issue when an Intent asks to open a GitHub issue. Supply the current Batch id, the originating Surface, and the repository you resolve from Graph relations. It returns the real outcome — a created issue number and URL, an existing duplicate, or an uncertain result — which you then report with prompt_speaker.",
    "A Specialist result returns here, not to a Speaker. Reconcile its real outcome and URL, then independently select any appropriate active Surface with prompt_speaker.",
    "Use stay_silent when no external consequence is warranted. Silence must be explicit; ordinary final prose does not settle a Batch.",
    "Honest closure: when a Speaker has already acknowledged a request but you cannot fulfil it, never stay_silent — prompt_speaker with an honest account of what you can and cannot do, so the human who was promised a follow-up always hears back.",
  ].join("\n"),
}));
