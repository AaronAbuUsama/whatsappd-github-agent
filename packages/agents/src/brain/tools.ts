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
      "Durably direct one Surface's Speaker to communicate an objective. Target EITHER a stable Surface " +
      "(`surfaceId`, an application UUID from the Batch) OR a known Person or thread from the Graph " +
      "(`entityId`) — trusted code resolves the entity to the same Surface registry, so 'DM someone' and " +
      "'reply in the group' are one operation. Never a WhatsApp address. The Speaker owns wording.",
    input: v.object({
      batchId: nonEmptyString,
      // Exactly one target: a resolved Surface id, or a Graph entity (person/thread) resolved here. Strict
      // arms reject an input carrying BOTH fields — an ambiguous target is invalid, not silently resolved.
      target: v.union([v.strictObject({ surfaceId: nonEmptyString }), v.strictObject({ entityId: nonEmptyString })]),
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
      // Resolve a known-Person / thread target to its Surface during prompt admission (§8). Fail closed:
      // an entity that resolves to no active/openable Surface never speaks — the Brain must stay_silent.
      let surfaceId: string;
      let release = (): void => undefined;
      if ("surfaceId" in input.target) {
        surfaceId = input.target.surfaceId;
      } else {
        if (runtime.resolveSurfaceForEntity === undefined) {
          throw new Error("Surface resolution is not configured for this Brain runtime.");
        }
        const resolved = runtime.resolveSurfaceForEntity(input.target.entityId);
        if (resolved === undefined) {
          throw new Error(
            `Entity ${input.target.entityId} resolves to no Surface — it is unknown or not addressable. ` +
              "Stay silent rather than participate; observation never grants participation.",
          );
        }
        surfaceId = resolved.surfaceId;
        release = resolved.release;
      }
      // Materialization is atomic with admission: if recordPrompt rejects (stale Batch, bad evidence), undo
      // a DM Surface this call just opened so no active binding survives without an accepted Prompt Effect.
      // deliverPromptEffect failures happen AFTER the Effect is durable → recovery re-delivers, keep the binding.
      let pending;
      try {
        pending = runtime.inbox.recordPrompt({
          batchId: input.batchId,
          surfaceId,
          objective: input.objective,
          brief: input.brief,
        });
      } catch (cause) {
        release();
        throw cause;
      }
      const effect = await deliverPromptEffect(pending);
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
