import type { GitHubRepositoryRef } from "@ambient-agent/engine/github/repository.ts";
import type { ReviewFinding } from "./schemas.ts";

export interface ReviewerGitHub {
  readonly repos: {
    downloadTarballArchive(input: { owner: string; repo: string; ref: string }): Promise<{ data: unknown }>;
    getCollaboratorPermissionLevel(input: { owner: string; repo: string; username: string }): Promise<{
      data: { permission: string };
    }>;
  };
  readonly pulls: {
    get(input: { owner: string; repo: string; pull_number: number; mediaType?: { format: "diff" } }): Promise<{
      data: {
        number: number;
        html_url: string;
        title: string;
        body?: string | null;
        draft?: boolean;
        state: string;
        head: { sha: string };
        base: { sha: string };
      };
    }>;
    listFiles(input: { owner: string; repo: string; pull_number: number; per_page: 100; page: number }): Promise<{
      data: ReadonlyArray<{ filename: string; patch?: string }>;
    }>;
    listReviews(input: { owner: string; repo: string; pull_number: number; per_page: 100; page: number }): Promise<{
      data: ReadonlyArray<{ id: number; html_url: string; body?: string | null; commit_id?: string | null; user?: { login?: string } | null }>;
    }>;
    createReview(input: {
      owner: string;
      repo: string;
      pull_number: number;
      commit_id: string;
      event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
      body: string;
      comments?: ReadonlyArray<{ path: string; line: number; side: "RIGHT"; body: string }>;
    }): Promise<{ data: { id: number; html_url: string } }>;
  };
  readonly apps: {
    getAuthenticated(): Promise<{ data: { slug: string } }>;
  };
}

export const reviewEvent = (checksPassed: boolean, findings: readonly Pick<ReviewFinding, "blocking">[]) =>
  !checksPassed || findings.some(({ blocking }) => blocking)
    ? "REQUEST_CHANGES" as const
    : findings.length > 0
      ? "COMMENT" as const
      : "APPROVE" as const;

export const renderReviewFinding = (finding: ReviewFinding): string =>
  `**[${finding.severity}] ${finding.title}**\n\n${finding.body}`;

export const renderSummaryFinding = (finding: ReviewFinding): string =>
  `${renderReviewFinding(finding)}\n\nLocation: \`${finding.path}:${finding.line}\``;

export const renderReviewSubmission = (
  summary: string,
  checksPassed: boolean,
  findings: readonly ReviewFinding[],
  inlineLocations: ReadonlySet<string>,
) => {
  const inline = findings.filter((finding) => inlineLocations.has(`${finding.path}:${finding.line}`));
  const summaryOnly = findings.filter((finding) => !inlineLocations.has(`${finding.path}:${finding.line}`));
  return {
    body: [
      checksPassed ? summary : `${summary}\n\nRepository exercise failed; approval is unavailable until it is green.`,
      summaryOnly.length === 0
        ? ""
        : `### Findings without a valid diff line\n\n${summaryOnly.map(renderSummaryFinding).join("\n\n")}`,
    ].filter(Boolean).join("\n\n"),
    comments: inline.map((finding) => ({
      path: finding.path,
      line: finding.line,
      side: "RIGHT" as const,
      body: renderReviewFinding(finding),
    })),
  };
};

export const reviewerSlug = async (github: ReviewerGitHub): Promise<string> =>
  (await github.apps.getAuthenticated()).data.slug.toLowerCase();

export const reviewerLogin = async (github: ReviewerGitHub): Promise<string> =>
  `${await reviewerSlug(github)}[bot]`;

export const reviewerHeadMarker = (headSha: string): string =>
  `<!-- ambient-agent-review-head:${headSha} -->`;

export const findReviewForHead = async (
  github: ReviewerGitHub,
  repo: GitHubRepositoryRef,
  pullRequest: number,
  headSha: string,
  login: string,
) => {
  for (let page = 1; ; page += 1) {
    const { data } = await github.pulls.listReviews({
      owner: repo.owner,
      repo: repo.repo,
      pull_number: pullRequest,
      per_page: 100,
      page,
    });
    // GitHub may rewrite an older approval's reported commit_id to a later PR head.
    // The marker is the durable provider-side part of the App + PR + head key.
    const marker = reviewerHeadMarker(headSha);
    const match = data.find((review) => review.body?.includes(marker) && review.user?.login?.toLowerCase() === login);
    if (match !== undefined || data.length < 100) return match;
  }
};

export const listChangedFiles = async (github: ReviewerGitHub, repo: GitHubRepositoryRef, pullRequest: number) => {
  const files: Array<{ filename: string; patch?: string }> = [];
  for (let page = 1; ; page += 1) {
    const { data } = await github.pulls.listFiles({ owner: repo.owner, repo: repo.repo, pull_number: pullRequest, per_page: 100, page });
    files.push(...data);
    if (data.length < 100) return files;
  }
};

/** GitHub accepts RIGHT-side inline comments only on lines represented by the diff. */
export const validInlineLocations = (files: readonly { filename: string; patch?: string }[]) => {
  const locations = new Set<string>();
  for (const file of files) {
    let line = 0;
    for (const row of file.patch?.split("\n") ?? []) {
      const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/u.exec(row);
      if (hunk !== null) {
        line = Number(hunk[1]);
      } else if (row.startsWith("\\")) {
        continue;
      } else if (line > 0 && (row.startsWith("+") || row.startsWith(" "))) {
        locations.add(`${file.filename}:${line}`);
        line += 1;
      } else if (line > 0 && !row.startsWith("-")) {
        line += 1;
      }
    }
  }
  return locations;
};

export const archiveBytes = (data: unknown): Uint8Array => {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (data instanceof Uint8Array) return data;
  throw new Error("downloadTarballArchive did not return archive bytes.");
};
