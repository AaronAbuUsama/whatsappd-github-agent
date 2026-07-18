import type { EntitlementSnapshot } from "@ambient-agent/auth/subscription-entitlement";
import type { RouterClient } from "@orpc/server";

import { protectedProcedure, publicProcedure } from "../index";

export interface AppRouterDependencies {
  readonly getEntitlementSnapshot: (userId: string) => Promise<EntitlementSnapshot>;
}

export const createAppRouter = (dependencies: AppRouterDependencies) => ({
  healthCheck: publicProcedure.handler(() => {
    return "OK";
  }),
  privateData: protectedProcedure.handler(({ context }) => {
    return {
      message: "This is private",
      user: context.session?.user,
    };
  }),
  billing: {
    entitlement: protectedProcedure.handler(({ context }) =>
      dependencies.getEntitlementSnapshot(context.session.user.id),
    ),
  },
});
export type AppRouter = ReturnType<typeof createAppRouter>;
export type AppRouterClient = RouterClient<AppRouter>;
