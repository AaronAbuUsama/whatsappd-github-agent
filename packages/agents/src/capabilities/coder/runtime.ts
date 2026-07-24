import type { SandboxFactory } from "@flue/runtime";

import type { GitHubRepositoryRef } from "@ambient-agent/engine/github/repository.ts";
import { createFlueGlobal } from "@ambient-agent/engine/shared/flue-global.ts";
import type { CoderGitHub } from "./github.ts";
import type { CodingJobRegistry } from "./registry.ts";

/**
 * The Coder's deployment bindings, configured once at the composition root — never
 * per-job (MEMORY-STATE-SPEC §8, template rule 1). `sandbox` is the config-bound full
 * sandbox (`local()` on the single-owner VPS, a remote container in SaaS); the
 * capability only ever names the `SandboxFactory` interface. `github` resolves the Octokit
 * under the coder App identity for a job's repository owner (multi-org: one client per
 * installation, resolved once per job). `workspacesRoot` is `~/.ambient-agent/workspaces`;
 * the model owns the implement→test loop, so there is no conductor attempt count.
 */
export interface CoderRuntime {
  readonly github: (repo: GitHubRepositoryRef) => Promise<CoderGitHub>;
  readonly sandbox: SandboxFactory;
  readonly workspacesRoot: string;
  /**
   * #211: the coding-job registry. Present in production; a `review_continuation` run and the
   * PR-journey record both require it, but `new_issue` runs stay functional without it (the
   * legacy delegation tests configure no registry), so it is optional at the boundary.
   */
  readonly registry?: CodingJobRegistry;
  /**
   * #211 finding 1: the configured Reviewer App's slug (e.g. "ambient-reviewer"). The repair tool
   * verifies the triggering review was authored by `<slug>[bot]` before acting. Absent when the
   * Reviewer App is unprovisioned — repair then fails closed (it cannot authorize any review).
   */
  readonly reviewerAppSlug?: string;
  /**
   * #211 round-4: the Coder App's own slug, so the over-budget lifecycle comment is matched only when
   * authored by `<slug>[bot]` — a human comment that quotes the marker is never edited. Best-effort at
   * boot; absent → the comment scan degrades to any Bot-authored marker match.
   */
  readonly coderAppSlug?: string;
}

const runtimeSlot = createFlueGlobal<CoderRuntime>(
  "coder-runtime",
  "Coder runtime is not configured (the coder GitHub App and sandbox binding are unset).",
);

export const configureCoderRuntime = (runtime: CoderRuntime): void => runtimeSlot.set(runtime);
export const getCoderRuntime = (): CoderRuntime => runtimeSlot.get();
