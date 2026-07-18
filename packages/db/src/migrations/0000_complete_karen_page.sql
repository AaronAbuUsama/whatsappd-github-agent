CREATE TABLE `account` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `account_userId_idx` ON `account` (`user_id`);--> statement-breakpoint
CREATE TABLE `session` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	`token` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`user_id` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `session_token_unique` ON `session` (`token`);--> statement-breakpoint
CREATE INDEX `session_userId_idx` ON `session` (`user_id`);--> statement-breakpoint
CREATE TABLE `user` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `user_email_unique` ON `user` (`email`);--> statement-breakpoint
CREATE TABLE `verification` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `verification_identifier_idx` ON `verification` (`identifier`);--> statement-breakpoint
CREATE TABLE `agent_instance` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`creds_store_key` text NOT NULL,
	`desired_mode` text DEFAULT 'stopped' NOT NULL,
	`observed_state` text DEFAULT 'absent' NOT NULL,
	`observed_at_ms` integer,
	`dokploy_display_name` text NOT NULL,
	`dokploy_creation_token` text NOT NULL,
	`dokploy_application_id` text,
	`dokploy_app_name` text,
	`applied_config_version` integer DEFAULT 0 NOT NULL,
	`remote_config_operation_id` text,
	`remote_config_owner_id` text,
	`remote_config_fencing_token` integer,
	`remote_config_target_version` integer,
	`remote_config_state` text DEFAULT 'idle' NOT NULL,
	`phase` text DEFAULT 'pending_input' NOT NULL,
	`last_error_code` text,
	`updated_at_ms` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`tenant_id`,`creds_store_key`) REFERENCES `tenant`(`id`,`tenant_db_name`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "agent_instance_desired_mode_check" CHECK("agent_instance"."desired_mode" in ('stopped', 'setup', 'operate')),
	CONSTRAINT "agent_instance_observed_state_check" CHECK("agent_instance"."observed_state" in (
        'absent', 'provisioning', 'starting', 'healthy', 'degraded', 'stopped', 'failed', 'uncertain'
      )),
	CONSTRAINT "agent_instance_applied_config_version_check" CHECK("agent_instance"."applied_config_version" >= 0),
	CONSTRAINT "agent_instance_remote_config_state_check" CHECK("agent_instance"."remote_config_state" in ('idle', 'pending', 'confirmed', 'blocked_unknown')),
	CONSTRAINT "agent_instance_phase_check" CHECK("agent_instance"."phase" in (
        'pending_input', 'provisioning', 'starting', 'running', 'stopping',
        'stopped', 'retryable_error', 'blocked_invariant'
      )),
	CONSTRAINT "agent_instance_remote_config_identity_check" CHECK((
        "agent_instance"."remote_config_state" = 'idle'
        and "agent_instance"."remote_config_operation_id" is null
        and "agent_instance"."remote_config_owner_id" is null
        and "agent_instance"."remote_config_fencing_token" is null
        and "agent_instance"."remote_config_target_version" is null
      ) or (
        "agent_instance"."remote_config_state" != 'idle'
        and "agent_instance"."remote_config_operation_id" is not null
        and "agent_instance"."remote_config_owner_id" is not null
        and "agent_instance"."remote_config_fencing_token" is not null
        and "agent_instance"."remote_config_fencing_token" > 0
        and "agent_instance"."remote_config_target_version" is not null
        and "agent_instance"."remote_config_target_version" > 0
      ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_instance_tenant_id_unique` ON `agent_instance` (`tenant_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `agent_instance_creds_store_key_unique` ON `agent_instance` (`creds_store_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `agent_instance_dokploy_display_name_unique` ON `agent_instance` (`dokploy_display_name`);--> statement-breakpoint
CREATE UNIQUE INDEX `agent_instance_dokploy_creation_token_unique` ON `agent_instance` (`dokploy_creation_token`);--> statement-breakpoint
CREATE UNIQUE INDEX `agent_instance_dokploy_application_id_unique` ON `agent_instance` (`dokploy_application_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `agent_instance_dokploy_app_name_unique` ON `agent_instance` (`dokploy_app_name`);--> statement-breakpoint
CREATE UNIQUE INDEX `agent_instance_remote_config_operation_id_unique` ON `agent_instance` (`remote_config_operation_id`);--> statement-breakpoint
CREATE TABLE `control_operation` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`kind` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`operation_identity` text NOT NULL,
	`target_config_version` integer,
	`fencing_token` integer,
	`error_code` text,
	`started_at_ms` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`settled_at_ms` integer,
	`updated_at_ms` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenant`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "control_operation_status_check" CHECK("control_operation"."status" in ('pending', 'running', 'succeeded', 'failed', 'uncertain')),
	CONSTRAINT "control_operation_target_version_check" CHECK("control_operation"."target_config_version" is null or "control_operation"."target_config_version" > 0),
	CONSTRAINT "control_operation_fencing_token_check" CHECK("control_operation"."fencing_token" is null or "control_operation"."fencing_token" > 0),
	CONSTRAINT "control_operation_settlement_check" CHECK((
        "control_operation"."status" in ('pending', 'running') and "control_operation"."settled_at_ms" is null
      ) or (
        "control_operation"."status" in ('succeeded', 'failed', 'uncertain') and "control_operation"."settled_at_ms" is not null
      ))
);
--> statement-breakpoint
CREATE INDEX `control_operation_tenant_status_idx` ON `control_operation` (`tenant_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `control_operation_identity_unique` ON `control_operation` (`tenant_id`,`operation_identity`);--> statement-breakpoint
CREATE TABLE `delivery_route` (
	`tenant_id` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`observed_at_ms` integer,
	`updated_at_ms` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenant`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "delivery_route_status_check" CHECK("delivery_route"."status" in ('pending', 'ready', 'degraded'))
);
--> statement-breakpoint
CREATE TABLE `github_installation` (
	`tenant_id` text NOT NULL,
	`role` text NOT NULL,
	`installation_id` integer,
	`status` text DEFAULT 'pending' NOT NULL,
	`account_login` text,
	`updated_at_ms` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	PRIMARY KEY(`tenant_id`, `role`),
	FOREIGN KEY (`tenant_id`) REFERENCES `tenant`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "github_installation_role_check" CHECK("github_installation"."role" in ('coder', 'reviewer', 'planner')),
	CONSTRAINT "github_installation_status_check" CHECK("github_installation"."status" in ('pending', 'installed', 'revoked', 'failed')),
	CONSTRAINT "github_installation_installed_check" CHECK("github_installation"."status" != 'installed' or "github_installation"."installation_id" is not null)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `github_installation_installation_id_unique` ON `github_installation` (`installation_id`);--> statement-breakpoint
CREATE TABLE `github_repository` (
	`tenant_id` text NOT NULL,
	`installation_role` text NOT NULL,
	`repository_id` integer NOT NULL,
	`owner` text NOT NULL,
	`name` text NOT NULL,
	`selected` integer DEFAULT false NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`updated_at_ms` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	PRIMARY KEY(`tenant_id`, `installation_role`, `repository_id`),
	FOREIGN KEY (`tenant_id`,`installation_role`) REFERENCES `github_installation`(`tenant_id`,`role`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "github_repository_default_check" CHECK("github_repository"."is_default" = 0 or "github_repository"."selected" = 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `github_repository_one_default_per_tenant` ON `github_repository` (`tenant_id`) WHERE "github_repository"."is_default" = 1;--> statement-breakpoint
CREATE INDEX `github_repository_selection_idx` ON `github_repository` (`tenant_id`,`selected`);--> statement-breakpoint
CREATE TABLE `managed_chat_selection` (
	`tenant_id` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`selected_at_ms` integer,
	`updated_at_ms` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenant`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "managed_chat_selection_status_check" CHECK("managed_chat_selection"."status" in ('pending', 'selected')),
	CONSTRAINT "managed_chat_selection_selected_at_check" CHECK("managed_chat_selection"."status" != 'selected' or "managed_chat_selection"."selected_at_ms" is not null)
);
--> statement-breakpoint
CREATE TABLE `model_connection` (
	`tenant_id` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'missing' NOT NULL,
	`credential_version` integer DEFAULT 0 NOT NULL,
	`verified_at_ms` integer,
	`updated_at_ms` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenant`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "model_connection_status_check" CHECK("model_connection"."status" in ('missing', 'validating', 'ready', 'invalid', 'revoked')),
	CONSTRAINT "model_connection_credential_version_check" CHECK("model_connection"."credential_version" >= 0),
	CONSTRAINT "model_connection_ready_check" CHECK("model_connection"."status" != 'ready' or ("model_connection"."credential_version" > 0 and "model_connection"."verified_at_ms" is not null))
);
--> statement-breakpoint
CREATE TABLE `provisioner_lease` (
	`creds_store_key` text PRIMARY KEY NOT NULL,
	`owner_id` text,
	`fencing_token` integer DEFAULT 0 NOT NULL,
	`expires_at_ms` integer,
	`acquired_at_ms` integer,
	`renewed_at_ms` integer,
	FOREIGN KEY (`creds_store_key`) REFERENCES `agent_instance`(`creds_store_key`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "provisioner_lease_fencing_token_check" CHECK("provisioner_lease"."fencing_token" >= 0),
	CONSTRAINT "provisioner_lease_owner_expiry_check" CHECK(("provisioner_lease"."owner_id" is null and "provisioner_lease"."expires_at_ms" is null)
        or ("provisioner_lease"."owner_id" is not null and "provisioner_lease"."expires_at_ms" is not null))
);
--> statement-breakpoint
CREATE TABLE `subscription_entitlement` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`polar_customer_id` text,
	`polar_subscription_id` text,
	`status` text DEFAULT 'inactive' NOT NULL,
	`last_event_id` text,
	`updated_at_ms` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "subscription_entitlement_status_check" CHECK("subscription_entitlement"."status" in ('inactive', 'active', 'past_due', 'canceled'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `subscription_entitlement_polar_customer_id_unique` ON `subscription_entitlement` (`polar_customer_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `subscription_entitlement_polar_subscription_id_unique` ON `subscription_entitlement` (`polar_subscription_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `subscription_entitlement_last_event_id_unique` ON `subscription_entitlement` (`last_event_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `subscription_entitlement_user_unique` ON `subscription_entitlement` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `subscription_entitlement_id_user_unique` ON `subscription_entitlement` (`id`,`user_id`);--> statement-breakpoint
CREATE TABLE `tenant` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`subscription_entitlement_id` text NOT NULL,
	`display_name` text NOT NULL,
	`status` text DEFAULT 'onboarding' NOT NULL,
	`tenant_db_name` text NOT NULL,
	`tenant_db_url` text,
	`tenant_db_token_ciphertext` text,
	`config_json` text DEFAULT '{}' NOT NULL,
	`config_version` integer DEFAULT 1 NOT NULL,
	`desired_state` text DEFAULT 'stopped' NOT NULL,
	`created_at_ms` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at_ms` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`subscription_entitlement_id`,`user_id`) REFERENCES `subscription_entitlement`(`id`,`user_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "tenant_status_check" CHECK("tenant"."status" in ('onboarding', 'active', 'suspended', 'archived')),
	CONSTRAINT "tenant_config_json_check" CHECK(json_valid("tenant"."config_json")),
	CONSTRAINT "tenant_config_version_check" CHECK("tenant"."config_version" > 0),
	CONSTRAINT "tenant_desired_state_check" CHECK("tenant"."desired_state" in ('stopped', 'running', 'deleted')),
	CONSTRAINT "tenant_db_credentials_pair_check" CHECK(("tenant"."tenant_db_url" is null and "tenant"."tenant_db_token_ciphertext" is null)
        or ("tenant"."tenant_db_url" is not null and "tenant"."tenant_db_token_ciphertext" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tenant_tenant_db_name_unique` ON `tenant` (`tenant_db_name`);--> statement-breakpoint
CREATE UNIQUE INDEX `tenant_tenant_db_url_unique` ON `tenant` (`tenant_db_url`);--> statement-breakpoint
CREATE UNIQUE INDEX `tenant_user_unique` ON `tenant` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `tenant_subscription_unique` ON `tenant` (`subscription_entitlement_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `tenant_id_db_name_unique` ON `tenant` (`id`,`tenant_db_name`);--> statement-breakpoint
CREATE TABLE `tenant_managed_chat` (
	`tenant_id` text NOT NULL,
	`jid` text NOT NULL,
	`display_name` text NOT NULL,
	`kind` text NOT NULL,
	`selected_at_ms` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	PRIMARY KEY(`tenant_id`, `jid`),
	FOREIGN KEY (`tenant_id`) REFERENCES `tenant`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "tenant_managed_chat_kind_check" CHECK("tenant_managed_chat"."kind" in ('group', 'direct'))
);
--> statement-breakpoint
CREATE TABLE `whatsapp_connection` (
	`tenant_id` text PRIMARY KEY NOT NULL,
	`status` text DEFAULT 'unpaired' NOT NULL,
	`account_jid` text,
	`observed_at_ms` integer,
	`updated_at_ms` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`tenant_id`) REFERENCES `tenant`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "whatsapp_connection_status_check" CHECK("whatsapp_connection"."status" in ('unpaired', 'pairing', 'paired', 'online', 're_pair_required', 'failed')),
	CONSTRAINT "whatsapp_connection_online_check" CHECK("whatsapp_connection"."status" != 'online' or ("whatsapp_connection"."account_jid" is not null and "whatsapp_connection"."observed_at_ms" is not null))
);
--> statement-breakpoint
CREATE VIEW `tenant_readiness` AS
  select
    tenant.id as tenant_id,
    case
      when subscription_entitlement.status != 'active'
        or tenant.status in ('suspended', 'archived') then 'suspended'
      when tenant.status = 'active'
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
        and exists (
          select 1
          from github_installation
          join github_repository
            on github_repository.tenant_id = github_installation.tenant_id
            and github_repository.installation_role = github_installation.role
          where github_installation.tenant_id = tenant.id
            and github_installation.status = 'installed'
            and github_repository.selected = 1
            and github_repository.is_default = 1
        )
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
;
