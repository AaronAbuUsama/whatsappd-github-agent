import {
  defineAgent,
  defineAgentProfile,
  defineWorkflow,
  type FlueHarness,
  type FlueLogger,
  type FlueSession,
} from "@flue/runtime";

import coderSkill from "./SKILL.md" with { type: "skill" };
import plannerSkill from "./planner/SKILL.md" with { type: "skill" };
import verifierSkill from "./verifier/verify/SKILL.md" with { type: "skill" };
import { createSpecialistGraphTools } from "../graph/tools.ts";
import { resolveAgentModelProfile } from "@ambient-agent/engine/model/pi-subscription.ts";
import { parseGitHubRepository } from "@ambient-agent/engine/github/repository.ts";
import type { SpecialistSpec } from "../delegation/tools.ts";
import { getCoderRuntime } from "./runtime.ts";
import { tryGetDelegationRuntime } from "../delegation/runtime.ts";
import {
  coderJobInputSchema,
  coderJobRequestSchema,
  coderResultSchema,
  planArtifactSchema,
  verificationReceiptSchema,
  type CoderJobInput,
  type CoderResult,
  type PlanArtifact,
  type VerificationReceipt,
  type VerificationVerdict,
} from "./schemas.ts";
export type { CoderGitHub } from "./github.ts";
import { coderBranch, downloadTarball, fetchDefaultBranch, fetchIssue, getBranchHead } from "./github.ts";
import { fetchReviewContinuation, renderReviewContinuation } from "./continuation.ts";
import type { CodingJobRecord } from "./registry.ts";
import { createOpenPullRequestTool } from "./tool.ts";
import {
  coderOutcome,
  gitignoreMatcher,
  parseHashListing,
  renderGraphContext,
  type OpenPrRecord,
  type WorkspaceSnapshot,
} from "./workspace.ts";

const SHELL_TIMEOUT_MS = 20 * 60 * 1000;
type CodingStage = "workflow" | "planner" | "coder" | "verifier" | "publication";
type CodingWaypointStatus = "started" | "completed" | "failed";
export interface CodingWaypoint {
  readonly event: "coding.waypoint";
  readonly schemaVersion: 1;
  readonly jobId: string;
  readonly mode: "new_issue" | "review_continuation";
  readonly stage: CodingStage;
  readonly status: CodingWaypointStatus;
  readonly reviewCycle: number;
  readonly maxReviewCycles: number;
  readonly verificationRound?: number;
  readonly maxVerificationRounds: number;
  readonly verdict?: VerificationVerdict;
  readonly pullRequest?: number;
  readonly draft?: boolean;
}

export const codingWaypoint = (input: Omit<CodingWaypoint, "event" | "schemaVersion">): CodingWaypoint => ({
  event: "coding.waypoint",
  schemaVersion: 1,
  ...input,
});

type StageWaypoint = (stage: Exclude<CodingStage, "workflow" | "publication">, status: "started" | "completed", extra?: {
  verificationRound?: number;
  verdict?: VerificationVerdict;
}) => void;

const roleProfiles = () => [
  defineAgentProfile({
    name: "planner",
    description: "Produce one ordered implementation and behavioral verification plan before code changes begin.",
    ...resolveAgentModelProfile("planner"),
    skills: [plannerSkill],
    instructions: "Plan one issue. Return only the requested structured artifact. Do not edit files or implement the change.",
  }),
  defineAgentProfile({
    name: "coder",
    description: "Implement or repair the current plan in the shared workspace, then author the final pull request when asked.",
    ...resolveAgentModelProfile("coder"),
    skills: [coderSkill],
    tools: createSpecialistGraphTools(),
    instructions: "Work only in the task's named shared workspace. Never launch another agent.",
  }),
  defineAgentProfile({
    name: "verifier",
    description: "Drive the changed code at its runtime surface and return a complete PASS, FAIL, BLOCKED, or SKIP report.",
    ...resolveAgentModelProfile("verifier"),
    skills: [verifierSkill],
    instructions: "Activate and follow the verify skill. Return only the requested structured receipt and never edit implementation files.",
  }),
];

/** Unprompted root: TypeScript alone chooses every role transition and budget. */
const coderAgent = defineAgent(() => {
  const { sandbox } = getCoderRuntime();
  return {
    ...resolveAgentModelProfile("coder"),
    sandbox,
    subagents: roleProfiles(),
    instructions: "Deterministic coding-workflow coordinator. This root session is never prompted.",
  };
});

/** Hash every tracked file so publication can diff the workspace against its seed. */
const snapshotWorkspace = async (
  shell: (command: string) => Promise<{ stdout: string; exitCode: number }>,
  isIgnored: (path: string) => boolean,
): Promise<WorkspaceSnapshot> => {
  const find = "find . -type f -not -path './node_modules/*' -not -path './.git/*'";
  const primary = await shell(`${find} -exec sha256sum {} + 2>/dev/null`);
  const listing = primary.exitCode === 0 && primary.stdout.trim() !== "" ? primary.stdout : (await shell(`${find} -exec shasum -a 256 {} +`)).stdout;
  const snapshot = new Map<string, string>();
  for (const [path, hash] of parseHashListing(listing)) if (!isIgnored(path)) snapshot.set(path, hash);
  return snapshot;
};

export const plannerTaskPrompt = (input: {
  issue: number;
  title: string;
  body: string;
  repository: string;
  repoDir: string;
  framing: string;
  graphContext: string;
}): string =>
  `Plan GitHub issue #${input.issue} — "${input.title}" — for ${input.repository}. The repository is available at ${input.repoDir}.\n\n` +
  `${input.body}${input.framing}${input.graphContext}\n\n` +
  "Return one ordered implementation plan plus a behavioral verification plan. Do not edit files or implement anything.";

export const coderTaskPrompt = (input: {
  issue: number;
  title: string;
  repoDir: string;
  round: number;
  plan: PlanArtifact;
  priorVerification?: VerificationReceipt;
}): string => {
  const prior = input.priorVerification === undefined
    ? ""
    : `\n\nPrevious Verifier report (verbatim):\n<verifier-report>\n${input.priorVerification.report}\n</verifier-report>`;
  return `Implement or repair GitHub issue #${input.issue} — "${input.title}" — in ${input.repoDir}. This is verification round ${input.round}.\n\n` +
    `Planner artifact:\n${JSON.stringify(input.plan, null, 2)}${prior}\n\n` +
    "Work the ordered plan in the shared workspace and leave it ready for independent runtime verification. " +
    "Do not author or open the pull request in this task; publication happens only after verification.";
};

export const verifierTaskPrompt = (input: {
  issue: number;
  title: string;
  repoDir: string;
  round: number;
  plan: PlanArtifact;
}): string =>
  `Verify GitHub issue #${input.issue} — "${input.title}" — in the shared workspace ${input.repoDir}. This is verification round ${input.round}.\n\n` +
  `Planner artifact:\n${JSON.stringify(input.plan, null, 2)}\n\n` +
  "Activate and follow the vendored verify methodology. Drive the runtime surface; return PASS, FAIL, BLOCKED, or legitimate SKIP plus the complete actionable Markdown report.";

export const publicationTaskPrompt = (input: {
  issue: number;
  title: string;
  plan: PlanArtifact;
  verification: VerificationReceipt;
  draft: boolean;
}): string =>
  `Author the final pull request for GitHub issue #${input.issue} — "${input.title}". Do not edit the verified workspace.\n\n` +
  `Planner artifact:\n${JSON.stringify(input.plan, null, 2)}\n\n` +
  `Final Verifier report (verbatim):\n<verifier-report>\n${input.verification.report}\n</verifier-report>\n\n` +
  `Write the rich current engineering record and call open_pull_request exactly once with draft=${String(input.draft)}.`;

/** The deterministic Planner → bounded Coder/Verifier loop, isolated for regression proof. */
export const runInternalCodingLoop = async (input: {
  session: Pick<FlueSession, "task">;
  plannerPrompt: string;
  coderPrompt: (round: number, plan: PlanArtifact, prior?: VerificationReceipt) => string;
  verifierPrompt: (round: number, plan: PlanArtifact) => string;
  cwd: string;
  maxVerificationRounds: number;
  waypoint: StageWaypoint;
}): Promise<{ plan: PlanArtifact; verification: VerificationReceipt; rounds: number }> => {
  input.waypoint("planner", "started");
  const plan = (await input.session.task(input.plannerPrompt, {
    agent: "planner",
    cwd: input.cwd,
    result: planArtifactSchema,
  })).data;
  input.waypoint("planner", "completed");

  let prior: VerificationReceipt | undefined;
  for (let round = 1; round <= input.maxVerificationRounds; round += 1) {
    input.waypoint("coder", "started", { verificationRound: round });
    await input.session.task(input.coderPrompt(round, plan, prior), {
      agent: "coder",
      cwd: input.cwd,
    });
    input.waypoint("coder", "completed", { verificationRound: round });

    input.waypoint("verifier", "started", { verificationRound: round });
    prior = (await input.session.task(input.verifierPrompt(round, plan), {
      agent: "verifier",
      cwd: input.cwd,
      result: verificationReceiptSchema,
    })).data;
    input.waypoint("verifier", "completed", { verificationRound: round, verdict: prior.verdict });
    if (prior.verdict === "PASS" || prior.verdict === "SKIP") return { plan, verification: prior, rounds: round };
    if (round === input.maxVerificationRounds) return { plan, verification: prior, rounds: round };
  }
  throw new Error("Verification loop ended without a Verifier receipt.");
};

const run = async ({ harness, input, log }: {
  harness: FlueHarness;
  input: CoderJobInput;
  log: FlueLogger;
}): Promise<CoderResult> => {
  const { github: resolveGithub, workspacesRoot, registry } = getCoderRuntime();
  const repo = parseGitHubRepository(input.repository, (value) => new Error(`Coder repository must be owner/repo, got ${value}`));
  const github = await resolveGithub(repo);
  const jobId = crypto.randomUUID();
  const isContinuation = input.mode === "review_continuation";
  // A review_continuation run is keyed by the live PR it repairs; the underlying issue, branch, and
  // consumed budget all come from the coding-job registry (never the caller). Being registered is
  // the safety key — a row exists only for a Coder-authored PR on its own branch, so an external or
  // fork-headed PR is never resolvable here. Defense in depth: the ingress already gates on this.
  let job: CodingJobRecord | undefined;
  if (isContinuation) {
    if (registry === undefined) throw new Error("review_continuation requires a coding-job registry");
    job = registry.get(input.repository, input.pullRequest!);
    if (job === undefined) {
      return {
        outcome: "no-op",
        jobId,
        summary: `Pull request #${input.pullRequest} is not registered to a coding job; no repair run.`,
        verificationRounds: 0,
        reviewCycle: 0,
      };
    }
  }
  const issueNumber = isContinuation ? job!.issue : input.issue!;
  const branch = isContinuation ? job!.branch : coderBranch(issueNumber);
  const reviewCycle = isContinuation ? job!.reviewCycle : 0;
  let activeStage: CodingStage = "workflow";
  const waypoint = (
    stage: CodingStage,
    status: "started" | "completed" | "failed",
    extra: { verificationRound?: number; verdict?: VerificationVerdict; pullRequest?: number; draft?: boolean } = {},
  ): void => {
    activeStage = status === "started" ? stage : "workflow";
    // Stream the meaningful stage transitions up to the Brain as work Milestones (§3.8, S3).
    // Start (accepted launch) and terminal (SpecialistResult) are streamed elsewhere; skip the
    // workflow bookends here and emit only the rare, human-legible stage beginnings and failures.
    if (input.brainWorkId !== undefined && stage !== "workflow" && (status === "started" || status === "failed")) {
      const round = extra.verificationRound;
      const note = `${stage}${round === undefined ? "" : ` (round ${round})`} ${status}`;
      try {
        tryGetDelegationRuntime()?.inbox.recordWorkMilestone({ workId: input.brainWorkId, note });
      } catch (cause) {
        log.info("work milestone write failed", { note, cause: String(cause) } as unknown as Record<string, unknown>);
      }
    }
    log.info(`${stage} ${status}`, codingWaypoint({
      jobId,
      mode: input.mode,
      stage,
      status,
      reviewCycle,
      maxReviewCycles: input.maxReviewCycles,
      maxVerificationRounds: input.maxVerificationRounds,
      ...extra,
    }) as unknown as Record<string, unknown>);
  };

  waypoint("workflow", "started");
  try {
    // Review continuation refetches the live PR and repairs the EXACT live Coder branch. The
    // fork/external guard is structural and hard: a fork-headed PR (head.repo differs), a PR whose
    // head branch is no longer the Coder branch, or a closed PR is never mutated — return blocked.
    let continuationFraming = "";
    // The PR base to publish against: the repo default for a new issue; the LIVE PR's actual base for
    // a review continuation, so a PR based off a non-default branch updates the right PR (finding 3).
    let continuationBase: string | undefined;
    // The exact head sha the continuation guard verified (headRef === branch, PR open). Seeding from
    // THIS — not a second getBranchHead re-fetch — closes a delete race by construction: if the branch
    // ref were deleted between the guard and a re-fetch, the fallback would silently seed from base and
    // overwrite the reviewed content instead of repairing it (round-4 finding).
    let continuationHeadSha: string | undefined;
    if (isContinuation) {
      const live = await fetchReviewContinuation(github, repo, input.pullRequest!);
      const expectedHeadRepo = `${repo.owner}/${repo.repo}`.toLowerCase();
      const forkHeaded = live.headRepoFull !== undefined && live.headRepoFull.toLowerCase() !== expectedHeadRepo;
      if (live.state !== "open" || forkHeaded || live.headRef !== branch) {
        waypoint("workflow", "completed");
        return {
          outcome: "blocked",
          branch,
          jobId,
          summary:
            `Pull request #${input.pullRequest} head is not the live Coder branch (${branch}); ` +
            "refusing to mutate an external, fork-headed, moved, or closed pull request.",
          verificationRounds: 0,
          reviewCycle,
        };
      }
      continuationBase = live.baseRef;
      continuationHeadSha = live.headSha;
      continuationFraming = renderReviewContinuation(live);
    }
    const issue = await fetchIssue(github, repo, issueNumber);
    const base = continuationBase ?? (await fetchDefaultBranch(github, repo));
    // Continuation seeds from the verified live head; a fresh issue checks the branch, seeding from it
    // if it exists, else from the base ref (fetched only when actually needed).
    const existingBranchHead = continuationHeadSha ?? (await getBranchHead(github, repo, branch));
    const seedBranchHead =
      existingBranchHead ??
      (await github.git.getRef({ owner: repo.owner, repo: repo.repo, ref: `heads/${base}` })).data.object.sha;
    const tarball = await downloadTarball(github, repo, seedBranchHead);
    const repoDir = `${workspacesRoot}/issue-${issueNumber}`;
    const shellIn = async (command: string) => await harness.shell(command, { cwd: repoDir, timeoutMs: SHELL_TIMEOUT_MS });

    try {
      await harness.fs.rm(repoDir, { recursive: true, force: true });
      await harness.fs.mkdir(repoDir, { recursive: true });
      await harness.fs.writeFile(`${repoDir}/.coder-source.tar.gz`, tarball);
      await harness.shell(`tar xzf ${repoDir}/.coder-source.tar.gz -C ${repoDir} --strip-components=1`, { timeoutMs: SHELL_TIMEOUT_MS });
      await harness.fs.rm(`${repoDir}/.coder-source.tar.gz`, { force: true });

      const gitignoreText = (await shellIn("cat .gitignore 2>/dev/null || true")).stdout;
      const isIgnored = gitignoreMatcher(gitignoreText);
      const snapshot = async () => await snapshotWorkspace(async (command) => await harness.shell(command, { cwd: repoDir }), isIgnored);
      const before = await snapshot();
      const session = await harness.session("coordinator");
      const requesterFraming = input.instructions === undefined ? "" : `\n\nExtra framing from the requester:\n${input.instructions}`;
      const framing = `${requesterFraming}${continuationFraming}`;
      const graphContext = renderGraphContext(input.graphContext);
      const coordinated = await runInternalCodingLoop({
        session,
        plannerPrompt: plannerTaskPrompt({
          issue: issueNumber,
          title: issue.title,
          body: issue.body,
          repository: input.repository,
          repoDir,
          framing,
          graphContext,
        }),
        coderPrompt: (round, plan, prior) => coderTaskPrompt({ issue: issueNumber, title: issue.title, repoDir, round, plan, priorVerification: prior }),
        verifierPrompt: (round, plan) => verifierTaskPrompt({ issue: issueNumber, title: issue.title, repoDir, round, plan }),
        cwd: repoDir,
        maxVerificationRounds: input.maxVerificationRounds,
        waypoint,
      });

      const requiredDraft = coordinated.verification.verdict === "FAIL" || coordinated.verification.verdict === "BLOCKED";
      const record: { pr?: OpenPrRecord } = {};
      const openPullRequest = createOpenPullRequestTool({
        github,
        repo,
        branch,
        base,
        seedBranchHead,
        seedBranchExisted: existingBranchHead !== undefined,
        issue: issueNumber,
        issueTitle: issue.title,
        before,
        requiredDraft,
        snapshotAfter: snapshot,
        readFile: (path) => harness.fs.readFileBuffer(`${repoDir}/${path}`),
        record,
      });

      waypoint("publication", "started", { draft: requiredDraft });
      await session.task(publicationTaskPrompt({
        issue: issueNumber,
        title: issue.title,
        plan: coordinated.plan,
        verification: coordinated.verification,
        draft: requiredDraft,
      }), {
        agent: "coder",
        cwd: repoDir,
        tools: [openPullRequest],
      });
      waypoint("publication", "completed", { pullRequest: record.pr?.number, draft: record.pr?.draft ?? requiredDraft });

      // Register (or refresh) the PR→job journey so a later Reviewer REQUEST_CHANGES can find the
      // issue, branch, and budgets to repair against. Idempotent and cycle-preserving: a
      // review_continuation republish refreshes the same row without resetting the consumed budget.
      if (record.pr !== undefined) {
        registry?.upsert({
          repository: input.repository,
          prNumber: record.pr.number,
          issue: issueNumber,
          branch,
          base,
          maxVerificationRounds: input.maxVerificationRounds,
          maxReviewCycles: input.maxReviewCycles,
        });
      }

      const result = coderOutcome(record.pr, {
        issue: issueNumber,
        branch,
        jobId,
        finalVerdict: coordinated.verification.verdict,
        verificationRounds: coordinated.rounds,
        reviewCycle,
      });
      waypoint("workflow", "completed", { pullRequest: result.prNumber, draft: result.draft });
      return result;
    } finally {
      await harness.fs.rm(repoDir, { recursive: true, force: true }).catch(() => {});
    }
  } catch (error) {
    const failedStage = activeStage;
    waypoint(failedStage, "failed");
    if (failedStage !== "workflow") waypoint("workflow", "failed");
    throw error;
  }
};

export const coder = defineWorkflow({
  agent: coderAgent,
  input: coderJobInputSchema,
  output: coderResultSchema,
  run,
});

export const START_CODER_JOB_DESCRIPTION =
  "Start a background coding workflow for one GitHub issue: Planner produces an ordered plan, Coder implements it, " +
  "Verifier drives the result within a bounded budget, and Coder opens one rich ready or draft pull request. Returns " +
  "immediately with a stable Brain work id and Flue run id; the finished result returns to the global Brain.";

export const coderSpecialistSpec: SpecialistSpec<typeof coderJobRequestSchema> = {
  name: "coder",
  toolName: "start_coder_job",
  description: START_CODER_JOB_DESCRIPTION,
  input: coderJobRequestSchema,
  workflow: coder,
};
