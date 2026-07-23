import type { IssueOperationStore } from "./operation-store.ts";
import {
  createGitHubIngress,
  type GitHubIngressResult,
  type GitHubIngressSettings,
  type RoutedGitHubWebhookDelivery,
} from "./ingress.ts";
import { createGitHubIngressStore, type GitHubIngressStore } from "./ingress-store.ts";
import type { GitHubUpInboxAdmit } from "./up-inbox.ts";
import { createFlueGlobal } from "../shared/flue-global.ts";

type GitHubIngressHandler = (delivery: RoutedGitHubWebhookDelivery) => Promise<GitHubIngressResult>;

const ingressHandler = createFlueGlobal<GitHubIngressHandler>(
  "github-ingress-handler",
  "GitHub ingress runtime is not configured",
);

export const installGitHubIngressRuntime = (
  settings: GitHubIngressSettings,
  admit: GitHubUpInboxAdmit,
  operations: IssueOperationStore,
  review?: Parameters<typeof createGitHubIngress>[0]["review"],
): GitHubIngressStore => {
  const store = createGitHubIngressStore(settings.databasePath);
  ingressHandler.set(
    createGitHubIngress({
      store,
      admit,
      operations,
      review,
    }),
  );
  return store;
};

export const handleGitHubDelivery = (delivery: RoutedGitHubWebhookDelivery): Promise<GitHubIngressResult> =>
  ingressHandler.get()(delivery);
