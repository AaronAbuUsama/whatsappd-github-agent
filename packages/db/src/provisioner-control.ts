import type { Client } from "@libsql/client";

import type { ProvisionerLease } from "./control-db";
import type * as schema from "./schema";

const nowMs = "cast(unixepoch('subsecond') * 1000 as integer)";

const leasePredicate = `EXISTS (
  SELECT 1
  FROM provisioner_lease
  WHERE provisioner_lease.creds_store_key = agent_instance.creds_store_key
    AND provisioner_lease.owner_id = ?2
    AND provisioner_lease.fencing_token = ?3
    AND provisioner_lease.expires_at_ms > (${nowMs})
)`;

const currentActivationPredicate = `EXISTS (
  SELECT 1
  FROM control_operation
  WHERE control_operation.tenant_id = tenant.id
    AND control_operation.kind = 'activate'
    AND control_operation.status IN ('pending', 'running')
    AND control_operation.target_config_version = tenant.config_version
)`;

export type DesiredRuntimeMode = (typeof schema.agentInstance.$inferSelect)["desiredMode"];
export type ObservedRuntimeState = (typeof schema.agentInstance.$inferSelect)["observedState"];
export type RemoteConfigState = (typeof schema.agentInstance.$inferSelect)["remoteConfigState"];
export type ProvisionerPhase = (typeof schema.agentInstance.$inferSelect)["phase"];
export type TenantDesiredState = (typeof schema.tenant.$inferSelect)["desiredState"];
export type TenantStatus = (typeof schema.tenant.$inferSelect)["status"];
export type EntitlementStatus = (typeof schema.subscriptionEntitlement.$inferSelect)["status"];

export interface ProvisioningTarget {
  readonly tenantId: string;
  readonly tenantDbName: string;
  readonly tenantDbUrl: string | null;
  readonly tenantDbTokenCiphertext: string | null;
  readonly configJson: string;
  readonly configVersion: number;
  readonly hasCurrentActivationIntent: boolean;
  readonly tenantStatus: TenantStatus;
  readonly tenantDesiredState: TenantDesiredState;
  readonly entitlementStatus: EntitlementStatus;
  readonly agentId: string;
  readonly credsStoreKey: string;
  readonly desiredMode: DesiredRuntimeMode;
  readonly appliedMode: DesiredRuntimeMode;
  readonly observedState: ObservedRuntimeState;
  readonly runtimeBaseUrl: string | null;
  readonly dokployDisplayName: string;
  readonly dokployCreationToken: string;
  readonly dokployApplicationId: string | null;
  readonly dokployAppName: string | null;
  readonly appliedConfigVersion: number;
  readonly remoteConfigOperationId: string | null;
  readonly remoteConfigOwnerId: string | null;
  readonly remoteConfigFencingToken: number | null;
  readonly remoteConfigTargetVersion: number | null;
  readonly remoteConfigState: RemoteConfigState;
  readonly phase: ProvisionerPhase;
  readonly lastErrorCode: string | null;
}

const requiredString = (row: Record<string, unknown>, name: string): string => {
  const value = row[name];
  if (typeof value !== "string") throw new TypeError(`provisioning target ${name} must be text`);
  return value;
};

const nullableString = (row: Record<string, unknown>, name: string): string | null => {
  const value = row[name];
  return value === null ? null : requiredString(row, name);
};

const requiredNumber = (row: Record<string, unknown>, name: string): number => {
  const value = row[name];
  if (typeof value !== "number" && typeof value !== "bigint") {
    throw new TypeError(`provisioning target ${name} must be numeric`);
  }
  return Number(value);
};

const nullableNumber = (row: Record<string, unknown>, name: string): number | null =>
  row[name] === null ? null : requiredNumber(row, name);

const requiredBoolean = (row: Record<string, unknown>, name: string): boolean =>
  requiredNumber(row, name) === 1;

const targetFrom = (row: Record<string, unknown>): ProvisioningTarget => ({
  tenantId: requiredString(row, "tenant_id"),
  tenantDbName: requiredString(row, "tenant_db_name"),
  tenantDbUrl: nullableString(row, "tenant_db_url"),
  tenantDbTokenCiphertext: nullableString(row, "tenant_db_token_ciphertext"),
  configJson: requiredString(row, "config_json"),
  configVersion: requiredNumber(row, "config_version"),
  hasCurrentActivationIntent: requiredBoolean(row, "has_current_activation_intent"),
  tenantStatus: requiredString(row, "tenant_status") as TenantStatus,
  tenantDesiredState: requiredString(row, "tenant_desired_state") as TenantDesiredState,
  entitlementStatus: requiredString(row, "entitlement_status") as EntitlementStatus,
  agentId: requiredString(row, "agent_id"),
  credsStoreKey: requiredString(row, "creds_store_key"),
  desiredMode: requiredString(row, "desired_mode") as DesiredRuntimeMode,
  appliedMode: requiredString(row, "applied_mode") as DesiredRuntimeMode,
  observedState: requiredString(row, "observed_state") as ObservedRuntimeState,
  runtimeBaseUrl: nullableString(row, "runtime_base_url"),
  dokployDisplayName: requiredString(row, "dokploy_display_name"),
  dokployCreationToken: requiredString(row, "dokploy_creation_token"),
  dokployApplicationId: nullableString(row, "dokploy_application_id"),
  dokployAppName: nullableString(row, "dokploy_app_name"),
  appliedConfigVersion: requiredNumber(row, "applied_config_version"),
  remoteConfigOperationId: nullableString(row, "remote_config_operation_id"),
  remoteConfigOwnerId: nullableString(row, "remote_config_owner_id"),
  remoteConfigFencingToken: nullableNumber(row, "remote_config_fencing_token"),
  remoteConfigTargetVersion: nullableNumber(row, "remote_config_target_version"),
  remoteConfigState: requiredString(row, "remote_config_state") as RemoteConfigState,
  phase: requiredString(row, "phase") as ProvisionerPhase,
  lastErrorCode: nullableString(row, "last_error_code"),
});

export async function readProvisioningTarget(
  client: Pick<Client, "execute">,
  tenantId: string,
): Promise<ProvisioningTarget | null> {
  const result = await client.execute({
    sql: `SELECT
      tenant.id AS tenant_id,
      tenant.tenant_db_name,
      tenant.tenant_db_url,
      tenant.tenant_db_token_ciphertext,
      tenant.config_json,
      tenant.config_version,
      CASE WHEN ${currentActivationPredicate} THEN 1 ELSE 0 END AS has_current_activation_intent,
      tenant.status AS tenant_status,
      tenant.desired_state AS tenant_desired_state,
      subscription_entitlement.status AS entitlement_status,
      agent_instance.id AS agent_id,
      agent_instance.creds_store_key,
      agent_instance.desired_mode,
      agent_instance.applied_mode,
      agent_instance.observed_state,
      agent_instance.runtime_base_url,
      agent_instance.dokploy_display_name,
      agent_instance.dokploy_creation_token,
      agent_instance.dokploy_application_id,
      agent_instance.dokploy_app_name,
      agent_instance.applied_config_version,
      agent_instance.remote_config_operation_id,
      agent_instance.remote_config_owner_id,
      agent_instance.remote_config_fencing_token,
      agent_instance.remote_config_target_version,
      agent_instance.remote_config_state,
      agent_instance.phase,
      agent_instance.last_error_code
    FROM tenant
    JOIN subscription_entitlement
      ON subscription_entitlement.id = tenant.subscription_entitlement_id
    JOIN agent_instance ON agent_instance.tenant_id = tenant.id
    WHERE tenant.id = ?1`,
    args: [tenantId],
  });
  const row = result.rows[0];
  return row ? targetFrom(row) : null;
}

export async function listProvisioningTenantIds(client: Pick<Client, "execute">): Promise<string[]> {
  const result = await client.execute(`SELECT tenant.id AS tenant_id
    FROM tenant
    JOIN subscription_entitlement
      ON subscription_entitlement.id = tenant.subscription_entitlement_id
    JOIN agent_instance ON agent_instance.tenant_id = tenant.id
    WHERE agent_instance.remote_config_state IN ('pending', 'blocked_unknown')
      OR agent_instance.phase IN ('provisioning', 'starting', 'stopping', 'retryable_error')
      OR (
        subscription_entitlement.status IN ('active', 'trialing')
        AND (
          tenant.status = 'active'
          OR (tenant.status = 'onboarding' AND agent_instance.desired_mode = 'setup')
          OR (
            tenant.status = 'onboarding'
            AND agent_instance.desired_mode = 'operate'
            AND ${currentActivationPredicate}
          )
        )
        AND tenant.desired_state = 'running'
        AND agent_instance.desired_mode IN ('setup', 'operate')
        AND (
          agent_instance.observed_state != 'healthy'
          OR agent_instance.applied_config_version != tenant.config_version
          OR agent_instance.applied_mode != agent_instance.desired_mode
        )
      )
      OR (
        (
          subscription_entitlement.status NOT IN ('active', 'trialing')
          OR tenant.status IN ('suspended', 'archived')
          OR (
            tenant.status = 'onboarding'
            AND agent_instance.desired_mode != 'setup'
            AND NOT (
              agent_instance.desired_mode = 'operate'
              AND ${currentActivationPredicate}
            )
          )
          OR tenant.desired_state != 'running'
          OR agent_instance.desired_mode = 'stopped'
        )
        AND agent_instance.observed_state NOT IN ('absent', 'stopped')
      )
    ORDER BY tenant.id`);
  return result.rows.map((row) => requiredString(row, "tenant_id"));
}

export async function writeTenantDatabaseCredentials(
  client: Pick<Client, "execute">,
  credsStoreKey: string,
  lease: ProvisionerLease,
  url: string,
  tokenCiphertext: string,
): Promise<boolean> {
  const result = await client.execute({
    sql: `UPDATE tenant
      SET tenant_db_url = ?4,
          tenant_db_token_ciphertext = ?5,
          updated_at_ms = (${nowMs})
      WHERE tenant_db_name = ?1
        AND (
          (tenant_db_url IS NULL AND tenant_db_token_ciphertext IS NULL)
          OR (tenant_db_url = ?4 AND tenant_db_token_ciphertext = ?5)
        )
        AND EXISTS (
          SELECT 1
          FROM agent_instance
          WHERE agent_instance.creds_store_key = tenant.tenant_db_name
            AND ${leasePredicate}
        )
      RETURNING tenant_db_name`,
    args: [credsStoreKey, lease.ownerId, lease.fencingToken, url, tokenCiphertext],
  });
  return result.rows.length === 1;
}

export async function bindDokployApplication(
  client: Pick<Client, "execute">,
  credsStoreKey: string,
  lease: ProvisionerLease,
  applicationId: string,
  appName: string,
): Promise<boolean> {
  const result = await client.execute({
    sql: `UPDATE agent_instance
      SET dokploy_application_id = ?4,
          dokploy_app_name = ?5,
          updated_at_ms = (${nowMs})
      WHERE creds_store_key = ?1
        AND (
          dokploy_application_id IS NULL
          OR (dokploy_application_id = ?4 AND dokploy_app_name = ?5)
        )
        AND ${leasePredicate}
      RETURNING dokploy_application_id`,
    args: [credsStoreKey, lease.ownerId, lease.fencingToken, applicationId, appName],
  });
  return result.rows.length === 1;
}

export async function beginRemoteConfig(
  client: Pick<Client, "execute">,
  credsStoreKey: string,
  lease: ProvisionerLease,
  operationId: string,
  targetVersion: number,
  targetMode: DesiredRuntimeMode,
): Promise<boolean> {
  const result = await client.execute({
    sql: `UPDATE agent_instance
      SET remote_config_operation_id = ?4,
          remote_config_owner_id = ?2,
          remote_config_fencing_token = ?3,
          remote_config_target_version = ?5,
          remote_config_state = 'pending',
          updated_at_ms = (${nowMs})
      WHERE creds_store_key = ?1
        AND remote_config_state IN ('idle', 'confirmed')
        AND desired_mode = ?6
        AND ?5 >= applied_config_version
        AND (?5 > applied_config_version OR ?6 != applied_mode)
        AND ${leasePredicate}
      RETURNING remote_config_operation_id`,
    args: [credsStoreKey, lease.ownerId, lease.fencingToken, operationId, targetVersion, targetMode],
  });
  return result.rows.length === 1;
}

export async function confirmRemoteConfig(
  client: Pick<Client, "execute">,
  credsStoreKey: string,
  lease: ProvisionerLease,
  operationId: string,
  targetMode: DesiredRuntimeMode,
): Promise<boolean> {
  const result = await client.execute({
    sql: `UPDATE agent_instance
      SET remote_config_state = 'confirmed',
          applied_config_version = remote_config_target_version,
          applied_mode = ?5,
          updated_at_ms = (${nowMs})
      WHERE creds_store_key = ?1
        AND remote_config_operation_id = ?4
        AND remote_config_owner_id = ?2
        AND remote_config_fencing_token = ?3
        AND remote_config_state = 'pending'
        AND desired_mode = ?5
        AND remote_config_target_version = (
          SELECT tenant.config_version
          FROM tenant
          WHERE tenant.id = agent_instance.tenant_id
        )
        AND ${leasePredicate}
      RETURNING applied_config_version, applied_mode`,
    args: [credsStoreKey, lease.ownerId, lease.fencingToken, operationId, targetMode],
  });
  return result.rows.length === 1;
}

export async function blockRemoteConfig(
  client: Pick<Client, "execute">,
  credsStoreKey: string,
  lease: ProvisionerLease,
  operationId: string,
): Promise<boolean> {
  const result = await client.execute({
    sql: `UPDATE agent_instance
      SET remote_config_state = 'blocked_unknown',
          phase = 'blocked_invariant',
          observed_state = 'uncertain',
          observed_at_ms = (${nowMs}),
          last_error_code = 'dokploy_config_outcome_unknown',
          updated_at_ms = (${nowMs})
      WHERE creds_store_key = ?1
        AND remote_config_operation_id = ?4
        AND remote_config_state = 'pending'
        AND ${leasePredicate}
      RETURNING remote_config_state`,
    args: [credsStoreKey, lease.ownerId, lease.fencingToken, operationId],
  });
  return result.rows.length === 1;
}

export interface AgentObservationWrite {
  readonly observedState: ObservedRuntimeState;
  readonly phase: ProvisionerPhase;
  readonly runtimeBaseUrl: string | null;
  readonly errorCode: string | null;
}

export async function writeAgentObservation(
  client: Pick<Client, "execute">,
  credsStoreKey: string,
  lease: ProvisionerLease,
  observation: AgentObservationWrite,
): Promise<boolean> {
  const result = await client.execute({
    sql: `UPDATE agent_instance
      SET observed_state = ?4,
          observed_at_ms = (${nowMs}),
          phase = ?5,
          runtime_base_url = ?6,
          last_error_code = ?7,
          updated_at_ms = (${nowMs})
      WHERE creds_store_key = ?1
        AND ${leasePredicate}
      RETURNING observed_state`,
    args: [
      credsStoreKey,
      lease.ownerId,
      lease.fencingToken,
      observation.observedState,
      observation.phase,
      observation.runtimeBaseUrl,
      observation.errorCode,
    ],
  });
  return result.rows.length === 1;
}

export interface OperatorQuiescenceAcknowledgement {
  readonly operationId: string;
  readonly actorId: string;
  readonly evidenceNote: string;
  readonly auditId: string;
}

export async function acknowledgeRemoteQuiescence(
  client: Pick<Client, "batch">,
  credsStoreKey: string,
  lease: ProvisionerLease,
  acknowledgement: OperatorQuiescenceAcknowledgement,
): Promise<boolean> {
  const actorId = acknowledgement.actorId.trim();
  const evidenceNote = acknowledgement.evidenceNote.trim();
  if (!actorId) throw new Error("operator_actor_required");
  if (!evidenceNote) throw new Error("operator_quiescence_evidence_required");

  const results = await client.batch(
    [
      {
        sql: `INSERT INTO provisioner_operator_audit (
          id, tenant_id, creds_store_key, operation_id, actor_id, evidence_note,
          fencing_token, outcome, resolution
        )
        SELECT ?5, agent_instance.tenant_id, agent_instance.creds_store_key, ?4, ?6, ?7, ?3,
          CASE WHEN agent_instance.remote_config_operation_id = ?4
              AND agent_instance.remote_config_state = 'blocked_unknown'
              AND ${leasePredicate}
            THEN 'accepted' ELSE 'rejected' END,
          CASE WHEN agent_instance.remote_config_operation_id = ?4
              AND agent_instance.remote_config_state = 'blocked_unknown'
              AND ${leasePredicate}
            THEN 'quiesced_restored' ELSE 'cas_rejected' END
        FROM agent_instance
        WHERE agent_instance.creds_store_key = ?1`,
        args: [
          credsStoreKey,
          lease.ownerId,
          lease.fencingToken,
          acknowledgement.operationId,
          acknowledgement.auditId,
          actorId,
          evidenceNote,
        ],
      },
      {
        sql: `UPDATE agent_instance
          SET remote_config_operation_id = NULL,
              remote_config_owner_id = NULL,
              remote_config_fencing_token = NULL,
              remote_config_target_version = NULL,
              remote_config_state = 'idle',
              phase = 'stopped',
              observed_state = 'stopped',
              observed_at_ms = (${nowMs}),
              last_error_code = NULL,
              updated_at_ms = (${nowMs})
          WHERE creds_store_key = ?1
            AND remote_config_operation_id = ?4
            AND remote_config_state = 'blocked_unknown'
            AND ${leasePredicate}
          RETURNING tenant_id`,
        args: [credsStoreKey, lease.ownerId, lease.fencingToken, acknowledgement.operationId],
      },
    ],
    "write",
  );
  if (results[0]?.rowsAffected !== 1) throw new Error("provisioning_target_not_found");
  return results[1]?.rows.length === 1;
}
