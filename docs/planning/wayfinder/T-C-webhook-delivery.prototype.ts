/**
 * Executable contract for T-C (#168), not a production implementation.
 *
 * The prototype makes the delivery-GUID, routing, claim-lease, retry, and
 * acknowledgement invariants mechanically reviewable before the control-plane
 * and runtime modules are implemented.
 */

export interface VerifiedGitHubDelivery {
  readonly githubAppId: string;
  readonly deliveryId: string;
  readonly eventName: string;
  readonly installationId: string | null;
  readonly tenantId: string | null;
  readonly payloadJson: string;
  readonly payloadSha256: string;
  readonly receivedAt: string;
}

export interface DeliveryClaim {
  readonly id: string;
  readonly expiresAtMs: number;
}

export interface OutboxDeliveryRecord extends VerifiedGitHubDelivery {
  readonly state: "pending" | "acked";
  readonly attemptCount: number;
  readonly nextAttemptAtMs: number;
  readonly claim: DeliveryClaim | null;
  readonly lastError: string | null;
  readonly tenantResultStatus: TenantIngressResult["status"] | null;
  readonly acknowledgedAtMs: number | null;
}

export type TenantIngressRecordStatus = "received" | "unsupported" | "uncorrelated" | "done" | "failed";

export type TenantIngressResult = { readonly githubAppId: string } & (
  | { readonly status: "deferred"; readonly deliveryId: string }
  | { readonly status: "unsupported"; readonly deliveryId: string }
  | { readonly status: "uncorrelated"; readonly deliveryId: string }
  | { readonly status: "done"; readonly deliveryId: string }
  | {
      readonly status: "failed";
      readonly record: { readonly deliveryId: string; readonly status: "failed" };
    }
  | {
      readonly status: "duplicate";
      readonly record: { readonly deliveryId: string; readonly status: TenantIngressRecordStatus };
    }
);

export type AcceptResult =
  | { readonly action: "inserted"; readonly record: OutboxDeliveryRecord }
  | { readonly action: "duplicate"; readonly record: OutboxDeliveryRecord };

export type ClaimResult =
  | { readonly action: "claimed"; readonly record: OutboxDeliveryRecord }
  | { readonly action: "not-claimed"; readonly reason: "acked" | "not-due" | "unrouted" | "leased" };

/** GitHub delivery GUIDs are idempotency identities within one configured GitHub App. */
export const deliveryOutboxIdentity = (delivery: Pick<VerifiedGitHubDelivery, "githubAppId" | "deliveryId">): string =>
  `${delivery.githubAppId}:${delivery.deliveryId}`;

const deliveryIdentityMatches = (existing: OutboxDeliveryRecord, incoming: VerifiedGitHubDelivery): boolean =>
  existing.githubAppId === incoming.githubAppId &&
  existing.eventName === incoming.eventName &&
  existing.installationId === incoming.installationId &&
  existing.payloadSha256 === incoming.payloadSha256;

export class DeliveryIdentityCollisionError extends Error {}

export class DeliveryRouteConflictError extends Error {}

export class DeliveryClaimError extends Error {}

/**
 * Models the receiver transaction. The caller computes payloadSha256 from the
 * verified raw body; (githubAppId, deliveryId) is the database primary key.
 * `existing` is the row read through that composite identity.
 */
export const acceptVerifiedDelivery = (
  existing: OutboxDeliveryRecord | undefined,
  incoming: VerifiedGitHubDelivery,
): AcceptResult => {
  if (existing !== undefined) {
    if (!deliveryIdentityMatches(existing, incoming)) {
      throw new DeliveryIdentityCollisionError(
        `GitHub App delivery ${deliveryOutboxIdentity(incoming)} changed identity`,
      );
    }
    return { action: "duplicate", record: existing };
  }

  const receivedAtMs = Date.parse(incoming.receivedAt);
  if (!Number.isFinite(receivedAtMs)) throw new TypeError("receivedAt must be an ISO timestamp");

  return {
    action: "inserted",
    record: {
      ...incoming,
      state: "pending",
      attemptCount: 0,
      nextAttemptAtMs: receivedAtMs,
      claim: null,
      lastError: null,
      tenantResultStatus: null,
      acknowledgedAtMs: null,
    },
  };
};

/** A GUID is routed once. Endpoint changes are resolved from that tenant at attempt time. */
export const routeDelivery = (record: OutboxDeliveryRecord, tenantId: string): OutboxDeliveryRecord => {
  if (record.tenantId !== null && record.tenantId !== tenantId) {
    throw new DeliveryRouteConflictError(
      `GitHub App delivery ${deliveryOutboxIdentity(record)} is already pinned to tenant ${record.tenantId}`,
    );
  }
  return { ...record, tenantId };
};

/** Models an atomic compare-and-set claim with an expiring worker lease. */
export const claimDelivery = (
  record: OutboxDeliveryRecord,
  claim: { readonly id: string; readonly nowMs: number; readonly leaseMs: number },
): ClaimResult => {
  if (record.state === "acked") return { action: "not-claimed", reason: "acked" };
  if (record.tenantId === null) return { action: "not-claimed", reason: "unrouted" };
  if (record.nextAttemptAtMs > claim.nowMs) return { action: "not-claimed", reason: "not-due" };
  if (record.claim !== null && record.claim.expiresAtMs > claim.nowMs) {
    return { action: "not-claimed", reason: "leased" };
  }
  if (claim.leaseMs <= 0) throw new RangeError("leaseMs must be positive");

  return {
    action: "claimed",
    record: {
      ...record,
      attemptCount: record.attemptCount + 1,
      claim: { id: claim.id, expiresAtMs: claim.nowMs + claim.leaseMs },
    },
  };
};

const requireClaim = (record: OutboxDeliveryRecord, claimId: string): void => {
  if (record.state !== "pending" || record.claim?.id !== claimId) {
    throw new DeliveryClaimError(`GitHub delivery ${record.deliveryId} is not held by claim ${claimId}`);
  }
};

const resultDeliveryId = (result: TenantIngressResult): string =>
  result.status === "failed" || result.status === "duplicate" ? result.record.deliveryId : result.deliveryId;

const resultDeliveryIdentity = (result: TenantIngressResult): string =>
  deliveryOutboxIdentity({ githubAppId: result.githubAppId, deliveryId: resultDeliveryId(result) });

/**
 * A 2xx response is an acknowledgement only when the result proves that the
 * tenant ledger is terminal. A concurrent duplicate still marked `received`
 * must remain retryable.
 */
export const isDurableTenantAcknowledgement = (
  expected: Pick<VerifiedGitHubDelivery, "githubAppId" | "deliveryId">,
  result: TenantIngressResult,
): boolean => {
  if (resultDeliveryIdentity(result) !== deliveryOutboxIdentity(expected) || result.status === "deferred") {
    return false;
  }
  if (result.status === "duplicate") return result.record.status !== "received";
  return true;
};

export const acknowledgeDelivery = (
  record: OutboxDeliveryRecord,
  claimId: string,
  result: TenantIngressResult,
  acknowledgedAtMs: number,
): OutboxDeliveryRecord => {
  requireClaim(record, claimId);
  if (!isDurableTenantAcknowledgement(record, result)) {
    throw new DeliveryClaimError(
      `Tenant did not durably acknowledge GitHub App delivery ${deliveryOutboxIdentity(record)}`,
    );
  }
  return {
    ...record,
    state: "acked",
    claim: null,
    lastError: null,
    tenantResultStatus: result.status,
    acknowledgedAtMs,
  };
};

export const retryDelivery = (
  record: OutboxDeliveryRecord,
  claimId: string,
  retry: { readonly nowMs: number; readonly delayMs: number; readonly error: string },
): OutboxDeliveryRecord => {
  requireClaim(record, claimId);
  if (retry.delayMs < 0) throw new RangeError("delayMs must not be negative");
  return {
    ...record,
    claim: null,
    nextAttemptAtMs: retry.nowMs + retry.delayMs,
    lastError: retry.error,
  };
};

export const cappedExponentialRetryDelayMs = (
  attemptCount: number,
  jitterSample: number,
  options: { readonly baseMs?: number; readonly capMs?: number } = {},
): number => {
  if (!Number.isInteger(attemptCount) || attemptCount < 1) throw new RangeError("attemptCount must be positive");
  if (jitterSample < 0 || jitterSample > 1) throw new RangeError("jitterSample must be between 0 and 1");
  const baseMs = options.baseMs ?? 1_000;
  const capMs = options.capMs ?? 15 * 60_000;
  const ceiling = Math.min(capMs, baseMs * 2 ** Math.min(attemptCount - 1, 30));
  return Math.floor(ceiling * jitterSample);
};
