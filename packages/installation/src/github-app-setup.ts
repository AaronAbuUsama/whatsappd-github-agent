import { GITHUB_APP_REFERENCES, type GitHubAppReference } from "./schema.ts";

/**
 * Recommended App name — a setup convention only. The operator may org-prefix it to dodge
 * global App-name uniqueness, and code hardcodes no name: every bot login is derived at
 * runtime from `apps.getAuthenticated()` (#135). One distinct avatar per App is recommended.
 */
const RECOMMENDED_NAME: Readonly<Record<GitHubAppReference, string>> = {
  coder: "Ambient Coder",
  reviewer: "Ambient Reviewer",
  planner: "Ambient Planner",
};

/** The least-privilege permission set each App needs for its Specialist domain. */
const PERMISSIONS: Readonly<Record<GitHubAppReference, readonly string[]>> = {
  coder: ["Contents: read & write", "Pull requests: read & write", "Issues: read", "Metadata: read"],
  reviewer: ["Pull requests: read & write", "Contents: read", "Metadata: read"],
  // The Planner file is also the Speaker's issue-filing identity.
  planner: ["Issues: read & write", "Pull requests: read", "Metadata: read"],
};

export const recommendedGitHubAppName = (reference: GitHubAppReference): string => RECOMMENDED_NAME[reference];

/**
 * The per-App operator checklist for guided-paste setup and rotation: exact permissions,
 * "download a private key", "install on owner/repo", and where to copy the App ID and
 * Installation ID from. Fully headless — no redirect, no listener.
 */
export const githubAppSetupChecklist = (reference: GitHubAppReference, repository: string): string =>
  [
    `GitHub App ${GITHUB_APP_REFERENCES.indexOf(reference) + 1} of ${GITHUB_APP_REFERENCES.length} — the ${reference} identity (recommended name "${RECOMMENDED_NAME[reference]}"):`,
    `  1. Create a GitHub App at https://github.com/settings/apps/new (org owners may prefix the name to keep it globally unique).`,
    `  2. Grant exactly these repository permissions: ${PERMISSIONS[reference].join(", ")}.`,
    ...(reference === "planner"
      ? [
          `  3. Enable the webhook and subscribe to exactly these events: Issues, Issue comment, Pull request, Pull request review.`,
        ]
      : []),
    `  ${reference === "planner" ? 4 : 3}. Generate a private key and download the .pem file.`,
    `  ${reference === "planner" ? 5 : 4}. Install the App on ${repository} and open the installation settings.`,
    `  ${reference === "planner" ? 6 : 5}. Copy the App ID (App settings) and the Installation ID (the number in the installation settings URL), then enter them below with the path to the .pem file.`,
  ].join("\n");
