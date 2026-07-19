import type { openControlDb } from "@ambient-agent/db";
import type { WebhooksOptions } from "@polar-sh/better-auth";
import type { Subscription } from "@polar-sh/sdk/models/components/subscription";

type EntitlementDatabase = Awaited<ReturnType<typeof openControlDb>>["client"];
type PolarWebhookPayload = Parameters<NonNullable<WebhooksOptions["onPayload"]>>[0];

const subscriptionEventTypes = [
  "subscription.created",
  "subscription.updated",
  "subscription.active",
  "subscription.canceled",
  "subscription.uncanceled",
  "subscription.revoked",
  "subscription.past_due",
] as const;

export type SubscriptionEventType = (typeof subscriptionEventTypes)[number];
export type EntitlementStatus = "inactive" | "confirming" | "trialing" | "active" | "past_due" | "canceled";

export interface SubscriptionLifecycleEvent {
  readonly type: SubscriptionEventType;
  readonly occurredAt: Date;
  readonly userId: string;
  readonly polarCustomerId: string;
  readonly polarSubscriptionId: string;
  readonly subscriptionStatus: string;
  readonly cancelAtPeriodEnd: boolean;
  readonly entitlingProduct: boolean;
}

export interface EntitlementProjection {
  readonly id: string;
  readonly userId: string;
  readonly polarCustomerId: string | null;
  readonly polarSubscriptionId: string | null;
  readonly status: Exclude<EntitlementStatus, "confirming">;
  readonly lastEventId: string | null;
  readonly updatedAt: Date;
}

export interface EntitlementSnapshot {
  readonly status: EntitlementStatus;
  readonly entitled: boolean;
  readonly runtimeStopRequested: boolean;
  readonly lastEventId: string | null;
}

const subscriptionEventType = (value: string): value is SubscriptionEventType =>
  subscriptionEventTypes.includes(value as SubscriptionEventType);

const statusFor = (event: SubscriptionLifecycleEvent): EntitlementProjection["status"] => {
  if (!event.entitlingProduct) return "inactive";
  if (event.type === "subscription.revoked" || event.subscriptionStatus === "unpaid") return "canceled";
  if (event.type === "subscription.past_due" || event.subscriptionStatus === "past_due") return "past_due";
  if (event.subscriptionStatus === "trialing") return "trialing";
  if (event.subscriptionStatus === "active") return "active";
  if (event.subscriptionStatus === "canceled") return "canceled";
  return "inactive";
};

const statusRank: Record<EntitlementProjection["status"], number> = {
  inactive: 0,
  trialing: 1,
  active: 2,
  past_due: 3,
  canceled: 4,
};

/**
 * Polar's Better Auth adapter verifies webhook IDs but exposes only the parsed
 * payload to onPayload. This cursor preserves the payload timestamp for replay
 * ordering and gives equal-time events a deterministic, fail-closed order.
 */
export const subscriptionEventCursor = (event: SubscriptionLifecycleEvent): string => {
  const timestamp = event.occurredAt.getTime().toString().padStart(13, "0");
  const status = statusFor(event);
  const rank = event.entitlingProduct ? statusRank[status] : statusRank.canceled;
  const productScope = event.entitlingProduct ? "entitling" : "non_entitling";
  return `${timestamp}:${rank}:${productScope}:${event.type}:${event.polarSubscriptionId}`;
};

const requiredString = (value: unknown, column: string): string => {
  if (typeof value !== "string") throw new TypeError(`subscription_entitlement.${column} must be text`);
  return value;
};

const requiredNumber = (value: unknown, column: string): number => {
  if (typeof value !== "number" && typeof value !== "bigint") {
    throw new TypeError(`subscription_entitlement.${column} must be numeric`);
  }
  return Number(value);
};

const nullableString = (value: unknown, column: string): string | null =>
  value === null ? null : requiredString(value, column);

const projectionFrom = (row: Record<string, unknown>): EntitlementProjection => ({
  id: requiredString(row.id, "id"),
  userId: requiredString(row.user_id, "user_id"),
  polarCustomerId: nullableString(row.polar_customer_id, "polar_customer_id"),
  polarSubscriptionId: nullableString(row.polar_subscription_id, "polar_subscription_id"),
  status: requiredString(row.status, "status") as EntitlementProjection["status"],
  lastEventId: nullableString(row.last_event_id, "last_event_id"),
  updatedAt: new Date(requiredNumber(row.updated_at_ms, "updated_at_ms")),
});

export const subscriptionLifecycleEvent = (
  payload: PolarWebhookPayload,
  allowedProductId: string,
): SubscriptionLifecycleEvent | null => {
  if (!subscriptionEventType(payload.type)) return null;

  const subscription = payload.data as Subscription;
  const entitlingProduct = subscription.productId === allowedProductId;
  const userId = subscription.customer.externalId;
  if (!userId) {
    if (!entitlingProduct) return null;
    throw new Error(`Polar subscription ${subscription.id} has no Better Auth external customer ID`);
  }

  return {
    type: payload.type,
    occurredAt: payload.timestamp,
    userId,
    polarCustomerId: subscription.customerId,
    polarSubscriptionId: subscription.id,
    subscriptionStatus: subscription.status,
    cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
    entitlingProduct,
  };
};

export const entitlementSnapshot = (
  projection: EntitlementProjection | null,
  providerHasActiveSubscription = false,
): EntitlementSnapshot => {
  const entitled = projection?.status === "active" || projection?.status === "trialing";
  const confirming = providerHasActiveSubscription && !entitled;
  return {
    status: confirming ? "confirming" : (projection?.status ?? "inactive"),
    entitled,
    runtimeStopRequested: !entitled,
    lastEventId: projection?.lastEventId ?? null,
  };
};

export const createSubscriptionEntitlementStore = (database: EntitlementDatabase) => {
  const get = async (userId: string): Promise<EntitlementProjection | null> => {
    const result = await database.execute({
      sql: "SELECT * FROM subscription_entitlement WHERE user_id = ?1",
      args: [userId],
    });
    const row = result.rows[0];
    return row ? projectionFrom(row) : null;
  };

  const reduce = async (event: SubscriptionLifecycleEvent): Promise<EntitlementProjection> => {
    const status = statusFor(event);
    const grantsEntitlement = status === "active" || status === "trialing";
    const eventCursor = subscriptionEventCursor(event);
    const receivedAt = Date.now();
    const transaction = await database.transaction("write");

    try {
      const reduction = grantsEntitlement
        ? await transaction.execute({
            sql: `INSERT INTO subscription_entitlement (
              id, user_id, polar_customer_id, polar_subscription_id, status,
              last_event_id, updated_at_ms
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
            ON CONFLICT(user_id) DO UPDATE SET
              polar_customer_id = excluded.polar_customer_id,
              polar_subscription_id = excluded.polar_subscription_id,
              status = excluded.status,
              last_event_id = excluded.last_event_id,
              updated_at_ms = excluded.updated_at_ms
            WHERE subscription_entitlement.last_event_id IS NULL
              OR excluded.last_event_id > subscription_entitlement.last_event_id
              OR (
                subscription_entitlement.last_event_id LIKE '%:non_entitling:%'
                AND subscription_entitlement.polar_subscription_id != excluded.polar_subscription_id
              )`,
            args: [
              `subscription:${event.userId}`,
              event.userId,
              event.polarCustomerId,
              event.polarSubscriptionId,
              status,
              eventCursor,
              receivedAt,
            ],
          })
        : await transaction.execute({
            sql: `INSERT INTO subscription_entitlement (
              id, user_id, polar_customer_id, polar_subscription_id, status,
              last_event_id, updated_at_ms
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
            ON CONFLICT(user_id) DO UPDATE SET
              polar_customer_id = excluded.polar_customer_id,
              polar_subscription_id = COALESCE(
                subscription_entitlement.polar_subscription_id,
                excluded.polar_subscription_id
              ),
              status = excluded.status,
              last_event_id = excluded.last_event_id,
              updated_at_ms = excluded.updated_at_ms
            WHERE (
                subscription_entitlement.polar_subscription_id IS NULL
                OR subscription_entitlement.polar_subscription_id = excluded.polar_subscription_id
              )
              AND (subscription_entitlement.last_event_id IS NULL
                OR excluded.last_event_id > subscription_entitlement.last_event_id)`,
            args: [
              `subscription:${event.userId}`,
              event.userId,
              event.polarCustomerId,
              event.polarSubscriptionId,
              status,
              eventCursor,
              receivedAt,
            ],
          });

      if (reduction.rowsAffected > 0 && !grantsEntitlement) {
        await transaction.execute({
          sql: `UPDATE agent_instance
            SET desired_mode = 'stopped', updated_at_ms = MAX(updated_at_ms, ?2)
            WHERE tenant_id IN (
              SELECT tenant.id
              FROM tenant
              WHERE tenant.subscription_entitlement_id IN (
                SELECT subscription_entitlement.id
                FROM subscription_entitlement
                WHERE subscription_entitlement.user_id = ?1
              )
                AND tenant.status != 'archived'
            )`,
          args: [event.userId, receivedAt],
        });
        await transaction.execute({
          sql: `UPDATE tenant
            SET desired_state = 'stopped', updated_at_ms = MAX(updated_at_ms, ?2)
            WHERE subscription_entitlement_id IN (
              SELECT subscription_entitlement.id
              FROM subscription_entitlement
              WHERE subscription_entitlement.user_id = ?1
            )
              AND status != 'archived'`,
          args: [event.userId, receivedAt],
        });
      }

      await transaction.commit();
    } catch (error) {
      if (!transaction.closed) await transaction.rollback();
      throw error;
    }

    const projection = await get(event.userId);
    if (!projection) throw new Error(`Failed to project Polar subscription ${event.polarSubscriptionId}`);
    return projection;
  };

  return { get, reduce };
};
