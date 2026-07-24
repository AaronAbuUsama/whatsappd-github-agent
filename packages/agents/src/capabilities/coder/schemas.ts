import * as v from "valibot";

import { graphDigestSchema } from "@ambient-agent/engine/graph/digest.ts";

const nonEmpty = v.pipe(v.string(), v.trim(), v.minLength(1));
const verbatimNonBlank = v.pipe(v.string(), v.check((value) => value.trim().length > 0, "Expected a non-blank string."));
const maxVerificationRounds = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(5));
const maxReviewCycles = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(5));

export const DEFAULT_MAX_VERIFICATION_ROUNDS = 3;
export const DEFAULT_MAX_REVIEW_CYCLES = 2;

const positiveInteger = v.pipe(v.number(), v.integer(), v.minValue(1));
const budgetEntries = {
  maxVerificationRounds: v.optional(maxVerificationRounds, DEFAULT_MAX_VERIFICATION_ROUNDS),
  maxReviewCycles: v.optional(maxReviewCycles, DEFAULT_MAX_REVIEW_CYCLES),
};

/**
 * The model-facing `start_coder_job` request (#210): new-issue only. The Speaker/Brain never
 * launches a repair — only a Reviewer-App REQUEST_CHANGES routed through the ingress can — so the
 * tool schema stays issue-keyed and `new_issue` is the only mode a model can express.
 */
export const coderJobRequestSchema = v.object({
  mode: v.optional(v.literal("new_issue"), "new_issue"),
  repository: nonEmpty,
  issue: positiveInteger,
  instructions: v.optional(nonEmpty),
  ...budgetEntries,
});

/**
 * The workflow input (#211): a `new_issue` run keyed by `issue`, OR a `review_continuation` run
 * keyed by the live `pullRequest` it repairs (the underlying issue, branch, and consumed budget
 * come from the coding-job registry, never the caller). `mode` defaults to `new_issue` so the
 * shipped issue request normalizes unchanged. The cross-field check fails closed: the key the mode
 * needs must be present, so a review_continuation without a pullRequest — or a new_issue without an
 * issue — is rejected at the boundary.
 */
export const coderJobInputSchema = v.pipe(
  v.object({
    mode: v.optional(v.picklist(["new_issue", "review_continuation"]), "new_issue"),
    repository: nonEmpty,
    issue: v.optional(positiveInteger),
    pullRequest: v.optional(positiveInteger),
    instructions: v.optional(nonEmpty),
    ...budgetEntries,
    brainWorkId: v.optional(nonEmpty),
    sourceSurfaceId: v.optional(nonEmpty),
    graphContext: v.optional(graphDigestSchema),
  }),
  v.check(
    (input) => (input.mode === "review_continuation" ? input.pullRequest !== undefined : input.issue !== undefined),
    "A new_issue job requires an issue number; a review_continuation job requires a pullRequest number.",
  ),
);

export type CoderJobInput = v.InferOutput<typeof coderJobInputSchema>;

export const planArtifactSchema = v.object({
  summary: nonEmpty,
  implementation: v.pipe(
    v.array(v.object({
      id: nonEmpty,
      objective: nonEmpty,
      paths: v.optional(v.array(nonEmpty)),
      acceptance: v.pipe(v.array(nonEmpty), v.minLength(1)),
    })),
    v.minLength(1),
  ),
  verification: v.pipe(
    v.array(v.object({
      id: nonEmpty,
      behavior: nonEmpty,
      passWhen: v.pipe(v.array(nonEmpty), v.minLength(1)),
    })),
    v.minLength(1),
  ),
});

export type PlanArtifact = v.InferOutput<typeof planArtifactSchema>;

export const verificationVerdictSchema = v.picklist(["PASS", "FAIL", "BLOCKED", "SKIP"]);
export type VerificationVerdict = v.InferOutput<typeof verificationVerdictSchema>;

export const verificationReceiptSchema = v.object({
  verdict: verificationVerdictSchema,
  // The coordinator must feed these exact bytes into Coder; validation may not trim them.
  report: verbatimNonBlank,
});

export type VerificationReceipt = v.InferOutput<typeof verificationReceiptSchema>;

export const coderResultSchema = v.object({
  outcome: v.picklist(["opened-pr", "updated-pr", "no-op", "blocked", "failed"]),
  prUrl: v.optional(v.string()),
  prNumber: v.optional(v.number()),
  branch: v.optional(v.string()),
  summary: v.string(),
  testsPassed: v.optional(v.boolean()),
  jobId: v.string(),
  finalVerdict: v.optional(verificationVerdictSchema),
  verificationRounds: v.pipe(v.number(), v.integer(), v.minValue(0)),
  reviewCycle: v.pipe(v.number(), v.integer(), v.minValue(0)),
  draft: v.optional(v.boolean()),
});

export type CoderResult = v.InferOutput<typeof coderResultSchema>;
