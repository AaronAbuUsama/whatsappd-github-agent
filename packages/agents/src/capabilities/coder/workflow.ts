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
  downloadTarball,
  fetchDefaultBranch,
  fetchIssue,
  getBranchHead,
} from "./github.ts";
import { createOpenPullRequestTool } from "./tool.ts";
import {
  coderOutcome,
  coderTmpDir,
  gitignoreMatcher,
  parseHashListing,
  renderGraphContext,
  type OpenPrRecord,
  type WorkspaceSnapshot,
} from "./workspace.ts";

const SHELL_TIMEOUT_MS = 20 * 60 * 1000;

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

/**
 * The issue → PR run (MEMORY-STATE-SPEC §8, #172). The conductor is safe scaffolding only:
 * fetch the issue + seed tarball, set up the workspace with a workspace-local `TMPDIR` (so a
 * `noexec /tmp` host can't break the model's test run), mount the model's one safe write
 * (`open_pull_request`), let the MODEL own the loop (detect toolchain → install → implement →
 * run the repo's tests → author a rich PR body → open the PR, draft = its own green/red
 * judgment), then a light after-check: a PR opened == done, none == `blocked`. No test re-run,
 * no PR templating — the idempotent branch/PR plumbing lives in the tool handler.
 */
const run = async ({
  harness,
  input,
}: {
  harness: FlueHarness;
  input: CoderJobInput;
  log: FlueLogger;
}): Promise<CoderResult> => {
  const { github, workspacesRoot } = getCoderRuntime();
  const repo = parseGitHubRepository(input.repository, (value) => new Error(`Coder repository must be owner/repo, got ${value}`));
  const branch = coderBranch(input.issue);

  const issue = await fetchIssue(github, repo, input.issue);
  const base = await fetchDefaultBranch(github, repo);
  const baseSha = (await github.git.getRef({ owner: repo.owner, repo: repo.repo, ref: `heads/${base}` })).data.object.sha;
  // Relaunch seeding (§8): if the per-issue branch already exists, seed the workspace FROM
  // its head so the tested tree and the tree we later commit against are identical. A fresh
  // issue seeds from the default branch. `ensureBranch(fromSha=baseSha)` in the tool returns
  // this same existing head (created:false), so `commitChanges` layers onto what we ran.
  const existingHead = await getBranchHead(github, repo, branch);
  const seedSha = existingHead ?? baseSha;
  const tarball = await downloadTarball(github, repo, seedSha);

  const repoDir = `${workspacesRoot}/issue-${input.issue}`;
  const tmpDir = coderTmpDir(workspacesRoot);
  const shellIn = async (command: string) => await harness.shell(command, { cwd: repoDir, timeoutMs: SHELL_TIMEOUT_MS });
  try {
    // The model's shell tools inherit TMPDIR from the sandbox env (bound at composition);
    // just make sure the workspace-local dir it points at exists before the model runs tests.
    // ponytail: this .tmp accumulates across runs — kept at the workspaces root (not under
    // repoDir) deliberately so the finally-block rm(repoDir) can't destroy a concurrent run's
    // scratch. Ceiling: unbounded growth. Upgrade path: a periodic sweep of stale entries.
    await harness.fs.mkdir(tmpDir, { recursive: true });
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

    // The model's one safe write, built with the workspace context bound in — the handler
    // snapshots-diffs-commits-and-opens the PR idempotently. `record.pr` is the after-check's
    // signal, and the seam a #173 verifier reads before the PR is opened.
    const record: { pr?: OpenPrRecord } = {};
    const openPullRequest = createOpenPullRequestTool({
      github,
      repo,
      branch,
      base,
      baseSha,
      issue: input.issue,
      issueTitle: issue.title,
      before,
      snapshotAfter: snapshot,
      readFile: (path) => harness.fs.readFileBuffer(`${repoDir}/${path}`),
      record,
    });

    const session = await harness.session();
    const framing = input.instructions === undefined ? "" : `\n\nExtra framing from the requester:\n${input.instructions}`;
    const graphContext = renderGraphContext(input.graphContext);
    // GROWTH SEAM (#173): this single model turn is the unit that later becomes
    // `session.task("coder", …)` inside a planner→coder→verifier workflow — the tool mount
    // and the after-check below stay identical; only who drives the turn changes.
    await session.prompt(
      `Implement GitHub issue #${input.issue} — "${issue.title}" — in the repository already checked out at ${repoDir}.\n\n` +
        `${issue.body}${framing}${graphContext}\n\n` +
        "Work there now: detect the project's toolchain, install it, make the change, and run the project's own test " +
        "suite until you have a verdict. Then write a rich pull-request body (a clear narrative, structured sections, " +
        "mermaid diagrams where they help) and call `open_pull_request` exactly once — set `draft` to false only if the " +
        "suite is green, true if it is not. Never present a red or unfinished change as done.",
      { tools: [openPullRequest] },
    );

    // Light after-check: no test re-run, no templating. A PR opened == the model finished.
    return coderOutcome(record.pr, input.issue, branch);
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
