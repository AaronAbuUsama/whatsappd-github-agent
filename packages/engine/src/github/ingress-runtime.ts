import type { GitHubWebhookDelivery } from "@flue/github";
import type { DispatchReceipt } from "@flue/runtime";

import type { GitHubIngressInput } from "../inputs.ts";
import type { IssueOperationStore } from "./operation-store.ts";
import { createGitHubIngress, type GitHubIngressResult, type GitHubIngressSettings } from "./ingress.ts";
import { createGitHubIngressStore, type GitHubIngressStore } from "./ingress-store.ts";
import { createFlueGlobal } from "../shared/flue-global.ts";

type GitHubIngressHandler = (delivery: GitHubWebhookDelivery) => Promise<GitHubIngressResult>;

const ingressHandler = createFlueGlobal<GitHubIngressHandler>(
  "github-ingress-handler",
  "GitHub ingress runtime is not configured",
);

export const installGitHubIngressRuntime = (
  settings: GitHubIngressSettings,
  dispatch: (chatId: string, input: GitHubIngressInput) => Promise<DispatchReceipt>,
  operations: IssueOperationStore,
): GitHubIngressStore => {
  const store = createGitHubIngressStore(settings.databasePath);
  ingressHandler.set(
    createGitHubIngress({
      store,
      managedChats: settings.managedChats,
      dispatch,
      operations,
    }),
  );
  return store;
};

export const handleGitHubDelivery = (delivery: GitHubWebhookDelivery): Promise<GitHubIngressResult> =>
  ingressHandler.get()(delivery);
