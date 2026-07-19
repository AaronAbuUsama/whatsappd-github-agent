import { describe, expect, it, vi } from "vite-plus/test";
import * as v from "valibot";

import { findReviewForHead, missingVerdictReviewEvent, renderReviewFinding, renderReviewSubmission, renderSummaryFinding, reviewEvent, reviewerHeadMarker, reviewerLogin, reviewerSlug, validInlineLocations, type ReviewerGitHub } from "../../packages/agents/src/capabilities/reviewer/github.ts";
import { REVIEW_SEVERITIES, reviewFindingSchema } from "../../packages/agents/src/capabilities/reviewer/schemas.ts";
import { reviewerExerciseCommand, serializeReviewerSubmission, singleSubmission } from "../../packages/agents/src/capabilities/reviewer/workflow.ts";

describe("Reviewer GitHub contract", () => {
  it("maps repository exercise and typed findings to a deterministic verdict", () => {
    expect(reviewEvent(false, [])).toBe("REQUEST_CHANGES");
    expect(reviewEvent(true, [{ blocking: true }])).toBe("REQUEST_CHANGES");
    expect(reviewEvent(true, [{ blocking: false }])).toBe("COMMENT");
    expect(reviewEvent(true, [])).toBe("APPROVE");
    expect(missingVerdictReviewEvent(false)).toBe("REQUEST_CHANGES");
    expect(missingVerdictReviewEvent(true)).toBe("COMMENT");
  });

  it.each(REVIEW_SEVERITIES)("validates and renders the %s finding contract", (severity) => {
    const finding = v.parse(reviewFindingSchema, {
      severity,
      blocking: severity === "P0" || severity === "P1",
      title: "Preserve the authorization boundary",
      body: "This branch accepts an untrusted caller and exposes the protected record.",
      path: "src/auth.ts",
      line: 17,
    });
    expect(renderReviewFinding(finding)).toBe(
      `**[${severity}] Preserve the authorization boundary**\n\nThis branch accepts an untrusted caller and exposes the protected record.`,
    );
    expect(renderSummaryFinding(finding)).toBe(
      `**[${severity}] Preserve the authorization boundary**\n\nThis branch accepts an untrusted caller and exposes the protected record.\n\nLocation: \`src/auth.ts:17\``,
    );
  });

  it("rejects severity and blocking combinations outside the rubric", () => {
    const finding = {
      title: "Invalid severity",
      body: "The severity and blocking flag disagree.",
      path: "src/a.ts",
      line: 1,
    };
    expect(v.safeParse(reviewFindingSchema, { ...finding, severity: "P1", blocking: false }).success).toBe(false);
    expect(v.safeParse(reviewFindingSchema, { ...finding, severity: "P3", blocking: true }).success).toBe(false);
    expect(v.safeParse(reviewFindingSchema, { ...finding, severity: "P2", blocking: true }).success).toBe(true);
  });

  it("renders valid findings inline and preserves invalid locations in the formal summary", () => {
    const inline = v.parse(reviewFindingSchema, {
      severity: "P1", blocking: true, title: "Keep authorization enforced",
      body: "This branch allows an untrusted caller to read the protected record.", path: "src/auth.ts", line: 17,
    });
    const fallback = v.parse(reviewFindingSchema, {
      severity: "P3", blocking: false, title: "Keep the failure attributable",
      body: "The new error omits the record identifier, which makes the failing request ambiguous.", path: "src/errors.ts", line: 41,
    });
    expect(renderReviewSubmission("Two concrete findings.", true, [inline, fallback], new Set(["src/auth.ts:17"]))).toEqual({
      body: "Two concrete findings.\n\n### Findings without a valid diff line\n\n**[P3] Keep the failure attributable**\n\nThe new error omits the record identifier, which makes the failing request ambiguous.\n\nLocation: `src/errors.ts:41`",
      comments: [{
        path: "src/auth.ts", line: 17, side: "RIGHT",
        body: "**[P1] Keep authorization enforced**\n\nThis branch allows an untrusted caller to read the protected record.",
      }],
    });
  });

  it("uses the configured App identity and PR+head SHA as the natural key", async () => {
    const github = {
      apps: { getAuthenticated: vi.fn(async () => ({ data: { slug: "reviewer" } })) },
      pulls: {
        listReviews: vi.fn(async () => ({ data: [
          { id: 1, html_url: "old", body: reviewerHeadMarker("old"), commit_id: "head", user: { login: "reviewer[bot]" } },
          { id: 2, html_url: "live", body: reviewerHeadMarker("head"), commit_id: "head", user: { login: "Reviewer[bot]" } },
        ] })),
      },
    } as unknown as ReviewerGitHub;
    await expect(reviewerSlug(github)).resolves.toBe("reviewer");
    const login = await reviewerLogin(github);
    expect(login).toBe("reviewer[bot]");
    await expect(findReviewForHead(github, { owner: "acme", repo: "widgets" }, 42, "head", login))
      .resolves.toMatchObject({ id: 2, html_url: "live" });
  });

  it("does not mistake GitHub's rewritten approval commit for a review of the new head", async () => {
    const github = {
      pulls: { listReviews: async () => ({ data: [
        { id: 1, html_url: "legacy", body: "Approved before the push.", commit_id: "new-head", user: { login: "reviewer[bot]" } },
      ] }) },
    } as unknown as ReviewerGitHub;
    await expect(findReviewForHead(github, { owner: "acme", repo: "widgets" }, 42, "new-head", "reviewer[bot]"))
      .resolves.toBeUndefined();
  });

  it("accepts only RIGHT-side lines represented by a changed-file patch", () => {
    const locations = validInlineLocations([{ filename: "src/a.ts", patch: "@@ -2,2 +2,3 @@\n same\n-old\n+new\n+more" }]);
    expect([...locations]).toEqual(["src/a.ts:2", "src/a.ts:3", "src/a.ts:4"]);
    expect(locations.has("src/a.ts:1")).toBe(false);
  });

  it("does not count no-newline diff metadata as a right-side line", () => {
    const locations = validInlineLocations([{ filename: "src/a.ts", patch: "@@ -1 +1,2 @@\n-old\n\\ No newline at end of file\n+new\n+next" }]);
    expect([...locations]).toEqual(["src/a.ts:1", "src/a.ts:2"]);
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

  it("allows a submit retry after the first attempt rejects", async () => {
    const submit = singleSubmission<string>();
    await expect(submit(async () => { throw new Error("transient"); })).rejects.toThrow("transient");
    await expect(submit(async () => "formal-review")).resolves.toBe("formal-review");
  });

  it("converges automatic and manual workflow races on one Reviewer App and PR head", async () => {
    const result = { status: "commented", prNumber: 42, headSha: "head", summary: "reviewed" } as const;
    const effect = vi.fn(async () => result);
    await expect(Promise.all([
      serializeReviewerSubmission("acme/widgets#42@head:reviewer[bot]", effect),
      serializeReviewerSubmission("acme/widgets#42@head:reviewer[bot]", effect),
    ])).resolves.toEqual([result, result]);
    expect(effect).toHaveBeenCalledTimes(1);
  });
});
