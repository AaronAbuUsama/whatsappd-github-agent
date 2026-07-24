import { flue } from "@flue/runtime/routing";
import { Hono } from "hono";

import type { IssueRepository } from "../capabilities/issue-management/issue-repository.ts";
import type { IssueOperationStore } from "@ambient-agent/engine/github/operation-store.ts";
import {
  configureIssueManagementRuntime,
  type IssueManagementPolicy,
} from "../capabilities/issue-management/runtime.ts";
import { configureGraphStore } from "../capabilities/graph/runtime.ts";
import type { GraphStore } from "@ambient-agent/engine/graph/store.ts";
import { configureWhatsAppParticipationPort } from "../capabilities/whatsapp-participation/whatsapp-port.ts";
import type { WhatsAppParticipationPort } from "../capabilities/whatsapp-participation/whatsapp-port.ts";
import { installGitHubIngressRuntime } from "@ambient-agent/engine/github/ingress-runtime.ts";
import type { GitHubIngressStore } from "@ambient-agent/engine/github/ingress-store.ts";
import type { GitHubIngressSettings } from "@ambient-agent/engine/github/ingress.ts";
import type { GitHubIngressAdmit } from "@ambient-agent/engine/github/up-inbox.ts";

export interface SpeakerIngressAdapters {
  readonly settings: GitHubIngressSettings;
  /** Admit a GitHub event to the single Brain up-inbox (§4); the Brain decides which Surface(s) hear it. */
  readonly admit: GitHubIngressAdmit;
  readonly review?: Parameters<typeof installGitHubIngressRuntime>[3];
}

/**
 * Adapters for the one Speaker composition root (T6, O1 ratified).
 *
 * Production passes real adapters (Octokit repository, SQLite stores) and wires its
 * WhatsApp participation port later inside `runWhatsAppSession`; the test fixture
 * passes fakes and wires its participation port here. The coalescer stack is
 * deliberately NOT part of this surface: production runs it in `runWhatsAppSession`
 * (apps/runtime/src/host/whatsapp-runtime.ts) and the fixture keeps its own Effect fork with test
 * seams (injected failure, test debounce). O2 — folding the coalescer stack into this
 * composition — is explicitly deferred to the monorepo cut follow-up.
 */
export interface SpeakerAdapters {
  readonly issues: IssueRepository;
  readonly operations: IssueOperationStore;
  readonly policy: IssueManagementPolicy;
  readonly ingress: SpeakerIngressAdapters;
  /** The shared graph store, wired so later graph consumers reach it via `getGraphStore()`. */
  readonly graph?: GraphStore;
  readonly participation?: WhatsAppParticipationPort;
  /** Payload for GET /health; defaults to a static `{ ok: true }`. */
  readonly health?: () => Record<string, unknown>;
  /** Caller-owned routes (smoke route, /test seams), mounted before the Flue routes. */
  readonly routes?: (app: Hono, context: { readonly githubIngress: GitHubIngressStore }) => void;
}

export const composeSpeaker = (adapters: SpeakerAdapters): Hono => {
  configureIssueManagementRuntime({
    repository: adapters.issues,
    operations: adapters.operations,
    policy: adapters.policy,
  });
  const githubIngress = installGitHubIngressRuntime(
    adapters.ingress.settings,
    adapters.ingress.admit,
    adapters.operations,
    adapters.ingress.review,
  );
  if (adapters.graph !== undefined) configureGraphStore(adapters.graph);
  if (adapters.participation !== undefined) configureWhatsAppParticipationPort(adapters.participation);
  const app = new Hono();
  const health = adapters.health ?? (() => ({ ok: true }));
  app.get("/health", (context) => context.json(health()));
  adapters.routes?.(app, { githubIngress });
  app.route("/", flue());
  return app;
};
