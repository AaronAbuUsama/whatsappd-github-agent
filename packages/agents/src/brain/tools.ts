import { defineTool } from "@flue/runtime";
import * as v from "valibot";

import { MAX_PUBLIC_ISSUE_BODY_LENGTH } from "../capabilities/issue-management/issue-repository.ts";
import { deliverIssueFilingEffect, deliverPromptEffect, getBrainEffectsRuntime } from "./effects-runtime.ts";

const nonEmptyString = v.pipe(v.string(), v.minLength(1));
const effectId = v.pipe(nonEmptyString, v.startsWith("brain-effect:"));
const issueNumber = v.pipe(v.number(), v.integer(), v.minValue(1));
const issueUrl = v.pipe(v.string(), v.url());

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

export const createFileIssueTool = () =>
  defineTool({
    name: "file_issue",
    description:
      "Durably file one GitHub issue for the originating Surface's repository, which is resolved from that Surface — never chosen here. Supply the current Batch id and the Surface as provenance. This creates the issue; report the outcome back separately with prompt_speaker.",
    input: v.object({
      batchId: nonEmptyString,
      surfaceId: nonEmptyString,
      kind: v.union([v.literal("bug"), v.literal("feature")]),
      title: v.pipe(nonEmptyString, v.maxLength(256)),
      body: v.pipe(nonEmptyString, v.maxLength(MAX_PUBLIC_ISSUE_BODY_LENGTH)),
    }),
    output: v.union([
      v.object({
        kind: v.literal("file_issue"),
        effectId,
        status: v.union([v.literal("created"), v.literal("reconciled")]),
        issueNumber,
        url: issueUrl,
      }),
      v.object({
        kind: v.literal("file_issue"),
        effectId,
        status: v.literal("duplicate"),
        issues: v.array(v.object({ number: issueNumber, url: issueUrl, title: nonEmptyString })),
      }),
      v.object({ kind: v.literal("file_issue"), effectId, status: v.literal("uncertain"), reason: nonEmptyString }),
    ]),
    run: async ({ input }) => {
      const runtime = getBrainEffectsRuntime();
      if (runtime.repositoryForSurface === undefined || runtime.fileIssue === undefined) {
        throw new Error("Issue filing is not configured for this Brain runtime.");
      }
      const effect = await deliverIssueFilingEffect(
        runtime.inbox.recordIssueFiling({
          batchId: input.batchId,
          sourceSurfaceId: input.surfaceId,
          repository: runtime.repositoryForSurface(input.surfaceId),
          kind: input.kind,
          title: input.title,
          body: input.body,
        }),
      );
      const outcome = effect.outcome;
      if (outcome === undefined) throw new Error(`File Issue Effect ${effect.id} did not settle to an outcome.`);
      if (outcome.status === "duplicate") {
        return {
          kind: "file_issue" as const,
          effectId: effect.id,
          status: "duplicate" as const,
          issues: outcome.issues.map((issue) => ({ ...issue })),
        };
      }
      return { kind: "file_issue" as const, effectId: effect.id, ...outcome };
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
