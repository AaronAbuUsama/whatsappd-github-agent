import { defineTool } from "eve/tools";
import { z } from "zod";
import { getOctokit, resolveRepo } from "../lib/github.ts";

/** Default character budget for the returned diff, to keep model context bounded. */
const MAX_DIFF = 60_000;

export default defineTool({
  description:
    "Fetch the unified diff of a pull request, for actual code review. Returns the raw patch " +
    "plus a per-file summary (status, additions, deletions). Large diffs are truncated to a " +
    "character budget — pull specific files with github_get_file_contents when you need more.",
  inputSchema: z.object({
    owner: z.string().optional().describe("Repo owner/org. Defaults to GITHUB_REPO."),
    repo: z.string().optional().describe("Repo name. Defaults to GITHUB_REPO."),
    pull_number: z.number().int().positive().describe("The pull request number."),
    max_chars: z
      .number()
      .int()
      .positive()
      .max(200_000)
      .optional()
      .describe(`Truncate the diff to this many characters (default ${MAX_DIFF}).`),
  }),
  async execute(input) {
    const { owner, repo } = resolveRepo(input);
    const octokit = getOctokit();

    const { data: files } = await octokit.rest.pulls.listFiles({
      owner,
      repo,
      pull_number: input.pull_number,
      per_page: 100,
    });
    const fileSummary = files.map((f) => ({
      filename: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
    }));

    // The diff media type makes GitHub return the raw patch as the response body;
    // Octokit still types `data` as the PR object, hence the cast.
    const { data } = await octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: input.pull_number,
      mediaType: { format: "diff" },
    });
    const raw = data as unknown as string;
    const limit = input.max_chars ?? MAX_DIFF;
    const truncated = raw.length > limit;

    return {
      pull_number: input.pull_number,
      changedFiles: fileSummary.length,
      files: fileSummary,
      truncated,
      diff: truncated ? `${raw.slice(0, limit)}\n... [truncated ${raw.length - limit} chars]` : raw,
    };
  },
});
