import { isEmptyDigest, type GraphDigest } from "@ambient-agent/engine/graph/digest.ts";

import type { CoderResult } from "./schemas.ts";

/**
 * Which files the model touched, git-free. The tarball seed has no `.git`, so the
 * commit-out step can't ask git what changed; instead we hash every tracked file
 * before and after the model works and diff the two snapshots. Portable across
 * `local()` and a remote sandbox (both expose `find`/hashing), and deterministic —
 * the testable core of "Git Data API out".
 *
 * A snapshot maps a workspace-relative path to a content hash. `parseHashListing`
 * reads the `<hash>␠␠<path>` lines a `sha256sum`-style command emits.
 */
export type WorkspaceSnapshot = ReadonlyMap<string, string>;

export const parseHashListing = (listing: string): WorkspaceSnapshot => {
  const snapshot = new Map<string, string>();
  for (const raw of listing.split("\n")) {
    const line = raw.trimEnd();
    if (line === "") continue;
    // `sha256sum` prints "<hash>  <path>" (two spaces); tolerate one-or-more.
    const match = /^(\S+)\s+(?:[*]?)(.+)$/u.exec(line);
    if (match === null) continue;
    const path = match[2]!.replace(/^\.\//u, "");
    snapshot.set(path, match[1]!);
  }
  return snapshot;
};

export interface WorkspaceDiff {
  /** Added or modified paths — their current bytes go into new blobs. */
  readonly changed: readonly string[];
  /** Paths present before but gone now — tree entries with `sha:null`. */
  readonly deleted: readonly string[];
}

export const diffSnapshots = (before: WorkspaceSnapshot, after: WorkspaceSnapshot): WorkspaceDiff => {
  const changed: string[] = [];
  for (const [path, hash] of after) {
    if (before.get(path) !== hash) changed.push(path);
  }
  const deleted: string[] = [];
  for (const path of before.keys()) {
    if (!after.has(path)) deleted.push(path);
  }
  return { changed: changed.sort(), deleted: deleted.sort() };
};

export const isEmptyDiff = (diff: WorkspaceDiff): boolean => diff.changed.length === 0 && diff.deleted.length === 0;

/**
 * Build-artifact patterns every JS/TS repo produces, layered UNDER the workspace
 * `.gitignore` so a repo that forgot one still never commits it (`node_modules`/`.git`
 * are already pruned by the `find`, listed here so the matcher is self-contained).
 */
const COMMON_ARTIFACT_PATTERNS = ["node_modules/", ".git/", "dist/", "coverage/", "*.tsbuildinfo"] as const;

const escapeRe = (segment: string): string =>
  segment.replace(/[.+^${}()|[\]\\]/gu, "\\$&").replace(/\*/gu, "[^/]*").replace(/\?/gu, "[^/]");

/**
 * A minimal `.gitignore` matcher for the workspace snapshot, so build artifacts
 * (`dist/`, `coverage/`, `*.tsbuildinfo`, …) never hash-diff as changes and get
 * committed. Honors: comments/blank lines, a bare name or glob matching any path
 * segment, and a slash-bearing pattern anchored at the workspace root (trailing-slash
 * dir prefixes included).
 *
 * ponytail: root `.gitignore` + the common-artifact list only. NOT honored — nested
 * `.gitignore` files, negation (`!…`, dropped), `**`, and tracked-but-install-rewritten
 * files (`pnpm-lock.yaml` is committed, not ignored, so it is out of this matcher's
 * reach). Upgrade path: `git check-ignore` once a real `.git` is present in the seed.
 */
export const gitignoreMatcher = (gitignoreText: string): ((path: string) => boolean) => {
  const patterns = [
    ...COMMON_ARTIFACT_PATTERNS,
    ...gitignoreText
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#") && !line.startsWith("!")),
  ];
  const matchers = patterns.map((raw) => {
    let pattern = raw;
    if (pattern.endsWith("/")) pattern = pattern.slice(0, -1);
    const anchored = pattern.startsWith("/");
    if (anchored) pattern = pattern.slice(1);
    // Bare name/glob (no slash): matches any path segment (a file, or anything under a dir).
    // Slash-bearing pattern: anchored at the workspace root, matches it or anything below.
    return pattern.includes("/")
      ? new RegExp(`^${escapeRe(pattern)}(/|$)`, "u")
      : new RegExp(`(^|/)${escapeRe(pattern)}(/|$)`, "u");
  });
  return (path: string): boolean => matchers.some((re) => re.test(path));
};

/**
 * The green-gate decision (§8 DoD), pure so it is unit-tested without a sandbox:
 *
 * - No change after a green run → `no-op` (nothing to commit; no PR).
 * - No change after a still-red run → `failed`: attempts exhausted, nothing fixed, the
 *   suite left red — a real failure, not the benign `no-op`. The failure rides `summary`.
 * - Green + a freshly opened PR → `opened-pr`; green + a PR already open → `updated-pr`
 *   (relaunch pushed more commits). Non-draft either way.
 * - Change but still red after N attempts → a **draft** PR and `blocked`, the failure in
 *   `summary`. Red work is never presented as done (the caller opens `draft: !testsPassed`).
 */
export const coderResult = (input: {
  hasChanges: boolean;
  testsPassed: boolean;
  prCreated: boolean;
  prUrl?: string;
  prNumber?: number;
  branch: string;
  summary: string;
}): CoderResult => {
  const base = {
    branch: input.branch,
    summary: input.summary,
    testsPassed: input.testsPassed,
    ...(input.prUrl === undefined ? {} : { prUrl: input.prUrl }),
    ...(input.prNumber === undefined ? {} : { prNumber: input.prNumber }),
  };
  if (!input.hasChanges) return { ...base, outcome: input.testsPassed ? "no-op" : "failed" };
  if (!input.testsPassed) return { ...base, outcome: "blocked" };
  return { ...base, outcome: input.prCreated ? "opened-pr" : "updated-pr" };
};

/**
 * Render the pushed graph digest (§8, seeded at launch) into a compact prompt block the
 * Coder gets alongside the issue body — background memory of what the shared graph knows
 * about this work. Empty/undefined → "" so the prompt stays clean when no graph is wired.
 */
export const renderGraphContext = (digest?: GraphDigest): string => {
  if (digest === undefined || isEmptyDigest(digest)) return "";
  const lines = [
    ...digest.entities.map((e) => `- ${e.type} ${e.entityId}: ${JSON.stringify(e.properties)}`),
    ...digest.relations.map((r) => `- ${r.fromId} —${r.relation}→ ${r.toId}`),
    ...digest.commitments.map((c) => `- commitment ${c.entityId}${c.overdue ? " (overdue)" : ""}: ${JSON.stringify(c.properties)}`),
  ];
  return `\n\nShared graph context (background memory — what the graph already knows about this work):\n${lines.join("\n")}`;
};
