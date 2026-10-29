CREATE TABLE `board_events` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`item_id` text,
	`task_id` text,
	`actor_kind` text NOT NULL,
	`actor_id` text,
	`actor_name` text DEFAULT '' NOT NULL,
	`kind` text NOT NULL,
	`payload` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`item_id`) REFERENCES `board_items`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`task_id`) REFERENCES `agent_tasks`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `board_events_workspace_idx` ON `board_events` (`workspace_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `board_events_item_idx` ON `board_events` (`item_id`);--> statement-breakpoint
CREATE INDEX `board_events_task_idx` ON `board_events` (`task_id`);--> statement-breakpoint
CREATE TABLE `office_github` (
	`workspace_id` text PRIMARY KEY NOT NULL,
	`token` text NOT NULL,
	`login` text DEFAULT '' NOT NULL,
	`set_by_user_id` text,
	`last_checked_at` integer,
	`last_error` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`set_by_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `pull_request_status` (
	`task_id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`state` text,
	`draft` integer DEFAULT false NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`head_sha` text DEFAULT '' NOT NULL,
	`head_ref` text DEFAULT '' NOT NULL,
	`base_ref` text DEFAULT '' NOT NULL,
	`mergeable` integer,
	`mergeable_state` text DEFAULT 'unknown' NOT NULL,
	`checks` text,
	`review_decision` text DEFAULT 'none' NOT NULL,
	`fetched_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`error` text,
	FOREIGN KEY (`task_id`) REFERENCES `agent_tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `pull_request_status_workspace_idx` ON `pull_request_status` (`workspace_id`);