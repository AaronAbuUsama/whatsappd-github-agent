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
      // Consume one cycle, then re-upsert (a republish): the journey refreshes, the cycle is preserved.
      registry.admitRepair("acme/widgets", 42, 1001);
      registry.upsert({ ...job, base: "release" });
      expect(registry.get("acme/widgets", 42)).toEqual({ ...job, base: "release", reviewCycle: 1 });
    } finally {
      registry.close();
    }
  });

  it("only launches repair for a registered PR — an external/fork PR is never admitted", () => {
    const registry = createCodingJobRegistry(":memory:");
    try {
      // No row for PR 99 — a contributor's or fork-headed PR the Coder never opened.
      expect(registry.admitRepair("acme/widgets", 99, 5000)).toEqual({ status: "unregistered" });
    } finally {
      registry.close();
    }
  });

  it("permits exactly two external repair cycles, then reports over-budget (launches nothing)", () => {
    const registry = createCodingJobRegistry(":memory:");
    try {
      registry.upsert(job);
      expect(registry.admitRepair("acme/widgets", 42, 1).status).toBe("launched");
      expect(registry.admitRepair("acme/widgets", 42, 2).status).toBe("launched");
      // The third distinct qualifying rejection would exceed the budget → over-budget, no cycle consumed.
      const third = registry.admitRepair("acme/widgets", 42, 3);
      expect(third.status).toBe("over-budget");
      expect(registry.get("acme/widgets", 42)!.reviewCycle).toBe(2);
    } finally {
      registry.close();
    }
  });

  it("NEGATIVE: a second identical review event launches no duplicate — the review id is idempotent", () => {
    const registry = createCodingJobRegistry(":memory:");
    try {
      registry.upsert(job);
      const first = registry.admitRepair("acme/widgets", 42, 777);
      expect(first.status).toBe("launched");
      // Same review id again (a webhook redelivery / repeated identical event): no second launch, no
      // second consumed cycle — it converges on the already-recorded decision.
      const again = registry.admitRepair("acme/widgets", 42, 777);
      expect(again).toEqual({ status: "duplicate", previous: "launched" });
      expect(registry.get("acme/widgets", 42)!.reviewCycle).toBe(1);
    } finally {
      registry.close();
    }
  });

  it("NEGATIVE: a repeated over-budget review id stays a single over-budget decision", () => {
    const registry = createCodingJobRegistry(":memory:");
    try {
      registry.upsert({ ...job, maxReviewCycles: 0 });
      expect(registry.admitRepair("acme/widgets", 42, 900).status).toBe("over-budget");
      expect(registry.admitRepair("acme/widgets", 42, 900)).toEqual({ status: "duplicate", previous: "over-budget" });
      expect(registry.get("acme/widgets", 42)!.reviewCycle).toBe(0);
    } finally {
      registry.close();
    }
  });
});
