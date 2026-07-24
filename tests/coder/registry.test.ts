import { describe, expect, it } from "vite-plus/test";

import { createCodingJobRegistry } from "../../packages/agents/src/capabilities/coder/registry.ts";

const job = {
  repository: "acme/widgets",
  prNumber: 42,
  issue: 210,
  branch: "agent/coder/issue-210",
  base: "main",
  maxVerificationRounds: 3,
  maxReviewCycles: 2,
};

describe("coding-job registry", () => {
  it("records the PR journey and budgets, preserving the consumed cycle across a re-upsert", () => {
    const registry = createCodingJobRegistry(":memory:");
    try {
      registry.upsert(job);
      expect(registry.get("acme/widgets", 42)).toEqual({ ...job, reviewCycle: 0 });
      // Consume one cycle (launch committed), then re-upsert (a republish): journey refreshes, cycle preserved.
      registry.commitRepair("acme/widgets", 42, 1001, "launched");
      registry.upsert({ ...job, base: "release" });
      expect(registry.get("acme/widgets", 42)).toEqual({ ...job, base: "release", reviewCycle: 1 });
    } finally {
      registry.close();
    }
  });

  it("only repairs a registered PR — an external/fork PR is never admitted", () => {
    const registry = createCodingJobRegistry(":memory:");
    try {
      // No row for PR 99 — a contributor's or fork-headed PR the Coder never opened.
      expect(registry.checkRepair("acme/widgets", 99, 5000)).toEqual({ status: "unregistered" });
    } finally {
      registry.close();
    }
  });

  it("permits exactly two external repair cycles, then reports over-budget", () => {
    const registry = createCodingJobRegistry(":memory:");
    try {
      registry.upsert(job);
      expect(registry.checkRepair("acme/widgets", 42, 1).status).toBe("within-budget");
      registry.commitRepair("acme/widgets", 42, 1, "launched");
      expect(registry.checkRepair("acme/widgets", 42, 2).status).toBe("within-budget");
      registry.commitRepair("acme/widgets", 42, 2, "launched");
      // The third distinct qualifying rejection would exceed the budget → over-budget.
      expect(registry.checkRepair("acme/widgets", 42, 3).status).toBe("over-budget");
      expect(registry.get("acme/widgets", 42)!.reviewCycle).toBe(2);
    } finally {
      registry.close();
    }
  });

  it("NEGATIVE: a cycle is consumed only on commit — checkRepair alone never bumps the budget", () => {
    const registry = createCodingJobRegistry(":memory:");
    try {
      registry.upsert(job);
      // Checking (and re-checking) the same review does not consume the budget — only a committed
      // launch does. This is the finding-2 fix: a failed launch (no commit) never wastes a cycle.
      registry.checkRepair("acme/widgets", 42, 7);
      registry.checkRepair("acme/widgets", 42, 7);
      expect(registry.get("acme/widgets", 42)!.reviewCycle).toBe(0);
    } finally {
      registry.close();
    }
  });

  it("NEGATIVE: a repeated identical review commit neither re-records nor double-consumes", () => {
    const registry = createCodingJobRegistry(":memory:");
    try {
      registry.upsert(job);
      registry.commitRepair("acme/widgets", 42, 777, "launched");
      expect(registry.get("acme/widgets", 42)!.reviewCycle).toBe(1);
      expect(registry.checkRepair("acme/widgets", 42, 777)).toEqual({ status: "duplicate", previous: "launched" });
      // A second commit for the same review id is an idempotent no-op — no second cycle consumed.
      registry.commitRepair("acme/widgets", 42, 777, "launched");
      expect(registry.get("acme/widgets", 42)!.reviewCycle).toBe(1);
    } finally {
      registry.close();
    }
  });

  it("records an over-budget review without consuming a cycle, and reports it duplicate thereafter", () => {
    const registry = createCodingJobRegistry(":memory:");
    try {
      registry.upsert({ ...job, maxReviewCycles: 0 });
      expect(registry.checkRepair("acme/widgets", 42, 900).status).toBe("over-budget");
      registry.commitRepair("acme/widgets", 42, 900, "over-budget");
      expect(registry.checkRepair("acme/widgets", 42, 900)).toEqual({ status: "duplicate", previous: "over-budget" });
      expect(registry.get("acme/widgets", 42)!.reviewCycle).toBe(0);
    } finally {
      registry.close();
    }
  });
});
