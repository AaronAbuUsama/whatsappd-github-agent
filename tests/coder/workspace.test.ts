import { describe, expect, it } from "vite-plus/test";

import {
  coderResult,
  diffSnapshots,
  gitignoreMatcher,
  isEmptyDiff,
  parseHashListing,
  renderGraphContext,
} from "../../packages/agents/src/capabilities/coder/workspace.ts";
import type { GraphDigest } from "@ambient-agent/engine/graph/digest.ts";

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

describe("coderResult — the green gate", () => {
  const base = { branch: "agent/coder/issue-7", summary: "s" };

  it("green + a freshly opened PR → opened-pr, non-blocked, testsPassed", () => {
    const result = coderResult({ ...base, hasChanges: true, testsPassed: true, prCreated: true, prUrl: "u", prNumber: 3 });
    expect(result.outcome).toBe("opened-pr");
    expect(result.testsPassed).toBe(true);
    expect(result).toMatchObject({ prUrl: "u", prNumber: 3, branch: "agent/coder/issue-7" });
  });

  it("green + a PR already open → updated-pr (relaunch pushed more commits)", () => {
    expect(coderResult({ ...base, hasChanges: true, testsPassed: true, prCreated: false }).outcome).toBe("updated-pr");
  });

  it("red after N attempts → blocked (the draft PR path), never presented as done", () => {
    const result = coderResult({ ...base, hasChanges: true, testsPassed: false, prCreated: true });
    expect(result.outcome).toBe("blocked");
    expect(result.testsPassed).toBe(false);
  });

  it("no change + green → no-op (nothing to do, the suite was already green)", () => {
    expect(coderResult({ ...base, hasChanges: false, testsPassed: true, prCreated: false }).outcome).toBe("no-op");
  });

  it("no change + still red → failed, never the benign no-op (attempts exhausted, nothing fixed)", () => {
    const result = coderResult({ ...base, hasChanges: false, testsPassed: false, prCreated: false });
    expect(result.outcome).toBe("failed");
    expect(result.testsPassed).toBe(false);
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
