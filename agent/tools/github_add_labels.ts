import { defineTool } from "eve/tools";
import { z } from "zod";
import { getOctokit, resolveWritableRepo } from "../lib/github.ts";

export default defineTool({
  description:
    "Add one or more labels to a GitHub issue or pull request (PRs are issues to the labels " +
    "API). Use for triage from chat — e.g. tagging 'bug', 'p1', 'needs-repro'. Returns the " +
    "issue's full label set after the change.",
  inputSchema: z.object({
    owner: z.string().optional().describe("Repo owner/org. Defaults to GITHUB_REPO."),
    repo: z.string().optional().describe("Repo name. Defaults to GITHUB_REPO."),
    issue_number: z.number().int().positive().describe("The issue or PR number."),
    labels: z.array(z.string().min(1)).min(1).describe("Label names to add."),
  }),
  async execute(input) {
    const { owner, repo } = resolveWritableRepo(input);
    const octokit = getOctokit();
    const { data } = await octokit.rest.issues.addLabels({
      owner,
      repo,
      issue_number: input.issue_number,
      labels: input.labels,
    });
    return {
      issue_number: input.issue_number,
      labels: data.map((label) => (typeof label === "string" ? label : label.name)),
    };
  },
});
