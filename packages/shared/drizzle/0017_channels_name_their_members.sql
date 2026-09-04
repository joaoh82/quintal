CREATE TABLE `conversation_members` (
	`conversation_id` text NOT NULL,
	`member_id` text NOT NULL,
	`member_kind` text NOT NULL,
	`added_by` text NOT NULL,
	`added_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	PRIMARY KEY(`conversation_id`, `member_id`),
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `conversation_members_member_idx` ON `conversation_members` (`member_id`);--> statement-breakpoint
ALTER TABLE `conversations` ADD `slug` text;--> statement-breakpoint
ALTER TABLE `conversations` ADD `created_by` text REFERENCES users(id) ON DELETE set null;--> statement-breakpoint
CREATE UNIQUE INDEX `conversations_slug_idx` ON `conversations` (`workspace_id`,`slug`);