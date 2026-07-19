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
import {
  coderJobInputSchema,
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
type CodingStage = "workflow" | "planner" | "coder" | "verifier" | "publication";
type CodingWaypointStatus = "started" | "completed" | "failed";
export interface CodingWaypoint {
  readonly event: "coding.waypoint";
  readonly schemaVersion: 1;
  readonly jobId: string;
  readonly mode: "new_issue";
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
  const { github, workspacesRoot } = getCoderRuntime();
  const repo = parseGitHubRepository(input.repository, (value) => new Error(`Coder repository must be owner/repo, got ${value}`));
  const branch = coderBranch(input.issue);
  const jobId = crypto.randomUUID();
  const reviewCycle = 0;
  let activeStage: CodingStage = "workflow";
  const waypoint = (
    stage: CodingStage,
    status: "started" | "completed" | "failed",
    extra: { verificationRound?: number; verdict?: VerificationVerdict; pullRequest?: number; draft?: boolean } = {},
  ): void => {
    activeStage = status === "started" ? stage : "workflow";
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
    const issue = await fetchIssue(github, repo, input.issue);
    const base = await fetchDefaultBranch(github, repo);
    const baseSha = (await github.git.getRef({ owner: repo.owner, repo: repo.repo, ref: `heads/${base}` })).data.object.sha;
    const existingBranchHead = await getBranchHead(github, repo, branch);
    const seedBranchHead = existingBranchHead ?? baseSha;
    const tarball = await downloadTarball(github, repo, seedBranchHead);
    const repoDir = `${workspacesRoot}/issue-${input.issue}`;
    const tmpDir = coderTmpDir(workspacesRoot);
    const shellIn = async (command: string) => await harness.shell(command, { cwd: repoDir, timeoutMs: SHELL_TIMEOUT_MS });

    try {
      await harness.fs.mkdir(tmpDir, { recursive: true });
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
      const framing = input.instructions === undefined ? "" : `\n\nExtra framing from the requester:\n${input.instructions}`;
      const graphContext = renderGraphContext(input.graphContext);
      const coordinated = await runInternalCodingLoop({
        session,
        plannerPrompt: plannerTaskPrompt({
          issue: input.issue,
          title: issue.title,
          body: issue.body,
          repository: input.repository,
          repoDir,
          framing,
          graphContext,
        }),
        coderPrompt: (round, plan, prior) => coderTaskPrompt({ issue: input.issue, title: issue.title, repoDir, round, plan, priorVerification: prior }),
        verifierPrompt: (round, plan) => verifierTaskPrompt({ issue: input.issue, title: issue.title, repoDir, round, plan }),
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
        issue: input.issue,
        issueTitle: issue.title,
        before,
        requiredDraft,
        snapshotAfter: snapshot,
        readFile: (path) => harness.fs.readFileBuffer(`${repoDir}/${path}`),
        record,
      });

      waypoint("publication", "started", { draft: requiredDraft });
      await session.task(publicationTaskPrompt({
        issue: input.issue,
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

      const result = coderOutcome(record.pr, {
        issue: input.issue,
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
  "immediately with a run id; the finished result reports back to this chat on its own.";

export const coderSpecialistSpec: SpecialistSpec<typeof coderJobInputSchema> = {
  name: "coder",
  toolName: "start_coder_job",
  description: START_CODER_JOB_DESCRIPTION,
  input: coderJobInputSchema,
  workflow: coder,
};
