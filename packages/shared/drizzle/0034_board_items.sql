CREATE TABLE `board_items` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`number` integer NOT NULL,
	`title` text NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`color` text DEFAULT 'yellow' NOT NULL,
	`labels` text DEFAULT '[]' NOT NULL,
	`assignee_agent_id` text,
	`created_by_user_id` text,
	`created_by_agent_id` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`assignee_agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by_agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `board_items_number_idx` ON `board_items` (`workspace_id`,`number`);--> statement-breakpoint
CREATE INDEX `board_items_status_idx` ON `board_items` (`workspace_id`,`status`);--> statement-breakpoint
ALTER TABLE `workspaces` ADD `board_counter` integer DEFAULT 0 NOT NULL;