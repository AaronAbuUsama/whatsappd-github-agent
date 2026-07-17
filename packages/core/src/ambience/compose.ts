import type { DispatchReceipt } from "@flue/runtime";
import { flue } from "@flue/runtime/routing";
import { Hono } from "hono";

import type { IssueRepository } from "../capabilities/issue-management/issue-repository.js";
import type { IssueOperationStore } from "../capabilities/issue-management/operation-store.js";
import {
  configureIssueManagementRuntime,
  type IssueManagementPolicy,
} from "../capabilities/issue-management/runtime.js";
import { configureWhatsAppParticipationPort } from "../capabilities/whatsapp-participation/whatsapp-port.js";
import type { WhatsAppParticipationPort } from "../capabilities/whatsapp-participation/whatsapp-port.js";
import { installGitHubIngressRuntime } from "../github/ingress-runtime.js";
import type { GitHubIngressStore } from "../github/ingress-store.js";
import type { GitHubIngressSettings } from "../github/ingress.js";
import type { GitHubIngressInput } from "./events.js";

export interface AmbienceIngressAdapters {
  readonly settings: GitHubIngressSettings;
  readonly dispatch: (chatId: string, input: GitHubIngressInput) => Promise<DispatchReceipt>;
}

/**
 * Adapters for the one Ambience composition root (T6, O1 ratified).
 *
 * Production passes real adapters (Octokit repository, SQLite stores) and wires its
 * WhatsApp participation port later inside `runWhatsAppSession`; the test fixture
 * passes fakes and wires its participation port here. The coalescer stack is
 * deliberately NOT part of this surface: production runs it in `runWhatsAppSession`
 * (src/host/whatsapp-runtime.ts) and the fixture keeps its own Effect fork with test
 * seams (injected failure, test debounce). O2 — folding the coalescer stack into this
 * composition — is explicitly deferred to the monorepo cut follow-up.
 */
export interface AmbienceAdapters {
  readonly issues: IssueRepository;
  readonly operations: IssueOperationStore;
  readonly policy: IssueManagementPolicy;
  readonly ingress: AmbienceIngressAdapters;
  readonly participation?: WhatsAppParticipationPort;
  /** Payload for GET /health; defaults to a static `{ ok: true }`. */
  readonly health?: () => Record<string, unknown>;
  /** Caller-owned routes (smoke route, /test seams), mounted before the Flue routes. */
  readonly routes?: (app: Hono, context: { readonly githubIngress: GitHubIngressStore }) => void;
}

export const composeAmbience = (adapters: AmbienceAdapters): Hono => {
  configureIssueManagementRuntime({
    repository: adapters.issues,
    operations: adapters.operations,
    policy: adapters.policy,
  });
  const githubIngress = installGitHubIngressRuntime(
    adapters.ingress.settings,
    adapters.ingress.dispatch,
    adapters.operations,
  );
  if (adapters.participation !== undefined) configureWhatsAppParticipationPort(adapters.participation);
  const app = new Hono();
  const health = adapters.health ?? (() => ({ ok: true }));
  app.get("/health", (context) => context.json(health()));
  adapters.routes?.(app, { githubIngress });
  app.route("/", flue());
  return app;
};
