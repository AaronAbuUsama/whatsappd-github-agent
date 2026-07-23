import type { GitHubEventDraft } from "../brain/inbox.ts";
import { createFlueGlobal } from "../shared/flue-global.ts";

/** The Brain up-inbox admission receipt for one GitHub event (§4). */
export interface GitHubUpInboxAdmission {
  readonly id: string;
  readonly admittedAt: string;
}

/** The configured admission function, once the Brain inbox exists. Always yields a receipt. */
export type GitHubUpInboxAdmit = (event: GitHubEventDraft) => Promise<GitHubUpInboxAdmission>;

/**
 * What the ingress accepts. `undefined` means the up-inbox port is not wired yet (the boot window
 * between the webhook route going live and the Brain inbox being created) — the ingress must then
 * DEFER the delivery for provider redelivery, never drop it (§10 — No silent drop).
 */
export type GitHubIngressAdmit = (event: GitHubEventDraft) => Promise<GitHubUpInboxAdmission | undefined>;

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
// Returns undefined (rather than throwing) when unconfigured, so an early delivery defers and retries.
export const admitGitHubEventToBrain: GitHubIngressAdmit = (event) => {
  const admit = port.peek();
  return admit === undefined ? Promise.resolve(undefined) : admit(event);
};
