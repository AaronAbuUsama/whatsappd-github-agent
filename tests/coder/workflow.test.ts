import { describe, expect, it, vi } from "vite-plus/test";
import * as v from "valibot";

import type { FlueSession } from "@flue/runtime";
import {
  codingWaypoint,
  coderTaskPrompt,
  runInternalCodingLoop,
} from "../../packages/agents/src/capabilities/coder/workflow.ts";
import {
  coderJobInputSchema,
  planArtifactSchema,
  verificationReceiptSchema,
  type PlanArtifact,
  type VerificationReceipt,
  type VerificationVerdict,
} from "../../packages/agents/src/capabilities/coder/schemas.ts";

const plan: PlanArtifact = {
  summary: "Implement the bounded workflow.",
  implementation: [{ id: "I1", objective: "Wire the coordinator", paths: ["workflow.ts"], acceptance: ["Planner runs before Coder"] }],
  verification: [{ id: "V1", behavior: "Drive the coordinator", passWhen: ["The finite role order is observable"] }],
};

const receipt = (verdict: VerificationVerdict, report = `${verdict} report`): VerificationReceipt => ({ verdict, report });

describe("Coder new-issue admission", () => {
  it("preserves the legacy start_coder_job request shape and normalizes it to new_issue", () => {
    expect(v.parse(coderJobInputSchema, { repository: "acme/widgets", issue: 210 })).toEqual({
      mode: "new_issue",
      repository: "acme/widgets",
      issue: 210,
      maxVerificationRounds: 3,
      maxReviewCycles: 2,
    });
  });

  it("fails closed on the unshipped review-continuation mode and invalid budgets", () => {
    expect(() => v.parse(coderJobInputSchema, { mode: "review_continuation", repository: "acme/widgets", issue: 210 })).toThrow();
    expect(() => v.parse(coderJobInputSchema, { repository: "acme/widgets", issue: 210, maxVerificationRounds: 0 })).toThrow();
    expect(() => v.parse(coderJobInputSchema, { repository: "acme/widgets", issue: 210, maxVerificationRounds: 6 })).toThrow();
    expect(() => v.parse(coderJobInputSchema, { repository: "acme/widgets", issue: 210, maxReviewCycles: 6 })).toThrow();
  });
});

describe("coding waypoint schema", () => {
  it("emits only the ratified stable attributes", () => {
    const waypoint = codingWaypoint({
      jobId: "job-210",
      mode: "new_issue",
      stage: "verifier",
      status: "completed",
      reviewCycle: 0,
      maxReviewCycles: 2,
      verificationRound: 2,
      maxVerificationRounds: 3,
      verdict: "FAIL",
    });
    expect(waypoint).toEqual({
      event: "coding.waypoint",
      schemaVersion: 1,
      jobId: "job-210",
      mode: "new_issue",
      stage: "verifier",
      status: "completed",
      reviewCycle: 0,
      maxReviewCycles: 2,
      verificationRound: 2,
      maxVerificationRounds: 3,
      verdict: "FAIL",
    });
    expect(JSON.stringify(waypoint)).not.toMatch(/plan|report|prompt|command|output/iu);
  });
});

describe("deterministic Planner → bounded Coder/Verifier loop", () => {
  it("plans first, uses fresh role tasks in one cwd, and feeds the complete report verbatim into repair", async () => {
    const calls: Array<{ prompt: string; options: Record<string, unknown> }> = [];
    const marker = "\nFAIL full report\n<do-not-summarize>exact bytes & reproduction</do-not-summarize>\n";
    const responses = [
      { data: plan },
      { data: undefined },
      { data: receipt("FAIL", marker) },
      { data: undefined },
      { data: receipt("PASS", "PASS after repair") },
    ];
    const task = vi.fn(async (prompt: string, options: Record<string, unknown>) => {
      calls.push({ prompt, options });
      return responses.shift()!;
    });
    const waypoints: string[] = [];

    const result = await runInternalCodingLoop({
      session: { task } as unknown as Pick<FlueSession, "task">,
      plannerPrompt: "PLAN",
      coderPrompt: (round, artifact, prior) => coderTaskPrompt({ issue: 210, title: "Workflow", repoDir: "/workspace", round, plan: artifact, priorVerification: prior }),
      verifierPrompt: (round) => `VERIFY ${round}`,
      cwd: "/workspace",
      maxVerificationRounds: 3,
      waypoint: (stage, status, extra) => waypoints.push(`${stage}:${status}:${extra?.verificationRound ?? "-"}:${extra?.verdict ?? "-"}`),
    });

    expect(result).toEqual({ plan, verification: receipt("PASS", "PASS after repair"), rounds: 2 });
    expect(calls.map((call) => call.options.agent)).toEqual(["planner", "coder", "verifier", "coder", "verifier"]);
    expect(calls.every((call) => call.options.cwd === "/workspace")).toBe(true);
    expect(calls[0]!.options.result).toBe(planArtifactSchema);
    expect(calls[2]!.options.result).toBe(verificationReceiptSchema);
    expect(calls[4]!.options.result).toBe(verificationReceiptSchema);
    expect(calls[3]!.prompt).toContain(marker);
    expect(v.parse(verificationReceiptSchema, receipt("FAIL", marker)).report).toBe(marker);
    expect(calls[1]!.prompt).not.toContain("Previous Verifier report");
    expect(waypoints).toEqual([
      "planner:started:-:-",
      "planner:completed:-:-",
      "coder:started:1:-",
      "coder:completed:1:-",
      "verifier:started:1:-",
      "verifier:completed:1:FAIL",
      "coder:started:2:-",
      "coder:completed:2:-",
      "verifier:started:2:-",
      "verifier:completed:2:PASS",
    ]);
  });

  it.each([
    { verdicts: ["SKIP"] as VerificationVerdict[], max: 3, expectedRounds: 1 },
    { verdicts: ["BLOCKED", "BLOCKED", "BLOCKED"] as VerificationVerdict[], max: 3, expectedRounds: 3 },
    { verdicts: ["FAIL", "FAIL"] as VerificationVerdict[], max: 2, expectedRounds: 2 },
  ])("stops only on PASS/SKIP or the configured bound: $verdicts", async ({ verdicts, max, expectedRounds }) => {
    const queue: Array<{ data: PlanArtifact | VerificationReceipt | undefined }> = [{ data: plan }];
    for (const verdict of verdicts) queue.push({ data: undefined }, { data: receipt(verdict) });
    const task = vi.fn(async () => queue.shift()!);

    const result = await runInternalCodingLoop({
      session: { task } as unknown as Pick<FlueSession, "task">,
      plannerPrompt: "PLAN",
      coderPrompt: (round) => `CODE ${round}`,
      verifierPrompt: (round) => `VERIFY ${round}`,
      cwd: "/workspace",
      maxVerificationRounds: max,
      waypoint: () => {},
    });

    expect(result.rounds).toBe(expectedRounds);
    expect(result.verification.verdict).toBe(verdicts[expectedRounds - 1]);
    expect(task).toHaveBeenCalledTimes(1 + expectedRounds * 2);
  });
});
