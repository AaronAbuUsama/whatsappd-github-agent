CREATE TABLE `github_delivery_outbox` (
	`github_app_id` text NOT NULL,
	`delivery_guid` text NOT NULL,
	`event_name` text NOT NULL,
	`installation_role` text NOT NULL,
	`installation_id` integer,
	`tenant_id` text,
	`payload_json` text NOT NULL,
	`payload_sha256` text NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`next_attempt_at_ms` integer NOT NULL,
	`claim_id` text,
	`claim_expires_at_ms` integer,
	`last_error` text,
	`tenant_result_json` text,
	`received_at_ms` integer NOT NULL,
	`acknowledged_at_ms` integer,
	PRIMARY KEY(`github_app_id`, `delivery_guid`),
	FOREIGN KEY (`tenant_id`) REFERENCES `tenant`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "github_delivery_outbox_state_check" CHECK("github_delivery_outbox"."state" in ('pending', 'acked')),
	CONSTRAINT "github_delivery_outbox_role_check" CHECK("github_delivery_outbox"."installation_role" in ('coder', 'reviewer', 'planner')),
	CONSTRAINT "github_delivery_outbox_attempt_count_check" CHECK("github_delivery_outbox"."attempt_count" >= 0),
	CONSTRAINT "github_delivery_outbox_payload_check" CHECK(json_valid("github_delivery_outbox"."payload_json")),
	CONSTRAINT "github_delivery_outbox_claim_check" CHECK(("github_delivery_outbox"."claim_id" is null and "github_delivery_outbox"."claim_expires_at_ms" is null)
        or ("github_delivery_outbox"."claim_id" is not null and "github_delivery_outbox"."claim_expires_at_ms" is not null)),
	CONSTRAINT "github_delivery_outbox_result_check" CHECK("github_delivery_outbox"."tenant_result_json" is null or json_valid("github_delivery_outbox"."tenant_result_json")),
	CONSTRAINT "github_delivery_outbox_ack_check" CHECK(("github_delivery_outbox"."state" = 'pending' and "github_delivery_outbox"."acknowledged_at_ms" is null)
        or ("github_delivery_outbox"."state" = 'acked' and "github_delivery_outbox"."acknowledged_at_ms" is not null and "github_delivery_outbox"."tenant_result_json" is not null))
);
--> statement-breakpoint
CREATE INDEX `github_delivery_outbox_due_idx` ON `github_delivery_outbox` (`state`,`next_attempt_at_ms`,`claim_expires_at_ms`);--> statement-breakpoint
CREATE INDEX `github_delivery_outbox_installation_idx` ON `github_delivery_outbox` (`installation_id`,`tenant_id`);--> statement-breakpoint
CREATE TABLE `github_installation_callback` (
	`state_hash` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`expires_at_ms` integer NOT NULL,
	`installation_id` integer,
	`account_login` text,
	`created_at_ms` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`completed_at_ms` integer,
	FOREIGN KEY (`tenant_id`,`user_id`) REFERENCES `tenant`(`id`,`user_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "github_installation_callback_role_check" CHECK("github_installation_callback"."role" in ('coder', 'reviewer', 'planner')),
	CONSTRAINT "github_installation_callback_expiry_check" CHECK("github_installation_callback"."expires_at_ms" > "github_installation_callback"."created_at_ms"),
	CONSTRAINT "github_installation_callback_completion_check" CHECK(("github_installation_callback"."completed_at_ms" is null and "github_installation_callback"."installation_id" is null and "github_installation_callback"."account_login" is null)
        or ("github_installation_callback"."completed_at_ms" is not null and "github_installation_callback"."installation_id" is not null and "github_installation_callback"."account_login" is not null))
);
--> statement-breakpoint
CREATE INDEX `github_installation_callback_expiry_idx` ON `github_installation_callback` (`expires_at_ms`);--> statement-breakpoint
CREATE UNIQUE INDEX `tenant_id_user_unique` ON `tenant` (`id`,`user_id`);
