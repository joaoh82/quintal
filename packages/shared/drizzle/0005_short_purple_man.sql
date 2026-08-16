CREATE TABLE `invite_links` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`created_by_user_id` text NOT NULL,
	`expires_at` integer NOT NULL,
	`max_uses` integer DEFAULT 1 NOT NULL,
	`used_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invite_links_token_hash_unique` ON `invite_links` (`token_hash`);--> statement-breakpoint
CREATE INDEX `invite_links_workspace_id_idx` ON `invite_links` (`workspace_id`);--> statement-breakpoint
ALTER TABLE `sessions` ADD `is_guest` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `users` ADD `pubkey` text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `users_pubkey_unique` ON `users` (`pubkey`);