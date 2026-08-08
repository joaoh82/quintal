CREATE TABLE `host_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`owner_user_id` text NOT NULL,
	`label` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`last_seen_at` integer,
	`revoked_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `host_tokens_token_hash_unique` ON `host_tokens` (`token_hash`);--> statement-breakpoint
ALTER TABLE `agents` ADD `runtime_id` text;--> statement-breakpoint
ALTER TABLE `agents` ADD `repo_spec` text;--> statement-breakpoint
ALTER TABLE `agents` ADD `host_label` text;--> statement-breakpoint
ALTER TABLE `agents` ADD `enabled` integer DEFAULT true NOT NULL;