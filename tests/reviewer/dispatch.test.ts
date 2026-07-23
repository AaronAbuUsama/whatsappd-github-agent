import { describe, expect, it } from "vite-plus/test";
import * as v from "valibot";

import { reviewHeadEligible } from "../../packages/agents/src/capabilities/reviewer/github.ts";
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
});
