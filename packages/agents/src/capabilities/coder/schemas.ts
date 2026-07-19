import * as v from "valibot";

import { graphDigestSchema } from "@ambient-agent/engine/graph/digest.ts";

const nonEmpty = v.pipe(v.string(), v.trim(), v.minLength(1));
const verbatimNonBlank = v.pipe(v.string(), v.check((value) => value.trim().length > 0, "Expected a non-blank string."));
const maxVerificationRounds = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(5));
const maxReviewCycles = v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(5));

export const DEFAULT_MAX_VERIFICATION_ROUNDS = 3;
export const DEFAULT_MAX_REVIEW_CYCLES = 2;

/**
 * #210 owns only new-issue admission. `mode` defaults at the schema boundary so the
 * shipped issue-only `start_coder_job` request is normalized before workflow code sees
 * it. `review_continuation` is deliberately reserved for #211.
 */
export const coderJobInputSchema = v.object({
  mode: v.optional(v.literal("new_issue"), "new_issue"),
  repository: nonEmpty,
  issue: v.pipe(v.number(), v.integer(), v.minValue(1)),
  instructions: v.optional(nonEmpty),
  maxVerificationRounds: v.optional(maxVerificationRounds, DEFAULT_MAX_VERIFICATION_ROUNDS),
  maxReviewCycles: v.optional(maxReviewCycles, DEFAULT_MAX_REVIEW_CYCLES),
  chatId: v.optional(nonEmpty),
  graphContext: v.optional(graphDigestSchema),
});

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
