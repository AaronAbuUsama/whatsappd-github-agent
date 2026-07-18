import { describe, expect, it } from "vitest";

import { recordRubricScore } from "../../packages/test-support/src/evals/braintrust-reporter.ts";

const record = (metric: string, threshold: number, direction: "minimum" | "maximum" = "minimum") =>
  recordRubricScore({
    axis: 1,
    metric,
    threshold,
    direction,
    score: 1,
    criteria: "test criterion",
    input: {},
    output: {},
    rationale: "test rationale",
    skillBundle: "test skill bundle",
  });

describe("Braintrust rubric reporter", () => {
  it("rejects a changed threshold for an existing metric", () => {
    record("test_threshold_invariant", 0.9);

    expect(() => record("test_threshold_invariant", 0.8)).toThrow(/threshold/i);
  });

  it("rejects a changed direction for an existing metric", () => {
    record("test_direction_invariant", 0.5, "minimum");

    expect(() => record("test_direction_invariant", 0.5, "maximum")).toThrow(/direction/i);
  });
});
