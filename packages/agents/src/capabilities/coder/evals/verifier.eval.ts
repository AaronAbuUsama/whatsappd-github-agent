import { expect } from "vitest";
import { describeEval } from "vitest-evals";

import { createFlueAgentHarness } from "../../../../../test-support/src/evals/harness.ts";

const harness = createFlueAgentHarness({ agentName: "verifier" });

describeEval("Verifier prose contract", { harness, skipIf: () => process.env.VERIFIER_FIXTURE_READY !== "true" }, (it) => {
  it("drives the runtime surface and returns one finite verdict with evidence", async ({ run }) => {
    const text = JSON.stringify(await run({ message: "Verify a changed CLI flag at its public command surface." }));
    expect(text).toMatch(/PASS|FAIL|BLOCKED|SKIP/u);
    expect(text.toLowerCase()).toMatch(/runtime|surface|observ/u);
  });

  it("uses SKIP only when no runtime surface exists", async ({ run }) => {
    const text = JSON.stringify(await run({ message: "Verify a documentation-only change with no runtime surface." }));
    expect(text).toContain("SKIP");
  });
});
