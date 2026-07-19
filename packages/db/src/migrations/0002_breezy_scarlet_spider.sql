CREATE TABLE `provisioner_operator_audit` (
	`id` text PRIMARY KEY NOT NULL,
	`tenant_id` text NOT NULL,
	`creds_store_key` text NOT NULL,
	`operation_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`evidence_note` text NOT NULL,
	`fencing_token` integer NOT NULL,
	`outcome` text NOT NULL,
	`resolution` text NOT NULL,
	`attempted_at_ms` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`tenant_id`,`creds_store_key`) REFERENCES `agent_instance`(`tenant_id`,`creds_store_key`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "provisioner_operator_audit_actor_check" CHECK(length(trim("provisioner_operator_audit"."actor_id")) > 0),
	CONSTRAINT "provisioner_operator_audit_evidence_check" CHECK(length(trim("provisioner_operator_audit"."evidence_note")) > 0),
	CONSTRAINT "provisioner_operator_audit_fence_check" CHECK("provisioner_operator_audit"."fencing_token" > 0),
	CONSTRAINT "provisioner_operator_audit_outcome_check" CHECK("provisioner_operator_audit"."outcome" in ('accepted', 'rejected')),
	CONSTRAINT "provisioner_operator_audit_resolution_check" CHECK(("provisioner_operator_audit"."outcome" = 'accepted' and "provisioner_operator_audit"."resolution" = 'quiesced_restored')
        or ("provisioner_operator_audit"."outcome" = 'rejected' and "provisioner_operator_audit"."resolution" = 'cas_rejected'))
);
--> statement-breakpoint
CREATE INDEX `provisioner_operator_audit_operation_idx` ON `provisioner_operator_audit` (`tenant_id`,`operation_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `agent_instance_tenant_store_unique` ON `agent_instance` (`tenant_id`,`creds_store_key`);