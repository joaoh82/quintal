DROP INDEX `agent_hosts_workspace_label`;--> statement-breakpoint
CREATE UNIQUE INDEX `agent_hosts_workspace_owner_label` ON `agent_hosts` (`workspace_id`,`owner_user_id`,`label`);--> statement-breakpoint
ALTER TABLE `agents` ADD `reported_host_label` text;