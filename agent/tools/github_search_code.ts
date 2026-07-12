import { defineTool } from "eve/tools";
import { z } from "zod";
import { getOctokit, resolveRepo } from "../lib/github.ts";

export default defineTool({
  description:
    "Search code on GitHub with the code search query syntax (e.g. 'useEffect language:ts'). " +
    "Scoped to owner/repo when given, else to GITHUB_REPO unless the query already contains a " +
    "'repo:' qualifier — pass a bare query with an explicit 'repo:' (or 'org:') qualifier to " +
    "search outside the default repo.",
  inputSchema: z.object({
    q: z.string().min(1).describe("GitHub code search query."),
    owner: z.string().optional().describe("Scope to this repo owner/org (paired with `repo`)."),
    repo: z.string().optional().describe("Scope to this repo (paired with `owner`)."),
    per_page: z.number().int().min(1).max(50).optional().describe("Defaults to 10, max 50."),
  }),
  async execute(input) {
    let q = input.q;
    // An explicit `repo:`/`org:` qualifier in the query itself is the documented
    // escape hatch for searching outside the default repo — respect it as-is.
    // Otherwise scope to the resolved repo: this routes owner/repo through the
    // shared resolver, so placeholder/partial values are cleaned and it defaults
    // HARD to GITHUB_REPO (F4: no more `repo:GITHUB_REPO/GITHUB_REPO`).
    if (!/\brepo:|(^|\s)org:/i.test(q)) {
      const { owner, repo } = resolveRepo(input);
      q += ` repo:${owner}/${repo}`;
    }

    const octokit = getOctokit();
    const { data } = await octokit.rest.search.code({ q, per_page: input.per_page ?? 10 });
    return {
      totalCount: data.total_count,
      items: data.items.map((item) => ({
        path: item.path,
        repository: item.repository.full_name,
        url: item.html_url,
        sha: item.sha,
      })),
    };
  },
});
