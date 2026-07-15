import type { GitHubWebhookDelivery } from "@flue/github";
import type { DispatchReceipt } from "@flue/runtime";

import { createGitHubIngress, type GitHubIngressResult, type GitHubIngressSettings } from "./ingress.js";
import { createGitHubIngressStore, type GitHubIngressStore } from "./ingress-store.js";
import type { GitHubIssueOpenedInput } from "../ambience/events.js";

type GitHubIngressHandler = (delivery: GitHubWebhookDelivery) => Promise<GitHubIngressResult>;

let configured: GitHubIngressHandler | undefined;

const configureGitHubIngressRuntime = (handler: GitHubIngressHandler): void => {
  configured = handler;
};

export const installGitHubIngressRuntime = (
  settings: GitHubIngressSettings,
  dispatch: (chatId: string, input: GitHubIssueOpenedInput) => Promise<DispatchReceipt>,
): GitHubIngressStore => {
  const store = createGitHubIngressStore(settings.databasePath, undefined, settings.legacyDatabasePath);
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
  if (!configured) throw new Error("GitHub ingress runtime is not configured");
  return configured(delivery);
};
