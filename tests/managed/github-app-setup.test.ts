import { describe, expect, it } from "vitest";

import { githubAppSetupChecklist } from "@ambient-agent/installation/github-app-setup.ts";

describe("GitHub App setup checklist", () => {
  it("requires the Planner webhook events used by automatic and manual review admission", () => {
    const checklist = githubAppSetupChecklist("planner", "owner/repository");

    expect(checklist).toContain(
      "Enable the webhook and subscribe to exactly these events: Issues, Issue comment, Pull request, Pull request review.",
    );
    expect(checklist).toContain("Pull requests: read");
    expect(checklist).toContain("  4. Generate a private key");
  });

  it.each(["coder", "reviewer"] as const)("does not ask the %s App to receive ingress", (reference) => {
    const checklist = githubAppSetupChecklist(reference, "owner/repository");

    expect(checklist).not.toContain("subscribe to exactly these events");
    expect(checklist).toContain("  3. Generate a private key");
  });
});
