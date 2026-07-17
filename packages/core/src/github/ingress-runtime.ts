import type { GitHubWebhookDelivery } from "@flue/github";
import type { DispatchReceipt } from "@flue/runtime";

import type { GitHubIngressInput } from "../ambience/events.js";
import type { IssueOperationStore } from "../capabilities/issue-management/operation-store.js";
import { createGitHubIngress, type GitHubIngressResult, type GitHubIngressSettings } from "./ingress.js";
import { createGitHubIngressStore, type GitHubIngressStore } from "./ingress-store.js";

type GitHubIngressHandler = (delivery: GitHubWebhookDelivery) => Promise<GitHubIngressResult>;

const GITHUB_INGRESS_HANDLER = Symbol.for("ambient-agent.github-ingress-handler");
const ingressGlobal = globalThis as typeof globalThis & { [GITHUB_INGRESS_HANDLER]?: GitHubIngressHandler };

const configureGitHubIngressRuntime = (handler: GitHubIngressHandler): void => {
  ingressGlobal[GITHUB_INGRESS_HANDLER] = handler;
};

export const installGitHubIngressRuntime = (
  settings: GitHubIngressSettings,
  dispatch: (chatId: string, input: GitHubIngressInput) => Promise<DispatchReceipt>,
  operations: IssueOperationStore,
): GitHubIngressStore => {
  const store = createGitHubIngressStore(settings.databasePath);
  configureGitHubIngressRuntime(
    createGitHubIngress({
      store,
      routes: settings.routes,
      dispatch,
      operations,
    }),
  );
  return store;
};

export const handleGitHubDelivery = (delivery: GitHubWebhookDelivery): Promise<GitHubIngressResult> => {
  const handler = ingressGlobal[GITHUB_INGRESS_HANDLER];
  if (handler === undefined) throw new Error("GitHub ingress runtime is not configured");
  return handler(delivery);
};
