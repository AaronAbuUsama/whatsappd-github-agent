import type { GitHubRepositoryRef } from "@ambient-agent/engine/github/repository.ts";

/**
 * The narrow Octokit surface the Coder actually touches — tarball in (`repos`), the
 * issue body (`issues`), and the Git Data API out (`git`, `pulls`). Structural like
 * `GitHubAppAccessClient` (apps/cli setup): production passes the real
 * `githubAppClient(coderCredential)` cast to this; tests pass `vi.fn()` mocks. This is
 * the whole GitHub surface — no `git` CLI anywhere (§8 template rule 2).
 */
export interface CoderGitHub {
  graphql<T>(query: string, variables: Record<string, unknown>): Promise<T>;
  readonly repos: {
    get(input: { owner: string; repo: string }): Promise<{ data: { default_branch: string } }>;
    downloadTarballArchive(input: { owner: string; repo: string; ref: string }): Promise<{ data: unknown }>;
  };
  readonly issues: {
    get(input: {
      owner: string;
      repo: string;
      issue_number: number;
    }): Promise<{ data: { title: string; body?: string | null } }>;
    // #211: PR-level lifecycle comments are issue comments; the over-budget notice is upserted on
    // a hidden marker so redelivery/retry updates the one comment instead of duplicating it.
    listComments(input: { owner: string; repo: string; issue_number: number; per_page: number; page: number }): Promise<{
      data: ReadonlyArray<{ id: number; body?: string | null; user?: { login?: string; type?: string } | null }>;
    }>;
    createComment(input: { owner: string; repo: string; issue_number: number; body: string }): Promise<{
      data: { id: number; html_url: string };
    }>;
    updateComment(input: { owner: string; repo: string; comment_id: number; body: string }): Promise<{ data: unknown }>;
  };
  readonly git: {
    getRef(input: { owner: string; repo: string; ref: string }): Promise<{ data: { object: { sha: string } } }>;
    createRef(input: { owner: string; repo: string; ref: string; sha: string }): Promise<{ data: { ref: string } }>;
    updateRef(input: {
      owner: string;
      repo: string;
      ref: string;
      sha: string;
      force?: boolean;
    }): Promise<{ data: unknown }>;
    getCommit(input: {
      owner: string;
      repo: string;
      commit_sha: string;
    }): Promise<{ data: { tree: { sha: string } } }>;
    createBlob(input: {
      owner: string;
      repo: string;
      content: string;
      encoding: "base64";
    }): Promise<{ data: { sha: string } }>;
    createTree(input: {
      owner: string;
      repo: string;
      base_tree: string;
      tree: readonly TreeEntry[];
    }): Promise<{ data: { sha: string } }>;
    createCommit(input: {
      owner: string;
      repo: string;
      message: string;
      tree: string;
      parents: readonly string[];
    }): Promise<{ data: { sha: string } }>;
  };
  readonly pulls: {
    list(input: {
      owner: string;
      repo: string;
      head: string;
      base: string;
      state: "open";
    }): Promise<{ data: ReadonlyArray<{ number: number; node_id?: string; html_url: string; draft?: boolean }> }>;
    create(input: {
      owner: string;
      repo: string;
      title: string;
      head: string;
      base: string;
      body: string;
      draft: boolean;
    }): Promise<{ data: { number: number; node_id?: string; html_url: string } }>;
    update(input: {
      owner: string;
      repo: string;
      pull_number: number;
      title: string;
      body: string;
    }): Promise<{ data: unknown }>;
    // #211 review continuation: the live PR head, branch ref, and head-repo identity — the
    // structural fork/external guard (a fork's head.repo.full_name differs) and the exact live
    // branch to repair. `node_id` is the GraphQL id for the draft-conversion mutation.
    get(input: { owner: string; repo: string; pull_number: number }): Promise<{
      data: {
        number: number;
        node_id?: string;
        html_url: string;
        title: string;
        body?: string | null;
        draft?: boolean;
        state: string;
        head: { sha: string; ref: string; repo: { full_name?: string } | null };
        base: { ref: string };
      };
    }>;
    // #211 finding 1: independently re-fetch the triggering review so the tool can verify, in trusted
    // code, that it was a REQUEST_CHANGES authored by the configured Reviewer App — the model may not
    // be trusted to assert the review's state or author.
    getReview(input: { owner: string; repo: string; pull_number: number; review_id: number }): Promise<{
      data: { state: string; user: { login: string } | null };
    }>;
  };
}

export interface TreeEntry {
  readonly path: string;
  readonly mode: "100644" | "100755";
  readonly type: "blob";
  readonly sha: string | null; // null deletes the path from base_tree
}

const HTTP_NOT_FOUND = 404;
const isNotFound = (cause: unknown): boolean =>
  typeof cause === "object" && cause !== null && "status" in cause && (cause as { status?: unknown }).status === HTTP_NOT_FOUND;

/** The issue body the run() prompt is seeded from — deterministic context, not a model tool (§8). */
export const fetchIssue = async (
  gh: CoderGitHub,
  repo: GitHubRepositoryRef,
  issueNumber: number,
): Promise<{ title: string; body: string }> => {
  const { data } = await gh.issues.get({ owner: repo.owner, repo: repo.repo, issue_number: issueNumber });
  return { title: data.title, body: data.body ?? "" };
};

/** The repo's default branch — the PR base and the commit parent. */
export const fetchDefaultBranch = async (gh: CoderGitHub, repo: GitHubRepositoryRef): Promise<string> => {
  const { data } = await gh.repos.get({ owner: repo.owner, repo: repo.repo });
  return data.default_branch;
};

/** The tree seed: the tarball archive of `ref`, as raw bytes to stage into the workspace. */
export const downloadTarball = async (
  gh: CoderGitHub,
  repo: GitHubRepositoryRef,
  ref: string,
): Promise<Uint8Array> => {
  const { data } = await gh.repos.downloadTarballArchive({ owner: repo.owner, repo: repo.repo, ref });
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (data instanceof Uint8Array) return data;
  throw new Error("downloadTarballArchive did not return archive bytes.");
};

/**
 * The head sha of the per-issue branch if it already exists, else undefined (a fresh
 * issue). Read-only check-then-act primitive: a relaunch reads the existing head so it
 * can seed the workspace tarball FROM that head and commit against the same tree (the
 * tested tree and the committed tree are then identical — no unvalidated combination).
 */
export const getBranchHead = async (
  gh: CoderGitHub,
  repo: GitHubRepositoryRef,
  branch: string,
): Promise<string | undefined> => {
  try {
    const { data } = await gh.git.getRef({ owner: repo.owner, repo: repo.repo, ref: `heads/${branch}` });
    return data.object.sha;
  } catch (cause) {
    if (isNotFound(cause)) return undefined;
    throw cause;
  }
};

/**
 * Idempotent branch (§8 principle 3): check-then-act on the natural key
 * `agent/coder/issue-<N>`. Returns the branch head sha and whether we created it, so a
 * relaunch converges on the same branch rather than duplicating.
 */
export const ensureBranch = async (
  gh: CoderGitHub,
  repo: GitHubRepositoryRef,
  branch: string,
  fromSha: string,
): Promise<{ sha: string; created: boolean }> => {
  const existing = await getBranchHead(gh, repo, branch);
  if (existing !== undefined) return { sha: existing, created: false };
  await gh.git.createRef({ owner: repo.owner, repo: repo.repo, ref: `refs/heads/${branch}`, sha: fromSha });
  return { sha: fromSha, created: true };
};

/** The branch name for an issue — the per-issue natural key that makes relaunch converge. */
export const coderBranch = (issueNumber: number): string => `agent/coder/issue-${issueNumber}`;

/**
 * Commit the workspace changes to `branch` via the Git Data API (blobs → tree →
 * commit → ref). `files` are the paths that changed (contents supplied by `read`) and
 * `deletions` the paths removed; an empty change set commits nothing and returns
 * undefined. Layered on the branch head, so successive relaunches stack commits.
 */
export const commitChanges = async (
  gh: CoderGitHub,
  repo: GitHubRepositoryRef,
  input: {
    branch: string;
    headSha: string;
    message: string;
    files: readonly { path: string; mode?: "100644" | "100755" }[];
    deletions?: readonly string[];
    read: (path: string) => Promise<Uint8Array>;
  },
): Promise<string | undefined> => {
  const deletions = input.deletions ?? [];
  if (input.files.length === 0 && deletions.length === 0) return undefined;

  const owner = repo.owner;
  const repository = repo.repo;
  const base = await gh.git.getCommit({ owner, repo: repository, commit_sha: input.headSha });

  const blobs: TreeEntry[] = await Promise.all(
    input.files.map(async (file) => {
      const bytes = await input.read(file.path);
      const { data } = await gh.git.createBlob({
        owner,
        repo: repository,
        content: Buffer.from(bytes).toString("base64"),
        encoding: "base64",
      });
      return { path: file.path, mode: file.mode ?? "100644", type: "blob", sha: data.sha } satisfies TreeEntry;
    }),
  );
  const removals: TreeEntry[] = deletions.map((path) => ({ path, mode: "100644", type: "blob", sha: null }));

  const tree = await gh.git.createTree({
    owner,
    repo: repository,
    base_tree: base.data.tree.sha,
    tree: [...blobs, ...removals],
  });
  const commit = await gh.git.createCommit({
    owner,
    repo: repository,
    message: input.message,
    tree: tree.data.sha,
    parents: [input.headSha],
  });
  await gh.git.updateRef({ owner, repo: repository, ref: `heads/${input.branch}`, sha: commit.data.sha });
  return commit.data.sha;
};

/**
 * Idempotent PR (§8 principle 3): one open PR per `head→base`, "update if open" (#172).
 * Lists open PRs for the head first; if one exists the new commits already rode the branch,
 * so reuse it (`created:false`) and PATCH its title + body with the model's fresh values
 * rather than opening a second or discarding them. The real draft lifecycle converges
 * through GitHub's GraphQL mutations; prose never stands in for ready/draft state.
 */
export const upsertPullRequest = async (
  gh: CoderGitHub,
  repo: GitHubRepositoryRef,
  input: { branch: string; base: string; title: string; body: string; draft: boolean; requireExisting?: number },
): Promise<{ number: number; url: string; created: boolean; draft: boolean; moved?: boolean }> => {
  const head = `${repo.owner}:${input.branch}`;
  const { data: open } = await gh.pulls.list({
    owner: repo.owner,
    repo: repo.repo,
    head,
    base: input.base,
    state: "open",
  });
  const existing = open[0];
  // #211: a review continuation must update its EXACT PR. If the open head→base PR is a different one
  // (the reviewed PR was closed and someone opened a new PR from the same branch), never mutate it —
  // fail closed, same as when no PR is found at all.
  if (input.requireExisting !== undefined && (existing === undefined || existing.number !== input.requireExisting)) {
    return { number: input.requireExisting, url: "", created: false, draft: input.draft, moved: true };
  }
  if (existing !== undefined) {
    await gh.pulls.update({
      owner: repo.owner,
      repo: repo.repo,
      pull_number: existing.number,
      title: input.title,
      body: input.body,
    });
    const currentDraft = existing.draft ?? false;
    if (currentDraft !== input.draft) {
      if (existing.node_id === undefined) throw new Error("Existing Coder pull request is missing its GraphQL node id.");
      await gh.graphql(
        input.draft
          ? "mutation ConvertPullRequestToDraft($pullRequestId: ID!) { convertPullRequestToDraft(input: { pullRequestId: $pullRequestId }) { pullRequest { isDraft } } }"
          : "mutation MarkPullRequestReadyForReview($pullRequestId: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $pullRequestId }) { pullRequest { isDraft } } }",
        { pullRequestId: existing.node_id },
      );
    }
    return { number: existing.number, url: existing.html_url, created: false, draft: input.draft };
  }
  // #211 fix: a review continuation must UPDATE the reviewed PR, never open a replacement. If it is no
  // longer an open head→base PR (a human closed it mid-run), fail closed — the commits already rode the
  // branch, but we open no new PR. The caller turns this into a `blocked` outcome.
  if (input.requireExisting !== undefined) {
    return { number: input.requireExisting, url: "", created: false, draft: input.draft, moved: true };
  }
  const { data } = await gh.pulls.create({
    owner: repo.owner,
    repo: repo.repo,
    title: input.title,
    head: input.branch,
    base: input.base,
    body: input.body,
    draft: input.draft,
  });
  return { number: data.number, url: data.html_url, created: true, draft: input.draft };
};
