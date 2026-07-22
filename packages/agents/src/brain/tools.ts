import { defineTool } from "@flue/runtime";
import * as v from "valibot";

import { deliverPromptEffect, getBrainEffectsRuntime } from "./effects-runtime.ts";

const nonEmptyString = v.pipe(v.string(), v.minLength(1));
const effectId = v.pipe(nonEmptyString, v.startsWith("brain-effect:"));

export const createPromptSpeakerTool = () =>
  defineTool({
    name: "prompt_speaker",
    description:
      "Durably direct one selected existing Surface's Speaker to communicate an objective. The Surface is an application UUID from the Batch, never a WhatsApp address. The Speaker owns wording.",
    input: v.object({
      batchId: nonEmptyString,
      surfaceId: nonEmptyString,
      objective: v.pipe(v.string(), v.minLength(1), v.maxLength(4_096)),
      brief: v.object({
        summary: v.pipe(v.string(), v.minLength(1), v.maxLength(8_192)),
        evidenceIds: v.pipe(v.array(nonEmptyString), v.minLength(1), v.maxLength(100)),
      }),
    }),
    output: v.object({
      kind: v.literal("prompt_speaker"),
      effectId,
      status: v.literal("accepted"),
      dispatchId: nonEmptyString,
    }),
    run: async ({ input }) => {
      const runtime = getBrainEffectsRuntime();
      const effect = await deliverPromptEffect(runtime.inbox.recordPrompt(input));
      if (effect.dispatch === undefined) throw new Error(`Prompt Effect ${effect.id} was not accepted.`);
      return {
        kind: "prompt_speaker" as const,
        effectId: effect.id,
        status: "accepted" as const,
        dispatchId: effect.dispatch.dispatchId,
      };
    },
  });

export const createStaySilentTool = () =>
  defineTool({
    name: "stay_silent",
    description: "Record an explicit decision that this Brain Batch warrants no external consequence.",
    input: v.object({
      batchId: nonEmptyString,
      reason: v.pipe(v.string(), v.minLength(1), v.maxLength(2_048)),
    }),
    output: v.object({ kind: v.literal("stay_silent"), effectId, status: v.literal("completed") }),
    run: ({ input }) => {
      const effect = getBrainEffectsRuntime().inbox.recordSilence(input.batchId, input.reason);
      return { kind: effect.kind, effectId: effect.id, status: effect.status };
    },
  });

export const createSettleBrainBatchTool = () =>
  defineTool({
    name: "settle_brain_batch",
    description:
      "Settle exactly one Brain Batch after all chosen Effects are durably completed or accepted. This reads application records; do not invent receipts.",
    input: v.object({ batchId: nonEmptyString }),
    output: v.object({
      batchId: nonEmptyString,
      status: v.literal("settled"),
      settledAt: nonEmptyString,
    }),
    run: async ({ input }) => {
      const runtime = getBrainEffectsRuntime();
      const settlement = runtime.inbox.settleBatch(input.batchId);
      await runtime.wake();
      return settlement;
    },
  });
