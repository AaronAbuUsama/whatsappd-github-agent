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
      // Reserve one cycle, then re-upsert (a republish): journey refreshes, consumed cycle preserved.
      registry.reserveRepair("acme/widgets", 42, 1001);
      registry.upsert({ ...job, base: "release" });
      expect(registry.get("acme/widgets", 42)).toEqual({ ...job, base: "release", reviewCycle: 1 });
    } finally {
      registry.close();
    }
  });

  it("round 9: preserves the repository's ORIGINAL casing (Graph identity is exact-match)", () => {
    const registry = createCodingJobRegistry(":memory:");
    try {
      registry.upsert({ ...job, repository: "TheCallApp/ios-app" });
      // Lookups are case-insensitive, but the returned repository keeps the caller's casing.
      expect(registry.get("thecallapp/ios-app", 42)!.repository).toBe("TheCallApp/ios-app");
      const reservation = registry.reserveRepair("TheCallApp/ios-app", 42, 1);
      expect(reservation.status).toBe("within-budget");
      expect((reservation as { job: { repository: string } }).job.repository).toBe("TheCallApp/ios-app");
    } finally {
      registry.close();
    }
  });

  it("round 9: clamps the repair budget to the two-cycle spec cap even when a job requests more", () => {
    const registry = createCodingJobRegistry(":memory:");
    try {
      registry.upsert({ ...job, maxReviewCycles: 5 });
      expect(registry.get("acme/widgets", 42)!.maxReviewCycles).toBe(2);
      expect(registry.reserveRepair("acme/widgets", 42, 1).status).toBe("within-budget");
      expect(registry.reserveRepair("acme/widgets", 42, 2).status).toBe("within-budget");
      // Enforced at 2, not 5 — the third qualifying review is over budget.
      expect(registry.reserveRepair("acme/widgets", 42, 3).status).toBe("over-budget");
    } finally {
      registry.close();
    }
  });

  it("only repairs a registered PR — an external/fork PR is never admitted", () => {
    const registry = createCodingJobRegistry(":memory:");
    try {
      expect(registry.reserveRepair("acme/widgets", 99, 5000)).toEqual({ status: "unregistered" });
    } finally {
      registry.close();
    }
  });

  it("NEGATIVE (finding 3): reserving consumes the cycle atomically — the budget can never be exceeded", () => {
    const registry = createCodingJobRegistry(":memory:");
    try {
      registry.upsert({ ...job, maxReviewCycles: 1 });
      // Two DISTINCT review events on the same PR, budget 1. The first reserves and consumes the cycle
      // in one atomic step; a second reserve (a concurrent/racing review) sees the already-consumed
      // cycle and is over-budget — never a second under-limit pass, never a second launch past budget.
      expect(registry.reserveRepair("acme/widgets", 42, 1).status).toBe("within-budget");
      expect(registry.reserveRepair("acme/widgets", 42, 2).status).toBe("over-budget");
      expect(registry.get("acme/widgets", 42)!.reviewCycle).toBe(1);
    } finally {
      registry.close();
    }
  });

  it("permits exactly two external repair cycles, then reports over-budget", () => {
    const registry = createCodingJobRegistry(":memory:");
    try {
      registry.upsert(job);
      expect(registry.reserveRepair("acme/widgets", 42, 1).status).toBe("within-budget");
      expect(registry.reserveRepair("acme/widgets", 42, 2).status).toBe("within-budget");
      expect(registry.reserveRepair("acme/widgets", 42, 3).status).toBe("over-budget");
      expect(registry.get("acme/widgets", 42)!.reviewCycle).toBe(2);
    } finally {
      registry.close();
    }
  });

  it("NEGATIVE: a released reservation gives the cycle back and can be re-reserved (failed launch → retry)", () => {
    const registry = createCodingJobRegistry(":memory:");
    try {
      registry.upsert(job);
      expect(registry.reserveRepair("acme/widgets", 42, 7).status).toBe("within-budget");
      expect(registry.get("acme/widgets", 42)!.reviewCycle).toBe(1);
      // The launch failed → release: the cycle returns and the review is no longer recorded.
      registry.releaseRepair("acme/widgets", 42, 7);
      expect(registry.get("acme/widgets", 42)!.reviewCycle).toBe(0);
      // A genuine retry re-reserves the same review from scratch.
      expect(registry.reserveRepair("acme/widgets", 42, 7).status).toBe("within-budget");
      expect(registry.get("acme/widgets", 42)!.reviewCycle).toBe(1);
    } finally {
      registry.close();
    }
  });

  it("NEGATIVE: a repeated identical review event is duplicate — no second reservation, no second cycle", () => {
    const registry = createCodingJobRegistry(":memory:");
    try {
      registry.upsert(job);
      expect(registry.reserveRepair("acme/widgets", 42, 777).status).toBe("within-budget");
      expect(registry.reserveRepair("acme/widgets", 42, 777)).toEqual({ status: "duplicate", previous: "launched" });
      expect(registry.get("acme/widgets", 42)!.reviewCycle).toBe(1);
    } finally {
      registry.close();
    }
  });

  it("reserves an over-budget review without consuming a cycle, and reports it duplicate thereafter", () => {
    const registry = createCodingJobRegistry(":memory:");
    try {
      registry.upsert({ ...job, maxReviewCycles: 0 });
      expect(registry.reserveRepair("acme/widgets", 42, 900).status).toBe("over-budget");
      expect(registry.reserveRepair("acme/widgets", 42, 900)).toEqual({ status: "duplicate", previous: "over-budget" });
      expect(registry.get("acme/widgets", 42)!.reviewCycle).toBe(0);
      // Releasing a failed over-budget demotion lets a retry re-reserve it.
      registry.releaseRepair("acme/widgets", 42, 900);
      expect(registry.reserveRepair("acme/widgets", 42, 900).status).toBe("over-budget");
    } finally {
      registry.close();
    }
  });
});
