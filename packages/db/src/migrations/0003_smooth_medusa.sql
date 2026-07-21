ALTER TABLE `agent_instance` ADD `applied_mode` text DEFAULT 'stopped' NOT NULL CONSTRAINT "agent_instance_applied_mode_check" CHECK (`applied_mode` in ('stopped', 'setup', 'operate'));
