import { describe, expect, it } from "vite-plus/test";
import * as v from "valibot";

import { reviewHeadEligible, reviewIneligibilityReason } from "../../packages/agents/src/capabilities/reviewer/github.ts";
import { reviewerJobInputSchema, reviewerJobRequestSchema } from "../../packages/agents/src/capabilities/reviewer/schemas.ts";
import { reviewerSpecialistSpec } from "../../packages/agents/src/capabilities/reviewer/workflow.ts";

describe("Reviewer on-request dispatch", () => {
  it("parses a Brain request of repository + pullRequest and rejects one without them", () => {
    expect(v.parse(reviewerJobRequestSchema, { repository: "acme/widgets", pullRequest: 8 }))
      .toEqual({ repository: "acme/widgets", pullRequest: 8 });
    expect(() => v.parse(reviewerJobRequestSchema, { expectedHeadSha: "abc123" })).toThrow();
  });

  it("accepts the delegation-injected input with no expectedHeadSha and the legacy input with one", () => {
    const injected = v.parse(reviewerJobInputSchema, {
      repository: "acme/widgets",
      pullRequest: 8,
      brainWorkId: "brain-work:abc",
      sourceSurfaceId: "surface:source",
    });
    expect(injected).toMatchObject({ repository: "acme/widgets", pullRequest: 8 });
    expect(injected.expectedHeadSha).toBeUndefined();

    expect(v.parse(reviewerJobInputSchema, {
      repository: "acme/widgets",
      pullRequest: 8,
      expectedHeadSha: "abc123",
    })).toMatchObject({ expectedHeadSha: "abc123" });
  });

  it("exposes a spec whose name matches the Flue-discovered reviewer workflow", () => {
    expect(reviewerSpecialistSpec.name).toBe("reviewer");
    expect(reviewerSpecialistSpec.toolName).toBe("start_reviewer_job");
  });

  it("refuses the launch when the reviewer runtime is unprovisioned instead of admitting a doomed run", () => {
    // Reviewer runtime is never configured in this isolated file, so ensureAvailable must throw
    // before any launch is reserved — the Brain hears 'unprovisioned', not a run that errors later.
    expect(() => reviewerSpecialistSpec.ensureAvailable?.()).toThrow(/unprovisioned/u);
  });

  it("relaxes head eligibility: live head reviewed when no expectedHeadSha is pinned", () => {
    const openHead = (sha: string, draft = false) => ({ state: "open", draft, head: { sha } });
    // On-request Brain launch (no pin): open + non-draft ⇒ eligible at whatever head is live.
    expect(reviewHeadEligible(openHead("live"))).toBe(true);
    // Legacy pinned launch: matching head ⇒ eligible; mismatched ⇒ ineligible.
    expect(reviewHeadEligible(openHead("live"), "live")).toBe(true);
    expect(reviewHeadEligible(openHead("live"), "stale")).toBe(false);
    // Draft or closed is never eligible, pinned or not.
    expect(reviewHeadEligible(openHead("live", true))).toBe(false);
    expect(reviewHeadEligible({ state: "closed", draft: false, head: { sha: "live" } })).toBe(false);
  });

  it("names the real disqualifier so the blocked summary never invents a head-pin story", () => {
    // Unpinned (every on-request Brain launch): the reason must be the true one, never a head change.
    expect(reviewIneligibilityReason({ state: "closed", draft: false, head: { sha: "live" } }))
      .toBe("Review skipped because the pull request is closed.");
    expect(reviewIneligibilityReason({ state: "closed", merged: true, head: { sha: "live" } }))
      .toBe("Review skipped because the pull request is already merged.");
    expect(reviewIneligibilityReason({ state: "open", draft: true, head: { sha: "live" } }))
      .toBe("Review skipped because the pull request is still a draft.");
    expect(reviewIneligibilityReason({ state: "open", draft: false, head: { sha: "live" } })).toBeUndefined();
    // Only a pinned launch whose live head moved gets the head-changed story.
    expect(reviewIneligibilityReason({ state: "open", draft: false, head: { sha: "live" } }, "stale"))
      .toBe("Review skipped because the admitted pull-request head is no longer the live eligible head.");
  });
});
