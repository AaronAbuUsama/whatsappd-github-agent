import * as v from "valibot";

const nonEmpty = v.pipe(v.string(), v.trim(), v.minLength(1));
export const REVIEW_SEVERITIES = ["P0", "P1", "P2", "P3"] as const;

const reviewerJobRequestEntries = {
  repository: nonEmpty,
  pullRequest: v.pipe(v.number(), v.integer(), v.minValue(1)),
};

// The Brain's on-request launch carries only repository + pullRequest; the workflow pins to
// the live head. The legacy webhook/command ingress still supplies expectedHeadSha, so it stays
// an optional part of the workflow input.
export const reviewerJobRequestSchema = v.object(reviewerJobRequestEntries);

export const reviewerJobInputSchema = v.object({
  ...reviewerJobRequestEntries,
  expectedHeadSha: v.optional(nonEmpty),
  brainWorkId: v.optional(nonEmpty),
  sourceSurfaceId: v.optional(nonEmpty),
});

export type ReviewerJobInput = v.InferOutput<typeof reviewerJobInputSchema>;

export const reviewFindingSchema = v.pipe(
  v.object({
    severity: v.picklist(REVIEW_SEVERITIES),
    blocking: v.boolean(),
    title: v.pipe(nonEmpty, v.maxLength(120)),
    body: nonEmpty,
    path: nonEmpty,
    line: v.pipe(v.number(), v.integer(), v.minValue(1)),
  }),
  v.check(
    ({ severity, blocking }) => severity === "P2" || blocking === (severity === "P0" || severity === "P1"),
    "P0/P1 findings must block; P3 findings must be advisory",
  ),
);

export type ReviewFinding = v.InferOutput<typeof reviewFindingSchema>;

export const reviewerResultSchema = v.object({
  status: v.picklist(["approved", "changes-requested", "commented", "blocked", "failed"]),
  reviewUrl: v.optional(v.string()),
  prNumber: v.optional(v.number()),
  headSha: v.optional(v.string()),
  verdict: v.optional(v.string()),
  summary: v.string(),
});

export type ReviewerResult = v.InferOutput<typeof reviewerResultSchema>;
