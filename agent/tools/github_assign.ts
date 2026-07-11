import { defineTool } from "eve/tools";
import { z } from "zod";
import { getOctokit, resolveWritableRepo } from "../lib/github.ts";

export default defineTool({
  description:
    "Assign and/or unassign GitHub users on an issue or pull request. Pass `add` to assign " +
    "and/or `remove` to unassign; at least one is required. Usernames GitHub can't assign " +
    "(non-collaborators) are silently ignored by the API. Returns the resulting assignees.",
  inputSchema: z.object({
    owner: z.string().optional().describe("Repo owner/org. Defaults to GITHUB_REPO."),
    repo: z.string().optional().describe("Repo name. Defaults to GITHUB_REPO."),
    issue_number: z.number().int().positive().describe("The issue or PR number."),
    add: z.array(z.string().min(1)).optional().describe("GitHub usernames to assign."),
    remove: z.array(z.string().min(1)).optional().describe("GitHub usernames to unassign."),
  }),
  async execute(input) {
    if (!input.add?.length && !input.remove?.length) {
      throw new Error("Provide at least one of `add` or `remove`.");
    }
    const { owner, repo } = resolveWritableRepo(input);
    const octokit = getOctokit();

    // Remove first so an add of the same run wins if a name appears in both.
    let issue: { assignees?: ({ login: string } | null)[] | null } | undefined;
    if (input.remove?.length) {
      issue = (
        await octokit.rest.issues.removeAssignees({
          owner,
          repo,
          issue_number: input.issue_number,
          assignees: input.remove,
        })
      ).data;
    }
    if (input.add?.length) {
      issue = (
        await octokit.rest.issues.addAssignees({
          owner,
          repo,
          issue_number: input.issue_number,
          assignees: input.add,
        })
      ).data;
    }
    return {
      issue_number: input.issue_number,
      assignees: (issue?.assignees ?? []).flatMap((a) => (a ? [a.login] : [])),
    };
  },
});
