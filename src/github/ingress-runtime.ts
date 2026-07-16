import type { GitHubWebhookDelivery } from "@flue/github";
import type { DispatchReceipt } from "@flue/runtime";

import { createGitHubIngress, type GitHubIngressResult, type GitHubIngressSettings } from "./ingress.js";
import { createGitHubIngressStore, type GitHubIngressStore } from "./ingress-store.js";
import type { GitHubIssueOpenedInput } from "../ambience/events.js";

type GitHubIngressHandler = (delivery: GitHubWebhookDelivery) => Promise<GitHubIngressResult>;

const GITHUB_INGRESS_HANDLER = Symbol.for("ambient-agent.github-ingress-handler");
const ingressGlobal = globalThis as typeof globalThis & { [GITHUB_INGRESS_HANDLER]?: GitHubIngressHandler };

const configureGitHubIngressRuntime = (handler: GitHubIngressHandler): void => {
  ingressGlobal[GITHUB_INGRESS_HANDLER] = handler;
};

export const installGitHubIngressRuntime = (
  settings: GitHubIngressSettings,
  dispatch: (chatId: string, input: GitHubIssueOpenedInput) => Promise<DispatchReceipt>,
): GitHubIngressStore => {
  const store = createGitHubIngressStore(settings.databasePath);
  configureGitHubIngressRuntime(
    createGitHubIngress({
      store,
      routes: settings.routes,
      dispatch,
    }),
  );
  return store;
};

export const handleGitHubDelivery = (delivery: GitHubWebhookDelivery): Promise<GitHubIngressResult> => {
  const handler = ingressGlobal[GITHUB_INGRESS_HANDLER];
  if (handler === undefined) throw new Error("GitHub ingress runtime is not configured");
  return handler(delivery);
};
