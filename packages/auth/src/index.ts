import { client, db } from "@ambient-agent/db";
import * as schema from "@ambient-agent/db/schema/auth";
import { env } from "@ambient-agent/env/server";
import { polar, checkout, portal, webhooks } from "@polar-sh/better-auth";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";

import { polarClient } from "./lib/payments";
import {
  createSubscriptionEntitlementStore,
  entitlementSnapshot,
  subscriptionLifecycleEvent,
} from "./subscription-entitlement";

const polarProProductId = "64122dbf-b3c1-4f6e-ac1d-9139b6570aea";

export const subscriptionEntitlements = createSubscriptionEntitlementStore(client);

export function createAuth() {
  return betterAuth({
    database: drizzleAdapter(db, {
      provider: "sqlite",

      schema: schema,
    }),
    trustedOrigins: [env.CORS_ORIGIN],
    emailAndPassword: {
      enabled: true,
    },
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.BETTER_AUTH_URL,
    advanced: {
      defaultCookieAttributes: {
        sameSite: "none",
        secure: true,
        httpOnly: true,
      },
    },
    plugins: [
      polar({
        client: polarClient,
        createCustomerOnSignUp: true,
        enableCustomerPortal: true,
        use: [
          checkout({
            products: [
              {
                productId: polarProProductId,
                slug: "pro",
              },
            ],
            successUrl: env.POLAR_SUCCESS_URL,
            authenticatedUsersOnly: true,
          }),
          portal(),
          webhooks({
            secret: env.POLAR_WEBHOOK_SECRET,
            onPayload: async (payload) => {
              const event = subscriptionLifecycleEvent(payload, polarProProductId);
              if (event) await subscriptionEntitlements.reduce(event);
            },
          }),
        ],
      }),
    ],
  });
}

export const auth = createAuth();

const isPolarNotFound = (error: unknown): boolean =>
  typeof error === "object" && error !== null && Reflect.get(error, "statusCode") === 404;

export const getEntitlementSnapshot = async (userId: string) => {
  const projection = await subscriptionEntitlements.get(userId);
  if (projection?.status === "active" || projection?.status === "trialing") {
    return entitlementSnapshot(projection);
  }

  try {
    const customerState = await polarClient.customers.getStateExternal({ externalId: userId });
    return entitlementSnapshot(
      projection,
      customerState.activeSubscriptions.some((subscription) => subscription.productId === polarProProductId),
    );
  } catch (error) {
    if (isPolarNotFound(error)) return entitlementSnapshot(projection);
    throw error;
  }
};
