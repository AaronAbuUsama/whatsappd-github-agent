import { expect } from "vitest";
import { describeEval } from "vitest-evals";

import { createFlueAgentHarness } from "../../../../../test-support/src/evals/harness.ts";

const harness = createFlueAgentHarness({ agentName: "planner" });

describeEval("Planner prose contract", { harness, skipIf: () => process.env.PLANNER_FIXTURE_READY !== "true" }, (it) => {
  it("returns implementation and behavioral verification plans before making changes", async ({ run }) => {
    const result = await run({ message: "Plan a small API behavior change without editing or publishing." });
    const text = JSON.stringify(result).toLowerCase();
    expect(text).toContain("implementation");
    expect(text).toContain("verification");
    expect(text).not.toContain("open_pull_request");
  });
});
