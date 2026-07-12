import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { githubResultSchema } from "../../agent/subagents/github/lib/output-schema.ts";

const repoPath = (rel: string) => fileURLToPath(new URL(`../../${rel}`, import.meta.url));

describe("github subagent — outputSchema shape", () => {
  it("accepts a full typed result", () => {
    const parsed = githubResultSchema.parse({
      action: "create_issue",
      number: 42,
      url: "https://github.com/acme/widgets/issues/42",
      summary: "Filed #42 for the login crash.",
    });
    expect(parsed).toEqual({
      action: "create_issue",
      number: 42,
      url: "https://github.com/acme/widgets/issues/42",
      summary: "Filed #42 for the login crash.",
    });
  });

  it("makes number and url optional", () => {
    const parsed = githubResultSchema.parse({ action: "none", summary: "Nothing to do here." });
    expect(parsed).toEqual({ action: "none", summary: "Nothing to do here." });
    expect(parsed.number).toBeUndefined();
    expect(parsed.url).toBeUndefined();
  });

  it("requires action and summary", () => {
    expect(githubResultSchema.safeParse({ summary: "no action" }).success).toBe(false);
    expect(githubResultSchema.safeParse({ action: "create_issue" }).success).toBe(false);
    expect(githubResultSchema.safeParse({ action: "create_issue", summary: "" }).success).toBe(false);
  });

  it("constrains action to the known verbs", () => {
    expect(githubResultSchema.safeParse({ action: "delete_everything", summary: "nope" }).success).toBe(false);
  });

  it("rejects a malformed number or url", () => {
    expect(
      githubResultSchema.safeParse({ action: "get_issue", number: -3, summary: "bad number" }).success,
    ).toBe(false);
    expect(
      githubResultSchema.safeParse({ action: "get_issue", number: 1.5, summary: "not an int" }).success,
    ).toBe(false);
    expect(
      githubResultSchema.safeParse({ action: "get_issue", url: "not-a-url", summary: "bad url" }).success,
    ).toBe(false);
  });

  it("strips unknown keys (closed shape for the voice)", () => {
    const withExtra: Record<string, unknown> = { action: "comment", summary: "Commented.", secret: "leak" };
    const parsed = githubResultSchema.parse(withExtra);
    expect(parsed).not.toHaveProperty("secret");
  });
});

describe("github subagent — carries its own GitHub-triage prompt", () => {
  const sub = readFileSync(repoPath("agent/subagents/github/instructions.md"), "utf8");

  it("is the GitHub Concierge triage prompt", () => {
    expect(sub).toMatch(/GitHub Concierge/);
    expect(sub).toMatch(/triage/i);
  });

  // The root/voice prompt owns the `say` tool + ambient-chatter judgment (#6).
  // The worker has no `say` tool and returns structured output, so its prompt
  // must NOT carry the voice-only instructions — this guards against anyone
  // re-syncing the worker to the (now different) root prompt.
  it("does not carry the voice-only `say` / ambient instructions", () => {
    expect(sub).not.toMatch(/`say`/);
    expect(sub).not.toMatch(/ambient/i);
  });
});

describe("github subagent — reuses the 13 tools unchanged", () => {
  const toolNames = [
    "github_add_labels",
    "github_assign",
    "github_close_issue",
    "github_comment_on_issue",
    "github_create_issue",
    "github_get_file_contents",
    "github_get_issue",
    "github_get_pull_request",
    "github_get_pull_request_diff",
    "github_list_issues",
    "github_list_pull_requests",
    "github_review_pull_request",
    "github_search_code",
  ];

  it("declares all 13 tools", () => {
    expect(toolNames).toHaveLength(13);
  });

  it.each(toolNames)("%s re-exports the root tool (same instance, no rewrite)", async (name) => {
    const rootTool = (await import(`../../agent/tools/${name}.ts`)).default;
    const subTool = (await import(`../../agent/subagents/github/tools/${name}.ts`)).default;
    expect(subTool).toBe(rootTool);
  });
});
