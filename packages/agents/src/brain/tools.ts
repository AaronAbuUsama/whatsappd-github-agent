import { defineTool } from "@flue/runtime";
import * as v from "valibot";

import type { IssueMutation, IssueMutationOutcome } from "@ambient-agent/engine/brain/inbox.ts";
import {
  MAX_PUBLIC_COMMENT_BODY_LENGTH,
  MAX_PUBLIC_ISSUE_BODY_LENGTH,
} from "../capabilities/issue-management/issue-repository.ts";
import {
  deliverIssueFilingEffect,
  deliverIssueMutationEffect,
  deliverPromptEffect,
  getBrainEffectsRuntime,
} from "./effects-runtime.ts";

const nonEmptyString = v.pipe(v.string(), v.minLength(1));
const effectId = v.pipe(nonEmptyString, v.startsWith("brain-effect:"));
const issueNumber = v.pipe(v.number(), v.integer(), v.minValue(1));
const issueUrl = v.pipe(v.string(), v.url());
// Optional in the schema so an omission surfaces a domain error the Brain can recover from, rather than a
// generic validation failure — but the Brain must supply it (fail-closed in resolveRepository below).
const repositoryInput = v.optional(
  v.pipe(nonEmptyString, v.regex(/^[^/\s]+\/[^/\s]+$/u, "repository must be owner/repo")),
);
const issueState = v.union([v.literal("open"), v.literal("closed")]);
const issueStateReason = v.union([
  v.literal("completed"),
  v.literal("not_planned"),
  v.literal("duplicate"),
  v.literal("reopened"),
]);

/** Fail closed: routing is the Brain's, never a config default. A mutation without a resolved repository
 * must never silently target defaultRepository — surface it so the Brain re-issues with an explicit repo
 * or reports honestly (§8: config is authorization, never routing). Mirrors createFileIssueTool. */
const resolveRepository = (repository: string | undefined, verb: string): string => {
  if (repository === undefined) {
    throw new Error(
      `${verb} requires an explicit repository (owner/repo) resolved from the Graph. No repository was ` +
        "supplied and there is no default — re-issue with the resolved repository, or report honestly.",
    );
  }
  return repository;
};

const mutationOutcome = v.union([
  v.object({
    status: v.union([v.literal("applied"), v.literal("reconciled")]),
    url: v.optional(issueUrl),
    commentId: v.optional(issueNumber),
    issueNumber: v.optional(issueNumber),
    state: v.optional(issueState),
  }),
  v.object({
    status: v.literal("uncertain"),
    reason: nonEmptyString,
    // Preserved even when uncertain: GitHub may have applied the mutation (e.g. created the comment)
    // while its Operation completion could not be persisted — the observed detail is still recorded.
    url: v.optional(issueUrl),
    commentId: v.optional(issueNumber),
    issueNumber: v.optional(issueNumber),
    state: v.optional(issueState),
  }),
]);

/** Record one issue mutation as a durable down-flow Effect (batch+surface provenance), run it, and return
 * its terminal outcome — the single path all five issue-mutation tools share. */
const deliverMutation = async (
  batchId: string,
  surfaceId: string,
  mutation: IssueMutation,
): Promise<{ readonly effectId: string; readonly outcome: IssueMutationOutcome }> => {
  const runtime = getBrainEffectsRuntime();
  if (runtime.mutateIssue === undefined) {
    throw new Error("Issue mutation is not configured for this Brain runtime.");
  }
  const effect = await deliverIssueMutationEffect(
    runtime.inbox.recordIssueMutation({ batchId, sourceSurfaceId: surfaceId, mutation }),
  );
  const outcome = effect.outcome;
  if (outcome === undefined) throw new Error(`Issue Mutation Effect ${effect.id} did not settle to an outcome.`);
  return { effectId: effect.id, outcome };
};

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

export const createScheduleWakeTool = () =>
  defineTool({
    name: "schedule_wake",
    description:
      "Durably schedule the Brain to reconsider an open loop at a future time (§6 Scheduled Wake) — e.g. " +
      "'chase this commitment if still unmet in two hours'. Supply the current Batch id (it is a local " +
      "effect of this Batch), an ISO-8601 dueAt, and a short reason naming the loop. It survives restart " +
      "and wakes the Brain exactly once when due. To RESCHEDULE an existing loop (move its follow-up to a " +
      "new time), pass the old wake's id as predecessorId: it is cancelled — never fires — as the " +
      "replacement is created. Returns the new wake id; keep it if you may reschedule again.",
    input: v.object({
      batchId: nonEmptyString,
      reason: v.pipe(v.string(), v.minLength(1), v.maxLength(2_048)),
      dueAt: v.pipe(v.string(), v.isoTimestamp()),
      predecessorId: v.optional(v.pipe(nonEmptyString, v.startsWith("scheduled-wake:"))),
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

const commentEffectOutput = (name: string) =>
  v.object({ kind: v.literal(name), effectId, outcome: mutationOutcome });

export const createCreateIssueCommentTool = () =>
  defineTool({
    name: "create_issue_comment",
    description:
      "Durably post one comment on an existing GitHub issue in the repository you choose (owner/repo). Supply the current Batch id, the originating Surface, and the target repository — there is no default. Returns the real outcome; report it back with prompt_speaker.",
    input: v.object({
      batchId: nonEmptyString,
      surfaceId: nonEmptyString,
      repository: repositoryInput,
      number: issueNumber,
      body: v.pipe(nonEmptyString, v.maxLength(MAX_PUBLIC_COMMENT_BODY_LENGTH)),
    }),
    output: commentEffectOutput("create_issue_comment"),
    run: async ({ input }) => ({
      kind: "create_issue_comment" as const,
      ...(await deliverMutation(input.batchId, input.surfaceId, {
        kind: "create-comment",
        repository: resolveRepository(input.repository, "create_issue_comment"),
        number: input.number,
        body: input.body,
      })),
    }),
  });

export const createUpdateIssueTool = () =>
  defineTool({
    name: "update_issue",
    description:
      "Durably update an existing GitHub issue's title, body, labels, assignees, or milestone in the repository you choose (owner/repo). At least one field must change. Supply the current Batch id, the originating Surface, and the target repository — there is no default.",
    input: v.object({
      batchId: nonEmptyString,
      surfaceId: nonEmptyString,
      repository: repositoryInput,
      number: issueNumber,
      title: v.optional(v.pipe(nonEmptyString, v.maxLength(256))),
      body: v.optional(v.pipe(v.string(), v.maxLength(MAX_PUBLIC_ISSUE_BODY_LENGTH))),
      labels: v.optional(v.array(nonEmptyString)),
      assignees: v.optional(v.array(nonEmptyString)),
      milestone: v.optional(v.nullable(issueNumber)),
    }),
    output: v.object({ kind: v.literal("update_issue"), effectId, outcome: mutationOutcome }),
    run: async ({ input }) => ({
      kind: "update_issue" as const,
      ...(await deliverMutation(input.batchId, input.surfaceId, {
        kind: "update-issue",
        repository: resolveRepository(input.repository, "update_issue"),
        number: input.number,
        ...(input.title === undefined ? {} : { title: input.title }),
        ...(input.body === undefined ? {} : { body: input.body }),
        ...(input.labels === undefined ? {} : { labels: input.labels }),
        ...(input.assignees === undefined ? {} : { assignees: input.assignees }),
        ...(input.milestone === undefined ? {} : { milestone: input.milestone }),
      })),
    }),
  });

export const createUpdateIssueCommentTool = () =>
  defineTool({
    name: "update_issue_comment",
    description:
      "Durably edit one existing comment on a GitHub issue in the repository you choose (owner/repo). RESTRICTED: you may only edit a comment you (the Brain) previously created — editing a human's comment is refused. Supply the current Batch id, the originating Surface, the target repository, and the exact comment id.",
    input: v.object({
      batchId: nonEmptyString,
      surfaceId: nonEmptyString,
      repository: repositoryInput,
      number: issueNumber,
      commentId: issueNumber,
      body: v.pipe(nonEmptyString, v.maxLength(MAX_PUBLIC_COMMENT_BODY_LENGTH)),
    }),
    output: commentEffectOutput("update_issue_comment"),
    run: async ({ input }) => ({
      kind: "update_issue_comment" as const,
      ...(await deliverMutation(input.batchId, input.surfaceId, {
        kind: "update-comment",
        repository: resolveRepository(input.repository, "update_issue_comment"),
        number: input.number,
        commentId: input.commentId,
        body: input.body,
      })),
    }),
  });

export const createDeleteIssueCommentTool = () =>
  defineTool({
    name: "delete_issue_comment",
    description:
      "Durably delete one comment on a GitHub issue in the repository you choose (owner/repo). RESTRICTED: you may only delete a comment you (the Brain) previously created — deleting a human's comment is refused. Supply the current Batch id, the originating Surface, the target repository, and the exact comment id.",
    input: v.object({
      batchId: nonEmptyString,
      surfaceId: nonEmptyString,
      repository: repositoryInput,
      number: issueNumber,
      commentId: issueNumber,
    }),
    output: v.object({ kind: v.literal("delete_issue_comment"), effectId, outcome: mutationOutcome }),
    run: async ({ input }) => ({
      kind: "delete_issue_comment" as const,
      ...(await deliverMutation(input.batchId, input.surfaceId, {
        kind: "delete-comment",
        repository: resolveRepository(input.repository, "delete_issue_comment"),
        number: input.number,
        commentId: input.commentId,
      })),
    }),
  });

export const createSetIssueStateTool = () =>
  defineTool({
    name: "set_issue_state",
    description:
      "Durably close (with a meaningful reason) or reopen an existing GitHub issue in the repository you choose (owner/repo). Closing requires completed, not_planned, or duplicate; reopening requires reopened. Supply the current Batch id, the originating Surface, and the target repository.",
    input: v.object({
      batchId: nonEmptyString,
      surfaceId: nonEmptyString,
      repository: repositoryInput,
      number: issueNumber,
      state: issueState,
      reason: issueStateReason,
    }),
    output: v.object({ kind: v.literal("set_issue_state"), effectId, outcome: mutationOutcome }),
    run: async ({ input }) => ({
      kind: "set_issue_state" as const,
      ...(await deliverMutation(input.batchId, input.surfaceId, {
        kind: "set-issue-state",
        repository: resolveRepository(input.repository, "set_issue_state"),
        number: input.number,
        state: input.state,
        reason: input.reason,
      })),
    }),
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
