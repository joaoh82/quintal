CREATE TABLE `agent_events` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`kind` text NOT NULL,
	`payload` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agent_events_agent_created_idx` ON `agent_events` (`agent_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `agent_events_kind_idx` ON `agent_events` (`kind`);--> statement-breakpoint
CREATE TABLE `agent_memory` (
	`agent_id` text NOT NULL,
	`slug` text NOT NULL,
	`content` text DEFAULT '' NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	PRIMARY KEY(`agent_id`, `slug`),
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`owner_user_id` text NOT NULL,
	`name` text NOT NULL,
	`sprite_key` text DEFAULT 'slate' NOT NULL,
	`api_key_hash` text NOT NULL,
	`scopes` text DEFAULT '["chat","move","status"]' NOT NULL,
	`status` text DEFAULT '' NOT NULL,
	`last_seen_at` integer,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`owner_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agents_api_key_hash_unique` ON `agents` (`api_key_hash`);--> statement-breakpoint
CREATE INDEX `agents_workspace_id_idx` ON `agents` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `agents_owner_user_id_idx` ON `agents` (`owner_user_id`);