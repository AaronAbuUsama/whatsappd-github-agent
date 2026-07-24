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

export const createResolveSurfaceTool = () =>
  defineTool({
    name: "resolve_surface",
    description:
      "Resolve a provider chat id — as it appears on a Graph `thread` entity's chatId — to the stable " +
      "application Surface id you pass to prompt_speaker. Use it to bridge a repository's works_on thread " +
      "to a Surface. Returns no surface for an unknown or unbound chat; then that chat hears nothing.",
    // ponytail: the Brain touches a provider chatId here only because #19 keys the Graph `thread`
    // entity by chatId; S5 (#329) subsumes this into prompt admission and removes the intermediate.
    input: v.object({ providerChatId: nonEmptyString }),
    output: v.union([
      v.object({ resolved: v.literal(true), surfaceId: nonEmptyString }),
      v.object({ resolved: v.literal(false) }),
    ]),
    run: ({ input }) => {
      const runtime = getBrainEffectsRuntime();
      if (runtime.resolveSurfaceForChat === undefined) {
        throw new Error("Surface resolution is not configured for this Brain runtime.");
      }
      const surfaceId = runtime.resolveSurfaceForChat(input.providerChatId);
      return surfaceId === undefined ? { resolved: false as const } : { resolved: true as const, surfaceId };
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
      "Durably file one GitHub issue in the repository you choose, resolved from Graph relations. Supply the current Batch id and the originating Surface as provenance, and the target repository as `owner/repo`. There is no default: if you cannot resolve a repository, do not call this — report honestly instead; an issue is never auto-filed into a fallback repo. This creates the issue; report the outcome back separately with prompt_speaker.",
    input: v.object({
      batchId: nonEmptyString,
      surfaceId: nonEmptyString,
      // Optional in the schema so an omission surfaces a domain error the Brain can recover from,
      // rather than a generic validation failure — but the Brain must supply it (fail-closed below).
      repository: v.optional(v.pipe(nonEmptyString, v.regex(/^[^/\s]+\/[^/\s]+$/u, "repository must be owner/repo"))),
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
      if (runtime.fileIssue === undefined) {
        throw new Error("Issue filing is not configured for this Brain runtime.");
      }
      // Fail closed: routing is the Brain's, never a config default. If no repository was resolved,
      // never silently misfile into defaultRepository — surface it so the Brain re-files with an
      // explicit repo or reports honestly. (§8: config is authorization, never routing.)
      if (input.repository === undefined) {
        throw new Error(
          "file_issue requires an explicit repository (owner/repo) resolved from the Graph. " +
            "No repository was supplied and there is no default — re-file with the resolved repository, " +
            "or report honestly that this Surface has no repository relation.",
        );
      }
      const effect = await deliverIssueFilingEffect(
        runtime.inbox.recordIssueFiling({
          batchId: input.batchId,
          sourceSurfaceId: input.surfaceId,
          repository: input.repository,
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

export const createScheduleWakeTool = () =>
  defineTool({
    name: "schedule_wake",
    description:
      "Durably schedule the Brain to reconsider an open loop at a future time (§6 Scheduled Wake) — e.g. " +
      "'chase this commitment if still unmet in two hours'. Supply the current Batch id (it is a local " +
      "effect of this Batch), an ISO-8601 dueAt, and a short reason naming the loop. It survives restart " +
      "and wakes the Brain exactly once when due. Scheduling the same reason and time twice coalesces to one wake.",
    input: v.object({
      batchId: nonEmptyString,
      reason: v.pipe(v.string(), v.minLength(1), v.maxLength(2_048)),
      dueAt: v.pipe(v.string(), v.isoTimestamp()),
    }),
    output: v.object({
      kind: v.literal("scheduled"),
      wakeId: v.pipe(nonEmptyString, v.startsWith("scheduled-wake:")),
      dueAt: nonEmptyString,
    }),
    run: ({ input }) => {
      const wake = getBrainEffectsRuntime().inbox.scheduleWake(input);
      return { kind: "scheduled" as const, wakeId: wake.id, dueAt: wake.dueAt };
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
