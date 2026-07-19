import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  sqliteView,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

import { user } from "./auth";

const nowMs = sql`(cast(unixepoch('subsecond') * 1000 as integer))`;

export const subscriptionEntitlement = sqliteTable(
  "subscription_entitlement",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    polarCustomerId: text("polar_customer_id").unique(),
    polarSubscriptionId: text("polar_subscription_id").unique(),
    status: text("status", { enum: ["inactive", "trialing", "active", "past_due", "canceled"] })
      .default("inactive")
      .notNull(),
    lastEventId: text("last_event_id").unique(),
    updatedAtMs: integer("updated_at_ms").default(nowMs).notNull(),
  },
  (table) => [
    unique("subscription_entitlement_user_unique").on(table.userId),
    unique("subscription_entitlement_id_user_unique").on(table.id, table.userId),
    check(
      "subscription_entitlement_status_check",
      sql`${table.status} in ('inactive', 'trialing', 'active', 'past_due', 'canceled')`,
    ),
  ],
);

export const tenant = sqliteTable(
  "tenant",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    subscriptionEntitlementId: text("subscription_entitlement_id").notNull(),
    displayName: text("display_name").notNull(),
    status: text("status", { enum: ["onboarding", "active", "suspended", "archived"] })
      .default("onboarding")
      .notNull(),
    tenantDbName: text("tenant_db_name").notNull().unique(),
    tenantDbUrl: text("tenant_db_url").unique(),
    tenantDbTokenCiphertext: text("tenant_db_token_ciphertext"),
    configJson: text("config_json").default("{}").notNull(),
    configVersion: integer("config_version").default(1).notNull(),
    desiredState: text("desired_state", { enum: ["stopped", "running", "deleted"] })
      .default("stopped")
      .notNull(),
    createdAtMs: integer("created_at_ms").default(nowMs).notNull(),
    updatedAtMs: integer("updated_at_ms").default(nowMs).notNull(),
  },
  (table) => [
    unique("tenant_user_unique").on(table.userId),
    unique("tenant_subscription_unique").on(table.subscriptionEntitlementId),
    unique("tenant_id_user_unique").on(table.id, table.userId),
    unique("tenant_id_db_name_unique").on(table.id, table.tenantDbName),
    foreignKey({
      name: "tenant_subscription_owner_fk",
      columns: [table.subscriptionEntitlementId, table.userId],
      foreignColumns: [subscriptionEntitlement.id, subscriptionEntitlement.userId],
    }),
    check("tenant_status_check", sql`${table.status} in ('onboarding', 'active', 'suspended', 'archived')`),
    check("tenant_config_json_check", sql`json_valid(${table.configJson})`),
    check("tenant_config_version_check", sql`${table.configVersion} > 0`),
    check("tenant_desired_state_check", sql`${table.desiredState} in ('stopped', 'running', 'deleted')`),
    check(
      "tenant_db_credentials_pair_check",
      sql`(${table.tenantDbUrl} is null and ${table.tenantDbTokenCiphertext} is null)
        or (${table.tenantDbUrl} is not null and ${table.tenantDbTokenCiphertext} is not null)`,
    ),
  ],
);

export const agentInstance = sqliteTable(
  "agent_instance",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull().unique(),
    credsStoreKey: text("creds_store_key").notNull().unique(),
    desiredMode: text("desired_mode", { enum: ["stopped", "setup", "operate"] })
      .default("stopped")
      .notNull(),
    observedState: text("observed_state", {
      enum: ["absent", "provisioning", "starting", "healthy", "degraded", "stopped", "failed", "uncertain"],
    })
      .default("absent")
      .notNull(),
    observedAtMs: integer("observed_at_ms"),
    runtimeBaseUrl: text("runtime_base_url"),
    dokployDisplayName: text("dokploy_display_name").notNull().unique(),
    dokployCreationToken: text("dokploy_creation_token").notNull().unique(),
    dokployApplicationId: text("dokploy_application_id").unique(),
    dokployAppName: text("dokploy_app_name").unique(),
    appliedConfigVersion: integer("applied_config_version").default(0).notNull(),
    remoteConfigOperationId: text("remote_config_operation_id").unique(),
    remoteConfigOwnerId: text("remote_config_owner_id"),
    remoteConfigFencingToken: integer("remote_config_fencing_token"),
    remoteConfigTargetVersion: integer("remote_config_target_version"),
    remoteConfigState: text("remote_config_state", {
      enum: ["idle", "pending", "confirmed", "blocked_unknown"],
    })
      .default("idle")
      .notNull(),
    phase: text("phase", {
      enum: [
        "pending_input",
        "provisioning",
        "starting",
        "running",
        "stopping",
        "stopped",
        "retryable_error",
        "blocked_invariant",
      ],
    })
      .default("pending_input")
      .notNull(),
    lastErrorCode: text("last_error_code"),
    updatedAtMs: integer("updated_at_ms").default(nowMs).notNull(),
  },
  (table) => [
    unique("agent_instance_tenant_store_unique").on(table.tenantId, table.credsStoreKey),
    foreignKey({
      name: "agent_instance_tenant_store_fk",
      columns: [table.tenantId, table.credsStoreKey],
      foreignColumns: [tenant.id, tenant.tenantDbName],
    }).onDelete("cascade"),
    check("agent_instance_desired_mode_check", sql`${table.desiredMode} in ('stopped', 'setup', 'operate')`),
    check(
      "agent_instance_observed_state_check",
      sql`${table.observedState} in (
        'absent', 'provisioning', 'starting', 'healthy', 'degraded', 'stopped', 'failed', 'uncertain'
      )`,
    ),
    check("agent_instance_applied_config_version_check", sql`${table.appliedConfigVersion} >= 0`),
    check(
      "agent_instance_remote_config_state_check",
      sql`${table.remoteConfigState} in ('idle', 'pending', 'confirmed', 'blocked_unknown')`,
    ),
    check(
      "agent_instance_phase_check",
      sql`${table.phase} in (
        'pending_input', 'provisioning', 'starting', 'running', 'stopping',
        'stopped', 'retryable_error', 'blocked_invariant'
      )`,
    ),
    check(
      "agent_instance_remote_config_identity_check",
      sql`(
        ${table.remoteConfigState} = 'idle'
        and ${table.remoteConfigOperationId} is null
        and ${table.remoteConfigOwnerId} is null
        and ${table.remoteConfigFencingToken} is null
        and ${table.remoteConfigTargetVersion} is null
      ) or (
        ${table.remoteConfigState} != 'idle'
        and ${table.remoteConfigOperationId} is not null
        and ${table.remoteConfigOwnerId} is not null
        and ${table.remoteConfigFencingToken} is not null
        and ${table.remoteConfigFencingToken} > 0
        and ${table.remoteConfigTargetVersion} is not null
        and ${table.remoteConfigTargetVersion} > 0
      )`,
    ),
  ],
);

export const provisionerOperatorAudit = sqliteTable(
  "provisioner_operator_audit",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    credsStoreKey: text("creds_store_key").notNull(),
    operationId: text("operation_id").notNull(),
    actorId: text("actor_id").notNull(),
    evidenceNote: text("evidence_note").notNull(),
    fencingToken: integer("fencing_token").notNull(),
    outcome: text("outcome", { enum: ["accepted", "rejected"] }).notNull(),
    resolution: text("resolution", { enum: ["quiesced_restored", "cas_rejected"] }).notNull(),
    attemptedAtMs: integer("attempted_at_ms").default(nowMs).notNull(),
  },
  (table) => [
    foreignKey({
      name: "provisioner_operator_audit_agent_fk",
      columns: [table.tenantId, table.credsStoreKey],
      foreignColumns: [agentInstance.tenantId, agentInstance.credsStoreKey],
    }).onDelete("cascade"),
    index("provisioner_operator_audit_operation_idx").on(table.tenantId, table.operationId),
    check("provisioner_operator_audit_actor_check", sql`length(trim(${table.actorId})) > 0`),
    check("provisioner_operator_audit_evidence_check", sql`length(trim(${table.evidenceNote})) > 0`),
    check("provisioner_operator_audit_fence_check", sql`${table.fencingToken} > 0`),
    check("provisioner_operator_audit_outcome_check", sql`${table.outcome} in ('accepted', 'rejected')`),
    check(
      "provisioner_operator_audit_resolution_check",
      sql`(${table.outcome} = 'accepted' and ${table.resolution} = 'quiesced_restored')
        or (${table.outcome} = 'rejected' and ${table.resolution} = 'cas_rejected')`,
    ),
  ],
);

export const provisionerLease = sqliteTable(
  "provisioner_lease",
  {
    credsStoreKey: text("creds_store_key")
      .primaryKey()
      .references(() => agentInstance.credsStoreKey, { onDelete: "cascade" }),
    ownerId: text("owner_id"),
    fencingToken: integer("fencing_token").default(0).notNull(),
    expiresAtMs: integer("expires_at_ms"),
    acquiredAtMs: integer("acquired_at_ms"),
    renewedAtMs: integer("renewed_at_ms"),
  },
  (table) => [
    check("provisioner_lease_fencing_token_check", sql`${table.fencingToken} >= 0`),
    check(
      "provisioner_lease_owner_expiry_check",
      sql`(${table.ownerId} is null and ${table.expiresAtMs} is null)
        or (${table.ownerId} is not null and ${table.expiresAtMs} is not null)`,
    ),
  ],
);

export const modelConnection = sqliteTable(
  "model_connection",
  {
    tenantId: text("tenant_id")
      .primaryKey()
      .references(() => tenant.id, { onDelete: "cascade" }),
    status: text("status", { enum: ["missing", "validating", "ready", "invalid", "revoked"] })
      .default("missing")
      .notNull(),
    credentialVersion: integer("credential_version").default(0).notNull(),
    verifiedAtMs: integer("verified_at_ms"),
    updatedAtMs: integer("updated_at_ms").default(nowMs).notNull(),
  },
  (table) => [
    check(
      "model_connection_status_check",
      sql`${table.status} in ('missing', 'validating', 'ready', 'invalid', 'revoked')`,
    ),
    check("model_connection_credential_version_check", sql`${table.credentialVersion} >= 0`),
    check(
      "model_connection_ready_check",
      sql`${table.status} != 'ready' or (${table.credentialVersion} > 0 and ${table.verifiedAtMs} is not null)`,
    ),
  ],
);

export const whatsappConnection = sqliteTable(
  "whatsapp_connection",
  {
    tenantId: text("tenant_id")
      .primaryKey()
      .references(() => tenant.id, { onDelete: "cascade" }),
    status: text("status", {
      enum: ["unpaired", "pairing", "paired", "online", "re_pair_required", "failed"],
    })
      .default("unpaired")
      .notNull(),
    accountJid: text("account_jid"),
    observedAtMs: integer("observed_at_ms"),
    updatedAtMs: integer("updated_at_ms").default(nowMs).notNull(),
  },
  (table) => [
    check(
      "whatsapp_connection_status_check",
      sql`${table.status} in ('unpaired', 'pairing', 'paired', 'online', 're_pair_required', 'failed')`,
    ),
    check(
      "whatsapp_connection_online_check",
      sql`${table.status} != 'online' or (${table.accountJid} is not null and ${table.observedAtMs} is not null)`,
    ),
  ],
);

export const managedChatSelection = sqliteTable(
  "managed_chat_selection",
  {
    tenantId: text("tenant_id")
      .primaryKey()
      .references(() => tenant.id, { onDelete: "cascade" }),
    status: text("status", { enum: ["pending", "selected"] })
      .default("pending")
      .notNull(),
    selectedAtMs: integer("selected_at_ms"),
    updatedAtMs: integer("updated_at_ms").default(nowMs).notNull(),
  },
  (table) => [
    check("managed_chat_selection_status_check", sql`${table.status} in ('pending', 'selected')`),
    check(
      "managed_chat_selection_selected_at_check",
      sql`${table.status} != 'selected' or ${table.selectedAtMs} is not null`,
    ),
  ],
);

export const tenantManagedChat = sqliteTable(
  "tenant_managed_chat",
  {
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenant.id, { onDelete: "cascade" }),
    jid: text("jid").notNull(),
    displayName: text("display_name").notNull(),
    kind: text("kind", { enum: ["group", "direct"] }).notNull(),
    selectedAtMs: integer("selected_at_ms").default(nowMs).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.jid] }),
    check("tenant_managed_chat_kind_check", sql`${table.kind} in ('group', 'direct')`),
  ],
);

export const githubInstallationCallback = sqliteTable(
  "github_installation_callback",
  {
    stateHash: text("state_hash").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    userId: text("user_id").notNull(),
    role: text("role", { enum: ["coder", "reviewer", "planner"] }).notNull(),
    expiresAtMs: integer("expires_at_ms").notNull(),
    installationId: integer("installation_id"),
    accountLogin: text("account_login"),
    createdAtMs: integer("created_at_ms").default(nowMs).notNull(),
    completedAtMs: integer("completed_at_ms"),
  },
  (table) => [
    foreignKey({
      name: "github_installation_callback_owner_fk",
      columns: [table.tenantId, table.userId],
      foreignColumns: [tenant.id, tenant.userId],
    }).onDelete("cascade"),
    index("github_installation_callback_expiry_idx").on(table.expiresAtMs),
    check("github_installation_callback_role_check", sql`${table.role} in ('coder', 'reviewer', 'planner')`),
    check("github_installation_callback_expiry_check", sql`${table.expiresAtMs} > ${table.createdAtMs}`),
    check(
      "github_installation_callback_completion_check",
      sql`(${table.completedAtMs} is null and ${table.installationId} is null and ${table.accountLogin} is null)
        or (${table.completedAtMs} is not null and ${table.installationId} is not null and ${table.accountLogin} is not null)`,
    ),
  ],
);

export const githubInstallation = sqliteTable(
  "github_installation",
  {
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenant.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["coder", "reviewer", "planner"] }).notNull(),
    installationId: integer("installation_id").unique(),
    status: text("status", { enum: ["pending", "installed", "revoked", "failed"] })
      .default("pending")
      .notNull(),
    accountLogin: text("account_login"),
    updatedAtMs: integer("updated_at_ms").default(nowMs).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.role] }),
    unique("github_installation_identity_unique").on(table.tenantId, table.role, table.installationId),
    check("github_installation_role_check", sql`${table.role} in ('coder', 'reviewer', 'planner')`),
    check("github_installation_status_check", sql`${table.status} in ('pending', 'installed', 'revoked', 'failed')`),
    check(
      "github_installation_installed_check",
      sql`${table.status} != 'installed' or ${table.installationId} is not null`,
    ),
  ],
);

export const githubRepository = sqliteTable(
  "github_repository",
  {
    tenantId: text("tenant_id").notNull(),
    installationRole: text("installation_role").notNull(),
    installationId: integer("installation_id").notNull(),
    repositoryId: integer("repository_id").notNull(),
    owner: text("owner").notNull(),
    name: text("name").notNull(),
    selected: integer("selected", { mode: "boolean" }).default(false).notNull(),
    isDefault: integer("is_default", { mode: "boolean" }).default(false).notNull(),
    updatedAtMs: integer("updated_at_ms").default(nowMs).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tenantId, table.installationRole, table.installationId, table.repositoryId] }),
    foreignKey({
      name: "github_repository_installation_fk",
      columns: [table.tenantId, table.installationRole, table.installationId],
      foreignColumns: [githubInstallation.tenantId, githubInstallation.role, githubInstallation.installationId],
    }).onDelete("cascade"),
    uniqueIndex("github_repository_one_default_per_role")
      .on(table.tenantId, table.installationRole)
      .where(sql`${table.isDefault} = 1`),
    index("github_repository_selection_idx").on(table.tenantId, table.selected),
    check("github_repository_default_check", sql`${table.isDefault} = 0 or ${table.selected} = 1`),
  ],
);

export const githubDeliveryOutbox = sqliteTable(
  "github_delivery_outbox",
  {
    githubAppId: text("github_app_id").notNull(),
    deliveryGuid: text("delivery_guid").notNull(),
    eventName: text("event_name").notNull(),
    installationRole: text("installation_role", { enum: ["coder", "reviewer", "planner"] }).notNull(),
    installationId: integer("installation_id"),
    tenantId: text("tenant_id").references(() => tenant.id, { onDelete: "cascade" }),
    payloadJson: text("payload_json").notNull(),
    payloadSha256: text("payload_sha256").notNull(),
    state: text("state", { enum: ["pending", "acked"] })
      .default("pending")
      .notNull(),
    attemptCount: integer("attempt_count").default(0).notNull(),
    nextAttemptAtMs: integer("next_attempt_at_ms").notNull(),
    claimId: text("claim_id"),
    claimExpiresAtMs: integer("claim_expires_at_ms"),
    lastError: text("last_error"),
    tenantResultJson: text("tenant_result_json"),
    receivedAtMs: integer("received_at_ms").notNull(),
    acknowledgedAtMs: integer("acknowledged_at_ms"),
  },
  (table) => [
    primaryKey({ columns: [table.githubAppId, table.deliveryGuid] }),
    index("github_delivery_outbox_due_idx").on(
      table.state,
      table.nextAttemptAtMs,
      table.claimExpiresAtMs,
    ),
    index("github_delivery_outbox_installation_idx").on(table.installationId, table.tenantId),
    check("github_delivery_outbox_state_check", sql`${table.state} in ('pending', 'acked')`),
    check(
      "github_delivery_outbox_role_check",
      sql`${table.installationRole} in ('coder', 'reviewer', 'planner')`,
    ),
    check("github_delivery_outbox_attempt_count_check", sql`${table.attemptCount} >= 0`),
    check("github_delivery_outbox_payload_check", sql`json_valid(${table.payloadJson})`),
    check(
      "github_delivery_outbox_claim_check",
      sql`(${table.claimId} is null and ${table.claimExpiresAtMs} is null)
        or (${table.claimId} is not null and ${table.claimExpiresAtMs} is not null)`,
    ),
    check(
      "github_delivery_outbox_result_check",
      sql`${table.tenantResultJson} is null or json_valid(${table.tenantResultJson})`,
    ),
    check(
      "github_delivery_outbox_ack_check",
      sql`(${table.state} = 'pending' and ${table.acknowledgedAtMs} is null)
        or (${table.state} = 'acked' and ${table.acknowledgedAtMs} is not null and ${table.tenantResultJson} is not null)`,
    ),
  ],
);

export const deliveryRoute = sqliteTable(
  "delivery_route",
  {
    tenantId: text("tenant_id")
      .primaryKey()
      .references(() => tenant.id, { onDelete: "cascade" }),
    status: text("status", { enum: ["pending", "ready", "degraded"] })
      .default("pending")
      .notNull(),
    observedAtMs: integer("observed_at_ms"),
    updatedAtMs: integer("updated_at_ms").default(nowMs).notNull(),
  },
  (table) => [check("delivery_route_status_check", sql`${table.status} in ('pending', 'ready', 'degraded')`)],
);

export const controlOperation = sqliteTable(
  "control_operation",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenant.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["provision_setup", "activate", "restart", "repair"] }).notNull(),
    status: text("status", { enum: ["pending", "running", "succeeded", "failed", "uncertain"] })
      .default("pending")
      .notNull(),
    operationIdentity: text("operation_identity").notNull(),
    targetConfigVersion: integer("target_config_version"),
    fencingToken: integer("fencing_token"),
    errorCode: text("error_code"),
    startedAtMs: integer("started_at_ms").default(nowMs).notNull(),
    settledAtMs: integer("settled_at_ms"),
    updatedAtMs: integer("updated_at_ms").default(nowMs).notNull(),
  },
  (table) => [
    unique("control_operation_identity_unique").on(table.tenantId, table.operationIdentity),
    index("control_operation_tenant_status_idx").on(table.tenantId, table.status),
    check("control_operation_kind_check", sql`${table.kind} in ('provision_setup', 'activate', 'restart', 'repair')`),
    check(
      "control_operation_status_check",
      sql`${table.status} in ('pending', 'running', 'succeeded', 'failed', 'uncertain')`,
    ),
    check(
      "control_operation_target_version_check",
      sql`${table.targetConfigVersion} is null or ${table.targetConfigVersion} > 0`,
    ),
    check("control_operation_fencing_token_check", sql`${table.fencingToken} is null or ${table.fencingToken} > 0`),
    check(
      "control_operation_settlement_check",
      sql`(
        ${table.status} in ('pending', 'running') and ${table.settledAtMs} is null
      ) or (
        ${table.status} in ('succeeded', 'failed', 'uncertain') and ${table.settledAtMs} is not null
      )`,
    ),
  ],
);

export const tenantReadiness = sqliteView("tenant_readiness", {
  tenantId: text("tenant_id").notNull(),
  readiness: text("readiness", { enum: ["onboarding", "healthy", "degraded", "suspended"] }).notNull(),
}).as(sql`
  select
    tenant.id as tenant_id,
    case
      when subscription_entitlement.status not in ('active', 'trialing')
        or tenant.status in ('suspended', 'archived') then 'suspended'
      when tenant.status = 'active'
        and tenant.desired_state = 'running'
        and agent_instance.desired_mode = 'operate'
        and agent_instance.observed_state = 'healthy'
        and agent_instance.applied_config_version = tenant.config_version
        and model_connection.status = 'ready'
        and whatsapp_connection.status = 'online'
        and managed_chat_selection.status = 'selected'
        and (
          select count(*)
          from github_installation
          where github_installation.tenant_id = tenant.id
            and github_installation.status = 'installed'
            and github_installation.role in ('coder', 'reviewer', 'planner')
        ) = 3
        and exists (
          select 1 from tenant_managed_chat
          where tenant_managed_chat.tenant_id = tenant.id
        )
        and (
          select count(distinct github_repository.installation_role)
          from github_installation
          join github_repository
            on github_repository.tenant_id = github_installation.tenant_id
            and github_repository.installation_role = github_installation.role
            and github_repository.installation_id = github_installation.installation_id
          where github_installation.tenant_id = tenant.id
            and github_installation.status = 'installed'
            and github_installation.role in ('coder', 'reviewer', 'planner')
            and github_repository.selected = 1
            and github_repository.is_default = 1
        ) = 3
        and delivery_route.status = 'ready' then 'healthy'
      when tenant.status = 'active' then 'degraded'
      else 'onboarding'
    end as readiness
  from tenant
  join subscription_entitlement
    on subscription_entitlement.id = tenant.subscription_entitlement_id
  left join agent_instance on agent_instance.tenant_id = tenant.id
  left join model_connection on model_connection.tenant_id = tenant.id
  left join whatsapp_connection on whatsapp_connection.tenant_id = tenant.id
  left join managed_chat_selection on managed_chat_selection.tenant_id = tenant.id
  left join delivery_route on delivery_route.tenant_id = tenant.id
`);
