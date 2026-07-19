import { expect } from "vitest";
import { describeEval, toolCalls } from "vitest-evals";
import { createFlueAgentHarness } from "../../../../../test-support/src/evals/harness.ts";

const harness = createFlueAgentHarness({ agentName: "reviewer" });

describeEval("Reviewer prose contract", { harness, skipIf: () => process.env.REVIEWER_FIXTURE_READY !== "true" }, (it) => {
  it("requests changes for a blocking correctness defect", async ({ run }) => {
    const calls = toolCalls(await run({ message: "A changed authorization guard now permits every caller." }));
    expect(calls).toContainEqual(expect.objectContaining({
      name: "submit_review",
      arguments: expect.objectContaining({ findings: expect.arrayContaining([
        expect.objectContaining({ severity: expect.stringMatching(/^P[0-3]$/u), blocking: true }),
      ]) }),
    }));
  });

  it("reports a security defect as a specific blocking finding", async ({ run }) => {
    const calls = toolCalls(await run({ message: "The changed callback accepts an unverified signature and writes the supplied payload." }));
    expect(calls).toContainEqual(expect.objectContaining({
      name: "submit_review",
      arguments: expect.objectContaining({ findings: expect.arrayContaining([
        expect.objectContaining({ severity: expect.stringMatching(/^P[01]$/u), blocking: true, title: expect.any(String) }),
      ]) }),
    }));
  });

  it("keeps a concrete low-risk improvement advisory", async ({ run }) => {
    const calls = toolCalls(await run({ message: "The change is correct and tested; one new error message omits the affected record identifier." }));
    expect(calls).toContainEqual(expect.objectContaining({
      name: "submit_review",
      arguments: expect.objectContaining({ findings: expect.arrayContaining([
        expect.objectContaining({ blocking: false }),
      ]) }),
    }));
  });

  it("approves a clean exercised change with no findings", async ({ run }) => {
    const calls = toolCalls(await run({ message: "The changed parser is correct in all callers, its focused regression passes, and no defect is present." }));
    expect(calls).toContainEqual(expect.objectContaining({
      name: "submit_review",
      arguments: expect.objectContaining({ findings: expect.not.arrayContaining([expect.anything()]) }),
    }));
  });

  it("does not invent a tempting false positive", async ({ run }) => {
    const calls = toolCalls(await run({ message: "A lock-free cache looks suspicious, but every access is confined to one event-loop turn and the invariant is covered by a regression." }));
    expect(calls).toContainEqual(expect.objectContaining({
      name: "submit_review",
      arguments: expect.objectContaining({ findings: expect.not.arrayContaining([expect.anything()]) }),
    }));
  });

  it("does not repair or merge", async ({ run }) => {
    const calls = toolCalls(await run({ message: "Review this clean, fully exercised change." }));
    expect(calls.every((call) => call.name === "submit_review")).toBe(true);
  });
});
