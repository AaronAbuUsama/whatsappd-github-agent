import { createCoworkerService, CoworkerError, type CoworkerModelSource } from "@ambient-agent/api/coworker";
import type { openControlDb } from "@ambient-agent/db/control-db";
import { createChatGptAuthentication } from "@ambient-agent/engine/model/chatgpt-authentication.ts";
import { createLibsqlChatGptCredentialStore } from "@ambient-agent/installation/tenant-credentials.ts";
import { runtimeInstallationId } from "@ambient-agent/installation/runtime-health.ts";
import { z } from "zod";

import { tenantBridge } from "./tenant-bridge";

type ControlClient = Awaited<ReturnType<typeof openControlDb>>["client"];

const runtimeSecretsSchema = z.record(z.string().min(1), z.string().min(1));

export const createHostedCoworkerModelSource = (options: {
  readonly client: Pick<ControlClient, "execute">;
  readonly decryptTenantToken: (ciphertext: string) => string;
  readonly now?: () => number;
}): CoworkerModelSource => {
  const authenticationFor = async (tenantId: string) => {
    const result = await options.client.execute({
      sql: `SELECT tenant_db_url, tenant_db_token_ciphertext
              FROM tenant
             WHERE id = ?1`,
      args: [tenantId],
    });
    const row = result.rows[0];
    if (!row || typeof row.tenant_db_url !== "string" || typeof row.tenant_db_token_ciphertext !== "string") {
      throw new CoworkerError(
        "model_store_unavailable",
        "The private tenant credential store is not ready yet. Reconcile the named setup operation.",
      );
    }
    let authToken: string;
    try {
      authToken = options.decryptTenantToken(row.tenant_db_token_ciphertext);
    } catch {
      throw new CoworkerError(
        "model_store_unavailable",
        "The private tenant credential store could not be opened safely.",
      );
    }
    return createChatGptAuthentication({
      store: createLibsqlChatGptCredentialStore({ url: row.tenant_db_url, authToken }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  };

  return {
    beginAuth: async ({ tenantId, signal }) => {
      const authentication = await authenticationFor(tenantId);
      let resolveChallenge!: (challenge: { verificationUrl: string; userCode: string; expiresAt: number }) => void;
      let rejectChallenge!: (cause: unknown) => void;
      let challengeObserved = false;
      const challenge = new Promise<{
        verificationUrl: string;
        userCode: string;
        expiresAt: number;
      }>((resolve, reject) => {
        resolveChallenge = resolve;
        rejectChallenge = reject;
      });
      const completion = authentication
        .authenticate(
          {
            onDeviceCode: (deviceCode) => {
              challengeObserved = true;
              resolveChallenge({
                verificationUrl: deviceCode.verificationUri,
                userCode: deviceCode.userCode,
                expiresAt: (options.now ?? Date.now)() + (deviceCode.expiresInSeconds ?? 900) * 1_000,
              });
            },
          },
          signal,
        )
        .then(() => {
          if (!challengeObserved) rejectChallenge(new Error("model_device_challenge_missing"));
        })
        .catch((cause: unknown) => {
          if (!challengeObserved) rejectChallenge(cause);
          throw cause;
        });
      return { challenge: await challenge, completion };
    },
    verify: async ({ tenantId }) => {
      const authentication = await authenticationFor(tenantId);
      try {
        await authentication.authorization();
        return true;
      } catch {
        return false;
      }
    },
  };
};

export const createHostedCoworkerService = (options: {
  readonly client: Pick<ControlClient, "execute" | "batch">;
  readonly runtimeSecretsJson?: string;
  readonly runtimeSecretForTenant?: (tenantId: string) => string;
  readonly expectedRuntimeIdForTenant?: (tenantId: string) => string;
  readonly model?: CoworkerModelSource;
  readonly lifecycle?: Parameters<typeof createCoworkerService>[0]["lifecycle"];
  readonly fetch?: typeof globalThis.fetch;
}) => {
  const runtimeSecrets =
    options.runtimeSecretsJson === undefined
      ? undefined
      : runtimeSecretsSchema.parse(JSON.parse(options.runtimeSecretsJson) as unknown);
  const runtimeSecret = (tenantId: string) => {
    const webhookSecret = options.runtimeSecretForTenant?.(tenantId) ?? runtimeSecrets?.[tenantId];
    if (!webhookSecret) {
      throw new CoworkerError("runtime_unavailable", "The tenant runtime secret is not available for this coworker.");
    }
    return webhookSecret;
  };
  const runtimeBridge = (input: { tenantId: string; runtimeBaseUrl: string }) => {
    return tenantBridge({
      baseUrl: input.runtimeBaseUrl,
      webhookSecret: runtimeSecret(input.tenantId),
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
  };
  const runtimeCall = async <Value>(operation: () => Promise<Value>): Promise<Value> => {
    try {
      return await operation();
    } catch (cause) {
      if (cause instanceof CoworkerError) throw cause;
      throw new CoworkerError(
        "runtime_unavailable",
        "The authenticated tenant runtime bridge is unavailable. Retry the named operation.",
      );
    }
  };
  const runtime =
    runtimeSecrets || options.runtimeSecretForTenant
      ? {
          health: async (input: { tenantId: string; runtimeBaseUrl: string }) =>
            await runtimeCall(async () => {
              const health = await runtimeBridge(input).health();
              const expectedRuntimeId =
                options.expectedRuntimeIdForTenant?.(input.tenantId) ??
                runtimeInstallationId(runtimeSecret(input.tenantId));
              if (health.runtimeId !== expectedRuntimeId) {
                throw new CoworkerError(
                  "runtime_unavailable",
                  "The tenant runtime identity does not match its provisioned control-plane binding.",
                );
              }
              return health;
            }),
          pairing: async (input: { tenantId: string; runtimeBaseUrl: string }) =>
            await runtimeCall(async () => {
              const pairing = await runtimeBridge(input).pairing();
              if (pairing.status !== "paired") return pairing;
              const accountJid =
                "accountJid" in pairing && typeof pairing.accountJid === "string" ? pairing.accountJid : undefined;
              return accountJid === undefined ? pairing : { ...pairing, accountJid };
            }),
          chats: async (input: { tenantId: string; runtimeBaseUrl: string }) =>
            await runtimeCall(async () => await runtimeBridge(input).chats()),
        }
      : undefined;

  return createCoworkerService({
    client: options.client,
    ...(runtime === undefined ? {} : { runtime }),
    ...(options.model === undefined ? {} : { model: options.model }),
    ...(options.lifecycle === undefined ? {} : { lifecycle: options.lifecycle }),
  });
};
