CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`kind` text NOT NULL,
	`map_id` text,
	`zone_id` text,
	`name` text DEFAULT '' NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversations_zone_idx` ON `conversations` (`workspace_id`,`map_id`,`zone_id`);--> statement-breakpoint
CREATE TABLE `message_mentions` (
	`message_id` text NOT NULL,
	`member_id` text NOT NULL,
	PRIMARY KEY(`message_id`, `member_id`),
	FOREIGN KEY (`message_id`) REFERENCES `messages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `message_mentions_member_idx` ON `message_mentions` (`member_id`);--> statement-breakpoint
CREATE TABLE `messages` (
	`id` text PRIMARY KEY NOT NULL,
	`workspace_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`from_id` text NOT NULL,
	`from_kind` text NOT NULL,
	`from_name` text NOT NULL,
	`text` text NOT NULL,
	`sent_at` integer NOT NULL,
	`x` integer,
	`y` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `messages_conversation_sent_idx` ON `messages` (`conversation_id`,`sent_at`);