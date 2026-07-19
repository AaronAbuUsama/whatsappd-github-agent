import { describe, expect, it } from "vite-plus/test";

import {
  coderOutcome,
  coderTmpDir,
  diffSnapshots,
  ensureClosesIssue,
  gitignoreMatcher,
  isEmptyDiff,
  parseHashListing,
  renderGraphContext,
} from "../../packages/agents/src/capabilities/coder/workspace.ts";
import type { GraphDigest } from "@ambient-agent/engine/graph/digest.ts";

describe("coderTmpDir — the workspace-local TMPDIR (#172, survives noexec /tmp)", () => {
  it("is under the workspaces root, never the host /tmp", () => {
    const tmp = coderTmpDir("/home/agent/.ambient-agent/workspaces");
    expect(tmp).toBe("/home/agent/.ambient-agent/workspaces/.tmp");
    expect(tmp.startsWith("/home/agent/.ambient-agent/workspaces")).toBe(true);
    expect(tmp.startsWith("/tmp")).toBe(false);
  });
});

describe("parseHashListing", () => {
  it("reads sha256sum-style lines and strips the leading ./", () => {
    const snapshot = parseHashListing(["abc123  ./src/a.ts", "def456  ./src/b.ts", "", "  "].join("\n"));
    expect([...snapshot]).toEqual([
      ["src/a.ts", "abc123"],
      ["src/b.ts", "def456"],
    ]);
  });

  it("tolerates a binary marker (*) and extra whitespace", () => {
    const snapshot = parseHashListing("aaa *bin/tool\nbbb   spaced/path.md\n");
    expect(snapshot.get("bin/tool")).toBe("aaa");
    expect(snapshot.get("spaced/path.md")).toBe("bbb");
  });
});

describe("diffSnapshots", () => {
  it("reports added, modified, and deleted paths, each sorted", () => {
    const before = parseHashListing("h1  keep.ts\nh2  change.ts\nh3  gone.ts");
    const after = parseHashListing("h1  keep.ts\nh2x change.ts\nh4  added.ts");
    const diff = diffSnapshots(before, after);
    expect(diff.changed).toEqual(["added.ts", "change.ts"]);
    expect(diff.deleted).toEqual(["gone.ts"]);
    expect(isEmptyDiff(diff)).toBe(false);
  });

  it("is empty when nothing moved (the no-op case)", () => {
    const snap = parseHashListing("h1  a.ts\nh2  b.ts");
    expect(isEmptyDiff(diffSnapshots(snap, snap))).toBe(true);
  });
});

describe("coderOutcome — the conductor's light after-check (#172)", () => {
  const branch = "agent/coder/issue-7";
  const context = {
    issue: 7,
    branch,
    jobId: "job-7",
    finalVerdict: "PASS" as const,
    verificationRounds: 2,
    reviewCycle: 0,
  };

  it("a freshly opened, non-draft PR → opened-pr, testsPassed true", () => {
    const result = coderOutcome({ url: "u", number: 3, created: true, draft: false }, context);
    expect(result.outcome).toBe("opened-pr");
    expect(result.testsPassed).toBe(true);
    expect(result).toMatchObject({ prUrl: "u", prNumber: 3, branch, jobId: "job-7", finalVerdict: "PASS", verificationRounds: 2, reviewCycle: 0, draft: false });
  });

  it("a reused open PR → updated-pr (relaunch pushed more commits, no duplicate)", () => {
    expect(coderOutcome({ url: "u", number: 3, created: false, draft: false }, context).outcome).toBe("updated-pr");
  });

  it("a draft PR → testsPassed false (the model's own red judgment), never presented as done", () => {
    const result = coderOutcome({ url: "u", number: 3, created: true, draft: true }, { ...context, finalVerdict: "FAIL" });
    expect(result.outcome).toBe("opened-pr");
    expect(result.testsPassed).toBe(false);
    expect(result.summary).toContain("draft");
  });

  it("no PR opened → blocked (the model made no committable change or gave up)", () => {
    const result = coderOutcome(undefined, { ...context, finalVerdict: "BLOCKED" });
    expect(result.outcome).toBe("blocked");
    expect(result.prUrl).toBeUndefined();
    expect(result.branch).toBe(branch);
  });
});

describe("ensureClosesIssue — the load-bearing `Closes #N` (#172, Finding 1)", () => {
  it("appends `Closes #N` when the model's body has no closing keyword for the issue", () => {
    expect(ensureClosesIssue("A rich narrative.", 172)).toBe("A rich narrative.\n\nCloses #172");
  });

  it("leaves the body untouched when it already closes the issue (any keyword, case-insensitive)", () => {
    for (const kw of ["Closes #172", "closed #172", "Fixes #172", "fix #172", "Resolves #172", "resolved #172"]) {
      const body = `Done. ${kw} for good.`;
      expect(ensureClosesIssue(body, 172)).toBe(body);
    }
  });

  it("still appends when the body closes a DIFFERENT issue (must close its own)", () => {
    expect(ensureClosesIssue("Closes #99.", 172)).toBe("Closes #99.\n\nCloses #172");
  });

  it("honors an owner/repo-qualified closing keyword", () => {
    const body = "Closes acme/widgets#172.";
    expect(ensureClosesIssue(body, 172)).toBe(body);
  });
});

describe("gitignoreMatcher — snapshot honors .gitignore", () => {
  const isIgnored = gitignoreMatcher(["# build output", "dist/", "coverage/", "*.tsbuildinfo", "/.env", ""].join("\n"));

  it("ignores directory patterns, globs, root-anchored and common build artifacts", () => {
    expect(isIgnored("dist/index.js")).toBe(true);
    expect(isIgnored("packages/x/dist/a.js")).toBe(true); // unanchored dir matches any depth
    expect(isIgnored("coverage/lcov.info")).toBe(true);
    expect(isIgnored("tsconfig.tsbuildinfo")).toBe(true);
    expect(isIgnored(".env")).toBe(true); // root-anchored
    expect(isIgnored("node_modules/pkg/index.js")).toBe(true); // common-artifact backstop
    expect(isIgnored("src/tsbuildinfo.ts")).toBe(false); // *.tsbuildinfo must not match a normal .ts
  });

  it("keeps source and tracked files (e.g. the committed lockfile)", () => {
    expect(isIgnored("src/index.ts")).toBe(false);
    expect(isIgnored("packages/agents/src/capabilities/coder/workflow.ts")).toBe(false);
    expect(isIgnored("pnpm-lock.yaml")).toBe(false);
    expect(isIgnored("README.md")).toBe(false);
  });

  it("skips comments, blanks and negations without matching everything", () => {
    const empty = gitignoreMatcher("# only comments\n\n!keep.ts\n");
    expect(empty("src/a.ts")).toBe(false); // no real patterns → nothing ignored (but the artifact backstop still applies)
    expect(empty("dist/a.js")).toBe(true);
  });
});

describe("renderGraphContext — the pushed digest into the prompt", () => {
  it("is empty for an undefined or empty digest (a clean prompt when no graph is wired)", () => {
    expect(renderGraphContext(undefined)).toBe("");
    expect(renderGraphContext({ seeds: [], entities: [], relations: [], commitments: [] })).toBe("");
  });

  it("renders entities, relations and commitments as a compact block", () => {
    const digest: GraphDigest = {
      seeds: ["e1"],
      entities: [{ entityId: "e1", type: "issue", properties: { number: 158 }, confidence: 1, lowConfidence: false }],
      relations: [{ fromId: "e1", relation: "part_of", toId: "e2", confidence: 1, lowConfidence: false }],
      commitments: [
        { entityId: "c1", type: "commitment", properties: { text: "ship it" }, confidence: 1, lowConfidence: false, overdue: true },
      ],
    };
    const rendered = renderGraphContext(digest);
    expect(rendered).toContain("Shared graph context");
    expect(rendered).toContain("issue e1");
    expect(rendered).toContain("part_of");
    expect(rendered).toContain("(overdue)");
  });
});
