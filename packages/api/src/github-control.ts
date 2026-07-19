import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import {
  GitHubControlStoreError,
  type GitHubAppRole,
  type GitHubControlStore,
  type GitHubDeliveryOutboxRecord,
  type GitHubRepositoryGrant,
} from "@ambient-agent/db/github-control";
import type { BridgeGitHubDelivery, BridgeGitHubDeliveryAck } from "@ambient-agent/installation/bridge-contract.ts";

export interface GitHubAppConfiguration {
  readonly role: GitHubAppRole;
  readonly appId: string;
  readonly slug: string;
  readonly webhookSecret: string;
}

export interface GitHubInstallationSnapshot {
  readonly accountLogin: string;
  readonly repositories: readonly Omit<GitHubRepositoryGrant, "selected" | "isDefault">[];
}

export interface GitHubInstallationSource {
  installation(configuration: GitHubAppConfiguration, installationId: number): Promise<GitHubInstallationSnapshot>;
}

export interface GitHubRuntimeDeliveryTarget {
  readonly tenantId: string;
  readonly runtimeId: string;
  readonly baseUrl: string;
  readonly webhookSecret: string;
}

export interface GitHubRuntimeTargetResolver {
  resolve(tenantId: string): Promise<GitHubRuntimeDeliveryTarget | null>;
}

export interface GitHubDeliveryPort {
  deliver(target: GitHubRuntimeDeliveryTarget, delivery: BridgeGitHubDelivery): Promise<BridgeGitHubDeliveryAck>;
}

export interface GitHubDeliveryRelayOptions {
  readonly store: GitHubControlStore;
  readonly targets: GitHubRuntimeTargetResolver;
  readonly deliveries: GitHubDeliveryPort;
  readonly now?: () => number;
  readonly random?: () => number;
  readonly claimId?: () => string;
  readonly maximumBackoffMs?: number;
}

const stateHash = (state: string): string => createHash("sha256").update(`ambient-agent-github-state\0${state}`).digest("hex");
const payloadHash = (payload: string): string => createHash("sha256").update(payload).digest("hex");

const authorizationMatches = (candidate: string | undefined, secret: string, body: string): boolean => {
  if (candidate === undefined || !candidate.startsWith("sha256=")) return false;
  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(body).digest("hex")}`);
  const actual = Buffer.from(candidate);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};

const installationIdFromPayload = (payload: Record<string, unknown>): number | null => {
  const installation = payload.installation;
  if (typeof installation !== "object" || installation === null || Array.isArray(installation)) return null;
  const id = (installation as Record<string, unknown>).id;
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? id : null;
};

const repositoryFromWebhook = (value: unknown): Omit<GitHubRepositoryGrant, "selected" | "isDefault"> | undefined => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const repository = value as Record<string, unknown>;
  const ownerValue = repository.owner;
  const owner =
    typeof ownerValue === "object" && ownerValue !== null && !Array.isArray(ownerValue)
      ? (ownerValue as Record<string, unknown>).login
      : undefined;
  return typeof repository.id === "number" &&
    Number.isSafeInteger(repository.id) &&
    repository.id > 0 &&
    typeof owner === "string" &&
    owner.length > 0 &&
    typeof repository.name === "string" &&
    repository.name.length > 0
    ? { id: repository.id, owner, name: repository.name }
    : undefined;
};

const repositoriesFromWebhook = (value: unknown): readonly Omit<GitHubRepositoryGrant, "selected" | "isDefault">[] =>
  Array.isArray(value) ? value.map(repositoryFromWebhook).filter((entry) => entry !== undefined) : [];

const removedRepositoryIds = (value: unknown): readonly number[] =>
  Array.isArray(value)
    ? value
        .map((entry) =>
          typeof entry === "object" && entry !== null && !Array.isArray(entry)
            ? (entry as Record<string, unknown>).id
            : undefined,
        )
        .filter((id): id is number => typeof id === "number" && Number.isSafeInteger(id) && id > 0)
    : [];

export const createGitHubControlService = (options: {
  readonly store: GitHubControlStore;
  readonly apps: Readonly<Record<GitHubAppRole, GitHubAppConfiguration>>;
  readonly installations: GitHubInstallationSource;
  readonly now?: () => number;
  readonly state?: () => string;
  readonly callbackTtlMs?: number;
}) => {
  const now = options.now ?? Date.now;
  const newState = options.state ?? (() => randomBytes(32).toString("base64url"));
  const callbackTtlMs = options.callbackTtlMs ?? 10 * 60_000;

  return {
    beginInstallation: async (input: { readonly tenantId: string; readonly userId: string; readonly role: GitHubAppRole }) => {
      const state = newState();
      const createdAtMs = now();
      await options.store.beginInstallation({
        stateHash: stateHash(state),
        tenantId: input.tenantId,
        userId: input.userId,
        role: input.role,
        createdAtMs,
        expiresAtMs: createdAtMs + callbackTtlMs,
      });
      return {
        state,
        url: `https://github.com/apps/${encodeURIComponent(options.apps[input.role].slug)}/installations/new?state=${encodeURIComponent(state)}`,
      };
    },

    completeInstallation: async (input: {
      readonly role: GitHubAppRole;
      readonly state: string;
      readonly installationId: number;
    }) => {
      const hash = stateHash(input.state);
      const callback = await options.store.installationCallback(hash, input.role, now());
      if (callback.completedAtMs !== null) {
        if (callback.installationId !== input.installationId) {
          throw new GitHubControlStoreError(
            "installation_state",
            "GitHub installation callback was replayed with another installation",
          );
        }
        return { status: "duplicate" as const, tenantId: callback.tenantId, installationId: input.installationId };
      }
      const snapshot = await options.installations.installation(options.apps[input.role], input.installationId);
      const status = await options.store.completeInstallation({
        stateHash: hash,
        role: input.role,
        installationId: input.installationId,
        accountLogin: snapshot.accountLogin,
        repositories: snapshot.repositories,
        nowMs: now(),
      });
      return { status, tenantId: callback.tenantId, installationId: input.installationId };
    },

    receiveWebhook: async (input: {
      readonly role: GitHubAppRole;
      readonly signature: string | undefined;
      readonly deliveryGuid: string | undefined;
      readonly eventName: string | undefined;
      readonly body: string;
    }) => {
      const configuration = options.apps[input.role];
      if (!authorizationMatches(input.signature, configuration.webhookSecret, input.body)) {
        return { status: 401 as const, body: { error: "GitHub webhook signature rejected" } };
      }
      if (!input.deliveryGuid || !input.eventName) {
        return { status: 400 as const, body: { error: "GitHub webhook identity is missing" } };
      }
      let payload: Record<string, unknown>;
      try {
        const value: unknown = JSON.parse(input.body);
        if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("not an object");
        payload = value as Record<string, unknown>;
      } catch {
        return { status: 400 as const, body: { error: "GitHub webhook payload is malformed" } };
      }
      const receivedAtMs = now();
      const accepted = await options.store.acceptDelivery({
        githubAppId: configuration.appId,
        deliveryGuid: input.deliveryGuid,
        eventName: input.eventName,
        installationRole: input.role,
        installationId: installationIdFromPayload(payload),
        payloadJson: input.body,
        payloadSha256: payloadHash(input.body),
        receivedAtMs,
      });

      const action = typeof payload.action === "string" ? payload.action : "";
      if (input.eventName === "installation" || input.eventName === "installation_repositories") {
        const installationId = installationIdFromPayload(payload);
        if (installationId !== null) {
          await options.store.applyInstallationWebhook({
            role: input.role,
            installationId,
            eventName: input.eventName,
            action,
            added: repositoriesFromWebhook(payload.repositories_added),
            removedIds: removedRepositoryIds(payload.repositories_removed),
            nowMs: receivedAtMs,
          });
        }
      }
      return {
        status: 202 as const,
        body: { admitted: accepted.action, githubAppId: configuration.appId, deliveryGuid: input.deliveryGuid },
      };
    },
  };
};

const deliveryIdentity = (ack: BridgeGitHubDeliveryAck): string | undefined => {
  if (ack.result.status === "duplicate" || ack.result.status === "failed") {
    const record = ack.result.record;
    return typeof record === "object" && record !== null && "deliveryId" in record && typeof record.deliveryId === "string"
      ? record.deliveryId
      : undefined;
  }
  return "deliveryId" in ack.result && typeof ack.result.deliveryId === "string" ? ack.result.deliveryId : undefined;
};

const relayPayload = (record: GitHubDeliveryOutboxRecord): BridgeGitHubDelivery => ({
  githubAppId: record.githubAppId,
  deliveryId: record.deliveryGuid,
  name: record.eventName,
  payload: JSON.parse(record.payloadJson) as Record<string, unknown>,
});

export const createGitHubDeliveryRelay = (options: GitHubDeliveryRelayOptions) => {
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const claimId = options.claimId ?? randomUUID;
  const maximumBackoffMs = options.maximumBackoffMs ?? 15 * 60_000;

  return {
    drainOnce: async (limit = 25): Promise<{ readonly claimed: number; readonly acknowledged: number; readonly retried: number }> => {
      await options.store.routePendingDeliveries();
      const claimedAtMs = now();
      const claim = claimId();
      const records = await options.store.claimDueDeliveries(claimedAtMs, claim, limit);
      let acknowledged = 0;
      let retried = 0;
      for (const record of records) {
        try {
          const target = await options.targets.resolve(record.tenantId!);
          if (target === null || target.tenantId !== record.tenantId) throw new Error("tenant runtime target is unavailable");
          const acknowledgement = await options.deliveries.deliver(target, relayPayload(record));
          if (
            acknowledgement.runtimeId !== target.runtimeId ||
            acknowledgement.githubAppId !== record.githubAppId ||
            deliveryIdentity(acknowledgement) !== record.deliveryGuid
          ) {
            throw new Error("tenant runtime acknowledgement identity does not match the routed delivery");
          }
          await options.store.acknowledgeDelivery({
            githubAppId: record.githubAppId,
            deliveryGuid: record.deliveryGuid,
            tenantId: record.tenantId!,
            claimId: claim,
            resultJson: JSON.stringify(acknowledgement.result),
            acknowledgedAtMs: now(),
          });
          acknowledged += 1;
        } catch (cause) {
          const error = cause instanceof Error ? cause.message : "tenant delivery failed";
          const ceiling = Math.min(maximumBackoffMs, 1_000 * 2 ** Math.max(0, record.attemptCount - 1));
          await options.store.retryDelivery({
            githubAppId: record.githubAppId,
            deliveryGuid: record.deliveryGuid,
            tenantId: record.tenantId!,
            claimId: claim,
            nextAttemptAtMs: now() + Math.max(1, Math.floor(random() * ceiling)),
            error,
          });
          retried += 1;
        }
      }
      return { claimed: records.length, acknowledged, retried };
    },
  };
};
