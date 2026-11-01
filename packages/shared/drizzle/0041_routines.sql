CREATE TABLE `routine_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`routine_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`due_at` integer NOT NULL,
	`outcome` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`fired_at` integer,
	`conversation_id` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`routine_id`) REFERENCES `routines`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `routine_runs_slot_idx` ON `routine_runs` (`routine_id`,`due_at`);--> statement-breakpoint
CREATE INDEX `routine_runs_routine_idx` ON `routine_runs` (`routine_id`,`due_at`);--> statement-breakpoint
CREATE INDEX `routine_runs_workspace_idx` ON `routine_runs` (`workspace_id`,`due_at`);--> statement-breakpoint
CREATE TABLE `routines` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`cron` text DEFAULT '' NOT NULL,
	`tz` text DEFAULT 'UTC' NOT NULL,
	`run_at` integer,
	`instructions` text DEFAULT '' NOT NULL,
	`command_id` text,
	`args` text DEFAULT '' NOT NULL,
	`paused` integer DEFAULT false NOT NULL,
	`next_due_at` integer,
	`last_run_at` integer,
	`created_by` text,
	`created_by_agent_id` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`command_id`) REFERENCES `office_commands`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by_agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `routines_workspace_idx` ON `routines` (`workspace_id`);--> statement-breakpoint
CREATE INDEX `routines_agent_idx` ON `routines` (`agent_id`);--> statement-breakpoint
CREATE INDEX `routines_due_idx` ON `routines` (`workspace_id`,`next_due_at`);