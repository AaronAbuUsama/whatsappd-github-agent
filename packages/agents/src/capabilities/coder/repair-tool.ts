import { defineTool } from "@flue/runtime";
import * as v from "valibot";

import { parseGitHubRepository } from "@ambient-agent/engine/github/repository.ts";

import { demoteOverBudget } from "./continuation.ts";
import { getCoderRuntime } from "./runtime.ts";
import { coderSpecialistSpec } from "./workflow.ts";
import { launchSpecialistWork } from "../delegation/tools.ts";

const nonEmptyString = v.pipe(v.string(), v.minLength(1));
const positiveInteger = v.pipe(v.number(), v.integer(), v.minValue(1));

/**
 * #211: the Brain-owned repair decision. Everything routes through the Brain (§7): a REQUEST_CHANGES
 * review reaches the Brain up-inbox as an ordinary GitHub event (S1/#249), the Brain reasons about it
 * with the registry as context, and — when it decides to repair — calls THIS tool, whose launch is
 * dispatched through the SAME Brain→delegation seam every other Brain-owned specialist launch uses
 * (`launchSpecialistWork`, which reserves a durable Brain work id so the run's result returns here).
 *
 * The tool holds the invariants trusted code must own, never the model: it repairs ONLY a registered
 * Coder-owned PR (an external contributor / fork PR is never in the registry, so it is never mutated),
 * and never past the configured review-cycle budget. The budget cycle is consumed only AFTER the
 * launch is durably admitted (registry.commitRepair), so a failed launch never silently wastes it.
 */
export const createRepairPullRequestTool = () =>
  defineTool({
    name: "repair_pull_request",
    description:
      "Repair a Coder-owned pull request after the standalone Reviewer formally requested changes on it. " +
      "Supply the current Batch id, the originating Surface, the target repository (owner/repo), the pull-request " +
      "number, and the triggering review's id. It repairs ONLY a pull request this coworker's Coder opened and " +
      "only within its configured review-cycle budget: an external or fork-headed pull request is reported back " +
      "untouched, and an exhausted budget converts the pull request to draft with one lifecycle note instead of " +
      "repairing. A repair run's result returns here as a Specialist result; report the outcome with prompt_speaker.",
    input: v.object({
      batchId: nonEmptyString,
      surfaceId: nonEmptyString,
      repository: v.pipe(nonEmptyString, v.regex(/^[^/\s]+\/[^/\s]+$/u, "repository must be owner/repo")),
      pullRequest: positiveInteger,
      reviewId: positiveInteger,
    }),
    output: v.union([
      v.object({ kind: v.literal("repair_pull_request"), status: v.literal("launched"), workId: nonEmptyString, runId: nonEmptyString }),
      v.object({ kind: v.literal("repair_pull_request"), status: v.literal("over-budget"), prUrl: nonEmptyString, maxReviewCycles: v.number() }),
      v.object({ kind: v.literal("repair_pull_request"), status: v.literal("duplicate"), previous: v.union([v.literal("launched"), v.literal("over-budget")]) }),
      v.object({ kind: v.literal("repair_pull_request"), status: v.literal("external") }),
    ]),
    run: async ({ input }) => {
      const { registry, github: resolveGithub } = getCoderRuntime();
      if (registry === undefined) throw new Error("The coding-job registry is not configured for this Brain runtime.");
      const check = registry.checkRepair(input.repository, input.pullRequest, input.reviewId);
      if (check.status === "unregistered") return { kind: "repair_pull_request" as const, status: "external" as const };
      if (check.status === "duplicate") return { kind: "repair_pull_request" as const, status: "duplicate" as const, previous: check.previous };

      if (check.status === "over-budget") {
        const repo = parseGitHubRepository(input.repository, (value) => new Error(`Coder repository must be owner/repo, got ${value}`));
        const { prUrl } = await demoteOverBudget(await resolveGithub(repo), repo, input.pullRequest, check.job.maxReviewCycles);
        // Record AFTER the demotion succeeds; the demotion is idempotent so a retry is safe.
        registry.commitRepair(input.repository, input.pullRequest, input.reviewId, "over-budget");
        return { kind: "repair_pull_request" as const, status: "over-budget" as const, prUrl, maxReviewCycles: check.job.maxReviewCycles };
      }

      // Within budget: launch the repair through the Brain→delegation seam, THEN consume the cycle.
      const { workId, runId } = await launchSpecialistWork(
        {
          batchId: input.batchId,
          sourceSurfaceId: input.surfaceId,
          mode: "review_continuation",
          repository: check.job.repository,
          pullRequest: input.pullRequest,
          maxVerificationRounds: check.job.maxVerificationRounds,
          maxReviewCycles: check.job.maxReviewCycles,
        },
        coderSpecialistSpec,
      );
      registry.commitRepair(input.repository, input.pullRequest, input.reviewId, "launched");
      return { kind: "repair_pull_request" as const, status: "launched" as const, workId, runId };
    },
  });
