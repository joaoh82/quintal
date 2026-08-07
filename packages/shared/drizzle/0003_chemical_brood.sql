CREATE TABLE `agent_hosts` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`owner_user_id` text NOT NULL,
	`label` text NOT NULL,
	`repos_dir` text DEFAULT '' NOT NULL,
	`runtimes` text DEFAULT '[]' NOT NULL,
	`last_seen_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_hosts_workspace_label` ON `agent_hosts` (`workspace_id`,`label`);--> statement-breakpoint
ALTER TABLE `agents` ADD `workspace_path` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `agents` ADD `rooted_at_repos_dir` integer DEFAULT false NOT NULL;