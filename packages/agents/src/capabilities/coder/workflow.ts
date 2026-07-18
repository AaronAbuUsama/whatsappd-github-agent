import { defineAgent, defineWorkflow, type FlueHarness, type FlueLogger } from "@flue/runtime";

import coderSkill from "./SKILL.md" with { type: "skill" };
import { createSpecialistGraphTools } from "../graph/tools.ts";
import { SPEAKER_MODEL_SPECIFIER } from "@ambient-agent/engine/model/pi-subscription.ts";
import { parseGitHubRepository } from "@ambient-agent/engine/github/repository.ts";
import type { SpecialistSpec } from "../delegation/tools.ts";
import { getCoderRuntime } from "./runtime.ts";
import { coderJobInputSchema, coderResultSchema, type CoderJobInput, type CoderResult } from "./schemas.ts";
export type { CoderGitHub } from "./github.ts";
import {
  coderBranch,
  commitChanges,
  downloadTarball,
  ensureBranch,
  fetchDefaultBranch,
  fetchIssue,
  getBranchHead,
  upsertPullRequest,
} from "./github.ts";
import {
  coderResult,
  diffSnapshots,
  gitignoreMatcher,
  isEmptyDiff,
  parseHashListing,
  renderGraphContext,
  type WorkspaceSnapshot,
} from "./workspace.ts";

/** The project convention for the authoritative green gate (single-owner repos, §8 v1). */
const TEST_COMMAND = "pnpm test";
const INSTALL_AND_TEST_HINT = "pnpm install && pnpm test";
const SHELL_TIMEOUT_MS = 20 * 60 * 1000;
/** How much of a failing suite's output to carry into the next attempt / the blocked summary. */
const FAILURE_TAIL = 4000;

/**
 * The Coder agent — the config-bound full sandbox (template rule 1) plus read-only
 * `lookup_graph` (§5 D6) and the lean eval-gated SKILL (rule 4). The sandbox is read
 * from the deployment-configured runtime, never `local()` here; omitting the adapter's
 * `tools` override gives the model the standard workspace fs+shell surface. All GitHub
 * I/O is deterministic app code in `run()` below — never a model tool.
 */
const coderAgent = defineAgent(() => {
  const { sandbox } = getCoderRuntime();
  return {
    model: SPEAKER_MODEL_SPECIFIER,
    sandbox,
    skills: [coderSkill],
    tools: createSpecialistGraphTools(),
    instructions: [
      "You are Coder, a Specialist that implements one GitHub issue in a real checked-out workspace.",
      "The repository is already extracted at the working directory named in your task.",
      "Follow the coder skill: read before you change, match existing idioms, and get the project's suite green.",
      "Your file and shell tools act inside the sandbox workspace; lookup_graph is read-only background.",
    ].join("\n"),
  };
});

/** Hash every tracked file so `diffSnapshots` can tell what the model changed — git-free (§8 rule 2). */
const snapshotWorkspace = async (
  shell: (command: string) => Promise<{ stdout: string; exitCode: number }>,
  isIgnored: (path: string) => boolean,
): Promise<WorkspaceSnapshot> => {
  // ponytail: sha256sum (coreutils) with a shasum fallback for hosts without it (macOS local()).
  // Excludes node_modules/.git so install churn never reads as a change. Upgrade path: a
  // provider-native diff when a remote sandbox exposes one.
  const find = "find . -type f -not -path './node_modules/*' -not -path './.git/*'";
  const primary = await shell(`${find} -exec sha256sum {} + 2>/dev/null`);
  const listing = primary.exitCode === 0 && primary.stdout.trim() !== "" ? primary.stdout : (await shell(`${find} -exec shasum -a 256 {} +`)).stdout;
  // Drop .gitignore'd build artifacts (dist/, coverage/, *.tsbuildinfo, …) so they never
  // hash-diff as changes and get committed (§8; the tarball seed carries the .gitignore).
  const snapshot = new Map<string, string>();
  for (const [path, hash] of parseHashListing(listing)) if (!isIgnored(path)) snapshot.set(path, hash);
  return snapshot;
};

const tail = (text: string, max: number): string => (text.length <= max ? text : text.slice(-max));

/**
 * The issue → PR run (MEMORY-STATE-SPEC §8). Tarball in, model works the issue in the
 * sandbox, the suite is the authoritative green gate, and the change goes out via the
 * Git Data API on the per-issue branch — one open PR per head→base, non-draft only when
 * green (a draft `blocked` PR after N red attempts). Idempotent on the branch/PR natural
 * keys, so a relaunch converges rather than duplicating.
 */
const run = async ({
  harness,
  input,
  log,
}: {
  harness: FlueHarness;
  input: CoderJobInput;
  log: FlueLogger;
}): Promise<CoderResult> => {
  const { github, workspacesRoot, maxAttempts } = getCoderRuntime();
  const repo = parseGitHubRepository(input.repository, (value) => new Error(`Coder repository must be owner/repo, got ${value}`));
  const branch = coderBranch(input.issue);

  const issue = await fetchIssue(github, repo, input.issue);
  const base = await fetchDefaultBranch(github, repo);
  const baseSha = (await github.git.getRef({ owner: repo.owner, repo: repo.repo, ref: `heads/${base}` })).data.object.sha;
  // Relaunch seeding (§8): if the per-issue branch already exists, seed the workspace FROM
  // its head so the tested tree and the tree we later commit against are identical. A fresh
  // issue seeds from the default branch. `ensureBranch(fromSha=baseSha)` below returns this
  // same existing head (created:false), so `commitChanges` layers onto exactly what we ran.
  const existingHead = await getBranchHead(github, repo, branch);
  const seedSha = existingHead ?? baseSha;
  const tarball = await downloadTarball(github, repo, seedSha);

  const repoDir = `${workspacesRoot}/issue-${input.issue}`;
  const shellIn = async (command: string) => await harness.shell(command, { cwd: repoDir, timeoutMs: SHELL_TIMEOUT_MS });
  try {
    await harness.fs.rm(repoDir, { recursive: true, force: true });
    await harness.fs.mkdir(repoDir, { recursive: true });
    await harness.fs.writeFile(`${repoDir}/.coder-source.tar.gz`, tarball);
    // Extract the single top-level archive dir into repoDir (tarball roots at owner-repo-<sha>/).
    await harness.shell(`tar xzf ${repoDir}/.coder-source.tar.gz -C ${repoDir} --strip-components=1`, {
      timeoutMs: SHELL_TIMEOUT_MS,
    });
    await harness.fs.rm(`${repoDir}/.coder-source.tar.gz`, { force: true });

    // The .gitignore rode in with the tarball seed; honor it so build artifacts never diff.
    const gitignoreText = (await shellIn("cat .gitignore 2>/dev/null || true")).stdout;
    const isIgnored = gitignoreMatcher(gitignoreText);
    const snapshot = async () => await snapshotWorkspace(async (command) => await harness.shell(command, { cwd: repoDir }), isIgnored);
    const before = await snapshot();

    const session = await harness.session();
    const framing = input.instructions === undefined ? "" : `\n\nExtra framing from the requester:\n${input.instructions}`;
    const graphContext = renderGraphContext(input.graphContext);
    let testsPassed = false;
    let failure = "";
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const promptText =
        attempt === 1
          ? `Implement GitHub issue #${input.issue} — "${issue.title}" — in the repository at ${repoDir}.\n\n${issue.body}${framing}${graphContext}\n\nWork there now, then run \`${INSTALL_AND_TEST_HINT}\` and get the suite green.`
          : `The suite is still failing after your last attempt. Read the failure and fix the cause, then make it green:\n\n${failure}`;
      await session.prompt(promptText);
      const test = await shellIn(TEST_COMMAND);
      if (test.exitCode === 0) {
        testsPassed = true;
        break;
      }
      failure = tail(`${test.stdout}\n${test.stderr}`.trim(), FAILURE_TAIL);
      log.warn("coder attempt failed the suite", { issue: input.issue, attempt });
    }

    const after = await snapshot();
    const diff = diffSnapshots(before, after);

    if (isEmptyDiff(diff)) {
      return coderResult({
        hasChanges: false,
        testsPassed,
        prCreated: false,
        branch,
        summary: testsPassed
          ? `Issue #${input.issue} needed no code change — the suite was already green.`
          : `Issue #${input.issue}: nothing was changed and the suite is not green.`,
      });
    }

    const head = await ensureBranch(github, repo, branch, baseSha);
    const commitSha = await commitChanges(github, repo, {
      branch,
      headSha: head.sha,
      message: `${testsPassed ? "" : "[blocked] "}Coder: issue #${input.issue} — ${issue.title}`.slice(0, 72),
      files: diff.changed.map((path) => ({ path })),
      deletions: diff.deleted,
      read: (path) => harness.fs.readFileBuffer(`${repoDir}/${path}`),
    });
    log.info("coder committed", { issue: input.issue, commitSha, changed: diff.changed.length, deleted: diff.deleted.length });

    const summary = testsPassed
      ? `Implemented issue #${input.issue}; the suite is green.`
      : `Issue #${input.issue} is not green after ${maxAttempts} attempts — opened a draft PR. Last failure: ${tail(failure, 400)}`;
    const pr = await upsertPullRequest(github, repo, {
      branch,
      base,
      title: `Coder: ${issue.title} (#${input.issue})`,
      body: `${testsPassed ? "Implements" : "DRAFT — blocked on a red suite for"} #${input.issue}.\n\n${summary}`,
      draft: !testsPassed,
    });

    return coderResult({
      hasChanges: true,
      testsPassed,
      prCreated: pr.created,
      prUrl: pr.url,
      prNumber: pr.number,
      branch,
      summary,
    });
  } finally {
    await harness.fs.rm(repoDir, { recursive: true, force: true }).catch(() => {});
  }
};

/** The discovered `coder` workflow (its filename becomes the workflow name). */
export const coder = defineWorkflow({
  agent: coderAgent,
  input: coderJobInputSchema,
  output: coderResultSchema,
  run,
});

/**
 * The agent-neutral, eval-gated description for the `start_coder_job` launch tool
 * (#137 hard rule: no acting-agent name). Mounted on the Speaker via
 * `createDelegationTools`; its input IS the workflow input (one source of truth).
 */
export const START_CODER_JOB_DESCRIPTION =
  "Start a background job that implements one GitHub issue: it checks out the repository, writes the code, " +
  "runs the project's suite, and opens a pull request under its own identity — a non-draft PR when the suite is " +
  "green, a draft flagged blocked when it cannot get there. Returns immediately with a run id; the finished " +
  "result reports back to this chat on its own.";

/** The Coder as the delegation transport sees it (§8): input == the workflow input, one source of truth. */
export const coderSpecialistSpec: SpecialistSpec<typeof coderJobInputSchema> = {
  name: "coder",
  toolName: "start_coder_job",
  description: START_CODER_JOB_DESCRIPTION,
  input: coderJobInputSchema,
  workflow: coder,
};
