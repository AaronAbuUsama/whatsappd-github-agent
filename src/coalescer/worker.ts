/**
 * The Worker (Agent 2, "the hands") — Rung 2b, in-process.
 *
 * Runs the GitHub agent's brain WITHOUT the Eve runtime: it reuses `agent/`'s
 * exact tools and instructions (imported unchanged) driven by ai@7 `streamText`,
 * the same seam the voice uses. The GitHub tools are env-based (`GITHUB_TOKEN`)
 * and ignore the Eve `ToolContext`, so a plain object satisfies their second arg
 * — no Eve session needed. This sits behind the `Worker` port, so it swaps in for
 * the stub with zero change to the voice or Coalescer, and a future `eve/client`
 * version (for Eve durability) swaps in exactly the same way.
 *
 * Model via the shared subscription-only policy. Requires a
 * Codex login plus `GITHUB_TOKEN` + `GITHUB_REPO` (writes gated to
 * `GITHUB_ALLOWED_REPOS`).
 */
import { readFileSync } from "node:fs";
import { Effect, Layer } from "effect";
import { stepCountIs, streamText, tool } from "ai";
import { subscriptionModelSettings } from "../model/subscription.ts";
import { Worker, WorkerError } from "./ports.ts";
// agent/ GitHub tools — reused unchanged (imported, never modified).
import addLabels from "../../agent/tools/github_add_labels.ts";
import assign from "../../agent/tools/github_assign.ts";
import closeIssue from "../../agent/tools/github_close_issue.ts";
import commentOnIssue from "../../agent/tools/github_comment_on_issue.ts";
import createIssue from "../../agent/tools/github_create_issue.ts";
import getFileContents from "../../agent/tools/github_get_file_contents.ts";
import getIssue from "../../agent/tools/github_get_issue.ts";
import getPullRequest from "../../agent/tools/github_get_pull_request.ts";
import getPullRequestDiff from "../../agent/tools/github_get_pull_request_diff.ts";
import listIssues from "../../agent/tools/github_list_issues.ts";
import listPullRequests from "../../agent/tools/github_list_pull_requests.ts";
import reviewPullRequest from "../../agent/tools/github_review_pull_request.ts";
import searchCode from "../../agent/tools/github_search_code.ts";

// Adapt an Eve `defineTool` to an AI-SDK tool. Same `{ description, inputSchema }`;
// the only gap is `execute(input, ctx)` vs AI-SDK's `execute(input, opts)` — our
// tools ignore ctx (verified: 0/13 use it), so a bare object stands in for it.
// `any` at the param: Eve's ToolDefinition is invariant on its input type, so the
// 13 concrete tools don't share one nameable type — this is a boundary adapter and
// each tool self-validates via its zod inputSchema at runtime.
//
// We also DROP empty-string args: the model sometimes fills optional owner/repo with
// "", and agent/'s resolveRepo does `input.owner ?? fallback` — which keeps "" (only
// null/undefined fall back). Stripping "" lets the configured default repo win.
// biome-ignore lint/suspicious/noExplicitAny: bridging two tool-typing systems at the boundary.
const adapt = (t: any) =>
  tool({
    description: t.description as string,
    inputSchema: t.inputSchema,
    execute: (input: Record<string, unknown>) => {
      const cleaned = Object.fromEntries(Object.entries(input ?? {}).filter(([, v]) => v !== ""));
      return t.execute(cleaned, {});
    },
  });

const TOOLS = {
  github_add_labels: adapt(addLabels),
  github_assign: adapt(assign),
  github_close_issue: adapt(closeIssue),
  github_comment_on_issue: adapt(commentOnIssue),
  github_create_issue: adapt(createIssue),
  github_get_file_contents: adapt(getFileContents),
  github_get_issue: adapt(getIssue),
  github_get_pull_request: adapt(getPullRequest),
  github_get_pull_request_diff: adapt(getPullRequestDiff),
  github_list_issues: adapt(listIssues),
  github_list_pull_requests: adapt(listPullRequests),
  github_review_pull_request: adapt(reviewPullRequest),
  github_search_code: adapt(searchCode),
};

// agent/'s instructions, plus one soft note steering the model to the default repo.
const INSTRUCTIONS = `${readFileSync(new URL("../../agent/instructions.md", import.meta.url), "utf8")}

## Repository
A default repository is preconfigured. Only specify a repository when the user
explicitly names a different one; otherwise leave it unspecified.`;

export const githubWorker: Layer.Layer<Worker> = Layer.effect(
  Worker,
  Effect.gen(function* () {
    const modelSettings = subscriptionModelSettings();
    return {
      delegate: (task) =>
        Effect.tryPromise({
          try: async (signal) => {
            console.log(`🛠️  worker → ${task.instruction}`);
            let streamError: unknown;
            const result = streamText({
              ...modelSettings,
              system: INSTRUCTIONS,
              prompt: task.instruction,
              tools: TOOLS,
              stopWhen: stepCountIs(12),
              abortSignal: signal,
              onError: ({ error }) => {
                streamError = error;
              },
            });
            await result.consumeStream({ onError: () => {} });
            if (streamError !== undefined) throw streamError;
            const summary = (await result.text) || "done.";
            console.log(`✅ worker done → ${summary.slice(0, 300)}`);
            return { summary };
          },
          catch: (cause) => new WorkerError({ cause }),
        }),
    };
  }),
);
