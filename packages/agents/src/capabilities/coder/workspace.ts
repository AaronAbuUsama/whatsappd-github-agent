import { isEmptyDigest, type GraphDigest } from "@ambient-agent/engine/graph/digest.ts";

import type { CoderResult, VerificationVerdict } from "./schemas.ts";

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
 * Deterministic handler plumbing (#172): guarantee the PR body carries a `Closes #N`. This
 * is load-bearing, not templating — a merged PR auto-closes its issue AND the ingress
 * backstop (engine/github/ingress.ts `linkedIssueNumbers`) parses it to correlate the
 * Coder's own `pull_request.opened` webhook to the issue. #172 deleted the body TEMPLATE,
 * not this one line. Idempotent: if the model's body already closes #N with any GitHub
 * closing keyword (close(s|d)/fix(es|ed)/resolve(s|d), optional `owner/repo` prefix),
 * append nothing. Mirrors the ingress regex so what we write is exactly what it reads.
 */
export const ensureClosesIssue = (body: string, issue: number): string => {
  const closesN = new RegExp(
    `\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)(?::\\s*|\\s+)(?:[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)?#${issue}\\b`,
    "i",
  );
  return closesN.test(body) ? body : `${body}\n\nCloses #${issue}`;
};

/**
 * What the `open_pull_request` handler records when it opens (or reuses) the PR, so the
 * conductor's light after-check can tell the model finished from the model giving up
 * without a second GitHub round-trip. `draft` is the model's own green/red judgment.
 */
export interface OpenPrRecord {
  readonly url: string;
  readonly number: number;
  readonly created: boolean;
  readonly draft: boolean;
}

/**
 * The workspace-local scratch dir the model's shell tools use as `TMPDIR`, so the test
 * run survives a `noexec /tmp` on hardened hosts. Kept at the workspaces root (not under
 * the per-issue `repoDir`) so the conductor's end-of-run `rm(repoDir)` never destroys it.
 * Bound into the sandbox env at composition (`local({ env: { TMPDIR } })`) and `mkdir`ed
 * by the conductor per run.
 */
export const coderTmpDir = (workspacesRoot: string): string => `${workspacesRoot}/.tmp`;

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
 * The conductor's light after-check, pure so it is unit-tested without a sandbox: the
 * model owned the loop and (if it got there) called `open_pull_request`, so the only thing
 * left to decide is whether a PR exists.
 *
 * - A PR record → `opened-pr` (fresh) or `updated-pr` (relaunch reused the open PR).
 *   `testsPassed` mirrors the model's own `draft` judgment (a draft PR is not green).
 * - No record → the model made no committable change or gave up → `blocked`. Red/abandoned
 *   work is never presented as done.
 *
 * ponytail: `summary` is the terse Speaker relay; the rich narrative is the MODEL-authored
 * PR body on the PR itself, never templated here.
 */
export const coderOutcome = (
  record: OpenPrRecord | undefined,
  context: {
    readonly issue: number;
    readonly branch: string;
    readonly jobId: string;
    readonly finalVerdict: VerificationVerdict;
    readonly verificationRounds: number;
    readonly reviewCycle: number;
  },
): CoderResult => {
  const metadata = {
    branch: context.branch,
    jobId: context.jobId,
    finalVerdict: context.finalVerdict,
    verificationRounds: context.verificationRounds,
    reviewCycle: context.reviewCycle,
  } as const;
  if (record === undefined) {
    return {
      outcome: "blocked",
      ...metadata,
      summary: `Issue #${context.issue}: no pull request was opened — the coder made no committable change or could not finish.`,
    };
  }
  return {
    outcome: record.created ? "opened-pr" : "updated-pr",
    prUrl: record.url,
    prNumber: record.number,
    ...metadata,
    testsPassed: !record.draft,
    draft: record.draft,
    summary: `Issue #${context.issue}: ${record.created ? "opened" : "updated"} ${record.draft ? "a draft (not yet green) " : "a "}pull request — ${record.url}`,
  };
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
