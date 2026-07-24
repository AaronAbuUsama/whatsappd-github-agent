import type { SandboxFactory } from "@flue/runtime";
import type { GitHubRepositoryRef } from "@ambient-agent/engine/github/repository.ts";
import { createFlueGlobal } from "@ambient-agent/engine/shared/flue-global.ts";
import type { ReviewerGitHub } from "./github.ts";

export interface ReviewerRuntime {
  // Resolves the Octokit under the reviewer App identity for a job's repository owner
  // (multi-org: one client per installation, resolved once per job).
  readonly github: (repo: GitHubRepositoryRef) => Promise<ReviewerGitHub>;
  readonly sandbox: SandboxFactory;
  readonly workspacesRoot: string;
}

const runtimeSlot = createFlueGlobal<ReviewerRuntime>(
  "reviewer-runtime",
  "Reviewer runtime is not configured (the reviewer GitHub App and sandbox binding are unset).",
);

export const configureReviewerRuntime = (runtime: ReviewerRuntime): void => runtimeSlot.set(runtime);
export const getReviewerRuntime = (): ReviewerRuntime => runtimeSlot.get();
export const reviewerRuntimeConfigured = (): boolean => runtimeSlot.peek() !== undefined;
