import type { GitHubEventDraft } from "../brain/inbox.ts";
import { createFlueGlobal } from "../shared/flue-global.ts";

/** The Brain up-inbox admission receipt for one GitHub event (§4). */
export interface GitHubUpInboxAdmission {
  readonly id: string;
  readonly admittedAt: string;
}

export type GitHubUpInboxAdmit = (event: GitHubEventDraft) => Promise<GitHubUpInboxAdmission>;

/**
 * The seam the GitHub ingress uses to hand an event to the single Brain up-inbox. The runtime
 * configures it once the Brain inbox exists; the ingress is composed earlier, so it resolves
 * lazily — the same pattern as the Brain Effects runtime.
 */
const port = createFlueGlobal<GitHubUpInboxAdmit>(
  "github-up-inbox",
  "GitHub up-inbox admission is not configured",
);

export const configureGitHubUpInbox = (admit: GitHubUpInboxAdmit): void => port.set(admit);
export const admitGitHubEventToBrain: GitHubUpInboxAdmit = (event) => port.get()(event);
