import type { EntitlementSnapshot } from "@ambient-agent/auth/subscription-entitlement";
import { ORPCError, type RouterClient } from "@orpc/server";
import { z } from "zod";

import { CoworkerError, type CoworkerService } from "../coworker";
import { protectedProcedure, publicProcedure } from "../index";

export interface AppRouterDependencies {
  readonly getEntitlementSnapshot: (userId: string) => Promise<EntitlementSnapshot>;
  readonly coworker?: CoworkerService;
}

const operationInput = z.object({ operationIdentity: z.string().trim().min(1).max(128) });
const coworkerInput = operationInput.extend({ displayName: z.string().trim().min(2).max(48) });
const activationInput = operationInput.extend({
  expectedConfigVersion: z.number().int().positive(),
  expectedBasisFingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
});
const managedChatsInput = z.object({ jids: z.array(z.string().trim().min(1).max(255)).min(1).max(100) });
const operationReadInput = z.object({ operationId: z.string().trim().min(1).max(128) });

const coworkerService = (dependencies: AppRouterDependencies): CoworkerService => {
  if (!dependencies.coworker) throw new ORPCError("SERVICE_UNAVAILABLE", { message: "Coworker service unavailable" });
  return dependencies.coworker;
};

const coworkerCall = async <Value>(operation: () => Promise<Value>): Promise<Value> => {
  try {
    return await operation();
  } catch (cause) {
    if (!(cause instanceof CoworkerError)) throw cause;
    const code =
      cause.code === "entitlement_required"
        ? "FORBIDDEN"
        : cause.code === "tenant_not_found"
          ? "NOT_FOUND"
          : cause.code === "invalid_name" || cause.code === "managed_chat_invalid"
            ? "BAD_REQUEST"
            : cause.code === "runtime_unavailable" || cause.code === "model_store_unavailable"
              ? "SERVICE_UNAVAILABLE"
              : "CONFLICT";
    throw new ORPCError(code, { message: cause.message, data: { code: cause.code } });
  }
};

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
  coworker: {
    snapshot: protectedProcedure.handler(({ context }) =>
      coworkerCall(() => coworkerService(dependencies).snapshot(context.session.user.id)),
    ),
    refresh: protectedProcedure.handler(({ context }) =>
      coworkerCall(() => coworkerService(dependencies).refresh(context.session.user.id)),
    ),
    create: protectedProcedure
      .input(coworkerInput)
      .handler(({ context, input }) =>
        coworkerCall(() => coworkerService(dependencies).create(context.session.user.id, input)),
      ),
    ensureSetup: protectedProcedure
      .input(operationInput)
      .handler(({ context, input }) =>
        coworkerCall(() => coworkerService(dependencies).ensureSetup(context.session.user.id, input)),
      ),
    operation: protectedProcedure
      .input(operationReadInput)
      .handler(({ context, input }) =>
        coworkerCall(() => coworkerService(dependencies).reconcileOperation(context.session.user.id, input)),
      ),
    model: {
      beginAuth: protectedProcedure
        .input(operationInput)
        .handler(({ context, input }) =>
          coworkerCall(() => coworkerService(dependencies).beginModelAuth(context.session.user.id, input)),
        ),
      verify: protectedProcedure.handler(({ context }) =>
        coworkerCall(() => coworkerService(dependencies).verifyModel(context.session.user.id)),
      ),
    },
    whatsapp: {
      pairing: protectedProcedure.handler(({ context }) =>
        coworkerCall(() => coworkerService(dependencies).pairing(context.session.user.id)),
      ),
      beginRepair: protectedProcedure
        .input(operationInput)
        .handler(({ context, input }) =>
          coworkerCall(() => coworkerService(dependencies).beginWhatsappRepair(context.session.user.id, input)),
        ),
    },
    chats: {
      list: protectedProcedure.handler(({ context }) =>
        coworkerCall(() => coworkerService(dependencies).listManagedChats(context.session.user.id)),
      ),
      select: protectedProcedure
        .input(managedChatsInput)
        .handler(({ context, input }) =>
          coworkerCall(() => coworkerService(dependencies).selectManagedChats(context.session.user.id, input)),
        ),
    },
    activate: protectedProcedure
      .input(activationInput)
      .handler(({ context, input }) =>
        coworkerCall(() => coworkerService(dependencies).activate(context.session.user.id, input)),
      ),
    github: {
      apply: protectedProcedure
        .input(activationInput)
        .handler(({ context, input }) =>
          coworkerCall(() => coworkerService(dependencies).applyGitHubConfiguration(context.session.user.id, input)),
        ),
    },
    runtime: {
      restart: protectedProcedure
        .input(operationInput)
        .handler(({ context, input }) =>
          coworkerCall(() => coworkerService(dependencies).restartRuntime(context.session.user.id, input)),
        ),
    },
  },
});
export type AppRouter = ReturnType<typeof createAppRouter>;
export type AppRouterClient = RouterClient<AppRouter>;
