import { expect } from "vitest";
import { describeEval, toolCalls } from "vitest-evals";

import { createFlueAgentHarness } from "./harness.ts";

const harness = createFlueAgentHarness({ agentName: "ambience" });
const window = (text: string): string => `WhatsApp Window for the current managed chat:\nAlice: ${text}`;
const issueSkillCalls = (calls: ReturnType<typeof toolCalls>) =>
  calls.filter((call) => call.name === "activate_skill" && JSON.stringify(call.arguments).includes("issue-management"));

describeEval(
  "Issue Management live model",
  { harness, skipIf: () => process.env.AMBIENCE_EVAL_LIVE_MODEL !== "true" },
  (it) => {
    it("files one complete bug report", async ({ run }) => {
      const result = await run({
        message: window(
          "Please file this bug. After restart, a queued scheduler job disappears instead of running. I can reproduce it by queueing a job, stopping the process, and starting it again; the expected result is that the queued job runs.",
        ),
        fixture: { resetGitHub: true, resetWhatsApp: true },
      });
      const calls = toolCalls(result);
      expect(issueSkillCalls(calls)).toHaveLength(1);
      const creates = calls.filter((call) => call.name === "github_create_issue");
      expect(creates).toHaveLength(1);
      expect(creates[0]).toMatchObject({ status: "ok", result: { status: "created" } });
      expect(creates[0]?.arguments).toMatchObject({ kind: "bug" });
      const report = JSON.stringify(creates[0]?.arguments).toLowerCase();
      expect(report).toContain("restart");
      expect(report).toContain("queue");
      expect(report).toContain("expected");
      expect(result.output.githubEvents.filter((event) => (event as { kind?: string }).kind === "create")).toHaveLength(
        1,
      );
      expect(result.output.githubOperations).toContainEqual(expect.objectContaining({ status: "completed" }));
    });

    it("files one complete feature request with audience and motivation", async ({ run }) => {
      const result = await run({
        message: window(
          "Please request a feature: show queue depth in the status command. Operators need it so they can diagnose backpressure before jobs start timing out.",
        ),
        fixture: { resetGitHub: true, resetWhatsApp: true },
      });
      const calls = toolCalls(result);
      expect(issueSkillCalls(calls)).toHaveLength(1);
      const creates = calls.filter((call) => call.name === "github_create_issue");
      expect(creates).toHaveLength(1);
      expect(creates[0]).toMatchObject({ status: "ok", result: { status: "created" } });
      expect(creates[0]?.arguments).toMatchObject({ kind: "feature" });
      const request = JSON.stringify(creates[0]?.arguments).toLowerCase();
      expect(request).toContain("queue depth");
      expect(request).toContain("operator");
      expect(request).toMatch(/diagnos|backpressure/);
      expect(result.output.githubEvents.filter((event) => (event as { kind?: string }).kind === "create")).toHaveLength(
        1,
      );
      expect(result.output.githubOperations).toContainEqual(expect.objectContaining({ status: "completed" }));
    });

    it("corrects and organizes an existing issue, then acknowledges it once", async ({ run }) => {
      const title = "Scheduler loses queued jobs after restart";
      const body = "Expected queued jobs to run after restart. Observed that they disappear.";
      const result = await run({
        message: window(
          `Please correct issue #1. Set the title exactly to "${title}". Set the body exactly to "${body}". Replace its labels with exactly "bug" and "priority: high", assign exactly "maintainer", set milestone #3, and tell the group once it is done.`,
        ),
        fixture: {
          resetGitHub: true,
          resetWhatsApp: true,
          githubOptions: {
            labels: ["bug", "priority: high"],
            assignees: ["maintainer"],
            milestones: [{ number: 3, title: "Stable base", state: "open" }],
          },
          githubIssues: [{ title: "Schedular looses jobs", body: "Restart is bad.", labels: ["bug"] }],
        },
      });
      const calls = toolCalls(result);
      expect(issueSkillCalls(calls)).toHaveLength(1);
      const updates = calls.filter((call) => call.name === "github_update_issue");
      expect(updates).toHaveLength(1);
      expect(updates[0]).toMatchObject({
        status: "ok",
        arguments: { number: 1, title, body, assignees: ["maintainer"], milestone: 3 },
        result: {
          status: "updated",
          issue: {
            number: 1,
            title,
            body,
            assignees: ["maintainer"],
            milestone: { number: 3, title: "Stable base", state: "open" },
          },
        },
      });
      expect((updates[0]?.arguments as { labels?: string[] }).labels).toEqual(["bug", "priority: high"]);
      expect(
        (updates[0] as { result?: { issue?: { labels?: string[] } } } | undefined)?.result?.issue?.labels,
      ).toEqual(["bug", "priority: high"]);
      const acknowledgements = calls.filter((call) => call.name === "say");
      expect(acknowledgements).toHaveLength(1);
      const acknowledgement = JSON.stringify(acknowledgements[0]?.arguments).toLowerCase();
      expect(acknowledgement).toContain("#1");
      expect(acknowledgement).toMatch(/correct|updated/);
      expect(acknowledgement).toMatch(/title|scheduler loses queued jobs/);
      expect(acknowledgement).not.toMatch(/clos|reopen|comment|delet/);
      expect(result.output.githubEvents.filter((event) => (event as { kind?: string }).kind === "update")).toHaveLength(
        1,
      );
      expect(result.output.githubOperations).toContainEqual(
        expect.objectContaining({ kind: "update-issue", issueNumber: 1, status: "completed" }),
      );
    });

    it("asks one focused question for an incomplete report before any GitHub mutation", async ({ run }) => {
      const result = await run({
        message: window("Please file a bug: the scheduler is broken."),
        fixture: { resetGitHub: true, resetWhatsApp: true },
      });
      const calls = toolCalls(result);
      expect(issueSkillCalls(calls)).toHaveLength(1);
      expect(calls.filter((call) => call.name === "github_create_issue")).toHaveLength(0);
      expect(calls.filter((call) => call.name === "say")).toHaveLength(1);
      expect(result.output.githubEvents).toEqual([]);
    });

    it("finds related work and does not duplicate it", async ({ run }) => {
      const title = "Queued scheduler job disappears after restart";
      const result = await run({
        message: window(
          `Please check whether this is already tracked and do not create a duplicate: ${title}. The queued job should run after restart.`,
        ),
        fixture: {
          resetGitHub: true,
          resetWhatsApp: true,
          githubIssues: [{ title, body: "Existing report with reproduction details." }],
        },
      });
      const calls = toolCalls(result);
      expect(issueSkillCalls(calls)).toHaveLength(1);
      expect(result.output.githubEvents.some((event) => (event as { kind?: string }).kind === "search")).toBe(true);
      expect(result.output.githubEvents.filter((event) => (event as { kind?: string }).kind === "create")).toHaveLength(
        0,
      );
    });
  },
);
