import type { SandboxFactory } from "@flue/runtime";

import type { GitHubRepositoryRef } from "@ambient-agent/engine/github/repository.ts";
import { createFlueGlobal } from "@ambient-agent/engine/shared/flue-global.ts";
import type { CoderGitHub } from "./github.ts";

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
}

const runtimeSlot = createFlueGlobal<CoderRuntime>(
  "coder-runtime",
  "Coder runtime is not configured (the coder GitHub App and sandbox binding are unset).",
);

export const configureCoderRuntime = (runtime: CoderRuntime): void => runtimeSlot.set(runtime);
export const getCoderRuntime = (): CoderRuntime => runtimeSlot.get();
