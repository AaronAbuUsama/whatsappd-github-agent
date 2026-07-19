import { describe, expect, it, vi } from "vite-plus/test";

import { findReviewForHead, reviewEvent, reviewerLogin, validInlineLocations, type ReviewerGitHub } from "../../packages/agents/src/capabilities/reviewer/github.ts";
import { reviewerExerciseCommand, serializeReviewerSubmission, singleSubmission } from "../../packages/agents/src/capabilities/reviewer/workflow.ts";

describe("Reviewer GitHub contract", () => {
  it("maps verdicts and never approves a red repository exercise", () => {
    expect(reviewEvent("approve", true)).toBe("APPROVE");
    expect(reviewEvent("comment", true)).toBe("COMMENT");
    expect(reviewEvent("approve", false)).toBe("REQUEST_CHANGES");
  });

  it("uses the configured App identity and PR+head SHA as the natural key", async () => {
    const github = {
      apps: { getAuthenticated: vi.fn(async () => ({ data: { slug: "reviewer" } })) },
      pulls: {
        listReviews: vi.fn(async () => ({ data: [
          { id: 1, html_url: "old", commit_id: "old", user: { login: "reviewer[bot]" } },
          { id: 2, html_url: "live", commit_id: "head", user: { login: "Reviewer[bot]" } },
        ] })),
      },
    } as unknown as ReviewerGitHub;
    const login = await reviewerLogin(github);
    expect(login).toBe("reviewer[bot]");
    await expect(findReviewForHead(github, { owner: "acme", repo: "widgets" }, 42, "head", login))
      .resolves.toMatchObject({ id: 2, html_url: "live" });
  });

  it("accepts only RIGHT-side lines represented by a changed-file patch", () => {
    const locations = validInlineLocations([{ filename: "src/a.ts", patch: "@@ -2,2 +2,3 @@\n same\n-old\n+new\n+more" }]);
    expect([...locations]).toEqual(["src/a.ts:2", "src/a.ts:3", "src/a.ts:4"]);
    expect(locations.has("src/a.ts:1")).toBe(false);
  });

  it("does not fail a pnpm repository merely because typecheck is absent", () => {
    expect(reviewerExerciseCommand()).toContain("pnpm run --if-present typecheck");
  });

  it("runs Yarn typecheck only when the repository defines it", () => {
    expect(reviewerExerciseCommand()).toContain("scripts?.typecheck ? 0 : 1");
  });

  it("submits at most once when the model invokes the effect repeatedly", async () => {
    const submit = singleSubmission<string>();
    const effect = vi.fn(async () => "formal-review");
    await expect(Promise.all([submit(effect), submit(effect)])).resolves.toEqual(["formal-review", "formal-review"]);
    expect(effect).toHaveBeenCalledTimes(1);
  });

  it("serializes concurrent workflow submissions for one Reviewer App and PR head", async () => {
    const result = { status: "commented", prNumber: 42, headSha: "head", summary: "reviewed" } as const;
    const effect = vi.fn(async () => result);
    await expect(Promise.all([
      serializeReviewerSubmission("acme/widgets#42@head:reviewer[bot]", effect),
      serializeReviewerSubmission("acme/widgets#42@head:reviewer[bot]", effect),
    ])).resolves.toEqual([result, result]);
    expect(effect).toHaveBeenCalledTimes(1);
  });
});
