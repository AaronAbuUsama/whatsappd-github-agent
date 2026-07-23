import { defineAgent, defineTool, defineWorkflow, type FlueHarness, type FlueLogger } from "@flue/runtime";
import * as v from "valibot";

import { resolveAgentModelProfile } from "@ambient-agent/engine/model/pi-subscription.ts";
import { parseGitHubRepository } from "@ambient-agent/engine/github/repository.ts";
import reviewerSkill from "./SKILL.md" with { type: "skill" };
import { archiveBytes, findReviewForHead, listChangedFiles, missingVerdictReviewEvent, renderReviewSubmission, reviewEvent, reviewerHeadMarker, reviewerLogin, validInlineLocations } from "./github.ts";
import { getReviewerRuntime } from "./runtime.ts";
import { reviewFindingSchema, reviewerJobInputSchema, reviewerResultSchema, type ReviewerJobInput, type ReviewerResult } from "./schemas.ts";

const SHELL_TIMEOUT_MS = 20 * 60 * 1000;
const reviewerSubmissions = new Map<string, Promise<ReviewerResult>>();

export const singleSubmission = <T>(): ((effect: () => Promise<T>) => Promise<T>) => {
  let submission: Promise<T> | undefined;
  return (effect) => {
    if (submission !== undefined) return submission;
    const attempt = effect().catch((cause) => {
      if (submission === attempt) submission = undefined;
      throw cause;
    });
    submission = attempt;
    return attempt;
  };
};

export const serializeReviewerSubmission = (
  key: string,
  effect: () => Promise<ReviewerResult>,
): Promise<ReviewerResult> => {
  const existing = reviewerSubmissions.get(key);
  if (existing !== undefined) return existing;
  const submission = effect().finally(() => {
    if (reviewerSubmissions.get(key) === submission) reviewerSubmissions.delete(key);
  });
  reviewerSubmissions.set(key, submission);
  return submission;
};

export const reviewerExerciseCommand = (): string => [
  "if [ -f pnpm-lock.yaml ]; then corepack pnpm install --frozen-lockfile && corepack pnpm run --if-present typecheck && corepack pnpm test",
  "elif [ -f package-lock.json ]; then npm ci && npm run typecheck --if-present && npm test",
  "elif [ -f yarn.lock ]; then corepack yarn install --immutable && (if node -e \"process.exit(require('./package.json').scripts?.typecheck ? 0 : 1)\"; then corepack yarn run typecheck; fi) && corepack yarn test",
  "elif [ -f pyproject.toml ]; then python -m pip install . && python -m pytest",
  "elif [ -f go.mod ]; then go test ./...",
  "elif [ -f Cargo.toml ]; then cargo test",
  "else echo 'No supported repository exercise contract found' >&2; exit 2; fi",
].join("\n");

const reviewerAgent = defineAgent(() => ({
  // #208 has one policy profile for verification/review work; Reviewer reuses it.
  ...resolveAgentModelProfile("verifier"),
  sandbox: getReviewerRuntime().sandbox,
  skills: [reviewerSkill],
  instructions: "You are Reviewer, an independent finite pull-request reviewer. Judge only; never repair or merge.",
}));

const runChecks = async (harness: FlueHarness, cwd: string): Promise<{ passed: boolean; output: string }> => {
  const result = await harness.shell(reviewerExerciseCommand(), { cwd, timeoutMs: SHELL_TIMEOUT_MS });
  return { passed: result.exitCode === 0, output: `${result.stdout}\n${result.stderr}`.slice(-12_000) };
};

const run = async ({ harness, input, log }: { harness: FlueHarness; input: ReviewerJobInput; log: FlueLogger }): Promise<ReviewerResult> => {
  const { github: resolveGithub, workspacesRoot } = getReviewerRuntime();
  const repo = parseGitHubRepository(input.repository, (value) => new Error(`Reviewer repository must be owner/repo, got ${value}`));
  const github = await resolveGithub(repo);
  log.info("reviewer.fetching-live-head", { repository: input.repository, pullRequest: input.pullRequest });
  const { data: pr } = await github.pulls.get({ owner: repo.owner, repo: repo.repo, pull_number: input.pullRequest });
  if (pr.state !== "open" || pr.draft || pr.head.sha !== input.expectedHeadSha) {
    return { status: "blocked", prNumber: pr.number, headSha: pr.head.sha, summary: "Review skipped because the admitted pull-request head is no longer the live eligible head." };
  }
  const login = await reviewerLogin(github);
  const existing = await findReviewForHead(github, repo, pr.number, pr.head.sha, login);
  if (existing !== undefined) {
    return { status: "commented", reviewUrl: existing.html_url, prNumber: pr.number, headSha: pr.head.sha, summary: "This Reviewer App already reviewed the live pull-request head." };
  }

  const workspace = `${workspacesRoot}/review-${pr.number}-${pr.head.sha.slice(0, 12)}`;
  try {
    await harness.fs.rm(workspace, { recursive: true, force: true });
    await harness.fs.mkdir(workspace, { recursive: true });
    await harness.fs.writeFile(`${workspace}/.review-source.tar.gz`, archiveBytes((await github.repos.downloadTarballArchive({ owner: repo.owner, repo: repo.repo, ref: pr.head.sha })).data));
    await harness.shell(`tar xzf ${workspace}/.review-source.tar.gz -C ${workspace} --strip-components=1`, { timeoutMs: SHELL_TIMEOUT_MS });
    await harness.fs.rm(`${workspace}/.review-source.tar.gz`, { force: true });

    log.info("reviewer.exercising-repository", { repository: input.repository, pullRequest: pr.number, headSha: pr.head.sha });
    const checks = await runChecks(harness, workspace);
    const files = await listChangedFiles(github, repo, pr.number);
    const inlineLocations = validInlineLocations(files);
    let submitted: ReviewerResult | undefined;
    let missingModelVerdict = false;
    const submitOnce = singleSubmission<ReviewerResult>();
    const submitReview = defineTool({
      name: "submit_review",
      description: "Submit the one formal review for this exact pull-request head.",
      input: v.object({
        summary: v.pipe(v.string(), v.trim(), v.minLength(1)),
        findings: v.optional(v.array(reviewFindingSchema), []),
      }),
      output: reviewerResultSchema,
      run: async ({ input: decision }) => {
        return await submitOnce(async () => await serializeReviewerSubmission(`${repo.owner}/${repo.repo}#${pr.number}@${pr.head.sha}:${login}`, async () => {
          const live = await github.pulls.get({ owner: repo.owner, repo: repo.repo, pull_number: pr.number });
          if (live.data.state !== "open" || live.data.draft || live.data.head.sha !== pr.head.sha) {
            submitted = { status: "blocked", prNumber: pr.number, headSha: live.data.head.sha, summary: "Review not submitted because the pull-request head changed during review." };
            return submitted;
          }
          const alreadySubmitted = await findReviewForHead(github, repo, pr.number, pr.head.sha, login);
          if (alreadySubmitted !== undefined) {
            submitted = { status: "commented", reviewUrl: alreadySubmitted.html_url, prNumber: pr.number, headSha: pr.head.sha, summary: "This Reviewer App already reviewed the live pull-request head." };
            return submitted;
          }
          const event = missingModelVerdict ? missingVerdictReviewEvent(checks.passed) : reviewEvent(checks.passed, decision.findings);
          const rendered = renderReviewSubmission(decision.summary, checks.passed, decision.findings, inlineLocations);
          const review = await github.pulls.createReview({
            owner: repo.owner,
            repo: repo.repo,
            pull_number: pr.number,
            commit_id: pr.head.sha,
            event,
            body: `${rendered.body}\n\n${reviewerHeadMarker(pr.head.sha)}`,
            ...(rendered.comments.length === 0 ? {} : { comments: rendered.comments }),
          });
          submitted = {
            status: event === "APPROVE" ? "approved" : event === "COMMENT" ? "commented" : "changes-requested",
            reviewUrl: review.data.html_url,
            prNumber: pr.number,
            headSha: pr.head.sha,
            verdict: event,
            summary: rendered.body,
          };
          return submitted;
        }));
      },
    });
    log.info("reviewer.judging-diff", { repository: input.repository, pullRequest: pr.number, headSha: pr.head.sha });
    await (await harness.session()).prompt(
      `Review PR #${pr.number}: ${pr.title}\n\n${pr.body ?? ""}\n\nBase ${pr.base.sha}; exact checked-out head ${pr.head.sha}.\n` +
        `Repository exercise ${checks.passed ? "PASSED" : "FAILED"}:\n${checks.output}\n\nChanged files and patches:\n` +
        files.map((file) => `--- ${file.filename}\n${file.patch ?? "(patch unavailable; inspect the workspace)"}`).join("\n") +
        `\n\nInspect the full repository at ${workspace}, judge the change in context, then call submit_review exactly once.`,
      { tools: [submitReview] },
    );
    if (submitted !== undefined) return submitted;
    // The workflow contract promises one formal review even if the model fails to call
    // its sole effect. Fall back conservatively; never turn silence into approval.
    missingModelVerdict = true;
    return await submitReview.run({
      input: {
        summary: checks.passed
          ? "Automated review completed without a model verdict; manual review is required."
          : "Repository exercise failed; changes are required before approval.",
        findings: [],
      },
    } as never) as ReviewerResult;
  } finally {
    await harness.fs.rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
};

export const reviewer = defineWorkflow({ agent: reviewerAgent, input: reviewerJobInputSchema, output: reviewerResultSchema, run });
