/**
 * The typed result the GitHub worker returns to the voice in task mode.
 *
 * The voice orchestrator never sees the worker's tool calls or chat — only this
 * structured payload (see `DECISION-SPEC.md` §2a G2). Keep it narrow and
 * narratable: `action` says *what* happened, `number`/`url` point at the
 * concrete issue/PR when there is one, and `summary` is the one-or-two-sentence
 * line the voice can speak back to the group.
 */
import { z } from "zod";

/**
 * High-level action the worker performed — a coarse result vocabulary over the
 * 13 `github_*` tools (PR-diff reads fold into `get_pr`/`review_pr`), plus
 * `none`/`error` so the child always has a valid slot.
 */
export const githubAction = z.enum([
  "create_issue",
  "get_issue",
  "close_issue",
  "comment",
  "label",
  "assign",
  "list_issues",
  "review_pr",
  "get_pr",
  "list_prs",
  "get_file",
  "search_code",
  "none",
  "error",
]);

export const githubResultSchema = z.object({
  action: githubAction.describe("What the worker did, e.g. create_issue, review_pr, none."),
  number: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("The issue or PR number involved, when the action concerns one."),
  url: z
    .string()
    .url()
    .optional()
    .describe("Canonical GitHub URL for the issue/PR/review, when there is one."),
  summary: z
    .string()
    .min(1)
    .describe("One or two sentences the voice can narrate back to the group chat."),
});

export type GithubResult = z.infer<typeof githubResultSchema>;
