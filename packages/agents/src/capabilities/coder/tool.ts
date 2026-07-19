import { defineTool, type ToolDefinition } from "@flue/runtime";
import * as v from "valibot";

import type { GitHubRepositoryRef } from "@ambient-agent/engine/github/repository.ts";

import type { CoderGitHub } from "./github.ts";
import { commitChanges, ensureBranch, upsertPullRequest } from "./github.ts";
import { diffSnapshots, ensureClosesIssue, isEmptyDiff, type OpenPrRecord, type WorkspaceSnapshot } from "./workspace.ts";

const nonEmpty = v.pipe(v.string(), v.trim(), v.minLength(1));

/**
 * Everything the `open_pull_request` handler needs, bound per run so the model call carries
 * no plumbing: the GitHub seam, the per-issue branch keys, and the workspace context
 * (the before-snapshot, an after-snapshot taken at call time, and how to read a changed
 * file's bytes). `record` is the conductor's out-parameter — the handler stamps it so the
 * light after-check sees the PR without a second GitHub round-trip.
 */
export interface OpenPullRequestContext {
  readonly github: CoderGitHub;
  readonly repo: GitHubRepositoryRef;
  readonly branch: string;
  readonly base: string;
  readonly seedBranchHead: string;
  readonly seedBranchExisted: boolean;
  readonly issue: number;
  readonly issueTitle: string;
  readonly before: WorkspaceSnapshot;
  readonly verified: WorkspaceSnapshot;
  readonly requiredDraft: boolean;
  readonly snapshotAfter: () => Promise<WorkspaceSnapshot>;
  readonly readFile: (path: string) => Promise<Uint8Array>;
  readonly record: { pr?: OpenPrRecord };
}

/**
 * The model's one safe write to the outside world. The model calls it with a title, a rich
 * Markdown body (its own creative artifact — never templated), and `draft` = its own
 * green/red judgment; the HANDLER does the deterministic, idempotent plumbing where the
 * safety lives: snapshot → diff against the seed (honoring `.gitignore`, already baked into
 * the snapshots) → commit via the Git Data API → check-then-act on the per-issue branch →
 * one PR per `head→base` (reuse if open). Relaunch converges rather than duplicating.
 *
 * No `git` CLI anywhere — Octokit only (§8 template rule 2).
 */
export const createOpenPullRequestTool = (ctx: OpenPullRequestContext): ToolDefinition =>
  defineTool({
    name: "open_pull_request",
    description:
      "Open the pull request for the issue you are implementing. Call this once, when your work is complete: supply a " +
      "title and a rich Markdown body (narrative, structured sections, mermaid diagrams all welcome), and use the " +
      "required `draft` value stated in your publication task. Your verified workspace " +
      "changes are committed and the pull request is opened for you; calling it again for the same issue converges on " +
      "the same branch and pull request rather than duplicating them.",
    input: v.object({
      title: nonEmpty,
      body: nonEmpty,
      draft: v.boolean(),
    }),
    output: v.object({
      opened: v.boolean(),
      url: v.optional(v.string()),
      number: v.optional(v.number()),
      draft: v.optional(v.boolean()),
      message: v.optional(v.string()),
    }),
    run: async ({ input }) => {
      if (input.draft !== ctx.requiredDraft) {
        throw new Error(`Final verification requires draft=${String(ctx.requiredDraft)}.`);
      }
      const after = await ctx.snapshotAfter();
      if (!isEmptyDiff(diffSnapshots(ctx.verified, after))) {
        throw new Error("Workspace changed after the final Verifier observation; start a new verified run before publishing.");
      }
      const diff = diffSnapshots(ctx.before, after);
      const empty = isEmptyDiff(diff);
      if (empty && !ctx.seedBranchExisted) {
        return {
          opened: false,
          message:
            "No file changes detected in the workspace — make your edits before opening a pull request.",
        };
      }

      const head = await ensureBranch(ctx.github, ctx.repo, ctx.branch, ctx.seedBranchHead);
      if (head.sha !== ctx.seedBranchHead) {
        throw new Error("Coder branch moved after this run was seeded; start a new verified run before publishing.");
      }
      if (!empty) {
        await commitChanges(ctx.github, ctx.repo, {
          branch: ctx.branch,
          headSha: head.sha,
          message: `Coder: issue #${ctx.issue} — ${ctx.issueTitle}`.slice(0, 72),
          files: diff.changed.map((path) => ({ path })),
          deletions: diff.deleted,
          read: ctx.readFile,
        });
      }
      // Handler plumbing (never templating): guarantee the load-bearing `Closes #N` so a
      // merged PR auto-closes its issue and the ingress backstop correlates the webhook.
      const body = ensureClosesIssue(input.body, ctx.issue);
      const pr = await upsertPullRequest(ctx.github, ctx.repo, {
        branch: ctx.branch,
        base: ctx.base,
        title: input.title,
        body,
        draft: input.draft,
      });
      // Report the PR's ACTUAL draft state (fresh → input.draft; reused → the existing PR's
      // real isDraft), never a blind stamp of input.draft — an honest state beats a lie.
      ctx.record.pr = { url: pr.url, number: pr.number, created: pr.created, draft: pr.draft };
      return { opened: true, url: pr.url, number: pr.number, draft: pr.draft };
    },
  });
