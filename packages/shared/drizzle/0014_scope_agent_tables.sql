-- Make an agent's office a column, not a convention.
--
-- Both tables were scoped correctly, but only transitively: every reader
-- happened to join through `agents`, which carries the workspace. That makes
-- isolation a habit rather than a property, and one query that forgets the
-- join is a leak nothing would catch. The value is derived from the agent both
-- here and on every future write, so the two cannot disagree.
--
-- Rebuilds rather than `ALTER TABLE ADD COLUMN`: the column is NOT NULL with no
-- sensible default, so existing rows have to be carried across with their
-- office already filled in.

CREATE TABLE `__new_agent_events` (
	`id` text PRIMARY KEY NOT NULL,
	`agent_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`kind` text NOT NULL,
	`payload` text,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint

INSERT INTO `__new_agent_events` (`id`, `agent_id`, `workspace_id`, `kind`, `payload`, `created_at`)
SELECT e.`id`, e.`agent_id`, a.`workspace_id`, e.`kind`, e.`payload`, e.`created_at`
FROM `agent_events` e
JOIN `agents` a ON a.`id` = e.`agent_id`;
--> statement-breakpoint

DROP TABLE `agent_events`;
--> statement-breakpoint
ALTER TABLE `__new_agent_events` RENAME TO `agent_events`;
--> statement-breakpoint
CREATE INDEX `agent_events_agent_created_idx` ON `agent_events` (`agent_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `agent_events_kind_idx` ON `agent_events` (`kind`);

--> statement-breakpoint

CREATE TABLE `__new_agent_memory` (
	`agent_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`slug` text NOT NULL,
	`content` text DEFAULT '' NOT NULL,
	`updated_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	PRIMARY KEY(`agent_id`, `slug`),
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workspace_id`) REFERENCES `workspaces`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint

INSERT INTO `__new_agent_memory` (`agent_id`, `workspace_id`, `slug`, `content`, `updated_at`)
SELECT m.`agent_id`, a.`workspace_id`, m.`slug`, m.`content`, m.`updated_at`
FROM `agent_memory` m
JOIN `agents` a ON a.`id` = m.`agent_id`;
--> statement-breakpoint

DROP TABLE `agent_memory`;
--> statement-breakpoint
ALTER TABLE `__new_agent_memory` RENAME TO `agent_memory`;
