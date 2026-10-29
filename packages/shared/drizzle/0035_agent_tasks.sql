CREATE TABLE `agent_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`board_item_id` text,
	`title` text NOT NULL,
	`repo` text NOT NULL,
	`branch` text NOT NULL,
	`pr_number` integer,
	`pr_url` text,
	`pr_state` text,
	`status` text DEFAULT 'active' NOT NULL,
	`started_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`ended_at` integer,
	`last_seen_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`board_item_id`) REFERENCES `board_items`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `agent_tasks_branch_idx` ON `agent_tasks` (`workspace_id`,`agent_id`,`branch`);--> statement-breakpoint
CREATE INDEX `agent_tasks_workspace_idx` ON `agent_tasks` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `agent_tasks_item_idx` ON `agent_tasks` (`board_item_id`);