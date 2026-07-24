import type { GitHubEventDraft } from "../brain/inbox.ts";
import { createFlueGlobal } from "../shared/flue-global.ts";

/** The Brain up-inbox admission receipt for one GitHub event (§4). */
export interface GitHubUpInboxAdmission {
  readonly id: string;
  readonly admittedAt: string;
}

/**
 * What the ingress accepts (and what the runtime configures). `undefined` means the delivery must
 * DEFER for provider redelivery, never drop (§10 — No silent drop). The runtime returns undefined in
 * two cases: the up-inbox port is not wired yet (boot window), or the owning runtime has torn down
 * (its Brain inbox handle is finalized). A live runtime always yields a receipt.
 */
export type GitHubIngressAdmit = (event: GitHubEventDraft) => Promise<GitHubUpInboxAdmission | undefined>;

/**
 * The seam the GitHub ingress uses to hand an event to the single Brain up-inbox. The runtime
 * configures it once the Brain inbox exists; the ingress is composed earlier, so it resolves
 * lazily — the same pattern as the Brain Effects runtime.
 */
const port = createFlueGlobal<GitHubIngressAdmit>(
  "github-up-inbox",
  "GitHub up-inbox admission is not configured",
);

export const configureGitHubUpInbox = (admit: GitHubIngressAdmit): void => port.set(admit);
// Returns undefined (rather than throwing) when unconfigured, so an early delivery defers and retries.
export const admitGitHubEventToBrain: GitHubIngressAdmit = (event) => {
  const admit = port.peek();
  return admit === undefined ? Promise.resolve(undefined) : admit(event);
};
