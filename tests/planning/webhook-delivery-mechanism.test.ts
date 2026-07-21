import { describe, expect, it } from "vitest";

import {
  DeliveryIdentityCollisionError,
  DeliveryRouteConflictError,
  acceptVerifiedDelivery,
  acknowledgeDelivery,
  cappedExponentialRetryDelayMs,
  claimDelivery,
  deliveryOutboxIdentity,
  isDurableTenantAcknowledgement,
  retryDelivery,
  routeDelivery,
  type OutboxDeliveryRecord,
  type VerifiedGitHubDelivery,
} from "../../docs/planning/wayfinder/T-C-webhook-delivery.prototype.ts";

const receivedAt = "2026-07-18T12:00:00.000Z";
const receivedAtMs = Date.parse(receivedAt);

const delivery = (overrides: Partial<VerifiedGitHubDelivery> = {}): VerifiedGitHubDelivery => ({
  githubAppId: "coder-app",
  deliveryId: "delivery-guid-1",
  eventName: "issues",
  installationId: "1234",
  tenantId: "tenant-a",
  payloadJson: '{"action":"opened"}',
  payloadSha256: "sha256:original",
  receivedAt,
  ...overrides,
});

const accepted = (overrides: Partial<VerifiedGitHubDelivery> = {}): OutboxDeliveryRecord => {
  const result = acceptVerifiedDelivery(undefined, delivery(overrides));
  expect(result.action).toBe("inserted");
  return result.record;
};

const claimed = (record = accepted(), nowMs = receivedAtMs): OutboxDeliveryRecord => {
  const result = claimDelivery(record, { id: "claim-a", nowMs, leaseMs: 60_000 });
  expect(result.action).toBe("claimed");
  if (result.action !== "claimed") throw new Error("expected delivery claim");
  return result.record;
};

describe("T-C durable delivery contract", () => {
  it("deduplicates an exact GitHub redelivery by GUID while preserving the original tenant route", () => {
    const original = accepted();
    const duplicate = acceptVerifiedDelivery(original, delivery({ tenantId: "tenant-b" }));

    expect(duplicate).toEqual({ action: "duplicate", record: original });
    expect(duplicate.record.tenantId).toBe("tenant-a");
  });

  it("scopes the same GitHub event GUID independently for each configured App", () => {
    const coderDelivery = delivery({ githubAppId: "coder-app" });
    const reviewerDelivery = delivery({
      githubAppId: "reviewer-app",
      installationId: "5678",
      tenantId: "tenant-b",
    });

    expect(deliveryOutboxIdentity(coderDelivery)).toBe("coder-app:delivery-guid-1");
    expect(deliveryOutboxIdentity(reviewerDelivery)).toBe("reviewer-app:delivery-guid-1");
    expect(deliveryOutboxIdentity(coderDelivery)).not.toBe(deliveryOutboxIdentity(reviewerDelivery));
    expect(acceptVerifiedDelivery(undefined, coderDelivery).action).toBe("inserted");
    expect(acceptVerifiedDelivery(undefined, reviewerDelivery).action).toBe("inserted");
  });

  it("fails closed when a GUID is reused with a different source identity inside one App", () => {
    const original = accepted();

    expect(() =>
      acceptVerifiedDelivery(original, delivery({ payloadJson: '{"action":"closed"}', payloadSha256: "sha256:changed" })),
    ).toThrow(DeliveryIdentityCollisionError);
  });

  it("persists a missing or unknown installation until routing is available and pins the resolved tenant", () => {
    const missing = accepted({ installationId: null, tenantId: null });
    expect(claimDelivery(missing, { id: "claim-a", nowMs: receivedAtMs, leaseMs: 60_000 })).toEqual({
      action: "not-claimed",
      reason: "unrouted",
    });

    const unknown = accepted({ tenantId: null });
    const routed = routeDelivery(unknown, "tenant-a");
    expect(routed.tenantId).toBe("tenant-a");
    expect(() => routeDelivery(routed, "tenant-b")).toThrow(DeliveryRouteConflictError);
  });

  it("allows one live claim and reclaims it after a worker crash expires the lease", () => {
    const first = claimed();

    expect(
      claimDelivery(first, { id: "claim-b", nowMs: receivedAtMs + 59_999, leaseMs: 60_000 }),
    ).toEqual({ action: "not-claimed", reason: "leased" });

    const reclaimed = claimDelivery(first, {
      id: "claim-b",
      nowMs: receivedAtMs + 60_000,
      leaseMs: 60_000,
    });
    expect(reclaimed.action).toBe("claimed");
    if (reclaimed.action !== "claimed") throw new Error("expected reclaimed delivery");
    expect(reclaimed.record.attemptCount).toBe(2);
    expect(reclaimed.record.claim?.id).toBe("claim-b");
  });

  it("retains the payload and schedules another attempt while a tenant is unavailable", () => {
    const inFlight = claimed();
    const retrying = retryDelivery(inFlight, "claim-a", {
      nowMs: receivedAtMs + 5_000,
      delayMs: 10_000,
      error: "tenant unavailable",
    });

    expect(retrying.payloadJson).toBe(delivery().payloadJson);
    expect(retrying.state).toBe("pending");
    expect(retrying.claim).toBeNull();
    expect(retrying.nextAttemptAtMs).toBe(receivedAtMs + 15_000);
    expect(
      claimDelivery(retrying, { id: "claim-b", nowMs: receivedAtMs + 14_999, leaseMs: 60_000 }),
    ).toEqual({ action: "not-claimed", reason: "not-due" });
  });

  it("acknowledges only a terminal tenant-ledger result for the same App/GUID pair", () => {
    expect(
      isDurableTenantAcknowledgement(delivery(), {
        githubAppId: "coder-app",
        status: "done",
        deliveryId: "delivery-guid-1",
      }),
    ).toBe(true);
    expect(
      isDurableTenantAcknowledgement(delivery(), {
        githubAppId: "coder-app",
        status: "duplicate",
        record: { deliveryId: "delivery-guid-1", status: "done" },
      }),
    ).toBe(true);
    expect(
      isDurableTenantAcknowledgement(delivery(), {
        githubAppId: "coder-app",
        status: "duplicate",
        record: { deliveryId: "delivery-guid-1", status: "received" },
      }),
    ).toBe(false);
    expect(
      isDurableTenantAcknowledgement(delivery(), {
        githubAppId: "coder-app",
        status: "done",
        deliveryId: "another-guid",
      }),
    ).toBe(false);
    expect(
      isDurableTenantAcknowledgement(delivery(), {
        githubAppId: "reviewer-app",
        status: "done",
        deliveryId: "delivery-guid-1",
      }),
    ).toBe(false);
  });

  it("settles after the retry caused by a control-plane crash observes a terminal duplicate", () => {
    const retried = claimed(claimed(), receivedAtMs + 60_000);
    const acked = acknowledgeDelivery(
      retried,
      "claim-a",
      {
        githubAppId: "coder-app",
        status: "duplicate",
        record: { deliveryId: "delivery-guid-1", status: "done" },
      },
      receivedAtMs + 61_000,
    );

    expect(acked.state).toBe("acked");
    expect(acked.claim).toBeNull();
    expect(acked.tenantResultStatus).toBe("duplicate");
  });

  it("uses capped exponential backoff with injected jitter", () => {
    expect(cappedExponentialRetryDelayMs(1, 1)).toBe(1_000);
    expect(cappedExponentialRetryDelayMs(4, 0.5)).toBe(4_000);
    expect(cappedExponentialRetryDelayMs(30, 1)).toBe(15 * 60_000);
  });
});
