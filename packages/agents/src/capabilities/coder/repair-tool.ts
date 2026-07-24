import { defineTool } from "@flue/runtime";
import * as v from "valibot";

import { parseGitHubRepository } from "@ambient-agent/engine/github/repository.ts";

import { demoteOverBudget } from "./continuation.ts";
import { getCoderRuntime } from "./runtime.ts";
import { coderSpecialistSpec } from "./workflow.ts";
import { launchSpecialistWork, SpecialistLaunchReservedError } from "../delegation/tools.ts";
import { getDelegationRuntime } from "../delegation/runtime.ts";

const nonEmptyString = v.pipe(v.string(), v.minLength(1));
const positiveInteger = v.pipe(v.number(), v.integer(), v.minValue(1));

/**
 * #211: the Brain-owned repair decision. Everything routes through the Brain (§7): a REQUEST_CHANGES
 * review reaches the Brain up-inbox as an ordinary GitHub event (S1/#249), the Brain reasons about it
 * with the registry as context, and — when it decides to repair — calls THIS tool, whose launch is
 * dispatched through the SAME Brain→delegation seam every other Brain-owned specialist launch uses
 * (`launchSpecialistWork`, which reserves a durable Brain work id so the run's result returns here).
 *
 * The tool holds every invariant trusted code must own, never the model:
 * - It independently re-fetches the live review and verifies, in trusted code, that it is a
 *   REQUEST_CHANGES authored by the configured Reviewer App — prompt wording is not an authorization
 *   boundary, so a human's review or a fabricated review id is refused here (finding 1).
 * - It repairs ONLY a registered Coder-owned PR (an external / fork PR is never in the registry, so
 *   it is never mutated), and never past the configured review-cycle budget.
 * - The budget cycle is consumed only AFTER the launch is durably admitted (registry.commitRepair),
 *   so a failed launch never silently wastes it (finding 2 of round 1).
 *
 * The launch cites the triggering GitHub event's own id as provenance (`evidenceIds`), exactly as
 * prompt_speaker does — a GitHub-event Batch carries no Intent, so the event itself is the evidence.
 */
export const createRepairPullRequestTool = () =>
  defineTool({
    name: "repair_pull_request",
    description:
      "Repair a Coder-owned pull request after the standalone Reviewer formally requested changes on it. " +
      "Supply the current Batch id, the originating Surface, the target repository (owner/repo), the pull-request " +
      "number, the triggering review's id, and that review event's own id as evidence. It independently verifies " +
      "the review is a change request by the configured Reviewer App, and repairs ONLY a pull request this " +
      "coworker's Coder opened, within its review-cycle budget: an unauthorized review or an external/fork pull " +
      "request is reported back untouched, and an exhausted budget converts the pull request to draft with one " +
      "lifecycle note instead of repairing. A repair run's result returns here; report the outcome with prompt_speaker.",
    input: v.object({
      batchId: nonEmptyString,
      surfaceId: nonEmptyString,
      repository: v.pipe(nonEmptyString, v.regex(/^[^/\s]+\/[^/\s]+$/u, "repository must be owner/repo")),
      pullRequest: positiveInteger,
      reviewId: positiveInteger,
      // The triggering review event's own up-inbox id — the launch's durable provenance (§4).
      evidenceIds: v.pipe(v.array(nonEmptyString), v.minLength(1)),
    }),
    output: v.union([
      v.object({ kind: v.literal("repair_pull_request"), status: v.literal("launched"), workId: nonEmptyString, runId: nonEmptyString }),
      v.object({ kind: v.literal("repair_pull_request"), status: v.literal("over-budget"), prUrl: nonEmptyString, maxReviewCycles: v.number() }),
      v.object({ kind: v.literal("repair_pull_request"), status: v.literal("duplicate"), previous: v.union([v.literal("launched"), v.literal("over-budget")]) }),
      v.object({ kind: v.literal("repair_pull_request"), status: v.literal("external") }),
      v.object({ kind: v.literal("repair_pull_request"), status: v.literal("unauthorized"), reason: nonEmptyString }),
    ]),
    run: async ({ input }) => {
      const { registry, github: resolveGithub, reviewerAppSlug, coderAppSlug } = getCoderRuntime();
      if (registry === undefined) throw new Error("The coding-job registry is not configured for this Brain runtime.");
      const repo = parseGitHubRepository(input.repository, (value) => new Error(`Coder repository must be owner/repo, got ${value}`));
      const github = await resolveGithub(repo);

      // Finding 1 — trusted authorization BEFORE any registry/GitHub side effect: re-fetch the live
      // review and confirm it is a REQUEST_CHANGES by the configured Reviewer App. Fail closed if the
      // Reviewer App is unprovisioned (no slug to authorize against).
      if (reviewerAppSlug === undefined) {
        return { kind: "repair_pull_request" as const, status: "unauthorized" as const, reason: "the Reviewer App is not provisioned; no review can be authorized" };
      }
      const { data: review } = await github.pulls.getReview({ owner: repo.owner, repo: repo.repo, pull_number: input.pullRequest, review_id: input.reviewId });
      const expectedAuthor = `${reviewerAppSlug.toLowerCase()}[bot]`;
      if (review.state.toUpperCase() !== "CHANGES_REQUESTED" || (review.user?.login ?? "").toLowerCase() !== expectedAuthor) {
        return {
          kind: "repair_pull_request" as const,
          status: "unauthorized" as const,
          reason: `review ${input.reviewId} is not a REQUEST_CHANGES by ${expectedAuthor} (state=${review.state}, author=${review.user?.login ?? "unknown"})`,
        };
      }

      // Provenance precision (round-4 finding): the cited evidence must actually be THIS review event —
      // at least one cited id in the current Batch must be the pull_request_review event for this exact
      // review id, PR number, and repository. Batch membership alone (checked at launch) is not enough:
      // an unrelated-but-batch-scoped event must not be recorded as what triggered this repair.
      // Read THIS Batch's events by id — never claimBatch()'s "whatever is globally open", which would
      // only equal the current batch under an unstated single-open-batch assumption.
      const batchEvents = getDelegationRuntime().inbox.githubEventsForBatch(input.batchId);
      const cited = batchEvents.filter((event) => input.evidenceIds.includes(event.id));
      const triggering = cited.find((event) => {
        const detail = event.detail as { review?: { id?: unknown }; pullRequest?: { number?: unknown } };
        return (
          event.eventName === "pull_request_review" &&
          detail.review?.id === input.reviewId &&
          detail.pullRequest?.number === input.pullRequest &&
          event.repository.toLowerCase() === input.repository.toLowerCase()
        );
      });
      if (triggering === undefined) {
        return {
          kind: "repair_pull_request" as const,
          status: "unauthorized" as const,
          reason: `no cited evidence is the pull_request_review event for review ${input.reviewId} on ${input.repository}#${input.pullRequest}`,
        };
      }

      // Atomically decide AND reserve (budget + cycle in one step) so two concurrent reviews can never
      // both launch past the same budget check (finding 3). On any subsequent side-effect failure we
      // release the reservation, so a failed launch/demotion never permanently wastes a cycle.
      const reservation = registry.reserveRepair(input.repository, input.pullRequest, input.reviewId);
      if (reservation.status === "unregistered") return { kind: "repair_pull_request" as const, status: "external" as const };
      if (reservation.status === "duplicate") return { kind: "repair_pull_request" as const, status: "duplicate" as const, previous: reservation.previous };

      if (reservation.status === "over-budget") {
        try {
          const { prUrl } = await demoteOverBudget(github, repo, input.pullRequest, reservation.job.maxReviewCycles, coderAppSlug === undefined ? undefined : `${coderAppSlug.toLowerCase()}[bot]`);
          return { kind: "repair_pull_request" as const, status: "over-budget" as const, prUrl, maxReviewCycles: reservation.job.maxReviewCycles };
        } catch (cause) {
          registry.releaseRepair(input.repository, input.pullRequest, input.reviewId);
          throw cause;
        }
      }

      // Within budget (cycle already reserved): launch the repair through the Brain→delegation seam,
      // citing the review event as provenance (no Intent needed).
      try {
        const { workId, runId } = await launchSpecialistWork(
          {
            batchId: input.batchId,
            sourceSurfaceId: input.surfaceId,
            evidenceIds: input.evidenceIds,
            mode: "review_continuation",
            repository: reservation.job.repository,
            // The registered issue number: the delegation seam wires Graph context only when `issue`
            // is present, so a review_continuation without it silently loses its Graph wiring.
            issue: reservation.job.issue,
            pullRequest: input.pullRequest,
            // Launch-identity uniqueness only: two distinct reviews for the SAME PR in one Batch have
            // identical inputs otherwise, so the delegation work-id hash would collide and the second
            // review's run would be deduped into the first's. The workflow does not read this field.
            reviewId: input.reviewId,
            maxVerificationRounds: reservation.job.maxVerificationRounds,
            maxReviewCycles: reservation.job.maxReviewCycles,
          },
          coderSpecialistSpec,
        );
        return { kind: "repair_pull_request" as const, status: "launched" as const, workId, runId };
      } catch (cause) {
        // Give the cycle back ONLY if the failure was BEFORE the durable Brain launch row committed
        // (nothing to reconcile). A SpecialistLaunchReservedError means the row exists and boot
        // reconciliation will run the repair — releasing then would double-count the budget.
        if (!(cause instanceof SpecialistLaunchReservedError)) {
          registry.releaseRepair(input.repository, input.pullRequest, input.reviewId);
        }
        throw cause;
      }
    },
  });
