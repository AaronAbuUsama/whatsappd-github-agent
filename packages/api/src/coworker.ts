import { createHash, randomUUID } from "node:crypto";

import type { openControlDb } from "@ambient-agent/db/control-db";
import { createManagedConfig } from "@ambient-agent/installation/schema.ts";

type ControlClient = Awaited<ReturnType<typeof openControlDb>>["client"];
type EntitlementStatus = "inactive" | "trialing" | "active" | "past_due" | "canceled";
type TenantStatus = "onboarding" | "active" | "suspended" | "archived";
type CapabilityState = "pending" | "healthy" | "degraded" | "repairing" | "failed" | "uncertain";
type OperationKind = "provision_setup" | "activate" | "restart" | "repair";
type OperationStatus = "pending" | "running" | "succeeded" | "failed" | "uncertain";
export type CoworkerNextAction =
  | "subscription"
  | "coworker"
  | "preparing"
  | "model"
  | "whatsapp"
  | "chats"
  | "github"
  | "activation"
  | "operate";

export type CoworkerBridgeHealth = {
  readonly ok: boolean;
  readonly runtimeId: string;
  readonly runtime: {
    readonly state: "stopped" | "starting" | "healthy" | "failed";
    readonly whatsapp: {
      readonly phase: "disabled" | "starting" | "pairing" | "online" | "failed" | "stopped";
    };
  };
};
export type CoworkerBridgePairing =
  | {
      readonly status: "pairing";
      readonly method: "qr" | "pairing_code";
      readonly qr?: string;
      readonly code?: string;
      readonly expiresAt: number;
    }
  | { readonly status: "paired"; readonly accountJid?: string }
  | { readonly status: "not_pairing" };
export type CoworkerBridgeChats = readonly {
  readonly jid: string;
  readonly name: string;
  readonly kind: "group" | "direct";
  readonly lastActivityAt?: number;
}[];

export interface CoworkerRuntimeSource {
  health(input: { readonly tenantId: string; readonly runtimeBaseUrl: string }): Promise<CoworkerBridgeHealth>;
  pairing(input: { readonly tenantId: string; readonly runtimeBaseUrl: string }): Promise<CoworkerBridgePairing>;
  chats(input: { readonly tenantId: string; readonly runtimeBaseUrl: string }): Promise<CoworkerBridgeChats>;
}

export interface ModelAuthorizationChallenge {
  readonly verificationUrl: string;
  readonly userCode: string;
  readonly expiresAt: number;
}

export interface CoworkerModelSource {
  beginAuth(input: {
    readonly tenantId: string;
    readonly operationIdentity: string;
    readonly signal: AbortSignal;
  }): Promise<{ readonly challenge: ModelAuthorizationChallenge; readonly completion: Promise<void> }>;
  verify(input: { readonly tenantId: string }): Promise<boolean>;
}

export interface CoworkerLifecycleSource {
  reconcileTenant(tenantId: string): Promise<{
    readonly status: "not_found" | "lease_busy" | "lease_lost" | "stopped" | "running" | "blocked" | "retryable_error";
    readonly errorCode?: string;
  }>;
}

export interface CoworkerCapability {
  readonly state: CapabilityState;
  readonly detail: string;
  readonly observedAtMs: number | null;
  readonly stale: boolean;
}

export interface CoworkerOperation {
  readonly id: string;
  readonly kind: OperationKind;
  readonly status: OperationStatus;
  readonly operationIdentity: string;
  readonly targetConfigVersion: number | null;
  readonly errorCode: string | null;
  readonly startedAtMs: number;
  readonly settledAtMs: number | null;
}

export interface GitHubRoleSnapshot {
  readonly role: "coder" | "reviewer" | "planner";
  readonly status: "missing" | "pending" | "installed" | "revoked" | "failed";
  readonly accountLogin: string | null;
  readonly selectedRepositories: number;
  readonly hasDefaultRepository: boolean;
}

export interface CoworkerSnapshot {
  readonly entitlement: { readonly status: EntitlementStatus; readonly entitled: boolean };
  readonly tenant: null | {
    readonly id: string;
    readonly displayName: string;
    readonly status: TenantStatus;
    readonly configVersion: number;
    readonly desiredState: "stopped" | "running" | "deleted";
    readonly createdAtMs: number;
  };
  readonly configurationRevision: null | {
    readonly configVersion: number;
    readonly basisFingerprint: string;
  };
  readonly nextAction: CoworkerNextAction;
  readonly readiness: "onboarding" | "healthy" | "degraded" | "suspended";
  readonly capabilities: {
    readonly subscription: CoworkerCapability;
    readonly workspace: CoworkerCapability;
    readonly model: CoworkerCapability;
    readonly whatsapp: CoworkerCapability;
    readonly chats: CoworkerCapability;
    readonly github: CoworkerCapability;
  };
  readonly github: readonly GitHubRoleSnapshot[];
  readonly managedChats: readonly {
    readonly jid: string;
    readonly displayName: string;
    readonly kind: "group" | "direct";
  }[];
  readonly operations: readonly CoworkerOperation[];
}

export class CoworkerError extends Error {
  override readonly name = "CoworkerError";

  constructor(
    readonly code:
      | "entitlement_required"
      | "invalid_name"
      | "tenant_not_found"
      | "operation_identity_conflict"
      | "stale_revision"
      | "incomplete_capabilities"
      | "runtime_unavailable"
      | "runtime_unhealthy"
      | "managed_chat_invalid"
      | "model_store_unavailable",
    message: string,
  ) {
    super(message);
  }
}

export interface CoworkerService {
  snapshot(userId: string): Promise<CoworkerSnapshot>;
  refresh(userId: string): Promise<CoworkerSnapshot>;
  create(
    userId: string,
    input: { readonly displayName: string; readonly operationIdentity: string },
  ): Promise<CoworkerSnapshot>;
  ensureSetup(userId: string, input: { readonly operationIdentity: string }): Promise<CoworkerOperation>;
  reconcileOperation(userId: string, input: { readonly operationId: string }): Promise<CoworkerOperation>;
  beginModelAuth(
    userId: string,
    input: { readonly operationIdentity: string },
  ): Promise<ModelAuthorizationChallenge & { readonly operationIdentity: string }>;
  verifyModel(userId: string): Promise<{ readonly ready: boolean }>;
  pairing(userId: string): Promise<CoworkerBridgePairing>;
  listManagedChats(userId: string): Promise<CoworkerBridgeChats>;
  selectManagedChats(userId: string, input: { readonly jids: readonly string[] }): Promise<CoworkerSnapshot>;
  activate(
    userId: string,
    input: {
      readonly expectedConfigVersion: number;
      readonly expectedBasisFingerprint: string;
      readonly operationIdentity: string;
    },
  ): Promise<CoworkerOperation>;
  applyGitHubConfiguration(
    userId: string,
    input: {
      readonly expectedConfigVersion: number;
      readonly expectedBasisFingerprint: string;
      readonly operationIdentity: string;
    },
  ): Promise<CoworkerOperation>;
  restartRuntime(userId: string, input: { readonly operationIdentity: string }): Promise<CoworkerOperation>;
  beginWhatsappRepair(userId: string, input: { readonly operationIdentity: string }): Promise<CoworkerOperation>;
}

interface OwnedTenant {
  readonly id: string;
  readonly status: TenantStatus;
  readonly configVersion: number;
  readonly runtimeBaseUrl: string | null;
}

interface ActivationRepository {
  readonly role: (typeof roles)[number];
  readonly installationId: number;
  readonly repositoryId: number;
  readonly owner: string;
  readonly name: string;
  readonly isDefault: boolean;
}

interface ActivationBasis {
  readonly chatsJson: string;
  readonly githubJson: string;
  readonly managedChats: readonly string[];
  readonly repositories: readonly ActivationRepository[];
}

const roles = ["coder", "reviewer", "planner"] as const;
const entitledStatuses: readonly EntitlementStatus[] = ["active", "trialing"];
const reservedNames = new Set(["admin", "ambient agent", "support", "system"]);

const text = (value: unknown): string | null => (typeof value === "string" ? value : null);
const number = (value: unknown): number | null => (typeof value === "number" ? value : null);
const bool = (value: unknown): boolean => Number(value) === 1;
const rowObject = (value: unknown): Record<string, unknown> => value as Record<string, unknown>;

const validateName = (value: string): string => {
  const normalized = value.trim().replaceAll(/\s+/gu, " ");
  if (
    normalized.length < 2 ||
    normalized.length > 48 ||
    [...normalized].some((character) => {
      const point = character.codePointAt(0) ?? 0;
      return point < 32 || point === 127;
    }) ||
    reservedNames.has(normalized.toLocaleLowerCase("en"))
  ) {
    throw new CoworkerError("invalid_name", "Choose a coworker name between 2 and 48 characters.");
  }
  return normalized;
};

const operationFromRow = (row: Record<string, unknown>): CoworkerOperation => ({
  id: String(row.id),
  kind: String(row.kind) as OperationKind,
  status: String(row.status) as OperationStatus,
  operationIdentity: String(row.operation_identity),
  targetConfigVersion: number(row.target_config_version),
  errorCode: text(row.error_code),
  startedAtMs: Number(row.started_at_ms),
  settledAtMs: number(row.settled_at_ms),
});

const activationFingerprint = (configVersion: number, basis: ActivationBasis): string =>
  createHash("sha256")
    .update(`ambient-agent-activation\0${configVersion}\0${basis.chatsJson}\0${basis.githubJson}`)
    .digest("hex");

const operationCapability = (
  operation: CoworkerOperation | undefined,
): Pick<CoworkerCapability, "state" | "detail"> | undefined => {
  if (!operation) return undefined;
  if (operation.status === "pending" || operation.status === "running") {
    return { state: "repairing", detail: "A durable repair operation is in progress." };
  }
  if (operation.status === "uncertain") {
    return {
      state: "uncertain",
      detail: "The last remote result is uncertain and must be reconciled before retrying.",
    };
  }
  if (operation.status === "failed") {
    return { state: "failed", detail: operation.errorCode ?? "The last operation failed and can be retried." };
  }
  return undefined;
};

export const createCoworkerService = (options: {
  readonly client: Pick<ControlClient, "execute" | "batch">;
  readonly runtime?: CoworkerRuntimeSource;
  readonly model?: CoworkerModelSource;
  readonly lifecycle?: CoworkerLifecycleSource;
  readonly now?: () => number;
  readonly staleAfterMs?: number;
  readonly id?: () => string;
}): CoworkerService => {
  const now = options.now ?? Date.now;
  const staleAfterMs = options.staleAfterMs ?? 120_000;
  const newId = options.id ?? randomUUID;
  const modelAttempts = new Map<
    string,
    {
      readonly operationIdentity: string;
      readonly controller: AbortController;
      readonly challenge: ModelAuthorizationChallenge;
    }
  >();

  const stale = (observedAtMs: number | null): boolean => observedAtMs !== null && now() - observedAtMs > staleAfterMs;

  const ownedTenant = async (userId: string): Promise<OwnedTenant> => {
    const result = await options.client.execute({
      sql: `SELECT tenant.id, tenant.status, tenant.config_version, agent_instance.runtime_base_url
              FROM tenant
              LEFT JOIN agent_instance ON agent_instance.tenant_id = tenant.id
             WHERE tenant.user_id = ?1`,
      args: [userId],
    });
    const row = result.rows[0];
    if (!row) throw new CoworkerError("tenant_not_found", "Create a coworker before using this operation.");
    return {
      id: String(row.id),
      status: String(row.status) as TenantStatus,
      configVersion: Number(row.config_version),
      runtimeBaseUrl: text(row.runtime_base_url),
    };
  };

  const requireEntitledTenant = async (userId: string): Promise<OwnedTenant> => {
    const tenant = await ownedTenant(userId);
    const result = await options.client.execute({
      sql: `SELECT 1
              FROM tenant
              JOIN subscription_entitlement
                ON subscription_entitlement.id = tenant.subscription_entitlement_id
               AND subscription_entitlement.user_id = tenant.user_id
             WHERE tenant.id = ?1
               AND subscription_entitlement.status IN ('active', 'trialing')`,
      args: [tenant.id],
    });
    if (!result.rows[0]) {
      throw new CoworkerError(
        "entitlement_required",
        "Restore an active hosted plan before changing or contacting this coworker.",
      );
    }
    return tenant;
  };

  const existingOperation = async (tenantId: string, identity: string): Promise<CoworkerOperation | null> => {
    const result = await options.client.execute({
      sql: `SELECT id, kind, status, operation_identity, target_config_version, error_code,
                   started_at_ms, settled_at_ms
              FROM control_operation
             WHERE tenant_id = ?1 AND operation_identity = ?2`,
      args: [tenantId, identity],
    });
    return result.rows[0] ? operationFromRow(rowObject(result.rows[0])) : null;
  };

  const unsettledOperation = async (tenantId: string, kind?: OperationKind): Promise<CoworkerOperation | null> => {
    const result = await options.client.execute({
      sql: `SELECT id, kind, status, operation_identity, target_config_version, error_code,
                   started_at_ms, settled_at_ms
              FROM control_operation
             WHERE tenant_id = ?1
               AND (?2 IS NULL OR kind = ?2)
               AND status IN ('pending', 'running', 'uncertain')
             ORDER BY started_at_ms DESC, id DESC
             LIMIT 1`,
      args: [tenantId, kind ?? null],
    });
    return result.rows[0] ? operationFromRow(rowObject(result.rows[0])) : null;
  };

  const requireOperationIdentity = (
    operation: CoworkerOperation,
    kind: OperationKind,
    targetConfigVersion: number | null,
  ): CoworkerOperation => {
    if (operation.kind !== kind || operation.targetConfigVersion !== targetConfigVersion) {
      throw new CoworkerError(
        "operation_identity_conflict",
        "This operation identity was already used for a different mutation.",
      );
    }
    return operation;
  };

  const enqueue = async (
    userId: string,
    input: { readonly kind: OperationKind; readonly operationIdentity: string; readonly targetConfigVersion?: number },
  ): Promise<{ readonly operation: CoworkerOperation; readonly created: boolean }> => {
    const tenant = await requireEntitledTenant(userId);
    const targetConfigVersion = input.targetConfigVersion ?? null;
    const duplicate = await existingOperation(tenant.id, input.operationIdentity);
    if (duplicate) {
      return { operation: requireOperationIdentity(duplicate, input.kind, targetConfigVersion), created: false };
    }
    const timestamp = now();
    const operationId = newId();
    await options.client.execute({
      sql: `INSERT INTO control_operation
              (id, tenant_id, kind, status, operation_identity, target_config_version, started_at_ms, updated_at_ms)
            SELECT ?1, ?2, ?3, 'pending', ?4, ?5, ?6, ?6
             WHERE EXISTS (
               SELECT 1
                 FROM tenant
                 JOIN subscription_entitlement
                   ON subscription_entitlement.id = tenant.subscription_entitlement_id
                  AND subscription_entitlement.user_id = tenant.user_id
                WHERE tenant.id = ?2
                  AND subscription_entitlement.status IN ('active', 'trialing')
             )
               AND NOT EXISTS (
               SELECT 1
                 FROM control_operation
                WHERE tenant_id = ?2 AND status IN ('pending', 'running', 'uncertain')
             )
            ON CONFLICT (tenant_id, operation_identity) DO NOTHING`,
      args: [operationId, tenant.id, input.kind, input.operationIdentity, targetConfigVersion, timestamp],
    });
    const operation = await existingOperation(tenant.id, input.operationIdentity);
    if (operation) {
      return {
        operation: requireOperationIdentity(operation, input.kind, targetConfigVersion),
        created: operation.id === operationId,
      };
    }
    await requireEntitledTenant(userId);
    const blocked = await unsettledOperation(tenant.id);
    throw new CoworkerError(
      "operation_identity_conflict",
      blocked
        ? `The existing ${blocked.kind} operation is ${blocked.status}; reconcile it before starting another mutation.`
        : `The ${input.kind} operation could not be claimed. Refresh its durable state before retrying.`,
    );
  };

  const readActivationBasis = async (tenantId: string): Promise<ActivationBasis> => {
    const basisResult = await options.client.execute({
      sql: `SELECT
              (SELECT json_group_array(jid)
                 FROM (SELECT jid FROM tenant_managed_chat WHERE tenant_id = ?1 ORDER BY jid)) AS chats_json,
              (SELECT json_group_array(json_object(
                  'role', installation_role,
                  'installationId', installation_id,
                  'repositoryId', repository_id,
                  'owner', owner,
                  'name', name,
                  'isDefault', is_default
                ))
                 FROM (
                   SELECT github_repository.installation_role, github_repository.installation_id,
                          github_repository.repository_id, github_repository.owner, github_repository.name,
                          github_repository.is_default
                     FROM github_repository
                     JOIN github_installation
                       ON github_installation.tenant_id = github_repository.tenant_id
                      AND github_installation.role = github_repository.installation_role
                      AND github_installation.installation_id = github_repository.installation_id
                    WHERE github_repository.tenant_id = ?1
                      AND github_installation.status = 'installed'
                      AND github_repository.selected = 1
                    ORDER BY github_repository.installation_role, github_repository.repository_id
                 )) AS github_json`,
      args: [tenantId],
    });
    const basis = rowObject(basisResult.rows[0] ?? {});
    const chatsJson = text(basis.chats_json) ?? "[]";
    const githubJson = text(basis.github_json) ?? "[]";
    const managedChats = JSON.parse(chatsJson) as unknown;
    if (!Array.isArray(managedChats) || !managedChats.every((jid) => typeof jid === "string")) {
      throw new CoworkerError("incomplete_capabilities", "Managed Chat configuration could not be rendered.");
    }
    const rawRepositories = JSON.parse(githubJson) as unknown;
    if (!Array.isArray(rawRepositories)) {
      throw new CoworkerError("incomplete_capabilities", "GitHub configuration could not be rendered.");
    }
    const repositories = rawRepositories.map((value): ActivationRepository => {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new CoworkerError("incomplete_capabilities", "GitHub configuration could not be rendered.");
      }
      const repository = rowObject(value);
      const role = text(repository.role);
      if (
        !roles.includes(role as ActivationRepository["role"]) ||
        typeof repository.installationId !== "number" ||
        typeof repository.repositoryId !== "number" ||
        typeof repository.owner !== "string" ||
        typeof repository.name !== "string"
      ) {
        throw new CoworkerError("incomplete_capabilities", "GitHub configuration could not be rendered.");
      }
      return {
        role: role as ActivationRepository["role"],
        installationId: repository.installationId,
        repositoryId: repository.repositoryId,
        owner: repository.owner,
        name: repository.name,
        isDefault: bool(repository.isDefault),
      };
    });
    return { chatsJson, githubJson, managedChats, repositories };
  };

  const renderManagedConfiguration = (basis: ActivationBasis): string => {
    const plannerDefault = basis.repositories.find(
      (repository) => repository.role === "planner" && repository.isDefault,
    );
    const repositoryRoles = new Set(
      basis.repositories.filter((repository) => repository.isDefault).map(({ role }) => role),
    );
    if (basis.managedChats.length === 0 || !plannerDefault || roles.some((role) => !repositoryRoles.has(role))) {
      throw new CoworkerError(
        "incomplete_capabilities",
        "A complete configuration requires Managed Chats and a selected default repository for every GitHub App role.",
      );
    }
    const defaultRepository = `${plannerDefault.owner}/${plannerDefault.name}`;
    const allowedRepositories = [
      ...new Set(
        basis.repositories
          .filter((repository) => repository.role === "planner")
          .map((repository) => `${repository.owner}/${repository.name}`),
      ),
    ].sort();
    const baseConfig = createManagedConfig(basis.managedChats, defaultRepository);
    return JSON.stringify({
      ...baseConfig,
      github: { ...baseConfig.github, allowedRepositories },
    });
  };

  const runtimeInput = async (userId: string) => {
    const tenant = await requireEntitledTenant(userId);
    if (!options.runtime || !tenant.runtimeBaseUrl) {
      throw new CoworkerError(
        "runtime_unavailable",
        "The tenant runtime is not reachable yet. Retry the named setup operation.",
      );
    }
    return { tenant, source: options.runtime, input: { tenantId: tenant.id, runtimeBaseUrl: tenant.runtimeBaseUrl } };
  };

  const reconcileLifecycle = async (userId: string, operation: CoworkerOperation): Promise<CoworkerOperation> => {
    if (!options.lifecycle || !["pending", "running", "uncertain"].includes(operation.status)) return operation;
    const tenant = await ownedTenant(userId);
    const entitlement = await options.client.execute({
      sql: `SELECT 1
              FROM tenant
              JOIN subscription_entitlement
                ON subscription_entitlement.id = tenant.subscription_entitlement_id
               AND subscription_entitlement.user_id = tenant.user_id
             WHERE tenant.id = ?1
               AND subscription_entitlement.status IN ('active', 'trialing')`,
      args: [tenant.id],
    });
    if (!entitlement.rows[0]) {
      const timestamp = now();
      await options.client.execute({
        sql: `UPDATE control_operation
                 SET status = 'failed', error_code = 'entitlement_required',
                     settled_at_ms = COALESCE(settled_at_ms, ?3), updated_at_ms = ?3
               WHERE id = ?1 AND tenant_id = ?2 AND status IN ('pending', 'running', 'uncertain')`,
        args: [operation.id, tenant.id, timestamp],
      });
      return (await existingOperation(tenant.id, operation.operationIdentity)) ?? operation;
    }
    const result = await options.lifecycle.reconcileTenant(tenant.id);
    const timestamp = now();
    if (result.status === "running" && operation.kind !== "repair") {
      if (operation.kind === "activate") {
        await options.client.batch(
          [
            {
              sql: `UPDATE control_operation
                       SET status = 'succeeded', error_code = NULL, settled_at_ms = ?3, updated_at_ms = ?3
                     WHERE id = ?1 AND tenant_id = ?2 AND status IN ('pending', 'running', 'uncertain')
                       AND EXISTS (
                         SELECT 1 FROM agent_instance
                          WHERE tenant_id = ?2 AND desired_mode = 'operate'
                            AND observed_state = 'healthy'
                            AND applied_config_version = control_operation.target_config_version
                       )`,
              args: [operation.id, tenant.id, timestamp],
            },
            {
              sql: `UPDATE tenant
                       SET status = 'active', updated_at_ms = ?3
                     WHERE id = ?1 AND status = 'onboarding'
                       AND EXISTS (
                         SELECT 1 FROM control_operation
                          WHERE id = ?2 AND tenant_id = ?1 AND status = 'succeeded'
                       )`,
              args: [tenant.id, operation.id, timestamp],
            },
          ],
          "write",
        );
      } else {
        await options.client.execute({
          sql: `UPDATE control_operation
                   SET status = 'succeeded', error_code = NULL, settled_at_ms = ?3, updated_at_ms = ?3
                 WHERE id = ?1 AND tenant_id = ?2 AND status IN ('pending', 'running', 'uncertain')
                   AND (
                     target_config_version IS NULL
                     OR EXISTS (
                       SELECT 1 FROM agent_instance
                        WHERE tenant_id = ?2 AND desired_mode = 'operate'
                          AND observed_state = 'healthy'
                          AND applied_config_version = control_operation.target_config_version
                     )
                   )`,
          args: [operation.id, tenant.id, timestamp],
        });
      }
    } else if (result.status === "running" && operation.kind === "repair") {
      await options.client.execute({
        sql: `UPDATE control_operation
                 SET status = 'succeeded', error_code = NULL,
                     settled_at_ms = COALESCE(settled_at_ms, ?3), updated_at_ms = ?3
               WHERE id = ?1 AND tenant_id = ?2 AND status IN ('pending', 'running', 'uncertain')
                 AND EXISTS (
                   SELECT 1 FROM agent_instance
                    WHERE tenant_id = ?2 AND desired_mode = 'operate'
                      AND observed_state = 'healthy'
                      AND applied_config_version = (SELECT config_version FROM tenant WHERE id = ?2)
                 )
                 AND EXISTS (
                   SELECT 1 FROM whatsapp_connection
                    WHERE tenant_id = ?2 AND status = 'online' AND account_jid IS NOT NULL
                      AND observed_at_ms >= ?4
                 )`,
        args: [operation.id, tenant.id, timestamp, timestamp - staleAfterMs],
      });
    } else if (result.status === "blocked") {
      await options.client.execute({
        sql: `UPDATE control_operation
                 SET status = 'uncertain', error_code = ?3,
                     settled_at_ms = COALESCE(settled_at_ms, ?4), updated_at_ms = ?4
               WHERE id = ?1 AND tenant_id = ?2 AND status IN ('pending', 'running', 'uncertain')`,
        args: [operation.id, tenant.id, result.errorCode ?? "remote_outcome_unknown", timestamp],
      });
    } else if (result.status === "retryable_error" || result.status === "not_found") {
      await options.client.execute({
        sql: `UPDATE control_operation
                 SET status = 'failed', error_code = ?3,
                     settled_at_ms = COALESCE(settled_at_ms, ?4), updated_at_ms = ?4
               WHERE id = ?1 AND tenant_id = ?2 AND status IN ('pending', 'running', 'uncertain')`,
        args: [operation.id, tenant.id, result.errorCode ?? `provisioner_${result.status}`, timestamp],
      });
    }
    return (await existingOperation(tenant.id, operation.operationIdentity)) ?? operation;
  };

  const snapshot = async (userId: string): Promise<CoworkerSnapshot> => {
    const primary = await options.client.execute({
      sql: `SELECT
              subscription_entitlement.status AS entitlement_status,
              tenant.id AS tenant_id,
              tenant.display_name,
              tenant.status AS tenant_status,
              tenant.config_version,
              tenant.desired_state,
              tenant.tenant_db_url,
              tenant.tenant_db_token_ciphertext,
              tenant.created_at_ms,
              agent_instance.desired_mode,
              agent_instance.observed_state,
              agent_instance.observed_at_ms AS runtime_observed_at_ms,
              agent_instance.runtime_base_url,
              agent_instance.applied_config_version,
              model_connection.status AS model_status,
              model_connection.verified_at_ms,
              model_connection.updated_at_ms AS model_updated_at_ms,
              whatsapp_connection.status AS whatsapp_status,
              whatsapp_connection.observed_at_ms AS whatsapp_observed_at_ms,
              managed_chat_selection.status AS chat_selection_status,
              managed_chat_selection.selected_at_ms,
              delivery_route.status AS delivery_status,
              delivery_route.observed_at_ms AS delivery_observed_at_ms
            FROM user
            LEFT JOIN subscription_entitlement ON subscription_entitlement.user_id = user.id
            LEFT JOIN tenant ON tenant.user_id = user.id
            LEFT JOIN agent_instance ON agent_instance.tenant_id = tenant.id
            LEFT JOIN model_connection ON model_connection.tenant_id = tenant.id
            LEFT JOIN whatsapp_connection ON whatsapp_connection.tenant_id = tenant.id
            LEFT JOIN managed_chat_selection ON managed_chat_selection.tenant_id = tenant.id
            LEFT JOIN delivery_route ON delivery_route.tenant_id = tenant.id
           WHERE user.id = ?1`,
      args: [userId],
    });
    const primaryRow = primary.rows[0] ? rowObject(primary.rows[0]) : {};
    const entitlementStatus = (text(primaryRow.entitlement_status) ?? "inactive") as EntitlementStatus;
    const tenantId = text(primaryRow.tenant_id);
    const entitlementHealthy = entitledStatuses.includes(entitlementStatus);
    const subscription: CoworkerCapability = {
      state: entitlementHealthy ? "healthy" : "failed",
      detail: entitlementHealthy
        ? "The hosted plan is entitled."
        : "Subscribe or restore billing to run this coworker.",
      observedAtMs: null,
      stale: false,
    };
    if (!tenantId) {
      return {
        entitlement: { status: entitlementStatus, entitled: entitlementHealthy },
        tenant: null,
        configurationRevision: null,
        nextAction: entitlementHealthy ? "coworker" : "subscription",
        readiness: "onboarding",
        capabilities: {
          subscription,
          workspace: { state: "pending", detail: "Create a coworker first.", observedAtMs: null, stale: false },
          model: { state: "pending", detail: "No tenant credential is connected.", observedAtMs: null, stale: false },
          whatsapp: { state: "pending", detail: "No WhatsApp account is paired.", observedAtMs: null, stale: false },
          chats: { state: "pending", detail: "No Managed Chats are selected.", observedAtMs: null, stale: false },
          github: { state: "pending", detail: "GitHub Apps are not connected.", observedAtMs: null, stale: false },
        },
        github: roles.map((role) => ({
          role,
          status: "missing",
          accountLogin: null,
          selectedRepositories: 0,
          hasDefaultRepository: false,
        })),
        managedChats: [],
        operations: [],
      };
    }

    const [githubResult, chatResult, operationResult] = await Promise.all([
      options.client.execute({
        sql: `SELECT github_installation.role, github_installation.status, github_installation.account_login,
                     count(CASE WHEN github_repository.selected = 1 THEN 1 END) AS selected_count,
                     max(CASE WHEN github_repository.is_default = 1 THEN 1 ELSE 0 END) AS has_default
                FROM github_installation
                LEFT JOIN github_repository
                  ON github_repository.tenant_id = github_installation.tenant_id
                 AND github_repository.installation_role = github_installation.role
                 AND github_repository.installation_id = github_installation.installation_id
               WHERE github_installation.tenant_id = ?1
               GROUP BY github_installation.role, github_installation.status, github_installation.account_login`,
        args: [tenantId],
      }),
      options.client.execute({
        sql: `SELECT jid, display_name, kind
                FROM tenant_managed_chat
               WHERE tenant_id = ?1
               ORDER BY lower(display_name), jid`,
        args: [tenantId],
      }),
      options.client.execute({
        sql: `SELECT id, kind, status, operation_identity, target_config_version, error_code,
                     started_at_ms, settled_at_ms
                FROM control_operation
               WHERE tenant_id = ?1
               ORDER BY started_at_ms DESC, id DESC
               LIMIT 12`,
        args: [tenantId],
      }),
    ]);
    const githubByRole = new Map(githubResult.rows.map((row) => [String(row.role), rowObject(row)]));
    const github: readonly GitHubRoleSnapshot[] = roles.map((role) => {
      const row = githubByRole.get(role);
      return {
        role,
        status: (text(row?.status) ?? "missing") as GitHubRoleSnapshot["status"],
        accountLogin: text(row?.account_login),
        selectedRepositories: Number(row?.selected_count ?? 0),
        hasDefaultRepository: bool(row?.has_default),
      };
    });
    const managedChats = chatResult.rows.map((row) => ({
      jid: String(row.jid),
      displayName: String(row.display_name),
      kind: String(row.kind) as "group" | "direct",
    }));
    const operations = operationResult.rows.map((row) => operationFromRow(rowObject(row)));
    const tenantStatus = String(primaryRow.tenant_status) as TenantStatus;
    const repairOperation = operations.find((operation) => operation.kind === "repair");
    const restartOperation = operations.find((operation) => operation.kind === "restart");
    const setupOperation = operations.find((operation) => operation.kind === "provision_setup");

    const runtimeObservedAtMs = number(primaryRow.runtime_observed_at_ms);
    const runtimeStale = stale(runtimeObservedAtMs);
    const runtimeState = text(primaryRow.observed_state);
    const runtimeOperation =
      operationCapability(restartOperation) ??
      (tenantStatus === "onboarding" ? operationCapability(setupOperation) : undefined);
    const workspace: CoworkerCapability = runtimeOperation
      ? { ...runtimeOperation, observedAtMs: runtimeObservedAtMs, stale: runtimeStale }
      : runtimeState === "healthy" && text(primaryRow.runtime_base_url) && !runtimeStale
        ? {
            state: "healthy",
            detail: "The private tenant runtime is healthy.",
            observedAtMs: runtimeObservedAtMs,
            stale: false,
          }
        : runtimeState === "failed"
          ? {
              state: "failed",
              detail: "The tenant runtime reported a failure.",
              observedAtMs: runtimeObservedAtMs,
              stale: false,
            }
          : runtimeState === "uncertain"
            ? {
                state: "uncertain",
                detail: "The latest remote runtime mutation has an uncertain result.",
                observedAtMs: runtimeObservedAtMs,
                stale: runtimeStale,
              }
            : runtimeState === "healthy" && runtimeStale
              ? {
                  state: "degraded",
                  detail: "The last healthy runtime observation is stale.",
                  observedAtMs: runtimeObservedAtMs,
                  stale: true,
                }
              : {
                  state: "repairing",
                  detail: "The private workspace is being prepared.",
                  observedAtMs: runtimeObservedAtMs,
                  stale: runtimeStale,
                };

    const modelStatus = text(primaryRow.model_status) ?? "missing";
    const modelUpdatedAtMs = number(primaryRow.model_updated_at_ms);
    const modelValidationStale = modelStatus === "validating" && stale(modelUpdatedAtMs);
    const model: CoworkerCapability =
      modelStatus === "ready"
        ? {
            state: "healthy",
            detail: "A tenant-owned model credential is verified.",
            observedAtMs: number(primaryRow.verified_at_ms),
            stale: false,
          }
        : modelValidationStale
          ? {
              state: "uncertain",
              detail: "The model authorization attempt expired without a settled result. Start a named retry.",
              observedAtMs: modelUpdatedAtMs,
              stale: true,
            }
          : modelStatus === "validating"
            ? {
                state: "repairing",
                detail: "Model authorization is being validated.",
                observedAtMs: modelUpdatedAtMs,
                stale: false,
              }
            : modelStatus === "invalid" || modelStatus === "revoked"
              ? { state: "failed", detail: "The model credential must be replaced.", observedAtMs: null, stale: false }
              : {
                  state: "pending",
                  detail: "Connect a tenant-owned model credential.",
                  observedAtMs: null,
                  stale: false,
                };

    const whatsappObservedAtMs = number(primaryRow.whatsapp_observed_at_ms);
    const whatsappStale = stale(whatsappObservedAtMs);
    const whatsappStatus = text(primaryRow.whatsapp_status) ?? "unpaired";
    const whatsappOperation = operationCapability(repairOperation);
    const whatsapp: CoworkerCapability = whatsappOperation
      ? { ...whatsappOperation, observedAtMs: whatsappObservedAtMs, stale: whatsappStale }
      : whatsappStatus === "online" && !whatsappStale
        ? { state: "healthy", detail: "WhatsApp is online.", observedAtMs: whatsappObservedAtMs, stale: false }
        : whatsappStatus === "online"
          ? {
              state: "degraded",
              detail: "The last WhatsApp observation is stale.",
              observedAtMs: whatsappObservedAtMs,
              stale: true,
            }
          : whatsappStatus === "pairing"
            ? {
                state: "repairing",
                detail: "WhatsApp pairing is in progress.",
                observedAtMs: whatsappObservedAtMs,
                stale: false,
              }
            : whatsappStatus === "failed" || whatsappStatus === "re_pair_required"
              ? {
                  state: "failed",
                  detail: "WhatsApp needs an explicit re-pair.",
                  observedAtMs: whatsappObservedAtMs,
                  stale: false,
                }
              : { state: "pending", detail: "Pair the tenant WhatsApp account.", observedAtMs: null, stale: false };

    const chatSelectionComplete = text(primaryRow.chat_selection_status) === "selected" && managedChats.length > 0;
    const chats: CoworkerCapability = chatSelectionComplete
      ? {
          state: "healthy",
          detail: `${managedChats.length} Managed Chat${managedChats.length === 1 ? "" : "s"} selected.`,
          observedAtMs: number(primaryRow.selected_at_ms),
          stale: false,
        }
      : { state: "pending", detail: "Select at least one real WhatsApp chat.", observedAtMs: null, stale: false };

    const githubSelectionsComplete = github.every(
      (installation) =>
        installation.status === "installed" &&
        installation.selectedRepositories > 0 &&
        installation.hasDefaultRepository,
    );
    const githubFailed = github.some(
      (installation) => installation.status === "failed" || installation.status === "revoked",
    );
    const deliveryObservedAtMs = number(primaryRow.delivery_observed_at_ms);
    const deliveryStale = stale(deliveryObservedAtMs);
    const activated = (text(primaryRow.tenant_status) as TenantStatus) !== "onboarding";
    const routeReady = text(primaryRow.delivery_status) === "ready" && !deliveryStale;
    const githubCapability: CoworkerCapability = githubFailed
      ? {
          state: "failed",
          detail: "A GitHub App installation was revoked or failed.",
          observedAtMs: deliveryObservedAtMs,
          stale: deliveryStale,
        }
      : githubSelectionsComplete && (!activated || routeReady)
        ? {
            state: "healthy",
            detail: "All three GitHub roles have a selected default repository.",
            observedAtMs: deliveryObservedAtMs,
            stale: activated && deliveryStale,
          }
        : githubSelectionsComplete && activated
          ? {
              state: "degraded",
              detail: "GitHub is configured, but the authenticated delivery route needs verification.",
              observedAtMs: deliveryObservedAtMs,
              stale: deliveryStale,
            }
          : {
              state: "pending",
              detail: "Connect each GitHub role and choose its default repository.",
              observedAtMs: null,
              stale: false,
            };

    const operationEntry = tenantStatus === "active" || tenantStatus === "suspended" || tenantStatus === "archived";
    const nextAction: CoworkerNextAction = operationEntry
      ? "operate"
      : !entitlementHealthy
        ? "subscription"
        : workspace.state !== "healthy"
          ? "preparing"
          : model.state !== "healthy"
            ? "model"
            : whatsapp.state !== "healthy"
              ? "whatsapp"
              : chats.state !== "healthy"
                ? "chats"
                : !githubSelectionsComplete
                  ? "github"
                  : "activation";
    const allOperateCapabilitiesHealthy =
      workspace.state === "healthy" &&
      model.state === "healthy" &&
      whatsapp.state === "healthy" &&
      chats.state === "healthy" &&
      githubCapability.state === "healthy" &&
      text(primaryRow.desired_mode) === "operate" &&
      Number(primaryRow.applied_config_version) === Number(primaryRow.config_version);
    const readiness =
      !entitlementHealthy || tenantStatus === "suspended" || tenantStatus === "archived"
        ? "suspended"
        : tenantStatus !== "active"
          ? "onboarding"
          : allOperateCapabilitiesHealthy
            ? "healthy"
            : "degraded";

    const basis = tenantStatus === "archived" ? null : await readActivationBasis(tenantId);

    return {
      entitlement: { status: entitlementStatus, entitled: entitlementHealthy },
      tenant: {
        id: tenantId,
        displayName: String(primaryRow.display_name),
        status: tenantStatus,
        configVersion: Number(primaryRow.config_version),
        desiredState: String(primaryRow.desired_state) as "stopped" | "running" | "deleted",
        createdAtMs: Number(primaryRow.created_at_ms),
      },
      configurationRevision:
        basis === null
          ? null
          : {
              configVersion: Number(primaryRow.config_version),
              basisFingerprint: activationFingerprint(Number(primaryRow.config_version), basis),
            },
      nextAction,
      readiness,
      capabilities: { subscription, workspace, model, whatsapp, chats, github: githubCapability },
      github,
      managedChats,
      operations,
    };
  };

  const refresh = async (userId: string): Promise<CoworkerSnapshot> => {
    let tenant: OwnedTenant;
    try {
      tenant = await ownedTenant(userId);
    } catch (cause) {
      if (cause instanceof CoworkerError && cause.code === "tenant_not_found") return await snapshot(userId);
      throw cause;
    }
    const entitlement = await options.client.execute({
      sql: `SELECT tenant.desired_state
              FROM tenant
              JOIN subscription_entitlement
                ON subscription_entitlement.id = tenant.subscription_entitlement_id
               AND subscription_entitlement.user_id = tenant.user_id
             WHERE tenant.id = ?1
               AND subscription_entitlement.status IN ('active', 'trialing')`,
      args: [tenant.id],
    });
    const isEntitled = Boolean(entitlement.rows[0]);
    const operation = await unsettledOperation(tenant.id);
    if (
      isEntitled &&
      entitlement.rows[0]?.desired_state === "stopped" &&
      (tenant.status === "active" || tenant.status === "onboarding")
    ) {
      const timestamp = now();
      const desiredMode =
        operation?.kind === "repair" || operation?.kind === "provision_setup"
          ? "setup"
          : operation?.kind === "activate" || operation?.kind === "restart"
            ? "operate"
            : tenant.status === "active"
              ? "operate"
              : "setup";
      await options.client.batch(
        [
          {
            sql: `UPDATE tenant
                     SET desired_state = 'running', updated_at_ms = ?3
                   WHERE id = ?1 AND status = ?2 AND desired_state = 'stopped'
                     AND EXISTS (
                       SELECT 1 FROM subscription_entitlement
                        WHERE id = tenant.subscription_entitlement_id
                          AND user_id = tenant.user_id
                          AND status IN ('active', 'trialing')
                     )`,
            args: [tenant.id, tenant.status, timestamp],
          },
          {
            sql: `UPDATE agent_instance
                     SET desired_mode = ?2, updated_at_ms = ?3
                   WHERE tenant_id = ?1
                     AND EXISTS (
                       SELECT 1 FROM tenant
                       JOIN subscription_entitlement
                         ON subscription_entitlement.id = tenant.subscription_entitlement_id
                        AND subscription_entitlement.user_id = tenant.user_id
                        AND subscription_entitlement.status IN ('active', 'trialing')
                        WHERE tenant.id = ?1 AND tenant.status = ?4
                          AND tenant.desired_state = 'running'
                     )`,
            args: [tenant.id, desiredMode, timestamp, tenant.status],
          },
        ],
        "write",
      );
    }
    if (options.lifecycle) {
      if (isEntitled && operation) await reconcileLifecycle(userId, operation);
      else await options.lifecycle.reconcileTenant(tenant.id);
    }
    if (isEntitled && options.runtime && tenant.runtimeBaseUrl) {
      try {
        const health = await options.runtime.health({ tenantId: tenant.id, runtimeBaseUrl: tenant.runtimeBaseUrl });
        const timestamp = now();
        await options.client.batch(
          [
            {
              sql: `UPDATE agent_instance
                       SET observed_state = ?2, observed_at_ms = ?3, updated_at_ms = ?3
                     WHERE tenant_id = ?1`,
              args: [tenant.id, health.runtime.state === "healthy" ? "healthy" : health.runtime.state, timestamp],
            },
            ...(health.ok && health.runtime.state === "healthy" && health.runtime.whatsapp.phase === "online"
              ? [
                  {
                    sql: `UPDATE whatsapp_connection
                             SET status = 'online', observed_at_ms = ?2, updated_at_ms = ?2
                           WHERE tenant_id = ?1 AND account_jid IS NOT NULL`,
                    args: [tenant.id, timestamp],
                  },
                ]
              : []),
          ],
          "write",
        );
      } catch {
        // Preserve the last sanitized observation; snapshot staleness exposes an unreachable runtime without fabricating state.
      }
    }
    return await snapshot(userId);
  };

  const create = async (
    userId: string,
    input: { readonly displayName: string; readonly operationIdentity: string },
  ): Promise<CoworkerSnapshot> => {
    const duplicate = await snapshot(userId);
    if (duplicate.tenant) return duplicate;
    if (!duplicate.entitlement.entitled) {
      throw new CoworkerError("entitlement_required", "An active hosted plan is required before creating a coworker.");
    }
    const displayName = validateName(input.displayName);
    const tenantId = newId();
    const tenantDbName = `tenant-${tenantId}`;
    const agentId = newId();
    const operationId = newId();
    const timestamp = now();
    const entitlement = await options.client.execute({
      sql: `SELECT id FROM subscription_entitlement
             WHERE user_id = ?1 AND status IN ('active', 'trialing')`,
      args: [userId],
    });
    const entitlementId = text(entitlement.rows[0]?.id);
    if (!entitlementId) {
      throw new CoworkerError("entitlement_required", "An active hosted plan is required before creating a coworker.");
    }
    try {
      await options.client.batch(
        [
          {
            sql: `INSERT INTO tenant
                    (id, user_id, subscription_entitlement_id, display_name, status, tenant_db_name,
                     desired_state, created_at_ms, updated_at_ms)
                  SELECT ?1, ?2, subscription_entitlement.id, ?4, 'onboarding', ?5, 'running', ?6, ?6
                    FROM subscription_entitlement
                   WHERE subscription_entitlement.id = ?3
                     AND subscription_entitlement.user_id = ?2
                     AND subscription_entitlement.status IN ('active', 'trialing')`,
            args: [tenantId, userId, entitlementId, displayName, tenantDbName, timestamp],
          },
          {
            sql: `INSERT INTO agent_instance
                    (id, tenant_id, creds_store_key, desired_mode, observed_state, dokploy_display_name,
                     dokploy_creation_token, phase, updated_at_ms)
                  VALUES (?1, ?2, ?3, 'setup', 'absent', ?4, ?5, 'pending_input', ?6)`,
            args: [
              agentId,
              tenantId,
              tenantDbName,
              `Ambient ${displayName} ${tenantId.slice(0, 8)}`,
              newId(),
              timestamp,
            ],
          },
          {
            sql: "INSERT INTO model_connection (tenant_id, updated_at_ms) VALUES (?1, ?2)",
            args: [tenantId, timestamp],
          },
          {
            sql: "INSERT INTO whatsapp_connection (tenant_id, updated_at_ms) VALUES (?1, ?2)",
            args: [tenantId, timestamp],
          },
          {
            sql: "INSERT INTO managed_chat_selection (tenant_id, updated_at_ms) VALUES (?1, ?2)",
            args: [tenantId, timestamp],
          },
          { sql: "INSERT INTO delivery_route (tenant_id, updated_at_ms) VALUES (?1, ?2)", args: [tenantId, timestamp] },
          {
            sql: `INSERT INTO control_operation
                    (id, tenant_id, kind, status, operation_identity, started_at_ms, updated_at_ms)
                  VALUES (?1, ?2, 'provision_setup', 'pending', ?3, ?4, ?4)`,
            args: [operationId, tenantId, input.operationIdentity, timestamp],
          },
        ],
        "write",
      );
    } catch (cause) {
      const raced = await snapshot(userId);
      if (raced.tenant) return raced;
      if (!raced.entitlement.entitled) {
        throw new CoworkerError(
          "entitlement_required",
          "An active hosted plan is required before creating a coworker.",
        );
      }
      throw cause;
    }
    const createdOperation = await existingOperation(tenantId, input.operationIdentity);
    if (createdOperation) await reconcileLifecycle(userId, createdOperation);
    return await snapshot(userId);
  };

  const ensureSetup = async (
    userId: string,
    input: { readonly operationIdentity: string },
  ): Promise<CoworkerOperation> => {
    const tenant = await requireEntitledTenant(userId);
    if (tenant.status !== "onboarding") {
      throw new CoworkerError("incomplete_capabilities", "Setup retries are only valid before activation.");
    }
    const { operation, created } = await enqueue(userId, {
      kind: "provision_setup",
      operationIdentity: input.operationIdentity,
    });
    if (!created) return await reconcileLifecycle(userId, operation);
    const timestamp = now();
    await options.client.batch(
      [
        {
          sql: `UPDATE tenant
                   SET desired_state = 'running', updated_at_ms = ?2
                 WHERE id = ?1
                   AND EXISTS (
                     SELECT 1 FROM subscription_entitlement
                      WHERE id = tenant.subscription_entitlement_id
                        AND user_id = tenant.user_id
                        AND status IN ('active', 'trialing')
                   )`,
          args: [tenant.id, timestamp],
        },
        {
          sql: `UPDATE agent_instance
                   SET desired_mode = 'setup', updated_at_ms = ?2
                 WHERE tenant_id = ?1
                   AND EXISTS (
                     SELECT 1 FROM tenant
                     JOIN subscription_entitlement
                       ON subscription_entitlement.id = tenant.subscription_entitlement_id
                      AND subscription_entitlement.user_id = tenant.user_id
                      AND subscription_entitlement.status IN ('active', 'trialing')
                    WHERE tenant.id = ?1
                   )`,
          args: [tenant.id, timestamp],
        },
      ],
      "write",
    );
    return await reconcileLifecycle(userId, operation);
  };

  const reconcileOperation = async (
    userId: string,
    input: { readonly operationId: string },
  ): Promise<CoworkerOperation> => {
    const tenant = await ownedTenant(userId);
    const result = await options.client.execute({
      sql: `SELECT id, kind, status, operation_identity, target_config_version, error_code,
                   started_at_ms, settled_at_ms
              FROM control_operation
             WHERE id = ?1 AND tenant_id = ?2`,
      args: [input.operationId, tenant.id],
    });
    if (!result.rows[0]) throw new CoworkerError("tenant_not_found", "The operation does not belong to this tenant.");
    return await reconcileLifecycle(userId, operationFromRow(rowObject(result.rows[0])));
  };

  const beginModelAuth = async (
    userId: string,
    input: { readonly operationIdentity: string },
  ): Promise<ModelAuthorizationChallenge & { readonly operationIdentity: string }> => {
    const tenant = await requireEntitledTenant(userId);
    if (!options.model) {
      throw new CoworkerError(
        "model_store_unavailable",
        "The tenant credential store is not reachable yet. Retry after private workspace reconciliation.",
      );
    }
    const active = modelAttempts.get(tenant.id);
    if (active?.operationIdentity === input.operationIdentity) {
      return { ...active.challenge, operationIdentity: active.operationIdentity };
    }
    const claimTimestamp = now();
    const claim = await options.client.execute({
      sql: `UPDATE model_connection
               SET status = 'validating', updated_at_ms = ?2
             WHERE tenant_id = ?1
               AND (status != 'validating' OR updated_at_ms <= ?3)
               AND EXISTS (
                 SELECT 1 FROM tenant
                 JOIN subscription_entitlement
                   ON subscription_entitlement.id = tenant.subscription_entitlement_id
                  AND subscription_entitlement.user_id = tenant.user_id
                  AND subscription_entitlement.status IN ('active', 'trialing')
                WHERE tenant.id = ?1
               )`,
      args: [tenant.id, claimTimestamp, claimTimestamp - staleAfterMs],
    });
    if (Number(claim.rowsAffected) !== 1) {
      await requireEntitledTenant(userId);
      throw new CoworkerError(
        "operation_identity_conflict",
        "Another model authorization attempt is still active. Finish it or wait for it to expire before retrying.",
      );
    }
    active?.controller.abort();
    const controller = new AbortController();
    let attempt: Awaited<ReturnType<CoworkerModelSource["beginAuth"]>>;
    try {
      attempt = await options.model.beginAuth({
        tenantId: tenant.id,
        operationIdentity: input.operationIdentity,
        signal: controller.signal,
      });
    } catch (cause) {
      await options.client.execute({
        sql: `UPDATE model_connection
                 SET status = 'invalid', updated_at_ms = ?3
               WHERE tenant_id = ?1 AND status = 'validating' AND updated_at_ms = ?2`,
        args: [tenant.id, claimTimestamp, now()],
      });
      throw cause;
    }
    modelAttempts.set(tenant.id, {
      operationIdentity: input.operationIdentity,
      controller,
      challenge: attempt.challenge,
    });
    void attempt.completion
      .then(
        async () => {
          if (modelAttempts.get(tenant.id)?.operationIdentity !== input.operationIdentity) return;
          await options.client.execute({
            sql: `UPDATE model_connection
                   SET status = 'ready', credential_version = credential_version + 1,
                       verified_at_ms = ?3, updated_at_ms = ?3
                 WHERE tenant_id = ?1 AND status = 'validating' AND updated_at_ms = ?2`,
            args: [tenant.id, claimTimestamp, now()],
          });
          modelAttempts.delete(tenant.id);
        },
        async () => {
          if (modelAttempts.get(tenant.id)?.operationIdentity !== input.operationIdentity) return;
          await options.client.execute({
            sql: `UPDATE model_connection
                     SET status = 'invalid', updated_at_ms = ?3
                   WHERE tenant_id = ?1 AND status = 'validating' AND updated_at_ms = ?2`,
            args: [tenant.id, claimTimestamp, now()],
          });
          modelAttempts.delete(tenant.id);
        },
      )
      .catch(() => undefined);
    return { ...attempt.challenge, operationIdentity: input.operationIdentity };
  };

  const verifyModel = async (userId: string): Promise<{ readonly ready: boolean }> => {
    const tenant = await requireEntitledTenant(userId);
    if (!options.model) {
      throw new CoworkerError("model_store_unavailable", "The tenant credential store is not reachable yet.");
    }
    const ready = await options.model.verify({ tenantId: tenant.id });
    const timestamp = now();
    await options.client.execute({
      sql: `UPDATE model_connection
               SET status = ?2,
                   credential_version = CASE WHEN ?2 = 'ready' AND credential_version = 0 THEN 1 ELSE credential_version END,
                   verified_at_ms = CASE WHEN ?2 = 'ready' THEN ?3 ELSE NULL END,
                   updated_at_ms = ?3
             WHERE tenant_id = ?1
               AND (?2 = 'ready' OR status != 'validating')
               AND EXISTS (
                 SELECT 1 FROM tenant
                 JOIN subscription_entitlement
                   ON subscription_entitlement.id = tenant.subscription_entitlement_id
                  AND subscription_entitlement.user_id = tenant.user_id
                  AND subscription_entitlement.status IN ('active', 'trialing')
                WHERE tenant.id = ?1
               )`,
      args: [tenant.id, ready ? "ready" : "invalid", timestamp],
    });
    await requireEntitledTenant(userId);
    return { ready };
  };

  const pairing = async (userId: string): Promise<CoworkerBridgePairing> => {
    const runtime = await runtimeInput(userId);
    const repairOperation =
      runtime.tenant.status === "active" ? await unsettledOperation(runtime.tenant.id, "repair") : null;
    if (runtime.tenant.status === "active" && !repairOperation) {
      throw new CoworkerError(
        "incomplete_capabilities",
        "WhatsApp pairing is only exposed during a named active repair.",
      );
    }
    const result = await runtime.source.pairing(runtime.input);
    const timestamp = now();
    if (result.status === "pairing") {
      await options.client.execute({
        sql: `UPDATE whatsapp_connection
                 SET status = 'pairing', observed_at_ms = ?2, updated_at_ms = ?2
               WHERE tenant_id = ?1
                 AND EXISTS (
                   SELECT 1 FROM tenant
                   JOIN subscription_entitlement
                     ON subscription_entitlement.id = tenant.subscription_entitlement_id
                    AND subscription_entitlement.user_id = tenant.user_id
                    AND subscription_entitlement.status IN ('active', 'trialing')
                  WHERE tenant.id = ?1
                 )`,
        args: [runtime.tenant.id, timestamp],
      });
      await requireEntitledTenant(userId);
      return result;
    }
    if (result.status !== "paired" || !result.accountJid?.trim()) return result;
    const health = await runtime.source.health(runtime.input);
    if (!health.ok || health.runtime.state !== "healthy" || health.runtime.whatsapp.phase !== "online") return result;
    await options.client.execute({
      sql: `UPDATE whatsapp_connection
               SET status = 'online', account_jid = ?3, observed_at_ms = ?2, updated_at_ms = ?2
             WHERE tenant_id = ?1
               AND EXISTS (
                 SELECT 1 FROM tenant
                 JOIN subscription_entitlement
                   ON subscription_entitlement.id = tenant.subscription_entitlement_id
                  AND subscription_entitlement.user_id = tenant.user_id
                  AND subscription_entitlement.status IN ('active', 'trialing')
                WHERE tenant.id = ?1
               )`,
      args: [runtime.tenant.id, timestamp, result.accountJid.trim()],
    });
    await requireEntitledTenant(userId);
    if (runtime.tenant.status !== "active") return result;
    const operation = repairOperation;
    if (!operation) return result;
    await options.client.batch(
      [
        {
          sql: `UPDATE tenant
                   SET config_version = config_version + 1, updated_at_ms = ?3
                 WHERE id = ?1
                   AND EXISTS (
                     SELECT 1 FROM agent_instance
                      WHERE tenant_id = ?1 AND desired_mode = 'setup'
                   )
                   AND EXISTS (
                     SELECT 1 FROM control_operation
                      WHERE id = ?2 AND tenant_id = ?1 AND status IN ('pending', 'running', 'uncertain')
                   )`,
          args: [runtime.tenant.id, operation.id, timestamp],
        },
        {
          sql: `UPDATE agent_instance
                   SET desired_mode = 'operate', updated_at_ms = ?3
                 WHERE tenant_id = ?1 AND desired_mode = 'setup'
                   AND EXISTS (
                     SELECT 1 FROM control_operation
                      WHERE id = ?2 AND tenant_id = ?1 AND status IN ('pending', 'running', 'uncertain')
                   )`,
          args: [runtime.tenant.id, operation.id, timestamp],
        },
      ],
      "write",
    );
    await reconcileLifecycle(userId, operation);
    return result;
  };

  const listManagedChats = async (userId: string): Promise<CoworkerBridgeChats> => {
    const runtime = await runtimeInput(userId);
    return await runtime.source.chats(runtime.input);
  };

  const selectManagedChats = async (
    userId: string,
    input: { readonly jids: readonly string[] },
  ): Promise<CoworkerSnapshot> => {
    const tenant = await requireEntitledTenant(userId);
    if (tenant.status !== "onboarding") {
      throw new CoworkerError("incomplete_capabilities", "Managed Chat changes are onboarding-only in the hosted MVP.");
    }
    const uniqueJids = [...new Set(input.jids)];
    if (uniqueJids.length === 0) {
      throw new CoworkerError("managed_chat_invalid", "Select at least one Managed Chat.");
    }
    const candidates = await listManagedChats(userId);
    const byJid = new Map(candidates.map((chat) => [chat.jid, chat]));
    const selected = uniqueJids.map((jid) => byJid.get(jid));
    if (selected.some((chat) => !chat)) {
      throw new CoworkerError(
        "managed_chat_invalid",
        "A selected chat is no longer available from the tenant runtime.",
      );
    }
    const existing = await options.client.execute({
      sql: "SELECT jid FROM tenant_managed_chat WHERE tenant_id = ?1 ORDER BY jid",
      args: [tenant.id],
    });
    const currentJids = existing.rows.map((row) => String(row.jid));
    const nextJids = [...uniqueJids].sort();
    if (currentJids.length === nextJids.length && currentJids.every((jid, index) => jid === nextJids[index])) {
      return await snapshot(userId);
    }
    const timestamp = now();
    await options.client.batch(
      [
        {
          sql: `DELETE FROM tenant_managed_chat
                 WHERE tenant_id = ?1
                   AND EXISTS (
                     SELECT 1 FROM tenant
                     JOIN subscription_entitlement
                       ON subscription_entitlement.id = tenant.subscription_entitlement_id
                      AND subscription_entitlement.user_id = tenant.user_id
                      AND subscription_entitlement.status IN ('active', 'trialing')
                    WHERE tenant.id = ?1
                   )`,
          args: [tenant.id],
        },
        ...selected.map((chat) => ({
          sql: `INSERT INTO tenant_managed_chat (tenant_id, jid, display_name, kind, selected_at_ms)
                SELECT ?1, ?2, ?3, ?4, ?5
                 WHERE EXISTS (
                   SELECT 1 FROM tenant
                   JOIN subscription_entitlement
                     ON subscription_entitlement.id = tenant.subscription_entitlement_id
                    AND subscription_entitlement.user_id = tenant.user_id
                    AND subscription_entitlement.status IN ('active', 'trialing')
                  WHERE tenant.id = ?1
                 )`,
          args: [tenant.id, chat!.jid, chat!.name, chat!.kind, timestamp],
        })),
        {
          sql: `UPDATE managed_chat_selection
                 SET status = 'selected', selected_at_ms = ?2, updated_at_ms = ?2
                 WHERE tenant_id = ?1
                   AND EXISTS (
                     SELECT 1 FROM tenant
                     JOIN subscription_entitlement
                       ON subscription_entitlement.id = tenant.subscription_entitlement_id
                      AND subscription_entitlement.user_id = tenant.user_id
                      AND subscription_entitlement.status IN ('active', 'trialing')
                    WHERE tenant.id = ?1
                   )`,
          args: [tenant.id, timestamp],
        },
        {
          sql: `UPDATE tenant
                   SET config_version = config_version + 1, updated_at_ms = ?2
                 WHERE id = ?1
                   AND EXISTS (
                     SELECT 1 FROM subscription_entitlement
                      WHERE id = tenant.subscription_entitlement_id
                        AND user_id = tenant.user_id
                        AND status IN ('active', 'trialing')
                   )`,
          args: [tenant.id, timestamp],
        },
      ],
      "write",
    );
    await requireEntitledTenant(userId);
    return await snapshot(userId);
  };

  const activate = async (
    userId: string,
    input: {
      readonly expectedConfigVersion: number;
      readonly expectedBasisFingerprint: string;
      readonly operationIdentity: string;
    },
  ): Promise<CoworkerOperation> => {
    const tenant = await requireEntitledTenant(userId);
    const targetConfigVersion = input.expectedConfigVersion + 1;
    const duplicate = await existingOperation(tenant.id, input.operationIdentity);
    if (duplicate) {
      return await reconcileLifecycle(userId, requireOperationIdentity(duplicate, "activate", targetConfigVersion));
    }
    if (tenant.configVersion !== input.expectedConfigVersion) {
      throw new CoworkerError(
        "stale_revision",
        `Activation expected config revision ${input.expectedConfigVersion}, but revision ${tenant.configVersion} is current.`,
      );
    }
    const state = await snapshot(userId);
    if (state.nextAction !== "activation") {
      throw new CoworkerError(
        "incomplete_capabilities",
        `Activation is blocked by the ${state.nextAction} capability.`,
      );
    }
    const runtime = await runtimeInput(userId);
    const health = await runtime.source.health(runtime.input);
    if (!health.ok || health.runtime.state !== "healthy" || health.runtime.whatsapp.phase !== "online") {
      throw new CoworkerError("runtime_unhealthy", "Activation requires a current healthy tenant runtime observation.");
    }
    const basis = await readActivationBasis(tenant.id);
    if (activationFingerprint(input.expectedConfigVersion, basis) !== input.expectedBasisFingerprint) {
      throw new CoworkerError(
        "stale_revision",
        "Activation facts changed after review. Refresh the capability ledger before retrying.",
      );
    }
    const configJson = renderManagedConfiguration(basis);
    const timestamp = now();
    const operationId = newId();
    await options.client.batch(
      [
        {
          sql: `WITH current_configuration AS (
                  SELECT tenant.id,
                         (SELECT json_group_array(jid)
                            FROM (SELECT jid FROM tenant_managed_chat
                                   WHERE tenant_id = tenant.id ORDER BY jid)) AS chats_json,
                         (SELECT json_group_array(json_object(
                             'role', installation_role,
                             'installationId', installation_id,
                             'repositoryId', repository_id,
                             'owner', owner,
                             'name', name,
                             'isDefault', is_default
                           ))
                            FROM (
                              SELECT github_repository.installation_role, github_repository.installation_id,
                                     github_repository.repository_id, github_repository.owner,
                                     github_repository.name, github_repository.is_default
                                FROM github_repository
                                JOIN github_installation
                                  ON github_installation.tenant_id = github_repository.tenant_id
                                 AND github_installation.role = github_repository.installation_role
                                 AND github_installation.installation_id = github_repository.installation_id
                               WHERE github_repository.tenant_id = tenant.id
                                 AND github_installation.status = 'installed'
                                 AND github_repository.selected = 1
                               ORDER BY github_repository.installation_role, github_repository.repository_id
                            )) AS github_json
                    FROM tenant
                    JOIN subscription_entitlement
                      ON subscription_entitlement.id = tenant.subscription_entitlement_id
                     AND subscription_entitlement.user_id = tenant.user_id
                    JOIN agent_instance ON agent_instance.tenant_id = tenant.id
                    JOIN model_connection ON model_connection.tenant_id = tenant.id
                    JOIN whatsapp_connection ON whatsapp_connection.tenant_id = tenant.id
                    JOIN managed_chat_selection ON managed_chat_selection.tenant_id = tenant.id
                   WHERE tenant.id = ?2
                     AND tenant.status = 'onboarding'
                     AND tenant.config_version = ?9
                     AND subscription_entitlement.status IN ('active', 'trialing')
                     AND agent_instance.desired_mode = 'setup'
                     AND agent_instance.observed_state = 'healthy'
                     AND agent_instance.observed_at_ms >= ?8
                     AND model_connection.status = 'ready'
                     AND whatsapp_connection.status = 'online'
                     AND whatsapp_connection.account_jid IS NOT NULL
                     AND whatsapp_connection.observed_at_ms >= ?8
                     AND managed_chat_selection.status = 'selected'
                )
                INSERT INTO control_operation
                  (id, tenant_id, kind, status, operation_identity, target_config_version, started_at_ms, updated_at_ms)
                SELECT ?1, ?2, 'activate', 'pending', ?3, ?4, ?5, ?5
                  FROM current_configuration
                 WHERE chats_json = ?6
                   AND github_json = ?7
                   AND NOT EXISTS (
                     SELECT 1 FROM control_operation
                      WHERE tenant_id = ?2 AND status IN ('pending', 'running', 'uncertain')
                   )
                ON CONFLICT (tenant_id, operation_identity) DO NOTHING`,
          args: [
            operationId,
            tenant.id,
            input.operationIdentity,
            targetConfigVersion,
            timestamp,
            basis.chatsJson,
            basis.githubJson,
            timestamp - staleAfterMs,
            input.expectedConfigVersion,
          ],
        },
        {
          sql: `UPDATE tenant
                   SET config_json = ?3, config_version = ?4,
                       desired_state = 'running', updated_at_ms = ?5
                 WHERE id = ?1
                   AND EXISTS (SELECT 1 FROM control_operation WHERE id = ?2 AND tenant_id = ?1)`,
          args: [tenant.id, operationId, configJson, targetConfigVersion, timestamp],
        },
        {
          sql: `UPDATE agent_instance
                   SET desired_mode = 'operate', updated_at_ms = ?3
                 WHERE tenant_id = ?1
                   AND EXISTS (SELECT 1 FROM control_operation WHERE id = ?2 AND tenant_id = ?1)`,
          args: [tenant.id, operationId, timestamp],
        },
      ],
      "write",
    );
    const operation = await existingOperation(tenant.id, input.operationIdentity);
    if (!operation) {
      const blocked = await unsettledOperation(tenant.id);
      if (blocked) {
        throw new CoworkerError(
          "operation_identity_conflict",
          `The existing ${blocked.kind} operation is ${blocked.status}; reconcile it before starting another mutation.`,
        );
      }
      const current = await ownedTenant(userId);
      if (current.configVersion !== input.expectedConfigVersion) {
        throw new CoworkerError(
          "stale_revision",
          `Activation expected config revision ${input.expectedConfigVersion}, but revision ${current.configVersion} is current.`,
        );
      }
      throw new CoworkerError(
        "stale_revision",
        "Activation prerequisites changed after review. Refresh the capability ledger before retrying.",
      );
    }
    return await reconcileLifecycle(userId, requireOperationIdentity(operation, "activate", targetConfigVersion));
  };

  const applyGitHubConfiguration = async (
    userId: string,
    input: {
      readonly expectedConfigVersion: number;
      readonly expectedBasisFingerprint: string;
      readonly operationIdentity: string;
    },
  ): Promise<CoworkerOperation> => {
    const tenant = await requireEntitledTenant(userId);
    const targetConfigVersion = input.expectedConfigVersion + 1;
    const duplicate = await existingOperation(tenant.id, input.operationIdentity);
    if (duplicate) {
      return await reconcileLifecycle(userId, requireOperationIdentity(duplicate, "restart", targetConfigVersion));
    }
    if (tenant.status !== "active") {
      throw new CoworkerError(
        "incomplete_capabilities",
        "GitHub configuration repair is only available for an active coworker.",
      );
    }
    if (tenant.configVersion !== input.expectedConfigVersion) {
      throw new CoworkerError(
        "stale_revision",
        `GitHub repair expected config revision ${input.expectedConfigVersion}, but revision ${tenant.configVersion} is current.`,
      );
    }
    const basis = await readActivationBasis(tenant.id);
    if (activationFingerprint(input.expectedConfigVersion, basis) !== input.expectedBasisFingerprint) {
      throw new CoworkerError(
        "stale_revision",
        "GitHub configuration changed after review. Refresh the capability ledger before retrying.",
      );
    }
    const configJson = renderManagedConfiguration(basis);
    const timestamp = now();
    const operationId = newId();
    await options.client.batch(
      [
        {
          sql: `WITH current_configuration AS (
                  SELECT tenant.id,
                         (SELECT json_group_array(jid)
                            FROM (SELECT jid FROM tenant_managed_chat
                                   WHERE tenant_id = tenant.id ORDER BY jid)) AS chats_json,
                         (SELECT json_group_array(json_object(
                             'role', installation_role,
                             'installationId', installation_id,
                             'repositoryId', repository_id,
                             'owner', owner,
                             'name', name,
                             'isDefault', is_default
                           ))
                            FROM (
                              SELECT github_repository.installation_role, github_repository.installation_id,
                                     github_repository.repository_id, github_repository.owner,
                                     github_repository.name, github_repository.is_default
                                FROM github_repository
                                JOIN github_installation
                                  ON github_installation.tenant_id = github_repository.tenant_id
                                 AND github_installation.role = github_repository.installation_role
                                 AND github_installation.installation_id = github_repository.installation_id
                               WHERE github_repository.tenant_id = tenant.id
                                 AND github_installation.status = 'installed'
                                 AND github_repository.selected = 1
                               ORDER BY github_repository.installation_role, github_repository.repository_id
                            )) AS github_json
                    FROM tenant
                    JOIN subscription_entitlement
                      ON subscription_entitlement.id = tenant.subscription_entitlement_id
                     AND subscription_entitlement.user_id = tenant.user_id
                    JOIN agent_instance ON agent_instance.tenant_id = tenant.id
                    JOIN model_connection ON model_connection.tenant_id = tenant.id
                    JOIN whatsapp_connection ON whatsapp_connection.tenant_id = tenant.id
                    JOIN managed_chat_selection ON managed_chat_selection.tenant_id = tenant.id
                   WHERE tenant.id = ?2
                     AND tenant.status = 'active'
                     AND tenant.config_version = ?9
                     AND subscription_entitlement.status IN ('active', 'trialing')
                     AND agent_instance.desired_mode = 'operate'
                     AND agent_instance.observed_state = 'healthy'
                     AND agent_instance.observed_at_ms >= ?8
                     AND model_connection.status = 'ready'
                     AND whatsapp_connection.status = 'online'
                     AND whatsapp_connection.account_jid IS NOT NULL
                     AND whatsapp_connection.observed_at_ms >= ?8
                     AND managed_chat_selection.status = 'selected'
                )
                INSERT INTO control_operation
                  (id, tenant_id, kind, status, operation_identity, target_config_version, started_at_ms, updated_at_ms)
                SELECT ?1, ?2, 'restart', 'pending', ?3, ?4, ?5, ?5
                  FROM current_configuration
                 WHERE chats_json = ?6
                   AND github_json = ?7
                   AND NOT EXISTS (
                     SELECT 1 FROM control_operation
                      WHERE tenant_id = ?2 AND status IN ('pending', 'running', 'uncertain')
                   )
                ON CONFLICT (tenant_id, operation_identity) DO NOTHING`,
          args: [
            operationId,
            tenant.id,
            input.operationIdentity,
            targetConfigVersion,
            timestamp,
            basis.chatsJson,
            basis.githubJson,
            timestamp - staleAfterMs,
            input.expectedConfigVersion,
          ],
        },
        {
          sql: `UPDATE tenant
                   SET config_json = ?3, config_version = ?4,
                       desired_state = 'running', updated_at_ms = ?5
                 WHERE id = ?1
                   AND EXISTS (SELECT 1 FROM control_operation WHERE id = ?2 AND tenant_id = ?1)`,
          args: [tenant.id, operationId, configJson, targetConfigVersion, timestamp],
        },
        {
          sql: `UPDATE agent_instance
                   SET desired_mode = 'operate', updated_at_ms = ?3
                 WHERE tenant_id = ?1
                   AND EXISTS (SELECT 1 FROM control_operation WHERE id = ?2 AND tenant_id = ?1)`,
          args: [tenant.id, operationId, timestamp],
        },
      ],
      "write",
    );
    const operation = await existingOperation(tenant.id, input.operationIdentity);
    if (!operation) {
      const blocked = await unsettledOperation(tenant.id);
      if (blocked) {
        throw new CoworkerError(
          "operation_identity_conflict",
          `The existing ${blocked.kind} operation is ${blocked.status}; reconcile it before starting another mutation.`,
        );
      }
      const current = await ownedTenant(userId);
      if (current.configVersion !== input.expectedConfigVersion) {
        throw new CoworkerError(
          "stale_revision",
          `GitHub repair expected config revision ${input.expectedConfigVersion}, but revision ${current.configVersion} is current.`,
        );
      }
      throw new CoworkerError(
        "stale_revision",
        "GitHub repair prerequisites changed after review. Refresh the capability ledger before retrying.",
      );
    }
    return await reconcileLifecycle(userId, requireOperationIdentity(operation, "restart", targetConfigVersion));
  };

  const restartRuntime = async (
    userId: string,
    input: { readonly operationIdentity: string },
  ): Promise<CoworkerOperation> => {
    const tenant = await requireEntitledTenant(userId);
    if (tenant.status !== "active") {
      throw new CoworkerError("incomplete_capabilities", "Runtime restart is only available for an active coworker.");
    }
    const { operation, created } = await enqueue(userId, {
      kind: "restart",
      operationIdentity: input.operationIdentity,
    });
    if (!created) return await reconcileLifecycle(userId, operation);
    const timestamp = now();
    await options.client.batch(
      [
        {
          sql: `UPDATE tenant
                   SET desired_state = 'running', updated_at_ms = ?2
                 WHERE id = ?1
                   AND EXISTS (
                     SELECT 1 FROM subscription_entitlement
                      WHERE id = tenant.subscription_entitlement_id
                        AND user_id = tenant.user_id
                        AND status IN ('active', 'trialing')
                   )`,
          args: [tenant.id, timestamp],
        },
        {
          sql: `UPDATE agent_instance
                   SET desired_mode = 'operate', updated_at_ms = ?2
                 WHERE tenant_id = ?1
                   AND EXISTS (
                     SELECT 1 FROM tenant
                     JOIN subscription_entitlement
                       ON subscription_entitlement.id = tenant.subscription_entitlement_id
                      AND subscription_entitlement.user_id = tenant.user_id
                      AND subscription_entitlement.status IN ('active', 'trialing')
                    WHERE tenant.id = ?1
                   )`,
          args: [tenant.id, timestamp],
        },
      ],
      "write",
    );
    return await reconcileLifecycle(userId, operation);
  };

  const beginWhatsappRepair = async (
    userId: string,
    input: { readonly operationIdentity: string },
  ): Promise<CoworkerOperation> => {
    const tenant = await requireEntitledTenant(userId);
    if (tenant.status !== "active") {
      throw new CoworkerError("incomplete_capabilities", "WhatsApp re-pair is only available for an active coworker.");
    }
    const { operation, created } = await enqueue(userId, {
      kind: "repair",
      operationIdentity: input.operationIdentity,
    });
    if (!created) return await reconcileLifecycle(userId, operation);
    const timestamp = now();
    await options.client.batch(
      [
        {
          sql: `UPDATE tenant
                   SET desired_state = 'running', config_version = config_version + 1, updated_at_ms = ?2
                 WHERE id = ?1
                   AND EXISTS (
                     SELECT 1 FROM subscription_entitlement
                      WHERE id = tenant.subscription_entitlement_id
                        AND user_id = tenant.user_id
                        AND status IN ('active', 'trialing')
                   )`,
          args: [tenant.id, timestamp],
        },
        {
          sql: `UPDATE agent_instance
                   SET desired_mode = 'setup', updated_at_ms = ?2
                 WHERE tenant_id = ?1
                   AND EXISTS (
                     SELECT 1 FROM tenant
                     JOIN subscription_entitlement
                       ON subscription_entitlement.id = tenant.subscription_entitlement_id
                      AND subscription_entitlement.user_id = tenant.user_id
                      AND subscription_entitlement.status IN ('active', 'trialing')
                    WHERE tenant.id = ?1
                   )`,
          args: [tenant.id, timestamp],
        },
        {
          sql: `UPDATE whatsapp_connection
                   SET status = 'pairing', observed_at_ms = NULL, updated_at_ms = ?2
                 WHERE tenant_id = ?1
                   AND EXISTS (
                     SELECT 1 FROM tenant
                     JOIN subscription_entitlement
                       ON subscription_entitlement.id = tenant.subscription_entitlement_id
                      AND subscription_entitlement.user_id = tenant.user_id
                      AND subscription_entitlement.status IN ('active', 'trialing')
                    WHERE tenant.id = ?1
                   )`,
          args: [tenant.id, timestamp],
        },
      ],
      "write",
    );
    return await reconcileLifecycle(userId, operation);
  };

  return {
    snapshot,
    refresh,
    create,
    ensureSetup,
    reconcileOperation,
    beginModelAuth,
    verifyModel,
    pairing,
    listManagedChats,
    selectManagedChats,
    activate,
    applyGitHubConfiguration,
    restartRuntime,
    beginWhatsappRepair,
  };
};
